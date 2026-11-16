import { realpath, stat } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { LspClient } from "./client.ts"
import {
  diagnosticListReport,
  displayPath,
  formatCall,
  formatCallItem,
  formatDocumentSymbols,
  formatHover,
  formatLocations,
  formatWorkspaceSymbols,
} from "./format.ts"
import { projectPath, requestWithRetry, within, type LspManager } from "./manager.ts"

const OPERATIONS = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
  "diagnostics",
  "status",
] as const

type Operation = (typeof OPERATIONS)[number]

interface Input {
  operation: Operation
  path: string
  line?: number
  character?: number
  query?: string
  severity?: "error" | "warning" | "information" | "hint"
  source?: string
  code?: string | number
}

const DESCRIPTION = `Interact with Language Server Protocol (LSP) servers to get code intelligence features.

Supported operations:
- goToDefinition: Find where a symbol is defined
- findReferences: Find all references to a symbol
- hover: Get hover information (documentation, type info) for a symbol
- documentSymbol: Get all symbols (functions, classes, variables) in a document
- workspaceSymbol: List project-wide symbols matching a query string
- goToImplementation: Find implementations of an interface or abstract method
- prepareCallHierarchy: Get call hierarchy item at a position (functions/methods)
- incomingCalls: Find all functions/methods that call the function at a position
- outgoingCalls: Find all functions/methods called by the function at a position
- diagnostics: Check current file diagnostics, including warnings, information, and hints
- status: Inspect applicable servers without starting them (state, root, server info, capabilities, last failure)

Every operation needs path. All except documentSymbol, workspaceSymbol, diagnostics, and status also need line and character (1-based, as shown in editors).

workspaceSymbol also accepts query, a string to filter symbols by; an empty string requests all symbols. Its path only selects which language server to ask.
diagnostics accepts optional severity (error, warning, information, hint), source, and code filters. Source and code match exactly; numeric and string codes with the same text match. A missing report is not a clean result. Checks may start servers even when automatic diagnostics are disabled.

Results use 1-based positions relative to the project. Navigation and diagnostic checks require an applicable configured server; status can report that none applies.`

/** The OpenCode 1 `lsp` tool, with V2's `path` argument name. */
export function lspTool(manager: LspManager, root: string) {
  return {
    name: "lsp",
    description: DESCRIPTION,
    input: {
      type: "object",
      properties: {
        operation: { type: "string", enum: OPERATIONS, description: "The LSP operation to perform" },
        path: { type: "string", description: "The absolute or relative path to the file" },
        line: { type: "integer", minimum: 1, description: "The line number (1-based, as shown in editors)" },
        character: { type: "integer", minimum: 1, description: "The character offset (1-based, as shown in editors)" },
        query: { type: "string", description: "Search query for workspaceSymbol. Empty string requests all symbols." },
        severity: { type: "string", enum: ["error", "warning", "information", "hint"], description: "Exact severity filter for diagnostics; omitted means all severities" },
        source: { type: "string", description: "Exact diagnostic source filter" },
        code: { type: ["string", "number"], description: "Exact diagnostic code filter (compared as text)" },
      },
      required: ["operation", "path"],
      additionalProperties: false,
    },
    options: { codemode: false, permission: "lsp" },
    async execute(input: Input, context: { signal?: AbortSignal } = {}) {
      const { signal } = context
      signal?.throwIfAborted()
      const file = await resolveFile(root, input.path)
      signal?.throwIfAborted()
      const content = await run(manager, root, file, input, signal)
      return {
        content: content || `No results found for ${input.operation}`,
        metadata: { operation: input.operation, path: displayPath(file, root) },
      }
    },
  }
}

