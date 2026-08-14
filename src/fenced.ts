/**
 * The fenced tool-call contract.
 *
 * M365 Copilot has no native `tool_calls`. We emulate them, and the format matters:
 * a JSON `{"tool": ...}` contract measured 0/5 on real agentic tasks in the reference
 * implementation and was removed. What works is Markdown fences — a code block whose
 * info string is the tool name.
 *
 *     ```read
 *     filePath: /etc/hostname
 *     ```
 *
 * Scalar arguments are `key: value` header lines; one free-form argument is the fence
 * body; an old/new pair renders as an aider-style SEARCH/REPLACE diff.
 *
 * The load-bearing trick is **shell-routing**. Microsoft's server-side prompt defines
 * this model as a retrieval chat assistant, so telling it to "be an agent" gets
 * refused or meta-analysed away. But it will reflexively write a ```bash block. So
 * when the toolset contains a shell tool we ask for exactly that, and route the block
 * to the shell tool. That is the difference between prose and a real agent loop.
 */

export interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: JsonSchema;
  };
}

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, any>;
}

export interface ParseResult {
  toolCalls: ParsedToolCall[];
  /** Prose to return to the client. Empty when the turn produced a tool call. */
  text: string;
}

/** Info strings we accept as "this is a shell block", beyond the tool's own name. */
const SHELL_FENCE_INFOS = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "console",
  "shellsession",
  "shellscript",
  "terminal",
]);

/** Tool names that mean "run a command", whatever the harness calls it. */
const SHELL_TOOL_NAMES = [
  "bash",
  "shell",
  "sh",
  "run",
  "run_command",
  "runcommand",
  "execute",
  "execute_command",
  "exec",
  "terminal",
  "command",
];

/**
 * Parameter names that are conventionally free-form, multi-line bodies.
 *
 * Membership here is the *only* way a parameter becomes the fence body when a tool
 * has more than one argument. A name-based rule is blunt, but it is symmetric: the
 * prompt and the parser derive the same shape from the same list, so a call we
 * described is always a call we can read back. Guessing from JSON-schema types is
 * not symmetric — `read(filePath, offset)` and `t(n, b, s)` both have exactly one
 * string parameter, and it is a body in neither.
 */
const BODY_PARAM_NAMES = [
  "command",
  "content",
  "body",
  "text",
  "code",
  "script",
  "patch",
  "diff",
  "input",
  "prompt",
  "query",
  "pattern",
  "thought",
  "message",
  "sql",
  "expression",
];

/** Pairs of parameter names that together mean "a search/replace edit". */
const EDIT_PARAM_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["oldString", "newString"],
  ["old_string", "new_string"],
  ["old", "new"],
  ["search", "replace"],
];

const SEARCH_MARKER = "<<<<<<< SEARCH";
const DIVIDER_MARKER = "=======";
const REPLACE_MARKER = ">>>>>>> REPLACE";

// --- toolset inspection ---------------------------------------------------------

/** The shell tool in this toolset, whatever the harness named it. */
export function findShellTool(tools: readonly ToolDef[]): ToolDef | undefined {
  return tools.find((tool) => SHELL_TOOL_NAMES.includes(tool.function.name.toLowerCase()));
}

interface ToolShape {
  tool: ToolDef;
  /** Scalar args rendered as `key: value` header lines. */
  headers: string[];
  /** The single free-form arg carried in the fence body, if any. */
  bodyParam?: string;
  /** The old/new pair rendered as a SEARCH/REPLACE diff, if any. */
  editPair?: readonly [string, string];
}

/**
 * Decide how a tool's arguments map onto the fence.
 *
 * The split has to be deterministic in both directions: whatever we describe in the
 * prompt is exactly what the parser expects back.
 */
function shapeOf(tool: ToolDef): ToolShape {
  const props = tool.function.parameters?.properties ?? {};
  const names = Object.keys(props);

  const editPair = EDIT_PARAM_PAIRS.find(([a, b]) => names.includes(a) && names.includes(b));

  let bodyParam: string | undefined;
  if (!editPair) {
    bodyParam = names.find((name) => BODY_PARAM_NAMES.includes(name.toLowerCase()));
    // A single-argument string tool has nowhere else to put its value, and a header
    // line cannot carry a multi-line one.
    if (!bodyParam && names.length === 1) {
      const only = names[0]!;
      if ((props[only]?.type ?? "string") === "string" && !props[only]?.enum) bodyParam = only;
    }
  }

  const consumed = new Set<string>([...(editPair ?? []), ...(bodyParam ? [bodyParam] : [])]);
  const headers = names.filter((name) => !consumed.has(name));

  return { tool, headers, bodyParam, editPair };
}

// --- prompt construction --------------------------------------------------------

export interface PromptOptions {
  /** Override the shell-routing framing (mainly for experiments). */
  shellFraming?: boolean;
}

/**
 * Build the `<tools>` block injected into the user turn.
 *
 * Kept deliberately gentle. The Disengaged filter tracks prompt *shape* rather than
 * size — fake `<system>` turns, shouted absolutes and "output ONLY JSON" all read as
 * manipulation and get the conversation disengaged, so a leaner prompt can outscore a
 * more forceful one. Behavioural framing lives here rather than in the agent's
 * server-side instructions, where heavy framing measurably backfired.
 */
