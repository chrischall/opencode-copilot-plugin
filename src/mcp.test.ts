import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type CatalogTool, parseCodeModeCatalog } from "./codemode.js";
import { describeTool, parseToolCalls } from "./fenced.js";
import {
  MCP_TOOL_NAME,
  argumentNames,
  callCode,
  executeCodeToMcp,
  mcpTool,
  parseMcpBlock,
  renderInvalidMcpBlock,
  renderMcpFence,
  renderSearchResult,
  renderUnknownTool,
  resolveCallPath,
  searchCatalog,
  searchCode,
  summariseCatalog,
} from "./mcp.js";

const fixture = (name: string) => readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), "utf8");
const catalog = parseCodeModeCatalog(fixture("opencode2-codemode.txt"))!.tools;
const byName = (name: string) => catalog.find((tool) => tool.name === name)!;

function entry(namespace: string, name: string, description = "Does it"): CatalogTool {
  const path = `tools.${namespace}.${name}`;
  return { path, namespace, name, signature: `${path}({ id: string }): Promise<void> // ${description}`, description };
}

describe("mcpTool", () => {
  it("is a function tool named mcp with optional search and call parameters", () => {
    const def = mcpTool(catalog, false);
    expect(MCP_TOOL_NAME).toBe("mcp");
    expect(def.type).toBe("function");
    expect(def.function.name).toBe("mcp");
    expect(Object.keys(def.function.parameters?.properties ?? {})).toEqual(["search", "call"]);
    expect(def.function.parameters?.properties?.search?.type).toBe("string");
    expect(def.function.parameters?.properties?.call?.type).toBe("string");
    expect(def.function.parameters?.required ?? []).toEqual([]);
  });

  it("says how many tools there are, and that a search shows how to call them, on its one line", () => {
    const line = describeTool(mcpTool(catalog, false))[0] ?? "";
    expect(line).toContain(String(catalog.length));
    expect(line.toLowerCase()).toContain("search");
    expect(line.toLowerCase()).toContain("how to call");
  });

  it("summarises the tools by namespace, in catalogue order", () => {
    const line = describeTool(mcpTool(catalog, false))[0] ?? "";
    expect(line).toContain("github (create_issue, search-code, list_pull_requests)");
    expect(line).toContain("slack (post_message)");
    expect(line).toContain("opencode (list_mcp_resources, models, read_mcp_resource, session_move, +4 more)");
    expect(line.indexOf("opencode")).toBeLessThan(line.indexOf("github"));
  });

  it("lists at most eight namespaces, then how many more", () => {
    const many = Array.from({ length: 11 }, (_, i) => entry(`srv${i}`, "do"));
    const line = describeTool(mcpTool(many, false))[0] ?? "";
    expect(line).toContain("srv7 (do)");
    expect(line).not.toContain("srv8");
    expect(line).toContain("and 3 more servers");
  });

  it("says there are more tools than listed when the catalogue is partial", () => {
    const complete = mcpTool(catalog, false).function.description ?? "";
    const partial = mcpTool(catalog, true).function.description ?? "";
    expect(complete).not.toMatch(/not listed/i);
    expect(partial).toMatch(/more not listed/i);
    expect(describeTool(mcpTool(catalog, true))[0]).toMatch(/more not listed/i);
  });

  it("keeps the description on one line with no sentence break", () => {
    for (const partial of [false, true]) {
      const description = mcpTool(catalog, partial).function.description ?? "";
      expect(description).not.toContain("\n");
      expect(description).not.toContain(". ");
    }
  });
});

describe("summariseCatalog", () => {
  it("shows at most four tools per namespace, then how many more", () => {
    const many = Array.from({ length: 7 }, (_, i) => entry("jira", `tool${i}`));
    expect(summariseCatalog(many)).toBe("jira (tool0, tool1, tool2, tool3, +3 more)");
  });
});

