import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_MCP_SEARCHES } from "./server.js";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");

/** The text of one `## ` section, up to the next `## ` heading. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  if (start < 0) return "";
  const rest = markdown.slice(start + 1);
  const end = rest.indexOf("\n## ", 1);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("docs for the opt-in MCP tool search", () => {
  it("has an MCP tools section right after How tool calling works", () => {
    const headings = [...readme.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings.indexOf("MCP tools")).toBe(headings.indexOf("How tool calling works") + 1);
  });

  it("explains the opt-in, a fenced search, the cost and the cap", () => {
    const mcp = section(readme, "MCP tools");
    expect(mcp).toContain('"mcpProxy": true');
    expect(mcp).toContain("M365_MCP_PROXY=1");
    expect(mcp).toMatch(/```mcp\nsearch: /);
    expect(mcp).toContain(`${MAX_MCP_SEARCHES} searches`);
    expect(mcp).toMatch(/not (yet )?(been )?measured/);
  });

  it("explains Code Mode, the call and its body, and the partial catalogue", () => {
    const mcp = section(readme, "MCP tools");
    expect(mcp).toContain("Code Mode");
    expect(mcp).toContain("`execute`");
    expect(mcp).toMatch(/```mcp\ncall: tools\.github\.create_issue\n\{/);
    expect(mcp).toMatch(/```mcp\ncall: tools\.\w+\.\w+\n\w+: /);
    expect(mcp).toContain("return await tools.github.create_issue(");
    expect(mcp).toMatch(/partial/);
    expect(mcp).toContain("return await search(");
    expect(mcp).toContain("mcpCall");
  });

  it("no longer describes #109's per-tool fences or the lean-only restriction", () => {
    const mcp = section(readme, "MCP tools");
    expect(mcp).not.toContain("```github_create_issue");
    expect(mcp).not.toMatch(/only applies while `lean` is on/);
  });

  it("lists the option in the configuration block", () => {
    expect(section(readme, "Configuration")).toMatch(/"mcpProxy": false,\s*\/\//);
  });

  it("has layout rows for src/mcp.ts and src/codemode.ts", () => {
    expect(agents).toMatch(/^\| `src\/mcp\.ts` \|.*`execute`/m);
    expect(agents).toMatch(/^\| `src\/codemode\.ts` \|.*Code Mode/m);
  });
});
