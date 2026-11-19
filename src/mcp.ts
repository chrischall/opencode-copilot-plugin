/**
 * The `mcp` meta-tool: the only way M365 reaches the MCP tools.
 *
 * opencode 2 does not offer MCP tools as function tools. It lists them in the system
 * prompt's Code Mode catalogue (see `codemode.ts`), callable only as JavaScript inside
 * its `execute` tool. The proxy strips that catalogue and offers one fenced tool, `mcp`,
 * in its place:
 *
 * - `search: <words>` is answered in the proxy: it ranks the catalogue and sends back
 *   the best matches' signatures, with how to call one.
 * - `call: <path>` plus a JSON (or `key: value`) body becomes an `execute` tool call
 *   whose code is `return await <path>(<args>);`, which opencode runs.
 *
 * When opencode says its catalogue is partial, a search with no local match goes to
 * opencode's own `search(...)`, through `execute` as well.
 */

import type { CatalogTool } from "./codemode.js";
import type { ToolDef } from "./fenced.js";

export const MCP_TOOL_NAME = "mcp";

/** Score for a query that names a tool exactly, or a namespace's whole prefix. */
const EXACT_SCORE = 1000;
const NAME_WEIGHT = 3;
const DESCRIPTION_WEIGHT = 1;

/** Tools named per server in the summary, and servers named, before "+N more". */
const SUMMARY_TOOLS_PER_SERVER = 4;
const SUMMARY_SERVERS = 8;

/** A call path: `tools` then dotted identifiers or `["bracketed"]` names, nothing else. */
const CALL_PATH = /^tools(?:\.[A-Za-z_$][\w$]*|\["[^"\\]+"\])+$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** What an `mcp` block asks for. */
export type McpRequest =
  | { kind: "search"; query: string }
  | { kind: "call"; path: string; args: Record<string, unknown> }
  | { kind: "invalid"; reason: string };

// --- the tool ------------------------------------------------------------------------

/** Group `[key, value]` pairs by key, keeping first-seen order. */
function groupBy<T>(items: readonly T[], key: (item: T) => string, value: (item: T) => string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const group = groups.get(key(item)) ?? [];
    group.push(value(item));
    groups.set(key(item), group);
  }
  return groups;
}

/** `server (a, b, +3 more), other (c)`, at most eight servers, then how many more. */
function summarise(servers: Map<string, string[]>): string {
  const entries = [...servers].slice(0, SUMMARY_SERVERS).map(([server, tools]) => {
    if (tools.length === 0) return server;
    const shown = tools.slice(0, SUMMARY_TOOLS_PER_SERVER);
    const more = tools.length - shown.length;
    return `${server} (${[...shown, ...(more > 0 ? [`+${more} more`] : [])].join(", ")})`;
  });
  const hidden = servers.size - SUMMARY_SERVERS;
  return entries.join(", ") + (hidden > 0 ? `, and ${hidden} more servers` : "");
}

/** The catalogue grouped by namespace, as one line: `github (create_issue, +2 more), slack (post_message)`. */
export function summariseCatalog(catalog: readonly CatalogTool[]): string {
  return summarise(groupBy(catalog, (tool) => tool.namespace, (tool) => tool.name));
}

/**
 * The virtual tool offered to M365 in place of the catalogue. Gentle wording on
 * purpose: see `buildToolPrompt` on why prompt shape matters more than size.
 *
 * The description stays on one line with no sentence break: the tool block shows only
 * a description's first sentence, and the summary is what tells the model a search is
 * worth making and which words to use.
 */