export function buildToolPrompt(tools: readonly ToolDef[], options: PromptOptions = {}): string {
  if (tools.length === 0) return "";

  const shell = findShellTool(tools);
  const useShellFraming = options.shellFraming ?? Boolean(shell);

  const lines: string[] = [];
  lines.push("<tools>");
  lines.push(
    "You are working in a real workspace with real files. These tools are available, and a fenced block is an action the runtime executes for you — not an illustration.",
  );
  lines.push("");

  for (const tool of tools) {
    const shape = shapeOf(tool);
    const description = tool.function.description?.trim();
    if (description) lines.push(`${tool.function.name} — ${firstSentence(description)}`);
    lines.push("```" + tool.function.name);
    for (const header of shape.headers) {
      lines.push(`${header}: ${placeholderFor(header, shape.tool)}`);
    }
    if (shape.editPair) {
      lines.push(SEARCH_MARKER);
      lines.push("the exact existing text");
      lines.push(DIVIDER_MARKER);
      lines.push("the replacement text");
      lines.push(REPLACE_MARKER);
    } else if (shape.bodyParam) {
      lines.push(`<${shape.bodyParam}>`);
    }
    lines.push("```");
    lines.push("");
  }

  if (useShellFraming && shell) {
    lines.push(
      `Prefer doing the whole step by writing one \`\`\`${shell.function.name} block: heredocs to create files, sed to edit, cat/ls/grep to inspect.`,
    );
  }
  lines.push(
    "You have not run anything yet, so do not describe what a command would return or say a file is empty — run it and read the result.",
  );
  lines.push(
    "Only say the work is done once a tool result above this line proves it. When you have the final answer, give it plainly with no preamble.",
  );
  lines.push("</tools>");

  return lines.join("\n");
}

function firstSentence(text: string): string {
  // Harness tool descriptions often open with a bullet or a blank line; taking the
  // first non-empty line and dropping the marker keeps the one-liner readable.
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? text;
  const cleaned = line.replace(/^\s*[-*•]\s*/, "");
  const stop = cleaned.indexOf(". ");
  return (stop > 0 ? cleaned.slice(0, stop) : cleaned).trim();
}

function placeholderFor(name: string, tool: ToolDef): string {
  const schema = tool.function.parameters?.properties?.[name];
  if (schema?.enum?.length) return schema.enum.map(String).join(" | ");
  const required = tool.function.parameters?.required?.includes(name);
  const type = schema?.type ?? "string";
  return `<${type}>${required ? "" : "   (optional)"}`;
}

// --- parsing --------------------------------------------------------------------

interface Fence {
  info: string;
  body: string;
  start: number;
  end: number;
}

/**
 * Extract fenced blocks, honouring the CommonMark rule that a fence is closed only by
 * a run of at least as many backticks as opened it.
 *
 * That rule matters here: the model writes heredocs containing ``` all the time, and
 * a naive split would truncate the command halfway through.
 */
function extractFences(source: string): Fence[] {
  const fences: Fence[] = [];
  const lines = source.split("\n");
  let index = 0;

  while (index < lines.length) {
    const open = /^(\s*)(`{3,})(.*)$/.exec(lines[index]!);
    if (!open) {
      index += 1;
      continue;
    }
    const ticks = open[2]!;
    const info = open[3]!.trim();
    const bodyLines: string[] = [];
    let cursor = index + 1;
    let closed = false;

    while (cursor < lines.length) {
      const close = /^\s*(`{3,})\s*$/.exec(lines[cursor]!);
      if (close && close[1]!.length >= ticks.length) {
        closed = true;
        break;
      }
      bodyLines.push(lines[cursor]!);
      cursor += 1;
    }

    // An unterminated fence is a truncated response, not an action. Ignoring it is
    // the safe read — executing half a command is not.
    if (closed) {
      fences.push({
        info,
        body: bodyLines.join("\n"),
        start: charOffset(lines, index),
        end: charOffset(lines, cursor + 1),
      });
    }
    index = cursor + 1;
  }

  return fences;
}

function charOffset(lines: string[], lineIndex: number): number {
  let offset = 0;
  for (let i = 0; i < lineIndex && i < lines.length; i += 1) offset += lines[i]!.length + 1;
  return offset;
}

/**
 * Does this response look like a document the model wrote *as its answer*, rather
 * than an action it wants executed?
 *
 * Shell-routing means every ```bash block becomes a tool call, so a model answering
 * "here's a suggested README" would get its own answer run as shell. A single action
 * is never reclassified — only genuinely document-shaped output is.
 */
export function isProseDocument(source: string): boolean {
  const fences = extractFences(source);
  if (fences.length <= 1) return false;
  if (fences.length >= 4) return true;

  const prose = proseAround(source, fences);
  return prose.length >= 120;
}

function proseAround(source: string, fences: Fence[]): string {
  let prose = "";
  let cursor = 0;
  for (const fence of fences) {
    prose += source.slice(cursor, fence.start);
    cursor = fence.end;
  }
  prose += source.slice(cursor);
  return prose.trim();
}

