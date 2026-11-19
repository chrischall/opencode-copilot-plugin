import { describe, expect, it } from "vitest";
import { describeTool, type ToolDef } from "./fenced.js";
import { deferredMcpTool, renderDeferredSearchResult, searchTools } from "./mcp.js";

function tool(name: string, description: string, properties: Record<string, { type: string }> = {}): ToolDef {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required: Object.keys(properties) },
    },
  };
}

const createIssue = tool("github_create_issue", "Create a new issue in a GitHub repository", {
  owner: { type: "string" },
  repo: { type: "string" },
  title: { type: "string" },
});
const listIssues = tool("github_list_issues", "List issues in a GitHub repository", {
  owner: { type: "string" },
  repo: { type: "string" },
});
const searchCode = tool("github_searchCode", "Search code across repositories", { query: { type: "string" } });
const slackPost = tool("slack_post_message", "Post a message to a channel, for example to report a new issue", {
  channel: { type: "string" },
  text: { type: "string" },
});
const linearCreate = tool("linear_createTicket", "Open a ticket in Linear", { title: { type: "string" } });

const deferred = [slackPost, createIssue, listIssues, searchCode, linearCreate];

describe("deferredMcpTool (until the proxy wiring moves to the catalogue)", () => {
  it("is a function tool named mcp with one required string search parameter", () => {
    const def = deferredMcpTool(deferred);
    expect(def.type).toBe("function");
    expect(def.function.name).toBe("mcp");
    expect(def.function.parameters?.properties?.search?.type).toBe("string");
    expect(def.function.parameters?.required).toEqual(["search"]);
    expect(Object.keys(def.function.parameters?.properties ?? {})).toEqual(["search"]);
  });

  it("says how many tools can be found and that a search shows how to call them", () => {
    const description = deferredMcpTool(deferred).function.description ?? "";
    expect(description).toContain("5");
    expect(description.toLowerCase()).toContain("search");
    expect(description.toLowerCase()).toContain("how to call");
  });

  it("keeps the count and the how-to in the one line the tool block shows", () => {
    // The tool block shows only a description's first sentence.
    const line = describeTool(deferredMcpTool(deferred))[0] ?? "";
    expect(line).toContain("5");
    expect(line.toLowerCase()).toContain("how to call");
  });

  it("summarises the tools by server, in the one line the tool block shows", () => {
    const line = describeTool(deferredMcpTool(deferred))[0] ?? "";
    expect(line).toContain("github (create_issue, list_issues, searchCode)");
    expect(line).toContain("slack (post_message)");
    expect(line).toContain("linear (createTicket)");
    // Servers in the order they were offered.
    expect(line.indexOf("slack")).toBeLessThan(line.indexOf("github"));
  });

  it("shows at most four tools per server, then how many more", () => {
    const many = Array.from({ length: 7 }, (_, i) => tool(`jira_tool${i}`, "Jira"));
    const line = describeTool(deferredMcpTool(many))[0] ?? "";
    expect(line).toContain("jira (tool0, tool1, tool2, tool3, +3 more)");
  });

  it("lists at most eight servers, then how many more", () => {
    const servers = Array.from({ length: 11 }, (_, i) => tool(`srv${i}_do`, "Does it"));
    const line = describeTool(deferredMcpTool(servers))[0] ?? "";
    expect(line).toContain("srv7 (do)");
    expect(line).not.toContain("srv8");
    expect(line).toContain("and 3 more servers");
  });

  it("groups a name with no server prefix under its own name", () => {
    const line = describeTool(deferredMcpTool([tool("standalone", "x")]))[0] ?? "";
    expect(line).toContain("standalone");
    expect(line).toMatch(/\b1 more tool\b/);
  });

  it("keeps the summary on one line with no sentence break, so none of it is cut", () => {
    const description = deferredMcpTool(deferred).function.description ?? "";
    expect(description).not.toContain("\n");
    expect(description).not.toContain(". ");
  });
});

describe("searchTools", () => {
  it("ranks a name hit above a description-only hit", () => {
    const matches = searchTools("create issue", deferred);
    const names = matches.map((t) => t.function.name);
    expect(names[0]).toBe("github_create_issue");
    // slack_post_message only mentions "issue" in its description.
    expect(names).toContain("slack_post_message");
    expect(names.indexOf("github_create_issue")).toBeLessThan(names.indexOf("slack_post_message"));
  });

  it("splits camelCase names into words", () => {
    const names = searchTools("ticket", deferred).map((t) => t.function.name);
    expect(names).toEqual(["linear_createTicket"]);
  });

  it("is case-insensitive and ignores one-letter words", () => {
    const names = searchTools("a CODE", deferred).map((t) => t.function.name);
    expect(names).toEqual(["github_searchCode"]);
  });

  it("breaks score ties by the original order", () => {
    const names = searchTools("issues", [listIssues, tool("jira_list_issues", "List issues")]).map(
      (t) => t.function.name,
    );
    expect(names).toEqual(["github_list_issues", "jira_list_issues"]);
  });

  it("drops tools that do not match", () => {
    expect(searchTools("calendar event", deferred)).toEqual([]);
  });

  it("caps the result at the limit", () => {
    const many = Array.from({ length: 9 }, (_, i) => tool(`srv_widget_${i}`, "Manage a widget"));
    expect(searchTools("widget", many)).toHaveLength(5);
    expect(searchTools("widget", many, 2).map((t) => t.function.name)).toEqual(["srv_widget_0", "srv_widget_1"]);
  });

  it("matches a query equal to a tool's full name", () => {
    expect(searchTools("github_list_issues", deferred)[0]?.function.name).toBe("github_list_issues");
    expect(searchTools("GitHub_List_Issues", deferred)[0]?.function.name).toBe("github_list_issues");
  });

  it("lists a server's tools when the query is its prefix", () => {
    const names = searchTools("github_", deferred).map((t) => t.function.name);
    expect(names).toEqual(["github_create_issue", "github_list_issues", "github_searchCode"]);
  });

  it("returns nothing for an empty query", () => {
    expect(searchTools("", deferred)).toEqual([]);
    expect(searchTools("   ", deferred)).toEqual([]);
  });
});

describe("renderDeferredSearchResult", () => {
  it("names the query and includes each match's fence template", () => {
    const text = renderDeferredSearchResult("create issue", [createIssue, listIssues], 5);
    expect(text).toContain('Tools matching "create issue":');
    expect(text).toContain("```github_create_issue");
    expect(text).toContain("```github_list_issues");
    for (const match of [createIssue, listIssues]) {
      expect(text).toContain(describeTool(match).join("\n"));
    }
    expect(text.toLowerCase()).toContain("block");
  });

  it("reads as a tool response", () => {
    const text = renderDeferredSearchResult("create issue", [createIssue], 5);
    expect(text.startsWith("<tool_response")).toBe(true);
    expect(text.trimEnd().endsWith("</tool_response>")).toBe(true);
  });

  it("returns a short plain line when nothing matches", () => {
    const text = renderDeferredSearchResult("calendar", [], 42);
    expect(text).toContain("calendar");
    expect(text).toContain("42");
    expect(text.toLowerCase()).toContain("no tool matched");
    expect(text).not.toContain("```");
    expect(text.split("\n").filter((l) => l.trim()).length).toBeLessThanOrEqual(3);
  });
});
