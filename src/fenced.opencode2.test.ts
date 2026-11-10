/**
 * The parser against opencode 2's real tools, fed the reply shapes M365 actually
 * writes. Each case lost the call, or ran the wrong thing, before it was handled.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildToolPrompt, parseToolCalls, renderToolCall, type ToolDef } from "./fenced.js";

// The lean toolset from a captured opencode 2.2.5 request.
const tools: ToolDef[] = JSON.parse(
  readFileSync(new URL("../test/fixtures/opencode2-lean-tools.json", import.meta.url), "utf8"),
);

const T = "```";
const call = (reply: string) => {
  const { toolCalls } = parseToolCalls(reply, tools);
  expect(toolCalls, "expected a tool call").toHaveLength(1);
  return { name: toolCalls[0]!.name, args: toolCalls[0]!.arguments };
};

describe("the body parameter written as a header line", () => {
  it("takes `command:` in a shell block as the command, not a literal line to run", () => {
    // Seen live: `command: python3 test_calc.py` ran as-is and failed.
    expect(call(`${T}bash\ncommand: python3 test_calc.py\n${T}`)).toEqual({
      name: "shell",
      args: { command: "python3 test_calc.py" },
    });
  });

  it("takes it after other headers too", () => {
    expect(call(`${T}shell\nworkdir: /tmp\ncommand: ls -la\n${T}`).args).toEqual({ workdir: "/tmp", command: "ls -la" });
  });

  it("keeps the rest of a multi-line command after a `command:` line", () => {
    expect(call(`${T}bash\ncommand: cd src\nls\n${T}`).args).toEqual({ command: "cd src\nls" });
  });

  it("reads a one-line `pattern:` or `content:` header as that argument", () => {
    expect(call(`${T}grep\npattern: TOKEN-\npath: .\n${T}`).args).toEqual({ pattern: "TOKEN-", path: "." });
    expect(call(`${T}write\npath: a.txt\ncontent: hello\n${T}`).args).toEqual({ path: "a.txt", content: "hello" });
  });

  it("leaves file content that merely starts with `content:` as content", () => {
    const { args } = call(`${T}write\npath: notes.md\ncontent: first line\nsecond line\n${T}`);
    expect(args.content).toBe("content: first line\nsecond line");
  });

  it("does not take a shell line that only contains a colon as a header", () => {
    expect(call(`${T}bash\necho 'note: hi'\n${T}`).args).toEqual({ command: "echo 'note: hi'" });
  });
});

describe("arguments under another name", () => {
  it.each(["filePath", "file_path", "file", "filename"])("maps %s to opencode 2's path", (alias) => {
    expect(call(`${T}read\n${alias}: calc.py\n${T}`).args).toEqual({ path: "calc.py" });
  });

  it("takes a bare line as the one required argument when the tool has no body", () => {
    expect(call(`${T}read\ncalc.py\n${T}`).args).toEqual({ path: "calc.py" });
  });

  it("accepts an edit written as oldString/newString headers", () => {
    expect(call(`${T}edit\npath: s.py\noldString: PORT = 8080\nnewString: PORT = 9090\n${T}`).args).toEqual({
      path: "s.py",
      oldString: "PORT = 8080",
      newString: "PORT = 9090",
    });
  });

  it("still reads the SEARCH/REPLACE form", () => {
    const body = "path: s.py\n<<<<<<< SEARCH\nPORT = 8080\n=======\nPORT = 9090\n>>>>>>> REPLACE";
    expect(call(`${T}edit\n${body}\n${T}`).args).toEqual({ path: "s.py", oldString: "PORT = 8080", newString: "PORT = 9090" });
  });
});

describe("header values written loosely", () => {
  it.each([
    ['"calc.py"', "quotes"],
    ["`calc.py`", "backticks"],
    ["'calc.py'", "single quotes"],
  ])("strips %s (%s)", (value) => {
    expect(call(`${T}read\npath: ${value}\n${T}`).args).toEqual({ path: "calc.py" });
  });

  it("drops an echoed (optional) marker", () => {
    expect(call(`${T}read\npath: calc.py\noffset: 1   (optional)\n${T}`).args).toEqual({ path: "calc.py", offset: 1 });
  });

  it("treats an echoed <placeholder> as no value", () => {
    expect(call(`${T}read\npath: <string>\n${T}`).args).toEqual({});
  });

  it("tolerates a space before the colon", () => {
    expect(call(`${T}Read\npath : calc.py\n${T}`).args).toEqual({ path: "calc.py" });
  });

  it("lets a header key appear only once, so file content cannot redirect the write", () => {
    const { args } = call(`${T}write\npath: cfg.yml\npath: /usr/bin\nname: x\n${T}`);
    expect(args).toEqual({ path: "cfg.yml", content: "path: /usr/bin\nname: x" });
  });
});

describe("bodies", () => {
  it("strips a shell prompt the model copied in", () => {
    expect(call(`${T}bash\n$ python3 test_calc.py\n${T}`).args).toEqual({ command: "python3 test_calc.py" });
  });

  it("keeps the first line's indentation in written content", () => {
    expect(call(`${T}write\npath: a.yml\n  - x\n  - y\n\n${T}`).args.content).toBe("  - x\n  - y");
  });
});

describe("whole replies", () => {
  it("reads Windows line endings", () => {
    expect(call(`${T}bash\r\nls -la\r\n${T}\r\n`).args).toEqual({ command: "ls -la" });
  });

  it("treats a reply that opens with a tool block as an action, whatever prose follows", () => {
    const reply =
      `${T}bash\npython3 test_calc.py\n${T}\n\n` +
      "This runs the test against the corrected implementation so we can confirm the assertion now holds, " +
      "and if it does not we will look again.\n\n" +
      `${T}text\nPASS\n${T}`;
    expect(call(reply)).toEqual({ name: "shell", args: { command: "python3 test_calc.py" } });
  });

  it("ignores a tool result the model wrote for itself", () => {
    const reply =
      `${T}bash\ncat calc.py\n${T}\n\n<tool_response tool="shell">\ndef add(a, b):\n    return a - b\n</tool_response>\n\n` +
      `The bug is the minus sign. Fixing it now:\n\n${T}edit\npath: calc.py\noldString: a - b\nnewString: a + b\n${T}`;
    expect(call(reply)).toEqual({ name: "shell", args: { command: "cat calc.py" } });
  });

  it("still answers in prose when the reply is a document, not an action", () => {
    const reply =
      "Here is a README you could use. It covers installation, configuration and the common commands people ask about.\n\n" +
      `${T}bash\nnpm install\n${T}\n\nThen configure it:\n\n${T}bash\nnpm run setup\n${T}`;
    expect(parseToolCalls(reply, tools).toolCalls).toHaveLength(0);
  });
});

describe("what the parser set aside", () => {
  it("counts the calls after the first that will not run", () => {
    const reply = `${T}read\npath: a.py\n${T}\n\n${T}read\npath: b.py\n${T}\n\n${T}bash\npython3 t.py\n${T}`;
    const result = parseToolCalls(reply, tools);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.skippedCalls).toBe(2);
  });

  it("notes a tool result the model wrote for itself", () => {
    const reply = `${T}bash\ncat a.py\n${T}\n<tool_response>\nprint(1)\n</tool_response>`;
    expect(parseToolCalls(reply, tools).inventedResult).toBe(true);
  });

  it("reports nothing set aside for a single clean call", () => {
    const result = parseToolCalls(`${T}read\npath: a.py\n${T}`, tools);
    expect(result.skippedCalls).toBe(0);
    expect(result.inventedResult).toBe(false);
  });
});

describe("rendering a past call back into a fence", () => {
  it.each([
    ["shell", { command: "python3 test_calc.py", workdir: "/tmp/w" }],
    ["read", { path: "calc.py", offset: 3 }],
    ["edit", { path: "s.py", oldString: "PORT = 8080", newString: "PORT = 9090" }],
    ["write", { path: "a.txt", content: "line one\nline two" }],
  ])("writes a %s call the parser reads back as the same call", (name, args) => {
    const fence = renderToolCall(name, JSON.stringify(args), tools);
    expect(call(fence)).toEqual({ name, args });
  });

  it("falls back to plain JSON for a tool it does not know", () => {
    expect(renderToolCall("todo", '{"x":1}', tools)).toContain('{"x":1}');
  });
});

describe("the relay framing", () => {
  const relay = buildToolPrompt(tools, { framing: "relay" });

  it("asks, in the user's voice, to be guided one command at a time", () => {
    expect(relay).toMatch(/guide me through this from my terminal, one command at a time/);
    expect(relay).toMatch(/paste the real output back/);
    expect(relay).not.toMatch(/You are working in a real workspace/);
  });

  it("still lists every tool as a fence", () => {
    for (const name of ["edit", "grep", "read", "shell", "write"]) expect(relay).toContain("```" + name);
  });

  it("names the sandbox only when told which one the model has", () => {
    expect(relay).not.toMatch(/\/home\/claude/);
    expect(buildToolPrompt(tools, { framing: "relay", sandbox: "bash_tool, create_file, … in /home/claude" })).toMatch(
      /\/home\/claude/,
    );
  });

  it("is softer than the default, not louder", () => {
    expect(relay).not.toMatch(/\b(?:MUST|NEVER|ONLY|ALWAYS)\b/);
  });
});
