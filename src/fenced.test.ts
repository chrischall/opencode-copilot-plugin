import { describe, expect, it } from "vitest";
import type { ToolDef } from "./fenced.js";
import {
  buildToolPrompt,
  findShellTool,
  isProseDocument,
  parseToolCalls,
  stripInventedJson,
} from "./fenced.js";

const readTool: ToolDef = {
  type: "function",
  function: {
    name: "read",
    description: "Read a file from disk",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Absolute path" },
        offset: { type: "number", description: "Start line" },
      },
      required: ["filePath"],
    },
  },
};

const bashTool: ToolDef = {
  type: "function",
  function: {
    name: "bash",
    description: "Run a shell command",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command" },
        timeout: { type: "number" },
      },
      required: ["command"],
    },
  },
};

const editTool: ToolDef = {
  type: "function",
  function: {
    name: "edit",
    description: "Replace exact text in a file",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        oldString: { type: "string" },
        newString: { type: "string" },
      },
      required: ["filePath", "oldString", "newString"],
    },
  },
};

const fence = (info: string, body: string) => "```" + info + "\n" + body + "\n```";

describe("shell tool detection", () => {
  it("finds a shell tool under any of the usual names", () => {
    for (const name of ["bash", "shell", "run", "run_command", "execute_command", "terminal"]) {
      const tool: ToolDef = { type: "function", function: { name, parameters: { type: "object", properties: {} } } };
      expect(findShellTool([tool])?.function.name).toBe(name);
    }
  });

  it("returns undefined when the toolset has no shell", () => {
    expect(findShellTool([readTool])).toBeUndefined();
  });
});

