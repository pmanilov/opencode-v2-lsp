import { createRequire } from "node:module"
import { constants } from "node:fs"
import { access, lstat, open, readlink, realpath } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { abortable } from "./cancellation.ts"
import { BUILTIN_ROOTS, languageIdForExtension } from "./catalog.ts"
import { LspClient, LspError, errorMessage, record, type Diagnostic } from "./client.ts"
import type { ServerConfig, Settings } from "./config.ts"

// After the first fresh push, a server that stays quiet this long is done publishing for now.
const SETTLE_MS = 300
// Servers answer pull requests quickly or not at all.
const PULL_TIMEOUT_MS = 3_000
const PULL_ATTEMPTS = 3
// Cold servers often answer navigation requests with nothing until their first analysis finishes.
const WARMUP_TIMEOUT_MS = 6_000
// Codes for "still loading" and "cancelled because the document changed".
const TRANSIENT_CODES = new Set([-32800, -32801, -32802])
// Manifest reads stop at 1 MiB even if the opened file grows while being read.
const MAX_MANIFEST_BYTES = 1024 * 1024
// Per server: retain the 128 most recently received URI reports, each at most
// 256 KiB / 1024 diagnostics. Prefer errors over warnings over informational
// reports when space runs out; an explicit diagnostic accounts for omissions.
const MAX_REPORT_URIS = 128
const MAX_REPORT_BYTES = 256 * 1024
const MAX_REPORT_DIAGNOSTICS = 1024
const MAX_MESSAGE_BYTES = 16 * 1024
const MAX_LABEL_BYTES = 1024
const MAX_URI_BYTES = 8192

/** Bound UTF-8 text without cutting a multibyte character. */
function boundedText(text: string, limit: number): string {
  if (Buffer.byteLength(text) <= limit) return text
  const bytes = Buffer.from(text.slice(0, limit))
  let end = limit - 3 // Reserve the ellipsis.
  while ((bytes[end]! & 0xc0) === 0x80) end--
  return `${bytes.subarray(0, end).toString("utf8")}…`
}

function boundedDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const retained: Diagnostic[] = []
  let bytes = 2
  let shortened = 0
  // Stable severity order means a flood of hints cannot displace errors.
  for (const severity of [1, 2, 3, 4, undefined]) {
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity !== severity) continue
      if (retained.length >= MAX_REPORT_DIAGNOSTICS - 1) break
      const message = boundedText(diagnostic.message, MAX_MESSAGE_BYTES)
      const source = diagnostic.source === undefined ? undefined : boundedText(diagnostic.source, MAX_LABEL_BYTES)
      const code = typeof diagnostic.code === "string" ? boundedText(diagnostic.code, MAX_LABEL_BYTES) : diagnostic.code
      // Copy only protocol fields: unknown server extensions must not retain
      // arbitrarily large object graphs alongside the bounded message.
      const item: Diagnostic = {
        range: {
          start: { line: diagnostic.range.start.line, character: diagnostic.range.start.character },
          end: { line: diagnostic.range.end.line, character: diagnostic.range.end.character },
        },
        severity, message, source, code,
      }
      const size = Buffer.byteLength(JSON.stringify(item)) + 1
      if (bytes + size > MAX_REPORT_BYTES - 512) continue
      retained.push(item)
      bytes += size
      if (message !== diagnostic.message || source !== diagnostic.source || code !== diagnostic.code) shortened++
    }
  }
  const omitted = diagnostics.length - retained.length
  if (omitted || shortened) {
    retained.unshift({
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      severity: diagnostics.some((item) => item.severity === 1 || item.severity === undefined) ? 1 : 2,
      source: "opencode-lsp",
      message: `Diagnostic report limited: ${omitted} diagnostics omitted; ${shortened} retained diagnostics had text shortened.`,
    })
  }
  return retained
}

interface Target {
  /** One client per server and root, as OpenCode 1 ran them. */
  readonly key: string
  readonly server: ServerConfig
  readonly root: string
}

interface Entry {
  client?: LspClient
  starting?: Promise<LspClient>
  broken?: string
  warmed?: boolean
  readonly opened: Map<string, { version: number; sentAt: number }>
}

interface Synced {
  readonly client: LspClient
  readonly version: number
  /** When this version reached the client; earlier reports describe older contents. */
  readonly sentAt: number
}