describe("searchCatalog", () => {
  it("ranks a name hit above a description-only hit", () => {
    const tools = [entry("slack", "post_message", "Post a message, for example to report a new issue"), byName("create_issue")];
    const names = searchCatalog("create issue", tools).map((tool) => tool.name);
    expect(names).toEqual(["create_issue", "post_message"]);
  });

  it("splits camelCase and hyphenated names into words", () => {
    expect(searchCatalog("ticket", [entry("linear", "createTicket"), byName("create_issue")]).map((t) => t.name)).toEqual([
      "createTicket",
    ]);
    expect(searchCatalog("code", catalog)[0]?.path).toBe('tools.github["search-code"]');
  });

  it("weights the namespace like a name word", () => {
    const names = searchCatalog("slack", catalog).map((tool) => tool.name);
    expect(names[0]).toBe("post_message");
  });

  it("is case-insensitive and ignores one-letter words", () => {
    expect(searchCatalog("a PULL", catalog).map((tool) => tool.name)).toEqual(["list_pull_requests"]);
  });

  it("breaks score ties by catalogue order", () => {
    const tools = [entry("github", "list_issues"), entry("jira", "list_issues")];
    expect(searchCatalog("issues", tools).map((tool) => tool.namespace)).toEqual(["github", "jira"]);
  });

  it("drops tools that do not match, and caps at the limit", () => {
    expect(searchCatalog("calendar event", catalog)).toEqual([]);
    const many = Array.from({ length: 9 }, (_, i) => entry("srv", `widget_${i}`, "Manage a widget"));
    expect(searchCatalog("widget", many)).toHaveLength(5);
    expect(searchCatalog("widget", many, 2).map((tool) => tool.name)).toEqual(["widget_0", "widget_1"]);
  });

  it("puts an exact name or path first", () => {
    expect(searchCatalog("list_pull_requests", catalog)[0]?.name).toBe("list_pull_requests");
    expect(searchCatalog("tools.slack.post_message", catalog)[0]?.name).toBe("post_message");
    expect(searchCatalog('tools.github["search-code"]', catalog)[0]?.name).toBe("search-code");
    expect(searchCatalog("github_create_issue", catalog)[0]?.name).toBe("create_issue");
    expect(searchCatalog("github.create_issue", catalog)[0]?.name).toBe("create_issue");
  });

  it("lists a namespace's tools when the query is its prefix", () => {
    for (const query of ["github_", "github.", "tools.github"]) {
      expect(searchCatalog(query, catalog).map((tool) => tool.name)).toEqual([
        "create_issue",
        "search-code",
        "list_pull_requests",
      ]);
    }
  });

  it("returns nothing for an empty query", () => {
    expect(searchCatalog("", catalog)).toEqual([]);
    expect(searchCatalog("   ", catalog)).toEqual([]);
  });
});

describe("argumentNames", () => {
  it("lists the top-level parameters of a signature, skipping doc comments", () => {
    expect(argumentNames(byName("create_issue").signature)).toEqual(["owner", "repo", "title", "body"]);
    expect(argumentNames(byName("list_pull_requests").signature)).toEqual(["owner", "repo"]);
    expect(argumentNames(byName("search-code").signature)).toEqual(["q"]);
  });

  it("does not let a function type's => close the parameter list", () => {
    expect(argumentNames("function f(params: { cb: (x: string) => void, after: number }): void")).toEqual(["cb", "after"]);
  });

  it("returns nothing for a tool with no parameters", () => {
    expect(argumentNames(byName("worktree_list").signature)).toEqual([]);
  });
});

describe("renderSearchResult", () => {
  it("reads as a tool response with each match's signature verbatim", () => {
    const matches = [byName("create_issue"), byName("search-code")];
    const text = renderSearchResult("issue", matches, catalog.length);
    expect(text.startsWith(`<tool_response tool="mcp">`)).toBe(true);
    expect(text.trimEnd().endsWith("</tool_response>")).toBe(true);
    expect(text).toContain('Tools matching "issue":');
    for (const match of matches) expect(text).toContain(match.signature);
  });

  it("shows how to call the first match, with its parameters", () => {
    const text = renderSearchResult("issue", [byName("create_issue")], catalog.length);
    expect(text).toContain("```mcp\ncall: tools.github.create_issue\n{");
    expect(text).toContain('"owner": "..."');
    expect(text).toContain('"body": "..."');
  });

  it("returns a short plain line when nothing matches", () => {
    const text = renderSearchResult("calendar", [], 42);
    expect(text.toLowerCase()).toContain("no tool matched");
    expect(text).toContain("calendar");
    expect(text).toContain("42");
    expect(text).not.toContain("```");
  });
});

