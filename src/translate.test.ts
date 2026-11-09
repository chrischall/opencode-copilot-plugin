import { describe, expect, it } from "vitest";
import type { ToolDef } from "./fenced.js";
import {
  ChatCompletionRequest,
  ConversationPool,
  condenseSystemPrompt,
  buildCompletion,
  buildTurnPrompt,
  buildUsage,
  generateTitle,
  streamChunk,
  streamDone,
} from "./translate.js";

const bashTool: ToolDef = {
  type: "function",
  function: {
    name: "bash",
    description: "Run a shell command",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
};

const user = (content: string) => ({ role: "user" as const, content });
const system = (content: string) => ({ role: "system" as const, content });

describe("request validation", () => {
  it("accepts a minimal chat completion request", () => {
    const parsed = ChatCompletionRequest.parse({ messages: [user("hi")] });
    expect(parsed.messages).toHaveLength(1);
  });

  it("accepts content supplied as an array of parts", () => {
    // opencode sends structured content parts, not always a bare string.
    const parsed = ChatCompletionRequest.parse({
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
    expect(parsed.messages[0]!.content).toBeDefined();
  });

  it("rejects a request with no messages", () => {
    expect(() => ChatCompletionRequest.parse({ messages: [] })).toThrow();
  });

  it("keeps tool definitions and the stream flag", () => {
    const parsed = ChatCompletionRequest.parse({ messages: [user("hi")], tools: [bashTool], stream: true });
    expect(parsed.tools?.[0]?.function.name).toBe("bash");
    expect(parsed.stream).toBe(true);
  });
});

describe("conversation pool", () => {
  it("threads follow-up turns onto the same conversation", () => {
    // The 600-message cap is per conversation, so a new one per turn would burn
    // quota and lose the server-side context.
    const pool = new ConversationPool();
    const first = pool.resolve([user("build the thing")]);
    const second = pool.resolve([user("build the thing"), { role: "assistant", content: "ok" }, user("now test it")]);
    expect(second).toBe(first);
  });

  it("starts a new conversation when the first user message changes", () => {
    const pool = new ConversationPool();
    const first = pool.resolve([user("task one")]);
    const second = pool.resolve([user("task two")]);
    expect(second).not.toBe(first);
  });

  it("keeps two sessions apart that open with the same message, when the harness names them", () => {
    // "fix the failing tests" in two sessions must not share one M365 conversation.
    const pool = new ConversationPool();
    const a = pool.resolve([user("fix the failing tests")], { sessionId: "ses_a" });
    const b = pool.resolve([user("fix the failing tests")], { sessionId: "ses_b" });
    expect(b).not.toBe(a);
    expect(pool.resolve([user("fix the failing tests"), user("more")], { sessionId: "ses_a" })).toBe(a);
  });

  it("keeps apart the same opener under different system prompts, e.g. two repos", () => {
    const pool = new ConversationPool();
    const a = pool.resolve([system("cwd: /repo/one"), user("fix the failing tests")]);
    const b = pool.resolve([system("cwd: /repo/two"), user("fix the failing tests")]);
    expect(b).not.toBe(a);
  });

  it("does not collide on a 32-bit hash", () => {
    // "Aa" and "BB" share a Java-style string hash; so do these longer strings.
    const pool = new ConversationPool();
    expect(pool.resolve([user("AaAa")])).not.toBe(pool.resolve([user("BBBB")]));
  });

  it("resets when the history shrinks, which means the client started over", () => {
    const pool = new ConversationPool();
    const state = pool.resolve([user("task"), { role: "assistant", content: "a" }, user("more")]);
    state.sentMessageCount = 3;
    pool.resolve([user("task")]);
    expect(state.sentMessageCount).toBe(0);
  });

  it("evicts conversations that have gone idle", () => {
    const pool = new ConversationPool({ maxIdleMs: 0 });
    pool.resolve([user("task")]);
    expect(pool.size).toBe(1);
    pool.resolve([user("other")]);
    expect(pool.size).toBe(1);
  });
});

describe("building the turn prompt", () => {
  it("includes the system prompt on the first turn", () => {
    const prompt = buildTurnPrompt([system("You are a careful engineer."), user("hi")], [], 0);
    expect(prompt).toContain("You are a careful engineer.");
  });

  it("includes the tool block when the request carries tools", () => {
    const prompt = buildTurnPrompt([user("list the files")], [bashTool], 0);
    expect(prompt).toContain("<tools>");
    expect(prompt).toContain("```bash");
  });

  it("only says nothing has run yet on the first turn", () => {
    // Repeated every turn, it contradicted the transcript from turn two on.
    expect(buildTurnPrompt([user("list the files")], [bashTool], 0)).toMatch(/not run anything yet/);
    const later = buildTurnPrompt([user("list the files"), user("now count them")], [bashTool], 1);
    expect(later).toContain("<tools>");
    expect(later).not.toMatch(/not run anything yet|above this line/);
  });

  it("omits the tool block entirely when there are no tools", () => {
    expect(buildTurnPrompt([user("what is 7x8?")], [], 0)).not.toContain("<tools>");
  });

  it("sends only new messages on a follow-up turn", () => {
    // The server remembers the conversation; resending history confuses it and
    // burns quota.
    const messages = [user("first"), { role: "assistant" as const, content: "answered" }, user("second")];
    const prompt = buildTurnPrompt(messages, [], 2);
    expect(prompt).toContain("second");
    expect(prompt).not.toContain("first");
  });

  it("repeats the tool block on later turns so the contract stays in view", () => {
    const messages = [user("first"), { role: "assistant" as const, content: "ok" }, user("second")];
    expect(buildTurnPrompt(messages, [bashTool], 2)).toContain("<tools>");
  });

  it("labels a tool result with the command that produced it", () => {
    // Without the label the model misreads an `ls` listing as file contents.
    const messages = [
      user("what is in the repo?"),
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [{ id: "c1", type: "function" as const, function: { name: "bash", arguments: '{"command":"ls -la"}' } }],
      },
      { role: "tool" as const, tool_call_id: "c1", content: "total 0\nREADME.md" },
    ];
    const prompt = buildTurnPrompt(messages, [bashTool], 1);
    expect(prompt).toContain('tool="bash"');
    expect(prompt).toContain('command="ls -la"');
    expect(prompt).toContain("README.md");
  });

  it("still labels a tool result when the call that produced it is out of view", () => {
    const messages = [user("x"), { role: "tool" as const, tool_call_id: "unknown", content: "output" }];
    const prompt = buildTurnPrompt(messages, [bashTool], 1);
    expect(prompt).toContain("<tool_response");
    expect(prompt).toContain("output");
  });

  it("flattens array content parts into text", () => {
    const messages = [{ role: "user" as const, content: [{ type: "text", text: "part one" }, { type: "text", text: "part two" }] }];
    const prompt = buildTurnPrompt(messages as any, [], 0);
    expect(prompt).toContain("part one");
    expect(prompt).toContain("part two");
  });
});

describe("condensing the harness system prompt", () => {
  const skillsCatalogue = `<available_skills>\n${"  <skill><name>x</name></skill>\n".repeat(50)}</available_skills>`;

  it("drops a skills catalogue the toolset cannot act on", () => {
    // Measured against opencode 1.18: this block was 34k of a 53k prompt, listing
    // skills that lean mode's toolset has no tool to invoke.
    const condensed = condenseSystemPrompt(`Be helpful.\n${skillsCatalogue}\n<env>cwd=/tmp</env>`, []);
    expect(condensed).not.toContain("<available_skills>");
    expect(condensed).toContain("Be helpful.");
  });

  it("keeps the catalogue when a skill tool is actually present", () => {
    const skillTool: ToolDef = { type: "function", function: { name: "skill", parameters: { type: "object", properties: {} } } };
    expect(condenseSystemPrompt(skillsCatalogue, [skillTool])).toContain("<available_skills>");
  });

  it("keeps environment context, which the model genuinely needs", () => {
    const condensed = condenseSystemPrompt(`Prose.\n${skillsCatalogue}\n<env>cwd=/tmp</env>`, []);
    expect(condensed).toContain("<env>cwd=/tmp</env>");
  });

  it("drops an agent catalogue when there is no tool to delegate with", () => {
    const text = "Prose.\n<available_agents>\n<agent>reviewer</agent>\n</available_agents>";
    expect(condenseSystemPrompt(text, [])).not.toContain("<available_agents>");
  });

  // The shape of opencode 2.2.5's system prompt (2026-11-09), cut down. Its Code Mode
  // section says every listed tool only works inside `execute`, and lean mode removes
  // `execute` — so the model was told its tools were unusable.
  const opencode2Prompt = [
    "You are opencode.",
    "",
    "# Harness",
    "- Responses are rendered as GitHub-flavored Markdown.",
    "- Prefer parallelizing independent tool calls.",
    "- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.",
    "",
    "# Your Model",
    "- Model ID: quick",
    "# Code Mode",
    "",
    "The tools listed below cannot be called directly: they only work as JavaScript inside the `execute` tool. Every other tool you have is a normal tool call: call it directly, never inside `execute`.",
    "",
    "## Code Mode tools (call only inside `execute`)",
    "",
    "- opencode (8 tools) // Tools for managing OpenCode itself",
    "  tools.opencode.session_move(input: {",
    "  directory: string,",
    "}): Promise<{ moved: boolean }> // Move the session.",
    "",
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
    "The user may also invoke a skill directly.",
    skillsCatalogue,
    "<env>",
    "  Working directory: /tmp/w",
    "</env>",
    "When you create a worktree, consider using `execute` to call `tools.opencode.session_move`.",
  ].join("\n");
  const leanFive = ["edit", "grep", "read", "shell", "write"].map(
    (name): ToolDef => ({ type: "function", function: { name, parameters: { type: "object", properties: {} } } }),
  );

  it("drops opencode 2's Code Mode section when execute is not offered", () => {
    const condensed = condenseSystemPrompt(opencode2Prompt, leanFive);
    expect(condensed).not.toMatch(/Code Mode|execute|session_move/);
    expect(condensed).toContain("# Your Model");
    expect(condensed).toContain("Working directory: /tmp/w");
  });

  it("drops the skills paragraph along with its catalogue", () => {
    expect(condenseSystemPrompt(opencode2Prompt, leanFive)).not.toMatch(/skill/i);
  });

  it("drops harness advice that contradicts one call per turn and the shell-first framing", () => {
    const condensed = condenseSystemPrompt(opencode2Prompt, leanFive);
    expect(condensed).not.toMatch(/parallelizing|dedicated tools over shell/);
    expect(condensed).toContain("GitHub-flavored Markdown");
  });

  it("never trims the user's own rules, even where they name a dropped tool", () => {
    // opencode 2.2.5's layout: harness text, then each rules file under an
    // `Instructions from:` line, then the date and <env>, then one more harness line.
    const rules = [
      "Instructions from: /repo/AGENTS.md",
      "# Project rules",
      "",
      "- Always run `npm test` before you execute a release.",
      "- Never use the `execute` tool for file edits.",
      "- Use the skill tool sparingly.",
      "- Prefer parallelizing independent tool calls.",
      "",
    ].join("\n");
    const prompt = opencode2Prompt.replace("<env>", `${rules}\n\nToday's date: Mon Nov 09 2026\n<env>`);
    const condensed = condenseSystemPrompt(prompt, leanFive);
    expect(condensed).toContain(rules.trim());
    expect(condensed).toContain("Today's date: Mon Nov 09 2026");
    // The harness's own text around them is still trimmed.
    expect(condensed).not.toMatch(/# Code Mode|tools\.opencode\.session_move|Skills provide/);
  });

  it("keeps Code Mode and skills when their tools are offered", () => {
    const withBoth = [...leanFive, ...["execute", "skill"].map(
      (name): ToolDef => ({ type: "function", function: { name, parameters: { type: "object", properties: {} } } }),
    )];
    const condensed = condenseSystemPrompt(opencode2Prompt, withBoth);
    expect(condensed).toContain("# Code Mode");
    expect(condensed).toContain("Use the skill tool");
  });

  it("leaves a prompt with no catalogues untouched", () => {
    expect(condenseSystemPrompt("Just a system prompt.", [])).toBe("Just a system prompt.");
  });

  // opencode injects project and global rules as PROSE inside the system message,
  // introduced by a `Instructions from: <path>` line. Dropping them silently means a
  // repo's own AGENTS.md stops applying with no sign in the UI.
  describe("project instructions", () => {
    const withRules = [
      "You are OpenCode, a long polished assistant persona.",
      "Instructions from: /home/me/project/AGENTS.md",
      "# Project rules",
      "",
      "Never touch files under vendor/, and always run `make check`.",
      "<env>cwd=/home/me/project</env>",
    ].join("\n");

    it("keeps them when the prose is replaced", () => {
      const condensed = condenseSystemPrompt(withRules, [], { replaceProseWith: "SHORT" });
      expect(condensed).toContain("Never touch files under vendor/");
      expect(condensed).toContain("Instructions from: /home/me/project/AGENTS.md");
    });

    it("still drops the harness's own persona prose", () => {
      const condensed = condenseSystemPrompt(withRules, [], { replaceProseWith: "SHORT" });
      expect(condensed).not.toContain("polished assistant persona");
      expect(condensed).toContain("SHORT");
    });

    it("keeps every instruction section, not just the first", () => {
      const two = [
        "persona prose",
        "Instructions from: /home/me/.config/rules.md",
        "GLOBAL RULE ONE",
        "Instructions from: /home/me/project/AGENTS.md",
        "PROJECT RULE TWO",
        "<env>x</env>",
      ].join("\n");
      const condensed = condenseSystemPrompt(two, [], { replaceProseWith: "SHORT" });
      expect(condensed).toContain("GLOBAL RULE ONE");
      expect(condensed).toContain("PROJECT RULE TWO");
    });

    it("keeps a structured block that sits BEFORE the rules", () => {
      // opencode puts `<env>` ahead of the instruction sections, so "keep only the
      // trailing blocks" loses it.
      const envFirst = [
        "persona prose",
        "<env>cwd=/tmp</env>",
        "Instructions from: /home/me/project/AGENTS.md",
        "PROJECT RULE",
        "trailing harness prose",
      ].join("\n");
      const condensed = condenseSystemPrompt(envFirst, [], { replaceProseWith: "SHORT" });
      expect(condensed).toContain("<env>cwd=/tmp</env>");
      expect(condensed).toContain("PROJECT RULE");
      expect(condensed).not.toContain("persona prose");
    });

    it("keeps rules that follow a tag-like line in the user's own file", () => {
      // A rules file is Markdown and routinely contains HTML/JSX. Ending the
      // section at the first `<word>` line would drop everything after it — the
      // exact silent deletion this whole change exists to prevent.
      const withHtml = [
        "persona prose",
        "Instructions from: /home/me/project/AGENTS.md",
        "<details> is fine in docs.",
        "RULE AFTER THE TAG",
        "<env>cwd=/tmp</env>",
      ].join("\n");
      const condensed = condenseSystemPrompt(withHtml, [], { replaceProseWith: "SHORT" });
      expect(condensed).toContain("RULE AFTER THE TAG");
      expect(condensed).toContain("<details> is fine in docs.");
    });

    it("keeps rules that follow a complete tag pair in the user's own file", () => {
      const withPair = [
        "persona prose",
        "Instructions from: /home/me/project/AGENTS.md",
        "Example:",
        "<details>",
        "<summary>expand</summary>",
        "</details>",
        "RULE AFTER THE PAIR",
        "<env>cwd=/tmp</env>",
      ].join("\n");
      const condensed = condenseSystemPrompt(withPair, [], { replaceProseWith: "SHORT" });
      expect(condensed).toContain("RULE AFTER THE PAIR");
      // ...and the user's own example is not duplicated into the preserved blocks.
      expect(condensed.match(/<summary>expand<\/summary>/g)).toHaveLength(1);
    });

    it("stops a section at the first structured block rather than swallowing it", () => {
      const condensed = condenseSystemPrompt(withRules, [], { replaceProseWith: "SHORT" });
      // <env> is preserved once, as a block — not duplicated inside the rules text.
      expect(condensed.match(/<env>/g)).toHaveLength(1);
    });

    it("still drops a catalogue that sits after the rules", () => {
      const text = `${withRules}\n<available_skills>\n<skill>x</skill>\n</available_skills>`;
      const condensed = condenseSystemPrompt(text, [], { replaceProseWith: "SHORT" });
      expect(condensed).not.toContain("<available_skills>");
      expect(condensed).toContain("Never touch files under vendor/");
    });
  });

  it("replaces the prose but keeps structured blocks when asked to go lean", () => {
    const text = `You are a long polished assistant persona.\n${skillsCatalogue}\n<env>cwd=/tmp</env>`;
    const condensed = condenseSystemPrompt(text, [], { replaceProseWith: "SHORT PROMPT" });
    expect(condensed).toContain("SHORT PROMPT");
    expect(condensed).toContain("<env>cwd=/tmp</env>");
    expect(condensed).not.toContain("polished assistant persona");
  });

  it("is applied to the system prompt on the first turn", () => {
    const prompt = buildTurnPrompt([system(`Prose.\n${skillsCatalogue}`), user("hi")], [], 0);
    expect(prompt).not.toContain("<available_skills>");
    expect(prompt).toContain("Prose.");
  });
});

describe("building the completion", () => {
  it("returns prose as message content", () => {
    const completion = buildCompletion({ text: "The answer is 56." }, { model: "gpt-5.5", tools: [] });
    expect(completion.choices[0]!.message.content).toBe("The answer is 56.");
    expect(completion.choices[0]!.finish_reason).toBe("stop");
  });

  it("converts a fenced tool call into OpenAI tool_calls", () => {
    const completion = buildCompletion(
      { text: "```bash\nls -la\n```" },
      { model: "gpt-5.5", tools: [bashTool] },
    );
    const call = completion.choices[0]!.message.tool_calls?.[0];
    expect(call?.function.name).toBe("bash");
    expect(JSON.parse(call!.function.arguments)).toEqual({ command: "ls -la" });
    expect(completion.choices[0]!.finish_reason).toBe("tool_calls");
  });

  it("nulls the content when the turn produced a tool call", () => {
    const completion = buildCompletion({ text: "I'll check.\n```bash\nls\n```" }, { model: "gpt-5.5", tools: [bashTool] });
    expect(completion.choices[0]!.message.content).toBeNull();
  });

  it("gives each tool call a distinct id", () => {
    const completion = buildCompletion(
      { text: "```bash\nls\n```\n```bash\npwd\n```" },
      { model: "gpt-5.5", tools: [bashTool], allowMultiple: true },
    );
    const calls = completion.choices[0]!.message.tool_calls ?? [];
    expect(new Set(calls.map((c) => c.id)).size).toBe(calls.length);
  });

  it("reports the model that was asked for", () => {
    expect(buildCompletion({ text: "hi" }, { model: "gpt-5.5-think-deeper", tools: [] }).model).toBe(
      "gpt-5.5-think-deeper",
    );
  });

  it("looks like an OpenAI chat completion", () => {
    const completion = buildCompletion({ text: "hi" }, { model: "gpt-5.5", tools: [] });
    expect(completion.object).toBe("chat.completion");
    expect(completion.id).toMatch(/^chatcmpl-/);
    expect(typeof completion.created).toBe("number");
  });
});

describe("usage reporting", () => {
  it("reports the per-conversation quota, which is the only budget M365 exposes", () => {
    const usage = buildUsage({ text: "", throttle: { current: 42, max: 600 } });
    expect(usage.x_m365_conversation_messages).toBe(42);
    expect(usage.x_m365_conversation_max).toBe(600);
    expect(usage.x_m365_conversation_remaining).toBe(558);
    expect(usage.x_m365_conversation_pct).toBe(7);
  });

  it("surfaces the classifier score that predicts disengagement", () => {
    // Clean tool calls sit around 1e-8 and jailbreak-shaped prompts around 1e-3, so
    // a client can back off before the filter fires.
    const usage = buildUsage({ text: "", scores: { dea_violation: 2.8e-6 } });
    expect(usage.x_m365_dea_score).toBeCloseTo(2.8e-6);
  });

  it("still returns the standard token fields, even though M365 hides real counts", () => {
    const usage = buildUsage({ text: "" });
    expect(usage.prompt_tokens).toBe(0);
    expect(usage.total_tokens).toBe(0);
  });
});

describe("local title generation", () => {
  it("produces a short title without contacting M365", () => {
    const title = generateTitle([user("Please refactor the authentication middleware to use async handlers")]);
    expect(title.length).toBeLessThanOrEqual(50);
    expect(title.toLowerCase()).toContain("refactor");
  });

  it("ignores the instruction wrapper the harness wraps around the request", () => {
    const messages = [
      system("Generate a short title for the following conversation. Respond with the title only."),
      user("fix the flaky test in session.test.ts"),
    ];
    expect(generateTitle(messages).toLowerCase()).toContain("flaky");
  });

  it("strips code fences rather than titling a conversation with a shell command", () => {
    expect(generateTitle([user("```bash\nnpm run build\n```\nwhy does this fail?")])).not.toContain("```");
  });

  it("always produces something, even for an empty conversation", () => {
    expect(generateTitle([]).length).toBeGreaterThan(0);
  });
});

describe("streaming", () => {
  it("emits server-sent event frames", () => {
    const chunk = streamChunk("chatcmpl-1", "gpt-5.5", { content: "hello" });
    expect(chunk.startsWith("data: ")).toBe(true);
    expect(chunk.endsWith("\n\n")).toBe(true);
    expect(JSON.parse(chunk.slice(6))).toMatchObject({ object: "chat.completion.chunk" });
  });

  it("puts text in the delta", () => {
    const parsed = JSON.parse(streamChunk("id", "m", { content: "hi" }).slice(6));
    expect(parsed.choices[0].delta.content).toBe("hi");
  });

  it("terminates the stream the way OpenAI clients expect", () => {
    expect(streamDone()).toBe("data: [DONE]\n\n");
  });

  it("carries the finish reason on the closing chunk", () => {
    const parsed = JSON.parse(streamChunk("id", "m", { finishReason: "stop" }).slice(6));
    expect(parsed.choices[0].finish_reason).toBe("stop");
  });
});