export function mcpTool(catalog: readonly CatalogTool[], partial: boolean): ToolDef {
  const count = catalog.length;
  const noun = count === 1 ? "tool" : "tools";
  const summary = summariseCatalog(catalog) + (partial ? ", and more not listed" : "");
  return {
    type: "function",
    function: {
      name: MCP_TOOL_NAME,
      description:
        `Use ${count}${partial ? "+" : ""} ${noun} from my MCP servers — ${summary} — by searching with a few ` +
        "words about what you want to do; the result shows how to call each match.",
      parameters: {
        type: "object",
        properties: {
          search: { type: "string", description: "A few words describing the tool you need" },
          call: { type: "string", description: "The path of a tool a search showed you, with its arguments below" },
        },
      },
    },
  };
}

// --- searching -----------------------------------------------------------------------

/** Lowercase words of two or more characters. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 2);
}

/** A tool name's words: split on `_`, `-` and camelCase boundaries. */
function nameWords(name: string): string[] {
  return words(name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2"));
}

/** Every way a model might write a tool's full name. */
function spellings(tool: CatalogTool): string[] {
  return [tool.path, `${tool.namespace}.${tool.name}`, `${tool.namespace}_${tool.name}`, `tools.${tool.namespace}.${tool.name}`].map(
    (spelling) => spelling.toLowerCase(),
  );
}

function isNamespacePrefix(query: string, namespace: string): boolean {
  const ns = namespace.toLowerCase();
  return [`${ns}_`, `${ns}.`, `tools.${ns}`, `tools.${ns}.`].includes(query);
}

function scoreTool(query: string, queryWords: readonly string[], tool: CatalogTool): number {
  if (query === tool.name.toLowerCase() || spellings(tool).includes(query)) return EXACT_SCORE;
  if (isNamespacePrefix(query, tool.namespace)) return EXACT_SCORE;

  const inName = new Set([...nameWords(tool.namespace), ...nameWords(tool.name)]);
  const inDescription = new Set(words(tool.description));
  let score = 0;
  for (const word of queryWords) {
    if (inName.has(word)) score += NAME_WEIGHT;
    if (inDescription.has(word)) score += DESCRIPTION_WEIGHT;
  }
  return score;
}

/**
 * Rank the catalogue against a search. Name (and namespace) hits weigh 3, description
 * hits 1; an exact name or path, or a namespace prefix, scores top. Tools that score
 * zero are dropped; ties keep catalogue order.
 */
export function searchCatalog(query: string, catalog: readonly CatalogTool[], limit = 5): CatalogTool[] {
  const normalised = query.trim().toLowerCase();
  if (!normalised) return [];
  const queryWords = [...new Set(words(normalised))];

  return catalog
    .map((tool, index) => ({ tool, index, score: scoreTool(normalised, queryWords, tool) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.tool);
}

/**
 * The top-level parameter names of a catalogue signature: the keys of its first
 * argument's object type, outside doc comments and nested types.
 */
export function argumentNames(signature: string): string[] {
  const open = signature.indexOf("(");
  if (open === -1) return [];
  const names: string[] = [];
  let depth = 0;
  let inComment = false;
  let token = "";
  for (let i = open; i < signature.length; i++) {
    const char = signature[i]!;
    if (inComment) {
      if (char === "*" && signature[i + 1] === "/") {
        inComment = false;
        i++;
      }
      continue;
    }
    if (char === "/" && signature[i + 1] === "*") {
      inComment = true;
      i++;
      continue;
    }
    if ("({[<".includes(char)) {
      depth++;
      token = "";
    } else if (")}]".includes(char) || (char === ">" && signature[i - 1] !== "=")) {
      depth--;
      if (depth === 0) break;
      token = "";
    } else if (depth === 2 && (char === ":" || (char === "?" && signature[i + 1] === ":"))) {
      const name = token.trim();
      if (IDENTIFIER.test(name) && !names.includes(name)) names.push(name);
      token = "";
      if (char === "?") i++;
    } else if (depth === 2 && (char === "," || char === "\n")) {
      token = "";
    } else {
      token += char;
    }
  }
  return names;
}

/** The fence that calls a tool, with a placeholder for each of its parameters. */
function callExample(tool: CatalogTool): string {
  const names = argumentNames(tool.signature);
  const args = names.length === 0 ? "" : `\n{${names.map((name) => `"${name}": "..."`).join(", ")}}`;
  return "```" + MCP_TOOL_NAME + `\ncall: ${tool.path}` + args + "\n```";
}

/**
 * The message sent back to M365 with a search's matches. It reads as a tool result:
 * each match's signature as opencode wrote it, then how to call one.
 */
export function renderSearchResult(query: string, matches: readonly CatalogTool[], total: number): string {
  if (matches.length === 0) {
    return `No tool matched "${query}". Try other words: ${total} tools are available.`;
  }
  const lines = [`<tool_response tool="${MCP_TOOL_NAME}">`, `Tools matching "${query}":`, ""];
  for (const tool of matches) lines.push(`- ${tool.signature}`, "");
  lines.push(
    "To call one, reply with an mcp block: `call:` and its path, then its arguments as a JSON object. For example:",
    callExample(matches[0]!),
    "</tool_response>",
  );
  return lines.join("\n");
}

// --- calling -------------------------------------------------------------------------

/** The JSON number grammar: no leading zeros, hex, `+`, bare `.5` or `Infinity`. */
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** A header value's own type: a JSON number, boolean or null is coerced; quotes are unwrapped. */
function headerValue(raw: string): unknown {
  const value = raw.trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (/^'.*'$|^`.*`$/.test(value)) return value.slice(1, -1);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (JSON_NUMBER.test(value)) return Number(value);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a call's arguments: a JSON object, or `key: value` lines. Empty means none. */
function parseArguments(body: string): { args: Record<string, unknown> } | { invalid: string } {
  const text = body.trim();
  if (text === "") return { args: {} };
  if (text.startsWith("{") || text.startsWith("[")) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { invalid: "the arguments are not valid JSON" };
    }
    return isPlainObject(value) ? { args: value } : { invalid: "the arguments must be a JSON object" };
  }
  const args: Record<string, unknown> = {};
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const header = /^\s*([A-Za-z_$][\w$]*)\s*:\s?(.*)$/.exec(line);
    if (!header) return { invalid: `"${line.trim()}" is neither a JSON object nor a key: value line` };
    args[header[1]!] = headerValue(header[2]!);
  }
  return { args };
}

/** A path as written: unwrap quotes and backticks, and split off a JS-style `(args)`. */
function splitCallValue(raw: string): { path: string; inline?: string } {
  let value = raw.trim();
  const wrapped = /^([`'])(.*)\1;?$/.exec(value);
  if (wrapped) value = wrapped[2]!.trim();
  value = value.replace(/;$/, "").trim();
  const paren = value.indexOf("(");
  if (paren !== -1 && value.endsWith(")")) {
    return { path: value.slice(0, paren).trim(), inline: value.slice(paren + 1, -1) };
  }
  return { path: value };
}

/**
 * Read an `mcp` block's body: `search: <words>`, or `call: <path>` followed by the
 * arguments. A body with no header is a search.
 */
export function parseMcpBlock(body: string): McpRequest {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  if (lines.length === 0) return { kind: "invalid", reason: "the block is empty" };

  const header = /^\s*(search|call)\s*:\s?(.*)$/i.exec(lines[0]!);
  if (!header) {
    const text = lines.join("\n").trim();
    if (text.startsWith("{")) return { kind: "invalid", reason: "the arguments need a `call:` line naming the tool" };
    return { kind: "search", query: text };
  }

  const rest = lines.slice(1).join("\n");
  if (header[1]!.toLowerCase() === "search") {
    const query = [header[2]!.trim(), rest.trim()].filter(Boolean).join(" ");
    return query ? { kind: "search", query } : { kind: "invalid", reason: "the search is empty" };
  }

  const { path, inline } = splitCallValue(header[2]!);
  if (!path) return { kind: "invalid", reason: "`call:` names no tool" };
  const parsed = parseArguments(inline !== undefined && rest.trim() === "" ? inline : rest);
  if ("invalid" in parsed) return { kind: "invalid", reason: parsed.invalid };
  return { kind: "call", path, args: parsed.args };
}

/**
 * The exact path to call for what the model wrote, or undefined if it may not be
 * called. A catalogued tool is accepted however the model spelled it; when opencode
 * says the catalogue is partial, any well-formed `tools` path is too, because opencode's
 * own search can return tools the catalogue leaves out.
 */
export function resolveCallPath(written: string, catalog: readonly CatalogTool[], partial: boolean): string | undefined {
  const wanted = written.trim().toLowerCase();
  const known = catalog.find((tool) => spellings(tool).includes(wanted));
  if (known) return known.path;
  if (partial && CALL_PATH.test(written.trim())) return written.trim();
  return undefined;
}

/** A complete answer to M365 for a path that is not a tool. */
export function renderUnknownTool(path: string): string {
  return [
    `<tool_response tool="${MCP_TOOL_NAME}">`,
    `There is no tool ${path}. Search first, and call a path exactly as the search shows it:`,
    "```" + MCP_TOOL_NAME + "\nsearch: a few words about what you want to do\n```",
    "</tool_response>",
  ].join("\n");
}

/** A complete answer to M365 for an `mcp` block it could not read, with the expected shape. */
export function renderInvalidMcpBlock(reason: string): string {
  return [
    `<tool_response tool="${MCP_TOOL_NAME}">`,
    `That mcp block could not be read: ${reason}. Search with:`,
    "```" + MCP_TOOL_NAME + "\nsearch: a few words about what you want to do\n```",
    "or call a tool a search showed you, with its arguments as a JSON object:",
    "```" + MCP_TOOL_NAME + '\ncall: tools.<server>.<tool>\n{"<argument>": "<value>"}\n```',
    "</tool_response>",
  ].join("\n");
}

// --- the execute code ----------------------------------------------------------------

/** The code opencode's `execute` runs for a call. */
export function callCode(path: string, args: Record<string, unknown>): string {
  return "return await " + path + "(" + JSON.stringify(args) + ");";
}

/** The code opencode's `execute` runs for a search of its own (a partial catalogue). */
export function searchCode(query: string): string {
  return "return await search(" + JSON.stringify(query) + ");";
}

const CALL_CODE = /^return await (tools(?:\.[A-Za-z_$][\w$]*|\["[^"\\]+"\])+)\((\{[\s\S]*\})\);$/;
const SEARCH_CODE = /^return await search\(("(?:[^"\\]|\\[\s\S])*")\);$/;

/**
 * The inverse of `callCode` and `searchCode`: the `mcp` request an `execute` call's code
 * came from, or undefined for code the proxy did not write.
 */
export function executeCodeToMcp(code: string | undefined): Exclude<McpRequest, { kind: "invalid" }> | undefined {
  if (typeof code !== "string") return undefined;
  const call = CALL_CODE.exec(code);
  if (call) {
    try {
      const args: unknown = JSON.parse(call[2]!);
      if (isPlainObject(args) && callCode(call[1]!, args) === code) return { kind: "call", path: call[1]!, args };
    } catch {
      return undefined;
    }
    return undefined;
  }
  const search = SEARCH_CODE.exec(code);
  if (search) {
    try {
      const query: unknown = JSON.parse(search[1]!);
      if (typeof query === "string") return { kind: "search", query };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Write a request back as the `mcp` fence the model wrote, for history replay. */
export function renderMcpFence(request: Exclude<McpRequest, { kind: "invalid" }>): string {
  if (request.kind === "search") return "```" + MCP_TOOL_NAME + `\nsearch: ${request.query}\n` + "```";
  const args = Object.keys(request.args).length === 0 ? "" : `\n${JSON.stringify(request.args)}`;
  return "```" + MCP_TOOL_NAME + `\ncall: ${request.path}` + args + "\n```";
}