interface Published {
  readonly diagnostics: Diagnostic[]
  readonly at: number
  readonly version?: number
}

export interface FileDiagnostics {
  /** Diagnostics for the requested file, merged across its servers. Undefined when no server reported. */
  readonly file?: Diagnostic[]
  /** Other files whose diagnostics a server published while this file was checked. */
  readonly others: Map<string, Diagnostic[]>
  /** Servers that did not supply a current report; an empty report is not a missing report. */
  readonly unreported: string[]
}

/** A file's extension, or `.name` for an extensionless file such as `Dockerfile`. */
export function extensionKey(file: string): string {
  return extname(file).toLowerCase() || `.${basename(file).toLowerCase()}`
}

/** Whether the file, after resolving symlinks, is inside the project. */
export async function insideProject(root: string, file: string): Promise<boolean> {
  if (!within(root, file)) return false
  const real = await realpath(file).catch(() => undefined)
  return real !== undefined && within(await realpath(root).catch(() => root), real)
}

/**
 * Reads a project file, checking the file that was opened rather than the path.
 * Linux names an open descriptor's file under /proc, so no symlink swap can get
 * outside contents past the check. Elsewhere the opened inode must still sit at
 * the resolved path, which a racing swap of a parent directory could defeat.
 */
async function readInside(root: string, file: string, limit?: number): Promise<string> {
  const outside = new Error(`${file} is outside the project directory ${root}.`)
  if (!within(root, file)) throw outside
  // A FIFO must not block open before we can reject it with fstat.
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const held = await handle.stat()
    if (!held.isFile()) throw new Error(`${file} is not a regular file.`)
    const opened = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined)
    const real = opened ?? (await realpath(file))
    if (!within(await realpath(root).catch(() => root), real)) throw outside
    if (opened === undefined) {
      const current = await lstat(real)
      if (current.dev !== held.dev || current.ino !== held.ino) throw outside
    }
    if (limit === undefined) return await handle.readFile("utf8")
    if (held.size > limit) throw new Error(`${file} exceeds the ${limit}-byte read limit.`)
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      // Read one extra byte to distinguish an exact-limit file from a growing one.
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit - total + 1))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) return Buffer.concat(chunks, total).toString("utf8")
      total += bytesRead
      if (total > limit) throw new Error(`${file} exceeds the ${limit}-byte read limit.`)
      chunks.push(chunk.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
}

/** A tool's file argument as an absolute path, without OpenCode's `@` file-reference prefix. */
export function projectPath(root: string, value: string): string {
  const path = value.replace(/^@/, "")
  return isAbsolute(path) ? resolve(path) : resolve(root, path)
}

export function within(root: string, file: string): boolean {
  const rel = relative(root, file)
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** The directory a server runs in for this file, or undefined when the server does not apply to it. */
export async function serverRoot(id: string, file: string, project: string): Promise<string | undefined> {
  const rule = Object.hasOwn(BUILTIN_ROOTS, id) ? BUILTIN_ROOTS[id] : undefined
  if (!rule) return project
  if (rule.exclude && (await nearest(file, project, rule.exclude))) return undefined
  const found = await nearest(file, project, rule.markers)
  if (!found) return rule.required ? undefined : project
  return id === "rust" ? cargoWorkspace(found, project) : found
}

/** The nearest directory from the file's up to `stop` holding one of `markers`. */
async function nearest(file: string, stop: string, markers: string[]): Promise<string | undefined> {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    for (const marker of markers) {
      if (await access(join(dir, marker)).then(() => true, () => false)) return dir
    }
    if (dir === stop || dir === dirname(dir)) return undefined
  }
}