/**
 * Remove JSON objects the model invents around its answer.
 *
 * M365 likes to append `{"confidence": 0.9}` and to wrap answers in `{"final": ...}`.
 * A lone `{"final": ...}` is unwrapped into its text; one riding alongside a real
 * tool call is a premature victory claim and gets dropped by the caller.
 */
export function stripInventedJson(text: string): string {
  let result = text;

  // Only strip when the object stands alone on its own line(s) — an inline example
  // inside prose is content, not noise.
  result = result.replace(/^\s*\{\s*"confidence"\s*:\s*[^}]*\}\s*$/gm, "");

  const lone = /^\s*\{\s*"final"\s*:\s*("(?:[^"\\]|\\.)*")\s*\}\s*$/.exec(result.trim());
  if (lone) {
    try {
      return JSON.parse(lone[1]!);
    } catch {
      /* fall through and return the text as-is */
    }
  }

  result = result.replace(/^\s*\{\s*"final"\s*:\s*(?:"(?:[^"\\]|\\.)*"|[^}]*)\}\s*$/gm, "");
  return result.trim();
}

export interface ParseOptions {
  /**
   * Keep every tool call instead of only the first.
   *
   * Off by default: M365 batches its whole plan into one response, so calls after
   * the first run against state it only guessed at.
   */
  allowMultiple?: boolean;
}

/** Parse a raw M365 response into OpenAI-shaped tool calls plus any prose. */
export function parseToolCalls(
  source: string,
  tools: readonly ToolDef[],
  options: ParseOptions = {},
): ParseResult {
  const cleaned = stripInventedJson(source);

  if (tools.length === 0) return { toolCalls: [], text: cleaned };
  if (isProseDocument(cleaned)) return { toolCalls: [], text: cleaned };

  const shell = findShellTool(tools);
  const byName = new Map(tools.map((tool) => [tool.function.name.toLowerCase(), tool]));

  const calls: ParsedToolCall[] = [];
  const consumed: Fence[] = [];

  for (const fence of extractFences(cleaned)) {
    const info = fence.info.split(/\s+/)[0]?.toLowerCase() ?? "";
    let tool = byName.get(info);
    // Shell-routing: a plain ```bash block is the model doing the work in the one
    // way its server-side prompt permits.
    if (!tool && shell && SHELL_FENCE_INFOS.has(info)) tool = shell;
    if (!tool) continue;

    calls.push({ name: tool.function.name, arguments: parseFenceBody(fence.body, tool) });
    consumed.push(fence);
    if (!options.allowMultiple) break;
  }

  if (calls.length === 0) return { toolCalls: [], text: cleaned };

  // Mixed output: when the model both acted and narrated, the client gets the action.
  // The narration is logged upstream, not returned.
  return { toolCalls: calls, text: "" };
}

/** Split a fence body into header args, a SEARCH/REPLACE pair, and/or a body arg. */
function parseFenceBody(body: string, tool: ToolDef): Record<string, any> {
  const shape = shapeOf(tool);
  const props = tool.function.parameters?.properties ?? {};
  const args: Record<string, any> = {};

  const lines = body.split("\n");
  let cursor = 0;

  // Header lines run until the first line that is not `knownParam: value`. Requiring
  // the key to be a declared parameter is what stops `echo 'note: hi'` from being
  // eaten as a header.
  while (cursor < lines.length) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s?(.*)$/.exec(lines[cursor]!);
    if (!match) break;
    const key = match[1]!;
    if (!shape.headers.includes(key)) break;
    args[key] = coerce(match[2]!.trim(), props[key]?.type);
    cursor += 1;
  }

  const rest = lines.slice(cursor).join("\n").replace(/^\n+/, "");

  if (shape.editPair) {
    const diff = parseSearchReplace(rest);
    if (diff) {
      args[shape.editPair[0]] = diff.search;
      args[shape.editPair[1]] = diff.replace;
    }
    return args;
  }

  if (shape.bodyParam) {
    const trimmed = rest.trim();
    if (trimmed !== "") args[shape.bodyParam] = trimmed;
  }

  return args;
}

function parseSearchReplace(body: string): { search: string; replace: string } | undefined {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.trim().startsWith(SEARCH_MARKER));
  if (start === -1) return undefined;
  const divider = lines.findIndex((line, i) => i > start && line.trim() === DIVIDER_MARKER);
  if (divider === -1) return undefined;
  const end = lines.findIndex((line, i) => i > divider && line.trim().startsWith(REPLACE_MARKER));
  if (end === -1) return undefined;

  return {
    search: lines.slice(start + 1, divider).join("\n"),
    replace: lines.slice(divider + 1, end).join("\n"),
  };
}

/** Coerce a header value to the type the schema declares. */
function coerce(value: string, type: string | undefined): unknown {
  switch (type) {
    case "number":
    case "integer": {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : value;
    }
    case "boolean":
      if (value === "true") return true;
      if (value === "false") return false;
      return value;
    default:
      return value;
  }
}
