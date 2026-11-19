/**
 * opencode 2's Code Mode catalogue.
 *
 * opencode 2 does not offer MCP tools as top-level function tools. It offers one
 * `execute` tool (a string of JavaScript) and lists the MCP tools — and its own
 * `opencode` namespace — in a `# Code Mode` section of the system prompt, callable only
 * as `tools.<namespace>.<tool>(...)` inside `execute`. The section's shape (opencode
 * 2.2.5, captured 2026-11-19):
 *
 * ```
 * # Code Mode
 *
 * The tools listed below cannot be called directly: ...
 *
 * The catalog is complete. Do not guess tool names.    <- or "The catalog is partial. ..."
 *
 * ## Code Mode tools (call only inside `execute`)
 *
 * - <namespace> (<N> tools) // <namespace description>
 *   - tools.<namespace>.<tool>({
 *   /** doc comment *\/
 *   arg: string,
 * }): Promise<{ ... }> // <tool description>
 *   - tools.<namespace>["awkward-name"](...): Promise<...> // <description>
 * ```
 *
 * A signature runs over many lines, and its doc comments are free text: a column-0
 * `# ` line inside one is not a heading. So an entry is bounded by bracket depth — it
 * ends on the line where its brackets balance — and not by the next heading.
 */

export interface CatalogTool {
  /** The exact call expression: `tools.github.create_issue` or `tools.github["x-y"]`. */
  path: string;
  namespace: string;
  name: string;
  /** The whole entry without its leading `- `, verbatim, description included. */
  signature: string;
  /** The text after ` // ` on the entry's final line. */
  description: string;
}

export interface CodeModeCatalog {
  tools: CatalogTool[];
  /** opencode said the catalogue is partial: more tools exist, found with `search(...)`. */
  partial: boolean;
  /** The section's bounds in the text: its heading up to the end of the catalogue. */
  section: { start: number; end: number };
}

const HEADING = /^# Code Mode[ \t]*$/m;
const NAMESPACE_LINE = /^- \S+ \(\d+ tools?\)/;
const ENTRY_LINE = /^ {2}(?:- )?(tools[.[].*)$/;
const PATH_SEGMENT = /\.([A-Za-z_$][\w$]*)|\["([^"]+)"\]/y;
/** Where the section ended before the catalogue was parsed by depth; the fallback when it has no entries. */
const LEGACY_END = /^# |^Skills provide |^<[a-z_]+>/m;
/** A structured block at column 0 always ends the catalogue, even mid-signature. */
const BLOCK_LINE = /^<\/?[a-z_]+>/;

interface Line {
  text: string;
  start: number;
  end: number;
}

function splitLines(text: string, from: number): Line[] {
  const lines: Line[] = [];
  let start = from;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline + 1;
    lines.push({ text: text.slice(start, newline === -1 ? text.length : newline), start, end });
    start = end;
  }
  return lines;
}

/**
 * Walk one line of a TypeScript signature, tracking bracket depth outside comments and
 * string literals. Returns the new state, plus where a ` // ` line comment starts at
 * depth 0 (the entry's description), if one does.
 */
function scanLine(line: string, state: { depth: number; inComment: boolean }): { descriptionAt?: number } {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (state.inComment) {
      if (char === "*" && line[i + 1] === "/") {
        state.inComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "/" && line[i + 1] === "*") {
      state.inComment = true;
      i++;
    } else if (char === "/" && line[i + 1] === "/") {
      return state.depth <= 0 ? { descriptionAt: i + 2 } : {};
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if ("({[".includes(char)) {
      state.depth++;
    } else if (")}]".includes(char)) {
      state.depth--;
    }
  }
  return {};
}

function splitPath(path: string): { namespace: string; name: string } | undefined {
  if (!path.startsWith("tools")) return undefined;
  const segments: string[] = [];
  PATH_SEGMENT.lastIndex = "tools".length;
  while (PATH_SEGMENT.lastIndex < path.length) {
    const match = PATH_SEGMENT.exec(path);
    if (!match) return undefined;
    segments.push(match[1] ?? match[2]!);
  }
  if (segments.length < 2) return undefined;
  return { namespace: segments[0]!, name: segments.slice(1).join(".") };
}

/** Parse the Code Mode catalogue out of a system prompt, or undefined if there is none. */
export function parseCodeModeCatalog(systemText: string): CodeModeCatalog | undefined {
  const heading = HEADING.exec(systemText);
  if (!heading) return undefined;
  const start = heading.index;
  const lines = splitLines(systemText, start + heading[0].length);

  const tools: CatalogTool[] = [];
  let catalogueEnd: number | undefined;
  let preamble = "";
  let i = 0;

  // The prose before the first namespace line: where opencode says complete or partial.
  for (; i < lines.length && !NAMESPACE_LINE.test(lines[i]!.text); i++) {
    if (/^# |^<[a-z_]+>/.test(lines[i]!.text)) break;
    preamble += `${lines[i]!.text}\n`;
  }
  const partial = /\bcatalog(?:ue)? is partial\b/i.test(preamble);

  while (i < lines.length) {
    const line = lines[i]!;
    if (NAMESPACE_LINE.test(line.text)) {
      catalogueEnd = line.end;
      i++;
      continue;
    }
    const entry = ENTRY_LINE.exec(line.text);
    if (entry) {
      const state = { depth: 0, inComment: false };
      const entryLines: string[] = [];
      let description = "";
      let j = i;
      for (; j < lines.length; j++) {
        const current = lines[j]!;
        if (j > i && !state.inComment && state.depth > 0 && BLOCK_LINE.test(current.text)) break;
        if (j > i && (NAMESPACE_LINE.test(current.text) || ENTRY_LINE.test(current.text)) && state.depth > 0 && !state.inComment) break;
        const text = j === i ? entry[1]! : current.text;
        entryLines.push(text);
        const { descriptionAt } = scanLine(text, state);
        if (state.depth <= 0 && !state.inComment) {
          if (descriptionAt !== undefined) description = text.slice(descriptionAt).trim();
          j++;
          break;
        }
      }
      const signature = entryLines.join("\n");
      const path = signature.slice(0, signature.indexOf("(")).trim();
      const parts = splitPath(path);
      if (parts) tools.push({ path, ...parts, signature, description });
      catalogueEnd = lines[j - 1]!.end;
      i = j;
      continue;
    }
    if (line.text.trim() === "") {
      i++;
      continue;
    }
    break;
  }

  let end: number;
  if (catalogueEnd === undefined) {
    // No catalogue lines at all: fall back to the next heading or block.
    const rest = systemText.slice(start + heading[0].length);
    const next = rest.search(LEGACY_END);
    end = next === -1 ? systemText.length : start + heading[0].length + next;
  } else {
    end = catalogueEnd;
    // Take the blank lines after the catalogue with it.
    while (end < systemText.length && systemText[end] === "\n") end++;
  }

  return { tools, partial, section: { start, end } };
}

/**
 * Remove opencode 2's whole `# Code Mode` section, from its heading to the end of the
 * catalogue. Text without one is returned unchanged.
 */
export function stripCodeModeSection(systemText: string): string {
  const catalog = parseCodeModeCatalog(systemText);
  if (!catalog) return systemText;
  return systemText.slice(0, catalog.section.start) + systemText.slice(catalog.section.end);
}