describe("parseMcpBlock", () => {
  it("reads a search", () => {
    expect(parseMcpBlock("search: create an issue")).toEqual({ kind: "search", query: "create an issue" });
  });

  it("reads a bare line as a search", () => {
    expect(parseMcpBlock("post to slack\n")).toEqual({ kind: "search", query: "post to slack" });
  });

  it("reads a call with a JSON body", () => {
    expect(parseMcpBlock('call: tools.github.create_issue\n{"owner": "o", "repo": "r", "title": "t"}')).toEqual({
      kind: "call",
      path: "tools.github.create_issue",
      args: { owner: "o", repo: "r", title: "t" },
    });
  });

  it("reads a call with a multi-line JSON body", () => {
    expect(parseMcpBlock('call: tools.slack.post_message\n{\n  "channel": "#x",\n  "text": "a\\nb"\n}')).toMatchObject({
      args: { channel: "#x", text: "a\nb" },
    });
  });

  it("reads a call with header arguments, coercing JSON scalars", () => {
    expect(parseMcpBlock("call: tools.opencode.models\nquery: gpt\nlimit: 5\nall: true\nprovider: null\nname: \"x y\"")).toEqual({
      kind: "call",
      path: "tools.opencode.models",
      args: { query: "gpt", limit: 5, all: true, provider: null, name: "x y" },
    });
  });

  it("keeps header values that are not JSON numbers as strings", () => {
    expect(
      parseMcpBlock("call: tools.opencode.models\nzip: 02134\nid: 0x1F\nbin: 0b11\nsp: 1_000\ninf: Infinity\ndot: .5\nplus: +3\nneg: -1.5e3"),
    ).toEqual({
      kind: "call",
      path: "tools.opencode.models",
      args: { zip: "02134", id: "0x1F", bin: "0b11", sp: "1_000", inf: "Infinity", dot: ".5", plus: "+3", neg: -1500 },
    });
  });

  it("reads a call with no arguments", () => {
    expect(parseMcpBlock("call: tools.opencode.worktree_list")).toEqual({
      kind: "call",
      path: "tools.opencode.worktree_list",
      args: {},
    });
  });

  it("reads a bracket-notation path, and tolerates backticks and a JS-style call", () => {
    expect(parseMcpBlock('call: `tools.github["search-code"]`\n{"q": "x"}')).toMatchObject({
      path: 'tools.github["search-code"]',
      args: { q: "x" },
    });
    expect(parseMcpBlock('call: tools.github.list_pull_requests({"owner": "o", "repo": "r"})')).toEqual({
      kind: "call",
      path: "tools.github.list_pull_requests",
      args: { owner: "o", repo: "r" },
    });
  });

  it("says what is wrong with a body it cannot read", () => {
    expect(parseMcpBlock('call: tools.github.create_issue\n{"owner": ')).toMatchObject({ kind: "invalid" });
    expect(parseMcpBlock("call: tools.github.create_issue\n[1, 2]")).toMatchObject({ kind: "invalid" });
    expect(parseMcpBlock("call: tools.github.create_issue\nnot a header line")).toMatchObject({ kind: "invalid" });
    expect(parseMcpBlock("call:")).toMatchObject({ kind: "invalid" });
    expect(parseMcpBlock("")).toMatchObject({ kind: "invalid" });
  });

  it("reads the body the fenced parser leaves out of an mcp block", () => {
    // The fenced parser keeps only header lines for the mcp tool; the raw body is ours.
    const reply = '```mcp\ncall: tools.slack.post_message\n{"channel": "#x", "text": "hi"}\n```';
    const parsed = parseToolCalls(reply, [mcpTool(catalog, false)]);
    expect(parsed.toolCalls[0]?.arguments).toEqual({ call: "tools.slack.post_message" });
  });
});