/** The nearest directory from the crate up to the project whose Cargo.toml declares a workspace, else the crate. */
async function cargoWorkspace(crate: string, project: string): Promise<string> {
  const { parse: parseToml } = createRequire(import.meta.url)("smol-toml")
  for (let dir = crate; ; dir = dirname(dir)) {
    let manifest: string | undefined
    try {
      manifest = await readInside(project, join(dir, "Cargo.toml"), MAX_MANIFEST_BYTES)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (manifest !== undefined && record(parseToml(manifest).workspace)) return dir
    if (dir === project || dir === dirname(dir)) return crate
  }
}

export class LspManager {
  readonly #settings: Settings
  readonly #root: string
  readonly #entries = new Map<string, Entry>()
  readonly #versions = new Map<string, number>()
  // One content copy per open URI, shared by all servers. Close releases it.
  readonly #contents = new Map<string, string>()
  readonly #deleted = new Set<string>()
  readonly #published = new Map<string, Map<string, Published>>()
  readonly #listeners = new Map<string, Set<() => void>>()
  readonly #queues = new Map<string, Promise<void>>()
  #closed = false

  constructor(settings: Settings, root: string) {
    this.#settings = settings
    this.#root = root
  }

  serversFor(file: string): ServerConfig[] {
    const key = extensionKey(file)
    const name = basename(file).toLowerCase()
    return this.#settings.servers.filter((server) =>
      server.extensions.some((extension) => [key, name].includes(extension.toLowerCase())),
    )
  }

  async #targets(file: string): Promise<Target[]> {
    const targets: Target[] = []
    for (const server of this.serversFor(file)) {
      const root = await serverRoot(server.id, file, this.#root)
      if (!root) continue
      const key = root === this.#root ? server.id : `${server.id} (${relative(this.#root, root)})`
      targets.push({ key, server, root })
    }
    return targets
  }

  /** Inspect only the servers applicable to this file; never starts or syncs them. */
  async status(file: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const targets = await abortable(this.#targets(file), signal)
    signal?.throwIfAborted()
    return targets.map(({ key, server, root }) => {
      const entry = this.#entries.get(key)
      const error = entry?.client?.failure?.message ?? entry?.broken
      const client = entry?.client
      return {
        id: server.id,
        root,
        state: this.#closed ? "stopped" : error ? "failed" : entry?.starting ? "starting" : entry?.client?.running ? "running" : "idle",
        serverInfo: client?.serverInfo,
        capabilities: Object.keys(client?.capabilities ?? {}).filter((key) => client?.capabilities[key]),
        error,
      }
    })
  }

  /** Explicit checks propagate sync/startup failures rather than silently treating them as clean. */
  async inspectDiagnostics(file: string, signal?: AbortSignal): Promise<FileDiagnostics> {
    signal?.throwIfAborted()
    if (this.serversFor(file).length === 0) throw new Error("No LSP server available for this file type.")
    const targets = await abortable(this.#targets(file), signal)
    if (targets.length === 0) throw new Error("No configured LSP server applies to this file's project.")
    const synced = await this.sync(file, signal)
    const missing = targets.filter((target) => !synced.some(({ client }) => client.id === target.key))
    const reasons = missing.map((target) => `${target.key}: ${this.#entries.get(target.key)?.broken ?? "not running"}`)
    if (synced.length === 0) throw new Error(`No LSP server for this file could start. ${reasons.join("; ")}`)
    const report = await this.#reports(file, synced, this.#settings.diagnosticsTimeoutMs, signal)
    return { ...report, unreported: [...report.unreported, ...reasons] }
  }

  /** Run one document operation per file at a time, so versions reach servers in order. */
  #serialize<T>(uri: string, run: () => Promise<T>): Promise<T> {
    const result = (this.#queues.get(uri) ?? Promise.resolve()).then(run)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.#queues.set(uri, tail)
    void tail.then(() => {
      if (this.#queues.get(uri) === tail) this.#queues.delete(uri)
    })
    return result
  }

  /** Start any missing servers for the file and send them its current contents. */
  async sync(file: string, signal?: AbortSignal): Promise<Synced[]> {
    signal?.throwIfAborted()
    const uri = pathToFileURL(file).href
    return abortable(this.#serialize(uri, () => this.#sync(file, uri, signal)), signal)
  }

  /**
   * Tell servers a deleted file is gone and forget what they reported. Reports that
   * arrive later describe deleted contents and are dropped until the file is synced
   * again. The version counter survives, so a recreated file never reuses a version
   * a late report names.
   */
  close(file: string): Promise<void> {
    const uri = pathToFileURL(file).href
    return this.#serialize(uri, async () => {
      this.#deleted.add(uri)
      this.#contents.delete(uri)
      for (const [key, entry] of this.#entries) {
        this.#published.get(key)?.delete(uri)
        if (!entry.opened.delete(uri)) continue
        if (entry.client?.running) entry.client.notify("textDocument/didClose", { textDocument: { uri } })
      }
      for (const key of this.#entries.keys()) this.#notify(key)
    })
  }

  async #sync(file: string, uri: string, signal?: AbortSignal): Promise<Synced[]> {
    signal?.throwIfAborted()
    // OpenCode 1 asked before touching files outside the project; plugins cannot ask, so they are never sent.
    const text = await readInside(this.#root, file)
    signal?.throwIfAborted()
    // Initialization is shared and independent servers start concurrently.
    const targets = await this.#targets(file)
    signal?.throwIfAborted()
    const started = await abortable(Promise.all(targets.map(async (target) => {
      const client = await this.#client(target).catch(() => undefined)
      return client ? { target, client } : undefined
    })), signal)
    const ready = started.filter((item): item is { target: Target; client: LspClient } => item !== undefined)
    signal?.throwIfAborted()
    if (this.#closed) throw new Error("LSP is shut down")
    if (ready.length === 0) return []
    // Commit the version only after startup finishes, then notify every client without
    // yielding. A cancelled startup must not make their last actual reports stale.
    const changed = this.#contents.get(uri) !== text
    const version = (this.#versions.get(uri) ?? 0) + (changed ? 1 : 0)
    if (changed) {
      this.#versions.set(uri, version)
      this.#contents.set(uri, text)
      // Unversioned reports cannot prove they describe the new contents.
      for (const [key, published] of this.#published) {
        published.delete(uri)
        this.#notify(key)
      }
    }
    this.#deleted.delete(uri)
    const synced: Synced[] = []
    for (const { target, client } of ready) {
      const entry = this.#entries.get(target.key)!
      const previous = entry.opened.get(uri)
      if (previous?.version === version) {
        synced.push({ client, version, sentAt: previous.sentAt })
        continue
      }
      this.#published.get(target.key)?.delete(uri)
      const sentAt = Date.now()
      if (previous) {
        client.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] })
      } else {
        client.notify("textDocument/didOpen", {
          textDocument: { uri, languageId: languageIdForExtension(extensionKey(file)), version, text },
        })
      }
      entry.opened.set(uri, { version, sentAt })
      // Edit tools write to disk, and some servers (rust-analyzer, for one) only re-check on save.
      const save = client.capabilities.textDocumentSync?.save
      if (save === true || (save && typeof save === "object")) {
        client.notify("textDocument/didSave", save?.includeText ? { textDocument: { uri }, text } : { textDocument: { uri } })
      }
      synced.push({ client, version, sentAt })
    }
    return synced
  }

  /** Sync the file and wait for its diagnostics. */
  async diagnostics(file: string, timeoutMs = this.#settings.diagnosticsTimeoutMs, signal?: AbortSignal): Promise<FileDiagnostics> {
    signal?.throwIfAborted()
    const synced = await this.sync(file, signal).catch((error) => {
      signal?.throwIfAborted()
      this.#log(`${file}: ${errorMessage(error)}`)
      return []
    })
    return this.#reports(file, synced, timeoutMs, signal)
  }

  async #reports(file: string, synced: Synced[], timeoutMs: number, signal?: AbortSignal): Promise<FileDiagnostics> {
    const uri = pathToFileURL(file).href
    // Reports from before this file's contents reached the server describe older contents.
    const reports = await Promise.all(synced.map(({ client, version, sentAt }) => this.#collect(client, uri, version, sentAt, timeoutMs, signal)))
    signal?.throwIfAborted()
    const unreported: string[] = []
    const reported = reports.filter((report, index): report is Diagnostic[] => {
      const current = report !== undefined && report === this.#fresh(synced[index]!.client.id, uri)?.diagnostics
      if (!current) unreported.push(synced[index]!.client.id)
      return current
    })
    const others = new Map<string, Diagnostic[]>()
    for (const { client, sentAt } of synced) {
      for (const [other, published] of this.#published.get(client.id) ?? []) {
        if (other === uri || !this.#fresh(client.id, other, sentAt)) continue
        others.set(other, [...(others.get(other) ?? []), ...published.diagnostics])
      }
    }
    return { file: reported.length ? reported.flat() : undefined, others, unreported }
  }

  async #collect(client: LspClient, uri: string, version: number, since: number, timeoutMs: number, signal?: AbortSignal): Promise<Diagnostic[] | undefined> {
    signal?.throwIfAborted()
    if (client.capabilities.diagnosticProvider) {
      try {
        // A pull answers for the contents the server held when the request arrived. Sending it from
        // the file's queue pins that version; if a later sync replaced it meanwhile, ask again.
        for (let attempt = 0; attempt < PULL_ATTEMPTS; attempt++) {
          const { sent, response } = await abortable(this.#serialize(uri, async () => {
            signal?.throwIfAborted()
            const response = client.request("textDocument/diagnostic", { textDocument: { uri } }, Math.min(timeoutMs, PULL_TIMEOUT_MS), signal)
            // Cancellation can win before the queue returns this nested promise to its caller.
            void response.catch(() => undefined)
            return {
              sent: this.#versions.get(uri),
              response,
            }
          }), signal)
          const report = await response
          if (this.#deleted.has(uri)) return undefined
          if (sent === undefined || this.#versions.get(uri) !== sent) continue
          if (report.kind === "full") {
            this.#store(client.id, uri, report.items, sent)
            return this.#fresh(client.id, uri)?.diagnostics
          }
          return this.#fresh(client.id, uri)?.diagnostics
        }
      } catch (error) {
        signal?.throwIfAborted()
        this.#log(`${client.id}: pull diagnostics failed, waiting for a push: ${errorMessage(error)}`)
      }
    }
    // An older report describes the file before this change, so no report beats a stale one.
    return this.#waitForPush(client.id, uri, version, since, timeoutMs, signal)
  }

  /** Resolve once the server has published for this version and gone quiet, or undefined on timeout. */
  #waitForPush(serverID: string, uri: string, version: number, since: number, timeoutMs: number, signal?: AbortSignal): Promise<Diagnostic[] | undefined> {
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      let settle: ReturnType<typeof setTimeout> | undefined
      const current = () => {
        const published = this.#fresh(serverID, uri, since)
        if (!published) return undefined
        if (published.version !== undefined && published.version < version) return undefined
        return published
      }
      const cleanup = () => {
        clearTimeout(timeout)
        if (settle) clearTimeout(settle)
        this.#listeners.get(serverID)?.delete(listener)
        signal?.removeEventListener("abort", abort)
      }
      const finish = () => {
        cleanup()
        resolve(current()?.diagnostics)
      }
      const abort = () => {
        cleanup()
        reject(signal!.reason)
      }
      // Any message from the server restarts the quiet period, so an early empty
      // result from a server that is still indexing is not taken as clean.
      const listener = () => {
        if (!current()) return
        if (settle) clearTimeout(settle)
        settle = setTimeout(finish, SETTLE_MS)
      }
      const timeout = setTimeout(finish, timeoutMs)
      const listeners = this.#listeners.get(serverID) ?? new Set()
      listeners.add(listener)
      this.#listeners.set(serverID, listeners)
      signal?.addEventListener("abort", abort, { once: true })
      listener()
    })
  }

  /**
   * Run `send` against every server for the file that has the capability, and
   * concatenate their results. Throws when none can answer.
   */
  async request(file: string, capability: string, send: (client: LspClient) => Promise<unknown>, signal?: AbortSignal): Promise<unknown[]> {
    signal?.throwIfAborted()
    if (this.serversFor(file).length === 0) throw new Error("No LSP server available for this file type.")
    const targets = await abortable(this.#targets(file), signal)
    if (targets.length === 0) throw new Error("No configured LSP server applies to this file's project.")
    const cold = targets.some((target) => !this.#entries.get(target.key)?.warmed)
    // Unlike a hook's check, a query must not go ahead for a file that could not be synced.
    const synced = await this.sync(file, signal)
    if (cold) await this.#reports(file, synced, WARMUP_TIMEOUT_MS, signal)
    signal?.throwIfAborted()
    const clients: LspClient[] = []
    for (const target of targets) {
      const entry = this.#entries.get(target.key)
      if (!entry?.client?.running) continue
      entry.warmed = true
      clients.push(entry.client)
    }
    if (clients.length === 0) {
      const reasons = targets.map((target) => `${target.key}: ${this.#entries.get(target.key)?.broken ?? "not running"}`)
      throw new Error(`No LSP server for this file could start. ${reasons.join("; ")}`)
    }
    const capable = clients.filter((client) => client.capabilities[capability])
    if (capable.length === 0) throw new Error(`No LSP server for this file supports ${capability}.`)
    const results = await Promise.all(capable.map(send))
    return results.flatMap((result) => (result === null || result === undefined ? [] : Array.isArray(result) ? result : [result]))
  }

  async #client({ key, server, root }: Target): Promise<LspClient> {
    if (this.#closed) throw new Error("LSP is shut down")
    let entry = this.#entries.get(key)
    if (!entry) {
      entry = { opened: new Map() }
      this.#entries.set(key, entry)
    }
    if (entry.client?.failure) entry.broken = entry.client.failure.message
    if (entry.broken) throw new Error(entry.broken)
    if (entry.client?.running) return entry.client
    if (entry.starting) return entry.starting
    const current = entry
    current.opened.clear()
    current.warmed = false
    this.#published.delete(key)
    const client = new LspClient({
      id: key,
      command: server.command,
      root,
      rootUri: pathToFileURL(root).href,
      env: server.env,
      initialization: server.initialization,
      initializeTimeoutMs: this.#settings.initializeTimeoutMs,
      requestTimeoutMs: this.#settings.requestTimeoutMs,
      onDiagnostics: (uri, diagnostics, version) => this.#store(key, uri, diagnostics, version),
      onActivity: () => this.#notify(key),
      onExit: (failure) => {
        if (failure) current.broken = failure.message
        if (current.client === client) current.client = undefined
      },
      debug: this.#settings.debug,
    })
    current.starting = client
      .start()
      .then(() => {
        current.client = client
        this.#log(`${key} started`)
        return client
      })
      .catch(async (error) => {
        // A server that cannot start stays off for this instance instead of costing every edit a retry.
        current.broken = errorMessage(error)
        this.#log(current.broken)
        await client.stop()
        throw error
      })
      .finally(() => {
        current.starting = undefined
      })
    return current.starting
  }

  #store(serverID: string, uri: string, diagnostics: Diagnostic[], version: number | undefined): void {
    if (this.#closed || this.#deleted.has(uri) || Buffer.byteLength(uri) > MAX_URI_BYTES) return
    const published = this.#published.get(serverID) ?? new Map<string, Published>()
    // A late report for an older version describes contents that are gone.
    const latest = this.#versions.get(uri) ?? published.get(uri)?.version
    if (version !== undefined && latest !== undefined && version < latest) return
    // Refresh insertion order, evicting the least recently received report first.
    published.delete(uri)
    published.set(uri, { diagnostics: boundedDiagnostics(diagnostics), at: Date.now(), version })
    if (published.size > MAX_REPORT_URIS) published.delete(published.keys().next().value!)
    this.#published.set(serverID, published)
    this.#notify(serverID)
  }

  #fresh(serverID: string, uri: string, since = 0): Published | undefined {
    if (this.#deleted.has(uri)) return undefined
    const published = this.#published.get(serverID)?.get(uri)
    if (!published || published.at < since) return undefined
    const version = this.#versions.get(uri)
    if (version !== undefined && published.version !== undefined && published.version !== version) return undefined
    return published
  }

  #notify(serverID: string): void {
    for (const listener of [...(this.#listeners.get(serverID) ?? [])]) listener()
  }

  #log(message: string): void {
    if (this.#settings.debug) console.error(`[lsp] ${message}`)
  }

  async shutdown(): Promise<void> {
    this.#closed = true
    const entries = [...this.#entries.values()]
    this.#entries.clear()
    this.#contents.clear()
    this.#published.clear()
    this.#versions.clear()
    this.#deleted.clear()
    await Promise.all(
      entries.map(async (entry) => {
        const client = entry.client ?? (await entry.starting?.catch(() => undefined))
        await client?.stop()
      }),
    )
  }
}

/** Send a request, retrying while the server reports it is still loading. */
export async function requestWithRetry(client: LspClient, method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted()
    try {
      return await client.request(method, params, undefined, signal)
    } catch (error) {
      signal?.throwIfAborted()
      if (attempt >= 5 || !(error instanceof LspError) || !TRANSIENT_CODES.has(error.code ?? 0)) throw error
      try {
        await delay(400 * attempt, undefined, { signal })
      } catch (error) {
        signal?.throwIfAborted()
        throw error
      }
    }
  }
}
