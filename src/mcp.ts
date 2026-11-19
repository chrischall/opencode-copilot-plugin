/**
 * The `mcp` meta-tool: discovery for the tools the lean trim defers.
 *
 * The lean trim keeps a handful of tools so the Disengaged budget holds, and that
 * drops every MCP tool opencode offers. Instead of listing them all, the proxy offers
 * one extra fenced tool, `mcp`, whose only argument is a search. The proxy answers the
 * search itself (it never reaches opencode): it ranks the deferred tools against the
 * query and sends the best matches back, each written as its normal fence template.
 * The model then calls the real tool with that tool's own block.
 */

import { describeTool, type ToolDef } from "./fenced.js";

export const MCP_TOOL_NAME = "mcp";

/** Score for a query that names a tool exactly, or a server's whole `<server>_` prefix. */
const EXACT_SCORE = 1000;
const NAME_WEIGHT = 3;
const DESCRIPTION_WEIGHT = 1;

/**
 * The virtual tool offered to M365 alongside the lean set. Gentle wording on purpose:
 * see `buildToolPrompt` on why prompt shape matters more than size.
 */
export function mcpTool(deferredCount: number): ToolDef {
  const noun = deferredCount === 1 ? "tool" : "tools";
  return {
    type: "function",
    function: {
      name: MCP_TOOL_NAME,
      description:
        `Find more tools. ${deferredCount} more ${noun} from my MCP servers can be found by searching ` +
        "with a few words about what you want to do; the result shows how to call each match.",
      parameters: {
        type: "object",
        properties: {
          search: { type: "string", description: "A few words describing the tool you need" },
        },
        required: ["search"],
      },
    },
  };
}

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

function scoreTool(query: string, queryWords: readonly string[], tool: ToolDef): number {
  const name = tool.function.name.toLowerCase();
  if (query === name) return EXACT_SCORE;
  if (query.endsWith("_") && name.startsWith(query)) return EXACT_SCORE;

  const inName = new Set(nameWords(tool.function.name));
  const inDescription = new Set(words(tool.function.description ?? ""));
  let score = 0;
  for (const word of queryWords) {
    if (inName.has(word)) score += NAME_WEIGHT;
    if (inDescription.has(word)) score += DESCRIPTION_WEIGHT;
  }
  return score;
}

/**
 * Rank the deferred tools against a search. Name hits weigh 3, description hits 1;
 * tools that score zero are dropped; ties keep the order opencode sent them in.
 */
export function searchTools(query: string, deferred: readonly ToolDef[], limit = 5): ToolDef[] {
  const normalised = query.trim().toLowerCase();
  if (!normalised) return [];
  const queryWords = [...new Set(words(normalised))];

  return deferred
    .map((tool, index) => ({ tool, index, score: scoreTool(normalised, queryWords, tool) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.tool);
}

/**
 * The message sent back to M365 with a search's matches. It reads as a tool result,
 * and each match is written exactly as the `<tools>` block would write it.
 */
export function renderSearchResult(query: string, matches: readonly ToolDef[], totalDeferred: number): string {
  if (matches.length === 0) {
    return `No tool matched "${query}". Try other words: ${totalDeferred} tools are available.`;
  }
  const lines = [`<tool_response tool="${MCP_TOOL_NAME}">`, `Tools matching "${query}":`, ""];
  for (const tool of matches) lines.push(...describeTool(tool), "");
  lines.push("To use one, reply with its block.", "</tool_response>");
  return lines.join("\n");
}