describe("resolveCallPath", () => {
  it("accepts a catalogued path as written", () => {
    expect(resolveCallPath("tools.github.create_issue", catalog, false)).toBe("tools.github.create_issue");
    expect(resolveCallPath('tools.github["search-code"]', catalog, false)).toBe('tools.github["search-code"]');
  });

  it("maps the shorthand forms models write onto the catalogued path", () => {
    expect(resolveCallPath("github.create_issue", catalog, false)).toBe("tools.github.create_issue");
    expect(resolveCallPath("github_create_issue", catalog, false)).toBe("tools.github.create_issue");
    expect(resolveCallPath("tools.github.search-code", catalog, false)).toBe('tools.github["search-code"]');
  });

  it("refuses an uncatalogued path when the catalogue is complete", () => {
    expect(resolveCallPath("tools.github.delete_repo", catalog, false)).toBeUndefined();
    expect(resolveCallPath("process.exit", catalog, false)).toBeUndefined();
  });

  it("accepts any well-formed tools path when the catalogue is partial", () => {
    expect(resolveCallPath("tools.jira.create_ticket", catalog, true)).toBe("tools.jira.create_ticket");
    expect(resolveCallPath('tools.jira["make-it"]', catalog, true)).toBe('tools.jira["make-it"]');
  });

  it("never accepts something that is not a plain tools path", () => {
    for (const path of ["tools", "tools.x;process.exit()", 'tools["a"]+1', "require('fs')", "tools.a.b()"]) {
      expect(resolveCallPath(path, catalog, true)).toBeUndefined();
    }
  });
});

describe("execute code templates", () => {
  it("writes a call and a search as the code execute runs", () => {
    expect(callCode("tools.github.create_issue", { owner: "o" })).toBe(
      'return await tools.github.create_issue({"owner":"o"});',
    );
    expect(searchCode('post "now"')).toBe('return await search("post \\"now\\"");');
  });

  it("reads its own templates back", () => {
    const args = { owner: "o", nested: { a: [1, "x"] } };
    expect(executeCodeToMcp(callCode('tools.github["search-code"]', args))).toEqual({
      kind: "call",
      path: 'tools.github["search-code"]',
      args,
    });
    expect(executeCodeToMcp(searchCode("a\nb"))).toEqual({ kind: "search", query: "a\nb" });
  });

  it("leaves code it did not write alone", () => {
    expect(executeCodeToMcp("console.log(1)")).toBeUndefined();
    expect(executeCodeToMcp("return await tools.a.b(1);")).toBeUndefined();
    expect(executeCodeToMcp("return await tools.a.b({});\nreturn 2;")).toBeUndefined();
    expect(executeCodeToMcp(undefined)).toBeUndefined();
  });

  it("renders a request back as the mcp fence the model wrote, which parses to the same request", () => {
    const call = { kind: "call" as const, path: "tools.slack.post_message", args: { channel: "#x", text: "a\nb" } };
    const fence = renderMcpFence(call);
    expect(fence).toBe('```mcp\ncall: tools.slack.post_message\n{"channel":"#x","text":"a\\nb"}\n```');
    expect(parseMcpBlock(fence.slice("```mcp\n".length, -"\n```".length))).toEqual(call);

    expect(renderMcpFence({ kind: "call", path: "tools.opencode.worktree_list", args: {} })).toBe(
      "```mcp\ncall: tools.opencode.worktree_list\n```",
    );
    expect(renderMcpFence({ kind: "search", query: "slack" })).toBe("```mcp\nsearch: slack\n```");
  });
});

describe("proxy answers", () => {
  it("tells the model to search first for an unknown tool", () => {
    const text = renderUnknownTool("tools.github.delete_repo");
    expect(text.startsWith(`<tool_response tool="mcp">`)).toBe(true);
    expect(text).toContain("tools.github.delete_repo");
    expect(text.toLowerCase()).toContain("search");
  });

  it("shows the expected shape for a block it could not read", () => {
    const text = renderInvalidMcpBlock("the body is not a JSON object");
    expect(text).toContain("the body is not a JSON object");
    expect(text).toContain("```mcp\ncall: tools.");
    expect(text).toContain("search: ");
  });
});

describe("parseMcpBlock header names", () => {
  it("takes a header named invalid as an ordinary argument", () => {
    expect(parseMcpBlock("call: tools.a.b\ninvalid: yes")).toEqual({ kind: "call", path: "tools.a.b", args: { invalid: "yes" } });
  });
});
