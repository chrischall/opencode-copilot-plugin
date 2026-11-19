import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCodeModeCatalog, stripCodeModeSection } from "./codemode.js";

// opencode 2.2.5's Code Mode section as captured live (2026-11-19), plus synthetic
// `github` and `slack` namespaces in the same format. The github namespace has a
// bracket-notation name, a doc comment with a column-0 `# ` line and an unbalanced
// brace, and a string literal holding ` // `.
const fixture = (name: string) => readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), "utf8");
const complete = fixture("opencode2-codemode.txt");
const partial = fixture("opencode2-codemode-partial.txt");

const before = "You are opencode.\n\n# Your Model\n- Model ID: quick\n";
const after = "\nSkills provide specialized instructions and workflows for specific tasks.\n<env>\n  Working directory: /tmp/w\n</env>";
const wrap = (section: string) => `${before}${section}${after}`;

describe("parseCodeModeCatalog", () => {
  it("returns undefined when there is no Code Mode section", () => {
    expect(parseCodeModeCatalog("You are opencode.\n# Harness\n- be brief")).toBeUndefined();
  });

  it("finds every tool in every namespace, opencode's own included", () => {
    const catalog = parseCodeModeCatalog(wrap(complete))!;
    expect(catalog.tools.map((tool) => tool.path)).toEqual([
      "tools.opencode.list_mcp_resources",
      "tools.opencode.models",
      "tools.opencode.read_mcp_resource",
      "tools.opencode.session_move",
      "tools.opencode.session_rename",
      "tools.opencode.worktree_create",
      "tools.opencode.worktree_list",
      "tools.opencode.worktree_remove",
      "tools.github.create_issue",
      'tools.github["search-code"]',
      "tools.github.list_pull_requests",
      "tools.slack.post_message",
    ]);
  });

  it("splits each path into namespace and name, bracket notation included", () => {
    const tools = parseCodeModeCatalog(wrap(complete))!.tools;
    const searchCode = tools.find((tool) => tool.path === 'tools.github["search-code"]')!;
    expect(searchCode).toMatchObject({ namespace: "github", name: "search-code" });
    expect(tools.find((tool) => tool.name === "post_message")).toMatchObject({ namespace: "slack" });
    expect(tools.filter((tool) => tool.namespace === "opencode")).toHaveLength(8);
  });

  it("takes the description from the entry's final line", () => {
    const tools = parseCodeModeCatalog(wrap(complete))!.tools;
    const byName = (name: string) => tools.find((tool) => tool.name === name)!;
    expect(byName("create_issue").description).toBe("Create a new issue in a GitHub repository.");
    expect(byName("search-code").description).toBe("Search code across GitHub repositories.");
    expect(byName("list_pull_requests").description).toBe("List open pull requests in a repository.");
    expect(byName("list_mcp_resources").description).toMatch(/^List documents, records, .*\.\.\.$/);
    expect(byName("worktree_remove").description).toMatch(/^Remove a worktree\./);
  });

  it("keeps the whole entry verbatim as the signature, without the leading '- '", () => {
    const createIssue = parseCodeModeCatalog(wrap(complete))!.tools.find((tool) => tool.name === "create_issue")!;
    expect(createIssue.signature.startsWith("tools.github.create_issue({\n  /** Repository owner. */")).toBe(true);
    expect(createIssue.signature).toContain("# Steps to reproduce");
    expect(createIssue.signature.endsWith("}> // Create a new issue in a GitHub repository.")).toBe(true);
    const worktreeList = parseCodeModeCatalog(wrap(complete))!.tools.find((tool) => tool.name === "worktree_list")!;
    expect(worktreeList.signature).toBe(
      "tools.opencode.worktree_list(): Promise<{\n  worktrees: Array<{\n      directory: string,\n      strategy?: string,\n    }>,\n}> // List a repository's worktrees.",
    );
  });

  it("reports whether the catalogue is partial", () => {
    expect(parseCodeModeCatalog(wrap(complete))!.partial).toBe(false);
    expect(parseCodeModeCatalog(wrap(partial))!.partial).toBe(true);
    expect(parseCodeModeCatalog(wrap(partial))!.tools).toHaveLength(12);
  });

  it("bounds the section from its heading to the end of the catalogue", () => {
    const text = wrap(complete);
    const { section } = parseCodeModeCatalog(text)!;
    expect(section.start).toBe(before.length);
    expect(text.slice(section.start)).toMatch(/^# Code Mode\n/);
    expect(text.slice(section.start, section.end).trimEnd().endsWith("// Post a message to a Slack channel.")).toBe(true);
    expect(text.slice(section.end).trimStart()).toMatch(/^Skills provide /);
  });
});

describe("stripCodeModeSection", () => {
  it("removes the whole section and nothing around it", () => {
    const stripped = stripCodeModeSection(wrap(complete));
    expect(stripped).not.toMatch(/Code Mode|tools\.|execute|search-code|post_message/);
    expect(stripped).toContain("# Your Model\n- Model ID: quick");
    expect(stripped).toContain("Skills provide specialized instructions");
    expect(stripped).toContain("Working directory: /tmp/w");
  });

  it("is not cut short by a column-0 '# ' line inside a signature's doc comment", () => {
    const stripped = stripCodeModeSection(wrap(complete));
    expect(stripped).not.toContain("# Steps to reproduce");
    expect(stripped).not.toContain("tools.slack.post_message");
    expect(stripped).not.toContain("Post a message to a Slack channel.");
  });

  it("strips a partial catalogue the same way", () => {
    const stripped = stripCodeModeSection(wrap(partial));
    expect(stripped).not.toMatch(/Code Mode|catalog is partial|tools\./);
    expect(stripped).toContain("Skills provide");
  });

  it("strips a section that ends the text", () => {
    expect(stripCodeModeSection(`${before}${complete}`).trim()).toBe(before.trim());
  });

  it("leaves text without a Code Mode section unchanged", () => {
    const text = "You are opencode.\n# Harness\n- be brief";
    expect(stripCodeModeSection(text)).toBe(text);
  });
});
