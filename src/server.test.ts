import { afterEach, describe, expect, it, vi } from "vitest";
import { botMessage, completion, delta, disengaged, startStubCopilot, streamItem, throttling, type StubServer } from "../test/stub-copilot.js";
import { AuthRequiredError } from "./auth.js";
import { DEFAULT_MODEL, LOCAL_TITLE_MODEL } from "./models.js";
import { startServer, type ProxyHandle } from "./server.js";

function fakeToken(oid = "oid", tid = "tid"): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ oid, tid })}.sig`;
}

let stub: StubServer | undefined;
let proxy: ProxyHandle | undefined;

afterEach(async () => {
  await proxy?.close();
  await stub?.close();
  proxy = undefined;
  stub = undefined;
});

async function start(overrides: Record<string, any> = {}) {
  stub = stub ?? (await startStubCopilot());
  proxy = await startServer({
    getToken: async () => fakeToken(),
    endpoint: stub.origin,
    resolveAgent: async () => "T_t.b.gpt.default",
    ...overrides,
  });
  return proxy;
}

const post = (url: string, body: unknown) =>
  fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const bashTool = {
  type: "function" as const,
  function: {
    name: "bash",
    description: "Run a shell command",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
};

describe("service endpoints", () => {
  it("reports health", async () => {
    const { url } = await start();
    const response = await fetch(`${url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });

  it("lists the model catalog", async () => {
    const { url } = await start();
    const body: any = await (await fetch(`${url}/v1/models`)).json();
    expect(body.object).toBe("list");
    expect(body.data.map((m: any) => m.id)).toContain(DEFAULT_MODEL);
  });

  it("404s an unknown path instead of hanging", async () => {
    const { url } = await start();
    expect((await fetch(`${url}/nope`)).status).toBe(404);
  });

  it("binds loopback only — the proxy is unauthenticated", async () => {
    const handle = await start();
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });
});

describe("chat completions", () => {
  it("answers a plain question in OpenAI shape", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("56"), completion()] });
    const { url } = await start();
    const body: any = await (await post(url, { model: DEFAULT_MODEL, messages: [{ role: "user", content: "7x8?" }] })).json();
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("56");
  });

  it("selects the tone for the requested model", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("ok"), completion()] });
    const { url } = await start();
    await post(url, { model: "quick", messages: [{ role: "user", content: "hi" }] });
    const chat = stub.last().frames.find((f) => f.type === 4);
    expect(chat.arguments[0].tone).toBe("Gpt_Quick");
  });

  it("converts a fenced block into tool_calls", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("```bash\nls -la\n```"), completion()] });
    const { url } = await start();
    const body: any = await (
      await post(url, { model: DEFAULT_MODEL, messages: [{ role: "user", content: "list files" }], tools: [bashTool] })
    ).json();
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments)).toEqual({ command: "ls -la" });
  });

  it("passes the quota through in usage", async () => {
    stub = await startStubCopilot({ respond: () => [throttling(3), botMessage("ok"), completion()] });
    const { url } = await start();
    const body: any = await (await post(url, { messages: [{ role: "user", content: "hi" }] })).json();
    expect(body.usage.x_m365_conversation_messages).toBe(3);
  });

  it("defaults the model when the client sends none", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("ok"), completion()] });
    const { url } = await start();
    const body: any = await (await post(url, { messages: [{ role: "user", content: "hi" }] })).json();
    expect(body.model).toBe(DEFAULT_MODEL);
  });
});