async function run(manager: LspManager, root: string, file: string, input: Input, signal?: AbortSignal): Promise<string> {
  const textDocument = { uri: pathToFileURL(file).href }
  const position = () => {
    if (!input.line || !input.character) throw new Error(`${input.operation} needs line and character.`)
    return { line: input.line - 1, character: input.character - 1 }
  }
  const ask = (capability: string, method: string, params: Record<string, unknown>) =>
    manager.request(file, capability, (client) => requestWithRetry(client, method, params, signal), signal)
  const list = (lines: string[]) => lines.join("\n")

  switch (input.operation) {
    case "status": {
      const statuses = await manager.status(file, signal)
      if (statuses.length === 0) return "No configured LSP server applies to this file."
      return JSON.stringify(statuses.map((status) => ({ ...status, root: status.root === root ? "." : displayPath(status.root, root) })), null, 2)
    }
    case "diagnostics": {
      const report = await manager.inspectDiagnostics(file, signal)
      const severities = { error: 1, warning: 2, information: 3, hint: 4 }
      const diagnostics = report.file?.filter((diagnostic) =>
        (input.severity === undefined || (diagnostic.severity ?? 1) === severities[input.severity]) &&
        (input.source === undefined || diagnostic.source === input.source) &&
        (input.code === undefined || (diagnostic.code !== undefined && String(diagnostic.code) === String(input.code))),
      )
      const output = diagnostics?.length
        ? diagnosticListReport(displayPath(file, root), diagnostics)
        : report.file === undefined ? "Diagnostics unavailable: no current report received." : "No matching diagnostics in current reports."
      return report.unreported.length ? `${output}\nIncomplete check; no current report from: ${report.unreported.join("; ")}` : output
    }
    case "goToDefinition":
      return list(formatLocations(await ask("definitionProvider", "textDocument/definition", { textDocument, position: position() }), root))
    case "goToImplementation":
      return list(formatLocations(await ask("implementationProvider", "textDocument/implementation", { textDocument, position: position() }), root))
    case "findReferences":
      return list(
        formatLocations(
          await ask("referencesProvider", "textDocument/references", {
            textDocument,
            position: position(),
            context: { includeDeclaration: true },
          }),
          root,
        ),
      )
    case "hover":
      return formatHover(await ask("hoverProvider", "textDocument/hover", { textDocument, position: position() }))
    case "documentSymbol":
      return list(formatDocumentSymbols(await ask("documentSymbolProvider", "textDocument/documentSymbol", { textDocument }), root))
    case "workspaceSymbol":
      return list(formatWorkspaceSymbols(await ask("workspaceSymbolProvider", "workspace/symbol", { query: input.query ?? "" }), root))
    case "prepareCallHierarchy":
      return list(callItems(await ask("callHierarchyProvider", "textDocument/prepareCallHierarchy", { textDocument, position: position() }), root))
    case "incomingCalls":
    case "outgoingCalls": {
      const incoming = input.operation === "incomingCalls"
      const at = position()
      // The follow-up request must go to the server that produced the item.
      const lines = await manager.request(file, "callHierarchyProvider", async (client: LspClient) => {
        const items = await requestWithRetry(client, "textDocument/prepareCallHierarchy", { textDocument, position: at }, signal)
        if (!Array.isArray(items)) return []
        if (items.length > 100) throw new Error("Call hierarchy returned more than 100 targets; choose a more specific position.")
        const method = incoming ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls"
        const output: string[] = []
        for (let offset = 0; offset < items.length; offset += 4) {
          signal?.throwIfAborted()
          const batch = items.slice(offset, offset + 4)
          const results = await Promise.all(batch.map((item) => requestWithRetry(client, method, { item }, signal)))
          // Outgoing call sites belong to the prepared item's file, not necessarily the requested file.
          for (const [index, result] of results.entries()) {
            const item = batch[index]
            const caller = typeof item?.uri === "string" && item.uri.startsWith("file:") ? fileURLToPath(item.uri) : file
            if (Array.isArray(result)) for (const call of result) {
              const formatted = formatCall(call, incoming, caller, root)
              if (formatted) output.push(formatted)
            }
          }
        }
        return output
      }, signal)
      return list(lines as string[])
    }
    default:
      throw new Error(`Unknown operation: ${String(input.operation)}`)
  }
}

function callItems(items: unknown[], root: string): string[] {
  return items.flatMap((item) => formatCallItem(item, root) ?? [])
}

async function resolveFile(root: string, value: string): Promise<string> {
  const file = projectPath(root, value)
  // OpenCode 1 asked before touching files outside the project; plugins cannot ask, so refuse.
  // Symlinks are resolved too, so a link inside the project cannot reach outside it.
  const outside = new Error(`${value} is outside the project directory ${root}.`)
  if (!within(root, file)) throw outside
  const real = await realpath(file).catch(() => undefined)
  if (!real) throw new Error(`File not found: ${file}`)
  if (!within(await realpath(root).catch(() => root), real)) throw outside
  if (!(await stat(real)).isFile()) throw new Error(`Not a file: ${file}`)
  return file
}