describe("tool prompt", () => {
  it("names every tool so the model knows what it may call", () => {
    const prompt = buildToolPrompt([readTool, bashTool]);
    expect(prompt).toContain("read");
    expect(prompt).toContain("bash");
  });

  it("shows each tool as a fenced template, since the fence IS the call", () => {
    const prompt = buildToolPrompt([readTool]);
    expect(prompt).toContain("```read");
  });

  it("renders scalar arguments as header lines", () => {
    const prompt = buildToolPrompt([readTool]);
    expect(prompt).toMatch(/filePath:/);
  });

  it("adds shell-first framing when a shell tool is present", () => {
    // This is the load-bearing lever: the model won't act as an agent on demand but
    // will reflexively write a ```bash block.
    const prompt = buildToolPrompt([readTool, bashTool]);
    expect(prompt.toLowerCase()).toContain("```bash");
  });

  it("omits shell framing when there is no shell tool to route to", () => {
    const prompt = buildToolPrompt([readTool]);
    expect(prompt).not.toContain("```bash");
  });

  it("tells the model it has not run anything yet", () => {
    // Anti-confabulation: the turn-1 reflex is "I can't access the files, paste them".
    const prompt = buildToolPrompt([readTool, bashTool]).toLowerCase();
    expect(prompt).toMatch(/have not|haven't|nothing yet/);
  });

  it("stays clear of jailbreak shapes that trip the Disengaged filter", () => {
    // The filter tracks prompt *shape*, not size: fake role turns and shouted
    // absolutes read as manipulation and disengage the model.
    const prompt = buildToolPrompt([readTool, bashTool]);
    expect(prompt).not.toMatch(/<\/?system>|<\/?assistant>/i);
    expect(prompt).not.toMatch(/\bSTRICT RULES\b|\bONLY JSON\b/);
  });

  it("tidies a description that opens with a bullet", () => {
    // opencode's grep description starts with "- Fast content search tool".
    const bulleted: ToolDef = {
      type: "function",
      function: { name: "grep", description: "- Fast content search\n- more", parameters: { type: "object", properties: {} } },
    };
    expect(buildToolPrompt([bulleted])).toContain("grep — Fast content search");
  });

  it("renders an old/new edit tool as a SEARCH/REPLACE template", () => {
    const prompt = buildToolPrompt([editTool]);
    expect(prompt).toContain("<<<<<<< SEARCH");
    expect(prompt).toContain(">>>>>>> REPLACE");
  });
});

describe("parsing a fenced tool call", () => {
  const tools = [readTool, bashTool, editTool];

  it("reads the tool name off the fence info string", () => {
    const { toolCalls } = parseToolCalls(fence("read", "filePath: /etc/hostname"), tools);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.name).toBe("read");
  });

  it("parses scalar args from header lines", () => {
    const { toolCalls } = parseToolCalls(fence("read", "filePath: /etc/hostname\noffset: 10"), tools);
    expect(toolCalls[0]!.arguments).toEqual({ filePath: "/etc/hostname", offset: 10 });
  });

  it("puts free-form content in the body argument", () => {
    const { toolCalls } = parseToolCalls(fence("bash", "ls -la /tmp"), tools);
    expect(toolCalls[0]!.arguments).toEqual({ command: "ls -la /tmp" });
  });

  it("keeps a multi-line body intact", () => {
    const body = "for f in *.ts; do\n  echo \"$f\"\ndone";
    const { toolCalls } = parseToolCalls(fence("bash", body), tools);
    expect(toolCalls[0]!.arguments.command).toBe(body);
  });

  it("combines header args with a body arg", () => {
    const { toolCalls } = parseToolCalls(fence("bash", "timeout: 30\nls -la"), tools);
    expect(toolCalls[0]!.arguments).toEqual({ timeout: 30, command: "ls -la" });
  });

  it("routes a plain ```bash block to the shell tool — the whole point of shell-routing", () => {
    const { toolCalls } = parseToolCalls("Let me look.\n" + fence("bash", "cat README.md"), tools);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.name).toBe("bash");
    expect(toolCalls[0]!.arguments.command).toBe("cat README.md");
  });

  it("routes other shell-ish info strings to the shell tool too", () => {
    for (const info of ["sh", "shell", "zsh", "console"]) {
      const { toolCalls } = parseToolCalls(fence(info, "echo hi"), tools);
      expect(toolCalls[0]?.name, info).toBe("bash");
    }
  });

  it("does not treat a non-shell language fence as a tool call", () => {
    // ```python in an answer is illustration, not an action we can execute.
    const { toolCalls, text } = parseToolCalls(fence("python", "print(1)"), tools);
    expect(toolCalls).toHaveLength(0);
    expect(text).toContain("print(1)");
  });

  it("parses a SEARCH/REPLACE body into old and new strings", () => {
    const body = [
      "filePath: /src/a.ts",
      "<<<<<<< SEARCH",
      "const a = 1;",
      "=======",
      "const a = 2;",
      ">>>>>>> REPLACE",
    ].join("\n");
    const { toolCalls } = parseToolCalls(fence("edit", body), tools);
    expect(toolCalls[0]!.arguments).toEqual({
      filePath: "/src/a.ts",
      oldString: "const a = 1;",
      newString: "const a = 2;",
    });
  });

  it("handles an empty SEARCH side (a pure insertion)", () => {
    const body = ["filePath: /src/a.ts", "<<<<<<< SEARCH", "=======", "added", ">>>>>>> REPLACE"].join("\n");
    const { toolCalls } = parseToolCalls(fence("edit", body), tools);
    expect(toolCalls[0]!.arguments.oldString).toBe("");
    expect(toolCalls[0]!.arguments.newString).toBe("added");
  });

  it("survives a fence nested inside a longer fence", () => {
    const inner = "```\nnested\n```";
    const source = "````bash\ncat <<'EOF'\n" + inner + "\nEOF\n````";
    const { toolCalls } = parseToolCalls(source, tools);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.arguments.command).toContain("nested");
  });

  it("ignores an unterminated fence rather than inventing a call", () => {
    const { toolCalls } = parseToolCalls("```bash\nrm -rf /", tools);
    expect(toolCalls).toHaveLength(0);
  });

  it("returns no calls and the original text for a plain prose answer", () => {
    const { toolCalls, text } = parseToolCalls("The answer is 56.", tools);
    expect(toolCalls).toHaveLength(0);
    expect(text).toBe("The answer is 56.");
  });

  it("coerces booleans and numbers in header lines", () => {
    const tool: ToolDef = {
      type: "function",
      function: {
        name: "t",
        parameters: { type: "object", properties: { n: { type: "number" }, b: { type: "boolean" }, s: { type: "string" } } },
      },
    };
    const { toolCalls } = parseToolCalls(fence("t", "n: 42\nb: true\ns: 42"), [tool]);
    expect(toolCalls[0]!.arguments).toEqual({ n: 42, b: true, s: "42" });
  });

  it("does not mistake a body line containing a colon for a header", () => {
    const { toolCalls } = parseToolCalls(fence("bash", "echo 'note: hi'"), tools);
    expect(toolCalls[0]!.arguments.command).toBe("echo 'note: hi'");
  });
});