describe("trimming the toolset the model sees", () => {
  // The nine tools opencode 1.18.18 actually sends, regardless of its own config.
  const opencodeTools = ["apply_patch", "bash", "glob", "grep", "read", "skill", "task", "todowrite", "webfetch"].map(
    (name) => ({
      type: "function" as const,
      function: {
        name,
        description: `The ${name} tool`,
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
    }),
  );

  const toolBlockNames = (server: StubServer) => {
    const text: string = server.last().frames.find((f) => f.type === 4).arguments[0].message.text;
    return [...text.matchAll(/^```([a-z_]+)$/gm)].map((m) => m[1]);
  };

  it("only offers M365 the lean subset", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("ok"), completion()] });
    const { url } = await start();
    await post(url, { messages: [{ role: "user", content: "hi" }], tools: opencodeTools });

    const offered = toolBlockNames(stub);
    expect(offered).toEqual(expect.arrayContaining(["bash", "read", "grep", "apply_patch"]));
    for (const dropped of ["glob", "skill", "task", "todowrite", "webfetch"]) {
      expect(offered, `${dropped} should not be offered`).not.toContain(dropped);
    }
  });

  it("drops the skills catalogue once the skill tool is gone", async () => {
    // The catalogue was 34k of a 53k prompt, listing skills nothing could invoke.
    stub = await startStubCopilot({ respond: () => [botMessage("ok"), completion()] });
    const { url } = await start();
    await post(url, {
      messages: [
        { role: "system", content: "Be useful.\n<available_skills>\n<skill>alpha</skill>\n</available_skills>" },
        { role: "user", content: "hi" },
      ],
      tools: opencodeTools,
    });
    const text: string = stub.last().frames.find((f) => f.type === 4).arguments[0].message.text;
    expect(text).not.toContain("<available_skills>");
    expect(text).toContain("Be useful.");
  });

  it("leaves the toolset alone when lean mode is off", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("ok"), completion()] });
    const { url } = await start({ lean: false });
    await post(url, { messages: [{ role: "user", content: "hi" }], tools: opencodeTools });
    expect(toolBlockNames(stub)).toContain("webfetch");
  });

  it("still routes a bash block to the shell tool after trimming", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("```bash\nls\n```"), completion()] });
    const { url } = await start();
    const body: any = await (
      await post(url, { messages: [{ role: "user", content: "list" }], tools: opencodeTools })
    ).json();
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("bash");
  });
});

describe("agent attachment", () => {
  it("attaches the declarative agent when the request carries tools", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("ok"), completion()] });
    const { url } = await start();
    await post(url, { messages: [{ role: "user", content: "hi" }], tools: [bashTool] });
    expect(stub.last().frames.find((f) => f.type === 4).arguments[0].threadLevelGptId).toBeDefined();
  });

  it("leaves plain chat agent-less, so the tone actually selects the model", async () => {
    // With an agent attached a non-default tone silently routes to GPT-5 anyway.
    stub = await startStubCopilot({ respond: () => [botMessage("ok"), completion()] });
    const { url } = await start();
    await post(url, { model: "claude-sonnet", messages: [{ role: "user", content: "hi" }] });
    expect(stub.last().frames.find((f) => f.type === 4).arguments[0].threadLevelGptId).toBeUndefined();
  });

  it("still answers when the agent cannot be provisioned", async () => {
    // No Copilot Studio access is a degraded mode, not a dead one.
    stub = await startStubCopilot({ respond: () => [botMessage("ok"), completion()] });
    const { url } = await start({
      resolveAgent: async () => {
        throw new Error("403 Forbidden");
      },
    });
    const response = await post(url, { messages: [{ role: "user", content: "hi" }], tools: [bashTool] });
    expect(response.status).toBe(200);
  });
});

describe("conversation reuse", () => {
  it("threads a follow-up onto the same M365 conversation", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("ok"), completion()] });
    const { url } = await start();
    const first = [{ role: "user", content: "start the task" }];
    await post(url, { messages: first });
    await post(url, { messages: [...first, { role: "assistant", content: "ok" }, { role: "user", content: "continue" }] });

    const ids = stub.connections.map((c) => new URL(c.url, "http://x").searchParams.get("ConversationId"));
    expect(new Set(ids).size).toBe(1);
  });

  it("sends only the new messages on a follow-up", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("ok"), completion()] });
    const { url } = await start();
    const first = [{ role: "user", content: "UNIQUEFIRST" }];
    await post(url, { messages: first });
    await post(url, { messages: [...first, { role: "assistant", content: "ok" }, { role: "user", content: "UNIQUESECOND" }] });

    const text = stub.last().frames.find((f) => f.type === 4).arguments[0].message.text;
    expect(text).toContain("UNIQUESECOND");
    expect(text).not.toContain("UNIQUEFIRST");
  });
});

describe("the local titler", () => {
  it("answers without opening any M365 conversation at all", async () => {
    stub = await startStubCopilot();
    const { url } = await start();
    const body: any = await (
      await post(url, {
        model: LOCAL_TITLE_MODEL,
        messages: [{ role: "user", content: "refactor the auth middleware" }],
      })
    ).json();
    expect(body.choices[0].message.content.toLowerCase()).toContain("refactor");
    expect(stub.connections).toHaveLength(0);
  });

  it("streams too, since the harness may ask for a stream", async () => {
    stub = await startStubCopilot();
    const { url } = await start();
    const response = await post(url, {
      model: LOCAL_TITLE_MODEL,
      stream: true,
      messages: [{ role: "user", content: "fix the flaky test" }],
    });
    const text = await response.text();
    expect(text).toContain("data: ");
    expect(text).toContain("[DONE]");
    expect(stub.connections).toHaveLength(0);
  });
});

describe("streaming", () => {
  it("streams a tool-less answer as it arrives", async () => {
    stub = await startStubCopilot({
      respond: () => [delta("Hel"), delta("lo"), streamItem("Hello"), completion()],
    });
    const { url } = await start();
    const text = await (await post(url, { stream: true, messages: [{ role: "user", content: "hi" }] })).text();
    expect(text).toContain('"content":"Hel"');
    expect(text).toContain("[DONE]");
  });

  it("sets the SSE content type", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("hi"), completion()] });
    const { url } = await start();
    const response = await post(url, { stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
  });

  it("buffers a tool turn, because fences can only be parsed once complete", async () => {
    stub = await startStubCopilot({
      respond: () => [delta("```bash\n"), delta("ls\n```"), streamItem("```bash\nls\n```"), completion()],
    });
    const { url } = await start();
    const text = await (
      await post(url, { stream: true, messages: [{ role: "user", content: "list" }], tools: [bashTool] })
    ).text();
    expect(text).toContain("tool_calls");
    expect(text).toContain('"name":"bash"');
    expect(text).toContain("[DONE]");
  });
});

describe("failures the client has to be able to tell apart", () => {
  it("reports Disengaged distinctly rather than as a generic error", async () => {
    stub = await startStubCopilot({ respond: () => [disengaged(), completion()] });
    const { url } = await start();
    const response = await post(url, { messages: [{ role: "user", content: "hi" }], tools: [bashTool] });
    expect(response.status).toBe(502);
    const body: any = await response.json();
    expect(body.error.code).toBe("m365_disengaged");
    expect(body.error.message).toMatch(/tool/i);
  });

  it("returns 401 when the user needs to sign in", async () => {
    const { url } = await start({
      getToken: async () => {
        throw new AuthRequiredError("No signed-in Microsoft 365 account");
      },
    });
    const response = await post(url, { messages: [{ role: "user", content: "hi" }] });
    expect(response.status).toBe(401);
    const body: any = await response.json();
    expect(body.error.message).toMatch(/opencode-m365 login/);
  });

  it("rejects a malformed request with 400", async () => {
    const { url } = await start();
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });

  it("rejects a request with no messages", async () => {
    const { url } = await start();
    expect((await post(url, { messages: [] })).status).toBe(400);
  });

  it("maps an upstream failure to 502", async () => {
    stub = await startStubCopilot({ respond: () => [completion("Failed to invoke 'Chat'")] });
    const { url } = await start();
    expect((await post(url, { messages: [{ role: "user", content: "hi" }] })).status).toBe(502);
  });
});

describe("lifecycle", () => {
  it("picks a free port when asked for 0", async () => {
    const handle = await start({ port: 0 });
    expect(handle.port).toBeGreaterThan(0);
  });

  it("stops listening once closed", async () => {
    const handle = await start();
    const { url } = handle;
    await handle.close();
    proxy = undefined;
    await expect(fetch(`${url}/health`)).rejects.toThrow();
  });

  it("resolves the agent once and reuses it", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("ok"), completion()] });
    const resolveAgent = vi.fn(async () => "T_t.b.gpt.default");
    const { url } = await start({ resolveAgent });
    await post(url, { messages: [{ role: "user", content: "a" }], tools: [bashTool] });
    await post(url, { messages: [{ role: "user", content: "b" }], tools: [bashTool] });
    expect(resolveAgent).toHaveBeenCalledTimes(1);
  });
});
