import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOCAL_TITLE_MODEL, MODEL_ALIASES, listModelIds, resolveModel } from "./models.js";
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

/** The `| \`id\` |` first cells of every table row in a piece of markdown. */
function firstCellIds(markdown: string): string[] {
  return [...markdown.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1] ?? "");
}

/** The text of one `### ` subsection, up to the next `## ` or `### ` heading. */
function subsection(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n### ${heading}\n`);
  if (start < 0) return "";
  const rest = markdown.slice(start + 1);
  const end = rest.slice(1).search(/\n##+ /);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

describe("docs for the model catalogue", () => {
  const models = section(readme, "Models");

  it("has a model table with one row for every advertised model", () => {
    const table = subsection(readme, "Every model");
    const rows = firstCellIds(table);
    for (const id of listModelIds()) expect(rows, id).toContain(id);
    expect(rows.filter((id) => !listModelIds().includes(id))).toEqual([]);
  });

  it("points the model table's cost column at the cost section", () => {
    expect(subsection(readme, "Every model")).toContain("(#what-it-costs)");
  });

  it("lists every alias in the alias table, against its canonical id", () => {
    for (const [alias, canonical] of Object.entries(MODEL_ALIASES)) {
      expect(models, alias).toMatch(new RegExp(`^\\|[^\\n]*\`${alias.replace(/\./g, "\\.")}\`[^\\n]*\\| \`${canonical.replace(/\./g, "\\.")}\` \\|$`, "m"));
    }
  });

  it("explains the paid scenario, the two refusals, the Claude change, Sol learning and M365_FORCE_AGENT", () => {
    expect(models).toContain("OfficeWebPaidCopilot");
    expect(models).toMatch(/premium/i);
    expect(models).toContain("premium_licence_required");
    expect(models).toContain("priority_access_exhausted");
    expect(models).toContain("M365_FORCE_AGENT=0");
    expect(models).toContain("M365_FORCE_AGENT=1");
    expect(models).toMatch(/claude-sonnet-think-deeper/);
    expect(models).toMatch(/not (been )?measured/);
    expect(models).not.toMatch(/Claude tones stay on the agent/);
  });
});

describe("docs for what it costs", () => {
  const costs = section(readme, "What it costs");

  it("is its own section, right after Models", () => {
    const headings = [...readme.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings.indexOf("What it costs")).toBe(headings.indexOf("Models") + 1);
  });

  it("has one row for every advertised model and none for an alias", () => {
    const rows = firstCellIds(costs);
    for (const id of listModelIds()) expect(rows, id).toContain(id);
    for (const alias of Object.keys(MODEL_ALIASES)) expect(rows, alias).not.toContain(alias);
  });

  it("marks the credit-billed and metered models from the catalogue", () => {
    const row = (id: string) => costs.split("\n").find((line) => line.startsWith(`| \`${id}\` |`)) ?? "";
    for (const id of listModelIds()) {
      const model = resolveModel(id);
      if (model.credits) expect(row(id), id).toMatch(/Copilot credits/);
      if (model.metered) expect(row(id), id).toMatch(/priority access/i);
      if (model.scenario === "paid") expect(row(id), id).toMatch(/paid scenario/);
    }
    expect(row(LOCAL_TITLE_MODEL)).toMatch(/no M365 call/);
  });

  it("gives the reference project's figures and cites it", () => {
    for (const figure of ["40 turns a day and 75 a week", "80 a day and 150 a week", "600 user messages", "midnight UTC", "PremiumModelsInM365Chat", "billing_info", "15 minutes"]) {
      expect(costs, figure).toContain(figure);
    }
    expect(costs).toContain("m365-copilot-api.md");
    expect(costs).toMatch(/GPT-6\.1 Sol/);
  });
});