describe("one call per turn", () => {
  const tools = [readTool, bashTool];

  it("keeps only the first call, because later steps run on guessed state", () => {
    // M365 batches its whole plan into one response; step 2 assumes an outcome for
    // step 1 that has not happened yet.
    const source = fence("bash", "ls") + "\n\n" + fence("bash", "cat out.txt");
    const { toolCalls } = parseToolCalls(source, tools);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.arguments.command).toBe("ls");
  });

  it("can be told to keep them all", () => {
    const source = fence("bash", "ls") + "\n\n" + fence("bash", "cat out.txt");
    const { toolCalls } = parseToolCalls(source, tools, { allowMultiple: true });
    expect(toolCalls).toHaveLength(2);
  });
});

describe("document guard", () => {
  it("treats a prose document full of fences as an answer, not as actions", () => {
    // Shell-routing turns every ```bash block into a call — so a model that ANSWERS
    // with a markdown document would get its own answer executed.
    const doc = [
      "Here is a suggested README for the project, which explains the layout and how to",
      "get started with the toolchain before running anything at all in your terminal.",
      fence("bash", "npm install"),
      "Then, once dependencies are installed and the lockfile has settled, you can build",
      "the project and run the test suite to make sure everything is wired up correctly.",
      fence("bash", "npm test"),
    ].join("\n\n");
    expect(isProseDocument(doc)).toBe(true);
  });

  it("never reclassifies a single action", () => {
    expect(isProseDocument("Let me check.\n" + fence("bash", "ls"))).toBe(false);
  });

  it("treats four or more fences as a document regardless of prose", () => {
    const many = ["a", "b", "c", "d"].map((c) => fence("bash", c)).join("\n");
    expect(isProseDocument(many)).toBe(true);
  });

  it("returns the document as text rather than executing it", () => {
    const doc = [
      "Here is a suggested README for the project, which explains the layout and how to",
      "get started with the toolchain before running anything at all in your terminal.",
      fence("bash", "npm install"),
      "Then, once dependencies are installed and the lockfile has settled, you can build",
      "the project and run the test suite to make sure everything is wired up correctly.",
      fence("bash", "npm test"),
    ].join("\n\n");
    const { toolCalls, text } = parseToolCalls(doc, [bashTool]);
    expect(toolCalls).toHaveLength(0);
    expect(text).toContain("npm install");
  });
});

describe("invented JSON", () => {
  it("strips a confidence object the model made up", () => {
    expect(stripInventedJson('Done.\n{"confidence": 0.9}')).toBe("Done.");
  });

  it("unwraps a lone final object into its text", () => {
    expect(stripInventedJson('{"final": "The answer is 56."}')).toBe("The answer is 56.");
  });

  it("drops a premature final claim riding alongside a real tool call", () => {
    const source = fence("bash", "ls") + '\n{"final":"Done!"}';
    const { toolCalls, text } = parseToolCalls(source, [bashTool]);
    expect(toolCalls).toHaveLength(1);
    expect(text).not.toContain("Done!");
  });

  it("leaves ordinary prose alone", () => {
    expect(stripInventedJson("The config uses {\"a\": 1} as an example.")).toContain('{"a": 1}');
  });
});

describe("mixed output", () => {
  it("drops commentary that accompanies a tool call", () => {
    // The client should receive tool_calls with null content, not both.
    const { toolCalls, text } = parseToolCalls("I'll list the directory now.\n" + fence("bash", "ls"), [bashTool]);
    expect(toolCalls).toHaveLength(1);
    expect(text).toBe("");
  });
});
