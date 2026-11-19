import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { botMessage, completion, delta, disengaged, startStubCopilot, streamItem, throttling, type StubServer } from "../test/stub-copilot.js";
import { AuthRequiredError } from "./auth.js";
import { DEFAULT_MODEL, LOCAL_TITLE_MODEL } from "./models.js";
import { opencodeWouldRetry } from "../test/opencode-retry.js";
import { AUX_REQUEST_KIND_HEADER, SESSION_ID_HEADER, startServer, stripMcpCalls, type ProxyHandle } from "./server.js";

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

/** `fetch`, carrying the running proxy's per-launch secret the way opencode does. */
const authedFetch = (input: string, init: RequestInit = {}) =>
  fetch(input, {
    ...init,
    headers: { Authorization: `Bearer ${proxy!.apiKey}`, ...(init.headers as Record<string, string> | undefined) },
  });

const post = (url: string, body: unknown) =>
  authedFetch(`${url}/v1/chat/completions`, {
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
    const body: any = await (await authedFetch(`${url}/v1/models`)).json();
    expect(body.object).toBe("list");
    expect(body.data.map((m: any) => m.id)).toContain(DEFAULT_MODEL);
  });

  it("lists canonical ids only, not the compatibility aliases", async () => {
    const { url } = await start();
    const body: any = await (await authedFetch(`${url}/v1/models`)).json();
    const ids = body.data.map((m: any) => m.id);
    expect(ids).toContain("m365-copilot");
    for (const alias of ["auto", "claude", "gpt-5.4", "gpt-5.3", "gpt-5.2"]) expect(ids).not.toContain(alias);
  });

  it("lists the paid, credit-billed and metered models, not their aliases", async () => {
    const { url } = await start();
    const body: any = await (await authedFetch(`${url}/v1/models`)).json();
    const ids = body.data.map((m: any) => m.id);
    for (const id of ["gpt-6-think-deeper", "gpt-6-astra", "gpt-6.2-astra", "claude-opus", "claude-opus-4.8", "claude-sonnet-5.5", "claude-sonnet-5", "claude-fable"]) {
      expect(ids).toContain(id);
    }
    for (const alias of ["claude-opus-5.5", "claude-opus-4.5", "claude-sonnet-4.6", "claude-fable-5.1"]) expect(ids).not.toContain(alias);
  });

  it("404s an unknown path instead of hanging", async () => {
    const { url } = await start();
    expect((await authedFetch(`${url}/nope`)).status).toBe(404);
  });

  it("binds loopback only", async () => {
    const handle = await start();
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });
});

/** A raw request, so a test can set headers `fetch` will not let it forge (Host, Origin). */
function rawRequest(
  url: string,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port: Number(port), method: options.method ?? "GET", path: options.path ?? "/", headers: options.headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    request.on("error", reject);
    request.end(options.body);
  });
}

describe("who may call the proxy", () => {
  // The proxy spends the user's corporate M365 quota and returns tenant-grounded
  // answers. A browser tab must never be able to use it: not by a cross-origin
  // fetch, not by a CORS-simple text/plain POST, and not by DNS rebinding.
  const chat = { messages: [{ role: "user", content: "hi" }] };

  it("generates a fresh high-entropy secret per launch", async () => {
    const first = await start();
    const firstKey = first.apiKey;
    await first.close();
    proxy = undefined;
    const second = await start();
    expect(firstKey.length).toBeGreaterThanOrEqual(43); // 32 random bytes, base64url
    expect(second.apiKey).not.toBe(firstKey);
  });

  it("uses a secret supplied by the caller", async () => {
    const handle = await start({ apiKey: "a-caller-chosen-secret-that-is-long-enough" });
    expect(handle.apiKey).toBe("a-caller-chosen-secret-that-is-long-enough");
  });

  it("refuses a chat completion with no secret, before touching M365", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("ok"), completion()] });
    const { url } = await start();
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chat),
    });
    expect(response.status).toBe(401);
    expect(stub.connections).toHaveLength(0);
  });

  it("refuses a wrong secret", async () => {
    const { url } = await start();
    const response = await fetch(`${url}/v1/models`, { headers: { Authorization: "Bearer m365-local" } });
    expect(response.status).toBe(401);
  });

  it("refuses the model list without the secret", async () => {
    const { url } = await start();
    expect((await fetch(`${url}/v1/models`)).status).toBe(401);
  });

  it("accepts the secret opencode is handed", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("56"), completion()] });
    const { url } = await start();
    const response = await post(url, chat);
    expect(response.status).toBe(200);
  });

  it("refuses a request carrying a browser Origin, even with the secret", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("ok"), completion()] });
    const { url } = await start();
    const response = await rawRequest(url, {
      method: "POST",
      path: "/v1/chat/completions",
      headers: {
        Origin: "https://evil.example",
        Authorization: `Bearer ${proxy!.apiKey}`,
        "Content-Type": "text/plain",
      },
      body: JSON.stringify(chat),
    });
    expect(response.status).toBe(403);
    expect(stub.connections).toHaveLength(0);
  });

  it("ignores the retired allowedOrigins option with a warning, still refusing the Origin", async () => {
    // Allowlisting an Origin could never make the proxy usable from a web page: the
    // bearer header forces a preflight, and preflights are always refused. So the
    // option is gone; an old caller that still passes it keeps starting, and learns why.
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      stub = await startStubCopilot({ respond: () => [botMessage("ok"), completion()] });
      const { url } = await start({ allowedOrigins: ["http://localhost:3000"] });
      const response = await rawRequest(url, {
        method: "POST",
        path: "/v1/chat/completions",
        headers: { Origin: "http://localhost:3000", Authorization: `Bearer ${proxy!.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(chat),
      });
      expect(response.status).toBe(403);
      expect(stub.connections).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/allowedOrigins/), expect.objectContaining({ type: "DeprecationWarning" }));
    } finally {
      warn.mockRestore();
    }
  });

  it("does not warn when allowedOrigins is not passed", async () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      await start();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses a CORS preflight and grants no CORS headers", async () => {
    const { url } = await start();
    const response = await rawRequest(url, {
      method: "OPTIONS",
      path: "/v1/chat/completions",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, content-type",
      },
    });
    expect(response.status).toBe(403);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["access-control-allow-headers"]).toBeUndefined();
  });

  it("sends no CORS headers on a normal response either", async () => {
    const { url } = await start();
    const response = await authedFetch(`${url}/v1/models`);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses a foreign Host header, which is what DNS rebinding looks like", async () => {
    const { url } = await start();
    const response = await rawRequest(url, {
      path: "/v1/models",
      headers: { Host: `attacker.example:${new URL(url).port}`, Authorization: `Bearer ${proxy!.apiKey}` },
    });
    expect(response.status).toBe(403);
  });

  it("accepts localhost as a Host alias for the loopback address", async () => {
    const { url } = await start();
    const response = await rawRequest(url, {
      path: "/v1/models",
      headers: { Host: `localhost:${new URL(url).port}`, Authorization: `Bearer ${proxy!.apiKey}` },
    });
    expect(response.status).toBe(200);
  });

  it("caps the request body instead of buffering whatever arrives", async () => {
    const { url } = await start({ maxBodyBytes: 1024 });
    const response = await post(url, { messages: [{ role: "user", content: "x".repeat(4096) }] });
    expect(response.status).toBe(413);
  });

  it("refuses to bind anything but loopback", async () => {
    await expect(start({ host: "0.0.0.0" })).rejects.toThrow(/loopback/);
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
    expect(chat.arguments[0].tone).toBe("Gpt_5_5_Chat");
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

describe("grounded models carry no tools", () => {
  const chatArg = (server: StubServer) => server.last().frames.find((f) => f.type === 4).arguments[0];

  it("sends no fenced tool prompt on a grounded turn, even when the client sends tools", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("Here is your inbox summary."), completion()] });
    const { url } = await start();
    await post(url, { model: "work", messages: [{ role: "user", content: "what's in my inbox?" }], tools: [bashTool] });
    const arg = chatArg(stub);
    // No tool block offered to M365; the built-in grounding agent is used, not the declarative one.
    expect(arg.message.text).not.toMatch(/```bash/);
    expect(arg.gpts[0].id).toBe("bizchat-as-gpt-scenario");
    expect(arg.threadLevelGptId).toBeUndefined();
  });

  it("does not parse a fenced block in a grounded answer as a tool call", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("```bash\nls -la\n```"), completion()] });
    const { url } = await start();
    const body: any = await (
      await post(url, { model: "work", messages: [{ role: "user", content: "show me" }], tools: [bashTool] })
    ).json();
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.choices[0].message.tool_calls).toBeUndefined();
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

describe("follow-up turns", () => {
  it("does not paste M365's own previous reply back to it as user input", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("FIRSTREPLY"), completion()] });
    const { url } = await start();
    const first = [{ role: "user", content: "UNIQUEFIRST" }];
    await post(url, { messages: first });
    await post(url, {
      messages: [...first, { role: "assistant", content: "FIRSTREPLY" }, { role: "user", content: "UNIQUESECOND" }],
    });

    const text = stub.last().frames.find((f) => f.type === 4).arguments[0].message.text;
    expect(text).toContain("UNIQUESECOND");
    expect(text).not.toContain("FIRSTREPLY");
  });

  it("gives each named session its own M365 conversation, even with the same opener", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("ok"), completion()] });
    const { url } = await start();
    const send = (session: string) =>
      authedFetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [SESSION_ID_HEADER]: session },
        body: JSON.stringify({ messages: [{ role: "user", content: "fix the failing tests" }] }),
      });
    await send("ses_a");
    await send("ses_b");

    const ids = stub.connections.map((c) => new URL(c.url, "http://x").searchParams.get("ConversationId"));
    expect(new Set(ids).size).toBe(2);
  });

  it("runs overlapping turns of one conversation one after the other", async () => {
    // Without serialising, the second turn reads the sent-count before the first
    // has recorded it and re-sends the opening message.
    stub = await startStubCopilot({ respond: () => [botMessage("ok"), completion()], delayMs: 50 });
    const { url } = await start();
    const first = [{ role: "user", content: "UNIQUEFIRST" }];
    await Promise.all([
      post(url, { messages: first }),
      post(url, { messages: [...first, { role: "assistant", content: "ok" }, { role: "user", content: "UNIQUESECOND" }] }),
    ]);

    const texts = stub.connections.flatMap((c) => c.frames.filter((f) => f.type === 4)).map((f) => f.arguments[0].message.text);
    const second = texts.find((text: string) => text.includes("UNIQUESECOND"));
    expect(second).toBeDefined();
    expect(second).not.toContain("UNIQUEFIRST");
  });
});

describe("pasted images", () => {
  const PNG = "data:image/png;base64,iVBORw0KGgo=";
  const JPEG = "data:image/jpeg;base64,/9j/4AAQ";
  const withImage = (text: string, url: string) => ({
    role: "user",
    content: [
      { type: "text", text },
      { type: "image_url", image_url: { url } },
    ],
  });
  const chatMessages = (server: StubServer) =>
    server.connections.flatMap((c) => c.frames.filter((f) => f.type === 4)).map((f) => f.arguments[0].message);

  it("uploads an image from the request and attaches it to the turn", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("a cat"), completion()] });
    const { url } = await start();
    const response = await post(url, { messages: [withImage("what is this?", PNG)] });

    expect(response.status).toBe(200);
    expect(stub.uploads.map((upload) => upload.form.get("FileBase64"))).toEqual([PNG]);
    const [message] = chatMessages(stub);
    expect(message.text).toContain("what is this?");
    expect(message.messageAnnotations.map((a: any) => a.id)).toEqual(["doc-1"]);
  });

  it("does not re-upload an earlier image when the client resends the history", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("ok"), completion()] });
    const { url } = await start();
    const first = [withImage("first", PNG)];
    await post(url, { messages: first });
    await post(url, { messages: [...first, { role: "assistant", content: "ok" }, withImage("second", JPEG)] });

    expect(stub.uploads.map((upload) => upload.form.get("FileBase64"))).toEqual([PNG, JPEG]);
    expect(chatMessages(stub).map((m: any) => m.messageAnnotations?.length)).toEqual([1, 1]);
  });

  it("gives an image-only message some text, so the turn is not empty", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("ok"), completion()] });
    const { url } = await start();
    await post(url, { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: PNG } }] }] });

    const [message] = chatMessages(stub);
    expect(message.text.trim()).not.toBe("");
    expect(message.messageAnnotations).toHaveLength(1);
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

  it("also answers locally when the request is flagged as a title request", async () => {
    // opencode 2 has no `small_model`, so the v2 plugin cannot point titling at the
    // local model by id. It flags the request kind on a header instead, and the
    // decision of what M365 actually receives stays here in the proxy.
    stub = await startStubCopilot();
    const { url } = await start();
    const response = await authedFetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [AUX_REQUEST_KIND_HEADER]: "title" },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages: [{ role: "user", content: "refactor the auth middleware" }],
      }),
    });
    const body: any = await response.json();
    expect(body.choices[0].message.content.toLowerCase()).toContain("refactor");
    expect(stub.connections).toHaveLength(0);
  });

  it("does not hijack a normal turn that carries some other request kind", async () => {
    // Compaction and generate are real model work; only titling opens a conversation
    // we cannot afford. See models.ts for why the distinction matters.
    stub = await startStubCopilot({ respond: () => [botMessage("summary"), completion()] });
    const { url } = await start();
    const response = await authedFetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [AUX_REQUEST_KIND_HEADER]: "compaction" },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages: [{ role: "user", content: "summarise the conversation" }],
      }),
    });
    const body: any = await response.json();
    expect(body.choices[0].message.content).toBe("summary");
    expect(stub.connections).toHaveLength(1);
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

describe("a give-up on a tool turn", () => {
  const giveUp = "I can't run commands because no shell execution tool is available in this session.";
  const chats = () => stub!.connections.map((c) => c.frames.find((f) => f.type === 4 && f.target === "chat"));

  it("asks once more in the same conversation, and returns the tool call that follows", async () => {
    let turn = 0;
    stub = await startStubCopilot({
      respond: () => [streamItem(turn++ === 0 ? giveUp : "```bash\nls\n```"), completion()],
    });
    const { url } = await start();
    const body: any = await (await post(url, { messages: [{ role: "user", content: "list files" }], tools: [bashTool] })).json();
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    const [first, second] = chats();
    expect(second.arguments[0].conversationId).toBe(first.arguments[0].conversationId);
    expect(second.arguments[0].message.text).toMatch(/first step/i);
  });

  it("words the nudge for a task already under way", async () => {
    let turn = 0;
    stub = await startStubCopilot({ respond: () => [streamItem(turn++ === 0 ? giveUp : "```bash\nls\n```"), completion()] });
    const { url } = await start();
    await post(url, {
      messages: [
        { role: "user", content: "list files" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{\"command\":\"pwd\"}" } }] },
        { role: "tool", tool_call_id: "c1", content: "/tmp/w" },
      ],
      tools: [bashTool],
    });
    expect(chats()[1].arguments[0].message.text).toMatch(/really ran/);
  });

  it("gives up after one nudge rather than looping", async () => {
    stub = await startStubCopilot({ respond: () => [streamItem(giveUp), completion()] });
    const { url } = await start();
    const body: any = await (await post(url, { messages: [{ role: "user", content: "list files" }], tools: [bashTool] })).json();
    expect(body.choices[0].message.content).toBe(giveUp);
    expect(stub.connections).toHaveLength(2);
  });

  it("leaves a real answer alone", async () => {
    stub = await startStubCopilot({ respond: () => [streamItem("There are three files."), completion()] });
    const { url } = await start();
    await post(url, { messages: [{ role: "user", content: "how many files?" }], tools: [bashTool] });
    expect(stub.connections).toHaveLength(1);
  });

  it("never nudges a turn without tools", async () => {
    stub = await startStubCopilot({ respond: () => [streamItem(giveUp), completion()] });
    const { url } = await start();
    await post(url, { messages: [{ role: "user", content: "hi" }] });
    expect(stub.connections).toHaveLength(1);
  });
});

describe("after a disengage", () => {
  const send = (url: string, messages: unknown[]) =>
    authedFetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [SESSION_ID_HEADER]: "ses_d" },
      body: JSON.stringify({ messages, tools: [bashTool] }),
    });
  const conversationIds = () => stub!.connections.map((c) => new URL(c.url, "http://x").searchParams.get("ConversationId"));

  it("starts the next request in a fresh conversation with the whole history", async () => {
    let turn = 0;
    stub = await startStubCopilot({
      respond: () => (turn++ === 1 ? [disengaged(), completion()] : [streamItem("```bash\nls\n```"), completion()]),
    });
    const { url } = await start();
    const opener = { role: "user", content: "UNIQUEOPENER list the files" };
    const call = { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] };
    const result = { role: "tool", tool_call_id: "c1", content: "a.py" };

    await send(url, [opener]);
    expect((await send(url, [opener, call, result])).status).toBe(422);
    await send(url, [opener, call, result]);

    const ids = conversationIds();
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[1]);
    const replay = stub.last().frames.find((f) => f.type === 4).arguments[0].message.text;
    expect(replay).toContain("UNIQUEOPENER");
    expect(replay).toContain("```bash\nls\n```");
    expect(replay).toContain("a.py");
  });

  it("says the next request starts over", async () => {
    stub = await startStubCopilot({ respond: () => [disengaged(), completion()] });
    const { url } = await start();
    const body: any = await (await send(url, [{ role: "user", content: "hi" }])).json();
    expect(body.error.message).toMatch(/fresh conversation/);
  });
});

describe("telling the model what ran", () => {
  const tool = { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] };
  const conversation = (stubReply: string) => async () => {
    let turn = 0;
    stub = await startStubCopilot({ respond: () => [streamItem(turn++ === 0 ? stubReply : "done"), completion()] });
    const { url } = await start();
    const send = (messages: unknown[]) =>
      authedFetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [SESSION_ID_HEADER]: "ses_n" },
        body: JSON.stringify({ messages, tools: [bashTool] }),
      });
    const opener = { role: "user", content: "go" };
    await send([opener]);
    await send([opener, tool, { role: "tool", tool_call_id: "c1", content: "a.py" }]);
    return stub.last().frames.find((f) => f.type === 4).arguments[0].message.text as string;
  };

  it("says which calls in the last reply did not run", async () => {
    const text = await conversation("```bash\nls\n```\n\n```bash\npwd\n```\n\n```bash\nwhoami\n```")();
    expect(text).toMatch(/only the first .*ran/i);
    expect(text).toMatch(/2 others? did not run/i);
  });

  it("says a predicted result was set aside", async () => {
    const text = await conversation("```bash\nls\n```\n<tool_response>\nb.py\n</tool_response>")();
    expect(text).toMatch(/predicted/i);
  });

  it("adds nothing after a clean single call", async () => {
    const text = await conversation("```bash\nls\n```")();
    expect(text).not.toMatch(/did not run|predicted/i);
  });
});

describe("tool turns per tone", () => {
  const chatArg = () => stub!.last().frames.find((f) => f.type === 4).arguments[0];

  it("keeps the agent for a reasoning GPT tone, framed as a relay", async () => {
    stub = await startStubCopilot({ respond: () => [streamItem("```bash\nls\n```"), completion()] });
    const { url } = await start();
    await post(url, { model: "gpt-5.5-think-deeper", messages: [{ role: "user", content: "list" }], tools: [bashTool] });
    expect(chatArg().threadLevelGptId).toBeDefined();
    expect(chatArg().message.text).toMatch(/guide me through this from my terminal/);
  });

  it("sends a Sol tool turn agent-less, as a relay that names its sandbox", async () => {
    // A non-premium account answers Sol with the agent attached on a dead route.
    stub = await startStubCopilot({ respond: () => [streamItem("```bash\nls\n```"), completion()] });
    const { url } = await start();
    await post(url, { model: "gpt-6.1-sol", messages: [{ role: "user", content: "list" }], tools: [bashTool] });
    expect(chatArg().threadLevelGptId).toBeUndefined();
    expect(chatArg().message.text).toMatch(/guide me through this from my terminal/);
    expect(chatArg().message.text).toMatch(/\/mnt\/data/);
  });

  const cases: Array<[model: string, scenario: string, agent: boolean]> = [
    ["claude-opus", "OfficeWebPaidCopilot", true],
    ["claude-opus-4.8", "OfficeWebIncludedCopilot", true],
    ["claude-sonnet-5.5", "OfficeWebPaidCopilot", false],
    ["claude-sonnet-5", "OfficeWebPaidCopilot", false],
    ["claude-sonnet", "OfficeWebIncludedCopilot", false],
    ["claude-fable", "OfficeWebIncludedCopilot", false],
    ["gpt-6-think-deeper", "OfficeWebPaidCopilot", false],
    ["gpt-6-astra", "OfficeWebPaidCopilot", false],
    ["gpt-6.2-astra", "OfficeWebIncludedCopilot", false],
    ["quick", "OfficeWebIncludedCopilot", true],
  ];

  it.each(cases)("sends a %s tool turn on %s, agent attached: %s", async (model, scenario, agent) => {
    stub = await startStubCopilot({ respond: () => [streamItem("```bash\nls\n```"), completion()] });
    const { url } = await start();
    await post(url, { model, messages: [{ role: "user", content: "list" }], tools: [bashTool] });
    const query = new URL(stub.last().url, "http://x").searchParams;
    expect(query.get("scenario")).toBe(scenario);
    expect(query.get("licenseType")).toBe(scenario === "OfficeWebPaidCopilot" ? "Premium" : null);
    expect(chatArg().threadLevelGptId === undefined).toBe(!agent);
  });

  it("sends a paid model's plain chat on the paid scenario too", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("ok"), completion()] });
    const { url } = await start();
    await post(url, { model: "claude-sonnet-5.5", messages: [{ role: "user", content: "hi" }] });
    expect(new URL(stub.last().url, "http://x").searchParams.get("scenario")).toBe("OfficeWebPaidCopilot");
  });

  it("leaves the default model as it was", async () => {
    stub = await startStubCopilot({ respond: () => [streamItem("```bash\nls\n```"), completion()] });
    const { url } = await start();
    await post(url, { model: "quick", messages: [{ role: "user", content: "list" }], tools: [bashTool] });
    expect(chatArg().threadLevelGptId).toBeDefined();
    expect(chatArg().message.text).not.toMatch(/guide me through/);
  });
});

describe("the turn log", () => {
  it("records what M365 sent back and what was parsed out of it", async () => {
    stub = await startStubCopilot({
      respond: () => [streamItem("```bash\nls\n```", { contentOrigin: "DeepLeo", turnCount: 1 }), completion()],
    });
    const entries: any[] = [];
    const { url } = await start({ turnLog: (entry: unknown) => entries.push(entry) });
    await post(url, { model: "quick", messages: [{ role: "user", content: "list files" }], tools: [bashTool] });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      model: "quick",
      tone: "Gpt_5_5_Chat",
      agent: true,
      tools: ["bash"],
      reply: "```bash\nls\n```",
      toolCalls: ["bash"],
      contentOrigin: "DeepLeo",
      turnCount: 1,
    });
  });

  it("records a failed turn too", async () => {
    stub = await startStubCopilot({ respond: () => [completion("Failed to invoke 'Chat'")] });
    const entries: any[] = [];
    const { url } = await start({ turnLog: (entry: unknown) => entries.push(entry) });
    await post(url, { messages: [{ role: "user", content: "hi" }] });
    expect(entries[0].error).toMatch(/Failed to invoke/);
  });
});

const OPUS_DAILY =
  "You've used your available priority access to the Opus model for today. You can choose another available model or wait until tomorrow to use the Opus model again.";

describe("refusals opencode must not retry", () => {
  // opencode always streams, so a refusal reaches it inside a 200 stream, and it then
  // decides from the error's code and wording alone. 2.2.0 got that wrong: a licence
  // refusal was retried ten times.
  const scenarios = {
    throttled: () => [
      { type: 2, item: { messages: [], result: { value: "Throttled", errorCode: "PerUserThrottled", message: "Rate limit hit: too many requests" } } },
      completion(),
    ],
    "not served": () => [
      {
        type: 2,
        item: {
          messages: [],
          result: { value: "InternalError", message: "ClaudeUnavailableForLicense: Claude isn't available with your current license. Choose another model and try again." },
        },
      },
      completion(),
    ],
    "licence (paid scenario)": () => [
      {
        type: 2,
        item: {
          messages: [{ author: "bot", text: "It looks like you don't have a valid licence. Please try again later.", contentOrigin: "BotConnection" }],
          result: { value: "ForbiddenRequest", errorCode: "InvalidCopilotLicense", message: "It looks like you don't have a valid licence." },
        },
      },
      completion(),
    ],
    "priority access exhausted": () => [
      { type: 2, item: { messages: [], result: { value: "OutOfCredits", message: OPUS_DAILY, creditScenario: "TotalTurn" } } },
      completion(),
    ],
    disengaged: () => [disengaged(), completion()],
    rejected: () => [completion("Failed to invoke 'Chat'. Please try again.")],
  };

  const streamedError = (text: string) => {
    const line = text.split("\n").find((l) => l.startsWith("data: {") && l.includes('"error"'));
    return JSON.parse(line!.slice("data: ".length));
  };

  for (const [name, respond] of Object.entries(scenarios)) {
    it(`words a ${name} refusal so a streaming client does not retry it`, async () => {
      stub = await startStubCopilot({ respond });
      const { url } = await start();
      const text = await (await post(url, { stream: true, messages: [{ role: "user", content: "hi" }], tools: [bashTool] })).text();
      const body = streamedError(text);
      expect(body.error.code).toMatch(/^m365_/);
      expect(opencodeWouldRetry(undefined, body), JSON.stringify(body)).toBe(false);
    });

    it(`answers a ${name} refusal with a 422 opencode does not retry`, async () => {
      stub = await startStubCopilot({ respond });
      const { url } = await start();
      const response = await post(url, { messages: [{ role: "user", content: "hi" }], tools: [bashTool] });
      expect(response.status).toBe(422);
      expect(opencodeWouldRetry(422, (await response.json()) as any)).toBe(false);
    });
  }
});

describe("failures the client has to be able to tell apart", () => {
  it("reports a throttle as non-retryable, since every retry extends it", async () => {
    // opencode retried a 429 eleven times in 80s against a fake backend.
    stub = await startStubCopilot({
      respond: () => [
        { type: 2, item: { messages: [], result: { value: "Throttled", errorCode: "PerUserThrottled", message: "Slow down" } } },
        completion(),
      ],
    });
    const { url } = await start();
    const response = await post(url, { messages: [{ role: "user", content: "hi" }] });
    expect(response.status).toBe(422);
    expect(((await response.json()) as any).error.code).toBe("m365_throttled");
  });

  it("reports a model this account cannot use as not served, with M365's reason", async () => {
    stub = await startStubCopilot({
      respond: () => [
        {
          type: 2,
          item: {
            messages: [{ author: "bot", text: "This model requires a Premium license.", contentOrigin: "BotConnection" }],
            result: { value: "InternalError", message: "This model requires a Premium license." },
          },
        },
        completion(),
      ],
    });
    const { url } = await start();
    const response = await post(url, { messages: [{ role: "user", content: "hi" }] });
    expect(response.status).toBe(422);
    const body: any = await response.json();
    expect(body.error.code).toBe("m365_not_served");
    expect(body.error.message).toMatch(/Premium license/);
  });

  it("reports a paid model on a non-premium seat as needing a premium licence", async () => {
    stub = await startStubCopilot({
      respond: () => [
        {
          type: 2,
          item: {
            messages: [{ author: "bot", text: "It looks like you don't have a valid licence.", contentOrigin: "BotConnection" }],
            result: { value: "ForbiddenRequest", errorCode: "InvalidCopilotLicense", message: "It looks like you don't have a valid licence." },
          },
        },
        completion(),
      ],
    });
    const { url } = await start();
    const response = await post(url, { model: "claude-opus", messages: [{ role: "user", content: "hi" }] });
    expect(response.status).toBe(422);
    const body: any = await response.json();
    expect(body.error.code).toBe("m365_not_served");
    expect(body.error.param).toBe("premium_licence_required");
    expect(body.error.message).toMatch(/premium Microsoft 365 Copilot licen[cs]e/i);
    expect(stub.connections).toHaveLength(1);
  });

  it("reports an exhausted priority-access allowance once, without continue retries", async () => {
    // The refusal only rides in the final item, so a stream reader would see an empty
    // turn and nudge it with "continue" — each nudge another refused turn.
    stub = await startStubCopilot({
      respond: () => [
        { type: 2, item: { messages: [], result: { value: "OutOfCredits", message: OPUS_DAILY, creditScenario: "TotalTurn" } } },
        completion(),
      ],
    });
    const { url } = await start();
    const text = await (
      await post(url, { model: "claude-opus", stream: true, messages: [{ role: "user", content: "hi" }], tools: [bashTool] })
    ).text();
    const line = text.split("\n").find((l) => l.startsWith("data: {") && l.includes('"error"'));
    const body = JSON.parse(line!.slice("data: ".length));
    expect(body.error.code).toBe("m365_not_served");
    expect(body.error.param).toBe("priority_access_exhausted");
    expect(body.error.message).toMatch(/allowance .*used up/i);
    expect(body.error.message).toMatch(/midnight UTC/);
    expect(body.error.message).toMatch(/Opus model for today/);
    const chats = stub.connections.flatMap((c) => c.frames.filter((f) => f.type === 4));
    expect(chats).toHaveLength(1);
  });

  it("reports Disengaged distinctly rather than as a generic error", async () => {
    stub = await startStubCopilot({ respond: () => [disengaged(), completion()] });
    const { url } = await start();
    const response = await post(url, { messages: [{ role: "user", content: "hi" }], tools: [bashTool] });
    // Not a 5xx: opencode retries those, and retrying a disengage only makes it worse.
    expect(response.status).toBe(422);
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
    const response = await authedFetch(`${url}/v1/chat/completions`, {
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

  it("reports a rejected turn as non-retryable", async () => {
    // A retired tone fails every time, and opencode retries any 5xx several times over.
    stub = await startStubCopilot({ respond: () => [completion("Failed to invoke 'Chat'")] });
    const { url } = await start();
    const response = await post(url, { messages: [{ role: "user", content: "hi" }] });
    expect(response.status).toBe(422);
    expect((await response.json() as any).error.code).toBe("m365_turn_rejected");
  });

  it("reports a dropped connection as a 502, not an empty 200 completion", async () => {
    stub = await startStubCopilot({
      respond: (_chat, connection) => {
        setTimeout(() => connection.socket.close(1011, "gone"), 20);
        return [delta("half an ans")];
      },
    });
    const { url } = await start();
    const response = await post(url, { messages: [{ role: "user", content: "hi" }] });
    expect(response.status).toBe(502);
    expect(await response.text()).toMatch(/upstream_error/);
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

  it("retries agent resolution after a transient failure instead of caching it forever", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("ok"), completion()] });
    const resolveAgent = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("fetch failed: ECONNRESET"))
      .mockResolvedValue("T_t.b.gpt.default");
    const { url } = await start({ resolveAgent });
    await post(url, { messages: [{ role: "user", content: "a" }], tools: [bashTool] });
    expect(stub.last().frames.find((f) => f.type === 4).arguments[0].threadLevelGptId).toBeUndefined();
    await post(url, { messages: [{ role: "user", content: "b" }], tools: [bashTool] });
    expect(resolveAgent).toHaveBeenCalledTimes(2);
    expect(stub.last().frames.find((f) => f.type === 4).arguments[0].threadLevelGptId).toBeDefined();
  });

  it("stops retrying once Copilot Studio says the account has no access", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("ok"), completion()] });
    const resolveAgent = vi.fn(async (): Promise<string | null> => {
      throw Object.assign(new Error("M365 rejected listing agents (HTTP 403)"), { status: 403 });
    });
    const { url } = await start({ resolveAgent });
    await post(url, { messages: [{ role: "user", content: "a" }], tools: [bashTool] });
    await post(url, { messages: [{ role: "user", content: "b" }], tools: [bashTool] });
    expect(resolveAgent).toHaveBeenCalledTimes(1);
  });
});

describe("the mcp proxy over opencode 2's Code Mode catalogue", () => {
  // What opencode 2 sends: its own function tools (the lean trim keeps five), `execute`,
  // and a system prompt whose `# Code Mode` section lists the MCP tools, callable only as
  // JavaScript inside `execute`.
  const fixture = (name: string) => readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), "utf8");
  const leanTools = JSON.parse(fixture("opencode2-lean-tools.json"));
  const fn = (name: string, description: string, properties: Record<string, unknown>) => ({
    type: "function" as const,
    function: { name, description, parameters: { type: "object", properties } },
  });
  const executeTool = fn("execute", "Run JavaScript that calls the Code Mode tools", { code: { type: "string" } });
  const requestTools = [
    ...leanTools,
    fn("experimental_image_generate", "Generate an image", { prompt: { type: "string" } }),
    fn("webfetch", "Fetch a web page", { url: { type: "string" } }),
    executeTool,
  ];
  const systemFor = (section: string) => ({
    role: "system",
    content: `You are opencode, an interactive CLI agent.\n\n${section}\nToday's date: Thu Nov 19 2026\n\n<env>\nWorking directory: /home/user/app\n</env>`,
  });
  const system = systemFor(fixture("opencode2-codemode.txt"));
  const partialSystem = systemFor(fixture("opencode2-codemode-partial.txt"));
  const opener = { role: "user", content: "UNIQUEOPENER file a bug about the build" };
  const messages = [system, opener];

  const searchReply = "```mcp\nsearch: create a github issue\n```";
  const callArgs = { owner: "acme", repo: "app", title: "Broken build" };
  const callReply = "```mcp\ncall: tools.github.create_issue\n" + JSON.stringify(callArgs) + "\n```";
  const callCodeText = `return await tools.github.create_issue(${JSON.stringify(callArgs)});`;

  const chatText = (connection: { frames: any[] }) =>
    connection.frames.find((f) => f.type === 4).arguments[0].message.text as string;
  const blockNames = (text: string) => [...text.matchAll(/^```([a-z_]+)$/gm)].map((m) => m[1]);
  const catalogueLeaks = /Code Mode|tools\.github|tools\.opencode|Steps to reproduce|Post a message to a Slack channel/;

  /** A stub that answers each M365 turn with the next reply, repeating the last. */
  const scripted = (...replies: string[]) => {
    let turn = 0;
    return startStubCopilot({ respond: () => [streamItem(replies[Math.min(turn++, replies.length - 1)]!), completion()] });
  };

  const firstCall = (body: any) => body.choices[0].message.tool_calls?.[0];

  it("with the option off: no mcp tool, no execute, and the whole catalogue stripped", async () => {
    stub = await scripted("ok");
    const { url } = await start();
    await post(url, { messages, tools: requestTools });
    const text = chatText(stub.last());
    expect(blockNames(text)).not.toContain("mcp");
    expect(blockNames(text)).not.toContain("execute");
    expect(text).not.toMatch(catalogueLeaks);
    expect(text).toContain("Working directory: /home/user/app");
  });

  it("ignores the old, unreleased `mcp` dep: only `mcpProxy` turns the proxy on", async () => {
    stub = await scripted("ok");
    const { url } = await start({ mcp: true });
    await post(url, { messages, tools: requestTools });
    expect(blockNames(chatText(stub.last()))).not.toContain("mcp");
  });

  for (const lean of [true, false]) {
    it(`with the option on (lean ${lean ? "on" : "off"}): offers mcp, never execute, and never the catalogue`, async () => {
      stub = await scripted("ok");
      const { url } = await start({ mcpProxy: true, lean });
      await post(url, { messages, tools: requestTools });
      const text = chatText(stub.last());
      const offered = blockNames(text);
      expect(offered).toContain("mcp");
      expect(offered).toContain("shell");
      expect(offered).not.toContain("execute");
      expect(text).not.toMatch(catalogueLeaks);
      expect(text).not.toContain("`execute`");
      expect(text).toMatch(/Use 12 tools from my MCP servers/);
      expect(text).toContain("github (create_issue");
    });
  }

  it("offers no mcp tool when the prompt has no Code Mode catalogue", async () => {
    stub = await scripted("ok");
    const { url } = await start({ mcpProxy: true });
    await post(url, { messages: [opener], tools: requestTools });
    const offered = blockNames(chatText(stub.last()));
    expect(offered).not.toContain("mcp");
    expect(offered).not.toContain("execute");
  });

  it("answers a search in the same conversation, with the matches' signatures", async () => {
    stub = await scripted(searchReply, "Found it.");
    const { url } = await start({ mcpProxy: true });
    const body: any = await (await post(url, { messages, tools: requestTools })).json();

    expect(stub.connections).toHaveLength(2);
    const [first, second] = stub.connections.map((c) => c.frames.find((f) => f.type === 4).arguments[0]);
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.message.text).toContain('Tools matching "create a github issue"');
    expect(second.message.text).toContain("tools.github.create_issue({");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.choices[0].message.content).toBe("Found it.");
  });

  it("turns a call into an execute tool call with the exact code", async () => {
    stub = await scripted(searchReply, callReply);
    const { url } = await start({ mcpProxy: true });
    const body: any = await (await post(url, { messages, tools: requestTools })).json();

    expect(stub.connections).toHaveLength(2);
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.choices[0].message.tool_calls).toHaveLength(1);
    const call = firstCall(body).function;
    expect(call.name).toBe("execute");
    expect(JSON.parse(call.arguments)).toEqual({ code: callCodeText });
  });

  it("accepts a catalogued call without a search first, and `key: value` arguments", async () => {
    stub = await scripted("```mcp\ncall: tools.slack.post_message\nchannel: general\ntext: hello there\n```");
    const { url } = await start({ mcpProxy: true });
    const body: any = await (await post(url, { messages, tools: requestTools })).json();

    expect(stub.connections).toHaveLength(1);
    expect(JSON.parse(firstCall(body).function.arguments)).toEqual({
      code: 'return await tools.slack.post_message({"channel":"general","text":"hello there"});',
    });
  });

  it("calls a bracket-notation tool by its exact path", async () => {
    stub = await scripted('```mcp\ncall: tools.github["search-code"]\n{"q": "TODO"}\n```');
    const { url } = await start({ mcpProxy: true });
    const body: any = await (await post(url, { messages, tools: requestTools })).json();
    expect(JSON.parse(firstCall(body).function.arguments)).toEqual({
      code: 'return await tools.github["search-code"]({"q":"TODO"});',
    });
  });

  it("answers an unknown path in the proxy, and never sends it to opencode", async () => {
    stub = await scripted("```mcp\ncall: tools.github.delete_repo\n{}\n```", "I could not find it.");
    const { url } = await start({ mcpProxy: true });
    const body: any = await (await post(url, { messages, tools: requestTools })).json();

    expect(stub.connections).toHaveLength(2);
    expect(chatText(stub.connections[1]!)).toContain("There is no tool tools.github.delete_repo");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.choices[0].message.content).toBe("I could not find it.");
  });

  it("answers an unreadable mcp block in the proxy with the expected shape", async () => {
    stub = await scripted("```mcp\ncall: tools.github.create_issue\n{not json\n```", "ok");
    const { url } = await start({ mcpProxy: true });
    await post(url, { messages, tools: requestTools });
    expect(stub.connections).toHaveLength(2);
    const text = chatText(stub.connections[1]!);
    expect(text).toContain("could not be read: the arguments are not valid JSON");
    expect(text).toContain("call: tools.<server>.<tool>");
  });

  it("never emits an execute call for an execute block the model wrote itself", async () => {
    stub = await scripted("```execute\nreturn await tools.github.create_issue({});\n```");
    const { url } = await start({ mcpProxy: true });
    const body: any = await (await post(url, { messages, tools: requestTools })).json();
    expect(body.choices[0].message.tool_calls).toBeUndefined();
  });

  it("sends a search with no local match to opencode's own search when the catalogue is partial", async () => {
    stub = await scripted("```mcp\nsearch: zebra quokka\n```");
    const { url } = await start({ mcpProxy: true });
    const body: any = await (await post(url, { messages: [partialSystem, opener], tools: requestTools })).json();

    expect(stub.connections).toHaveLength(1);
    const call = firstCall(body).function;
    expect(call.name).toBe("execute");
    expect(JSON.parse(call.arguments)).toEqual({ code: 'return await search("zebra quokka");' });
  });

  it("answers a search with no match itself when the catalogue is complete", async () => {
    stub = await scripted("```mcp\nsearch: zebra quokka\n```", "Nothing there.");
    const { url } = await start({ mcpProxy: true });
    const body: any = await (await post(url, { messages, tools: requestTools })).json();
    expect(stub.connections).toHaveLength(2);
    expect(chatText(stub.connections[1]!)).toContain('No tool matched "zebra quokka"');
    expect(body.choices[0].message.content).toBe("Nothing there.");
  });

  it("accepts any well-formed path when the catalogue is partial", async () => {
    stub = await scripted('```mcp\ncall: tools.linear.create_ticket\n{"title": "x"}\n```');
    const { url } = await start({ mcpProxy: true });
    const body: any = await (await post(url, { messages: [partialSystem, opener], tools: requestTools })).json();
    expect(JSON.parse(firstCall(body).function.arguments)).toEqual({
      code: 'return await tools.linear.create_ticket({"title":"x"});',
    });
  });

  it("stops after 3 proxy answers and returns the prose, never an mcp call", async () => {
    stub = await scripted("Let me look.\n\n```mcp\nsearch: something else\n```");
    const { url } = await start({ mcpProxy: true });
    const body: any = await (await post(url, { messages, tools: requestTools })).json();

    expect(stub.connections).toHaveLength(4);
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.choices[0].message.tool_calls).toBeUndefined();
    expect(body.choices[0].message.content).not.toContain("```mcp");
    expect(body.choices[0].message.content).toContain("Let me look.");
  });

  it("counts unknown paths toward the cap too", async () => {
    stub = await scripted("```mcp\ncall: tools.nope.nothing\n{}\n```");
    const { url } = await start({ mcpProxy: true });
    const body: any = await (await post(url, { messages, tools: requestTools })).json();
    expect(stub.connections).toHaveLength(4);
    expect(body.choices[0].message.tool_calls).toBeUndefined();
  });

  it("streams the execute call after a search, never an mcp call", async () => {
    stub = await scripted(searchReply, callReply);
    const { url } = await start({ mcpProxy: true });
    const text = await (await post(url, { stream: true, messages, tools: requestTools })).text();
    expect(text).toContain('"name":"execute"');
    expect(text).toContain(JSON.stringify(JSON.stringify({ code: callCodeText })).slice(1, -1));
    expect(text).not.toContain('"name":"mcp"');
    expect(text).toContain('"finish_reason":"tool_calls"');
    expect(text).toContain("[DONE]");
  });

  it("never streams an mcp call, even past the cap", async () => {
    stub = await scripted(searchReply);
    const { url } = await start({ mcpProxy: true });
    const text = await (await post(url, { stream: true, messages, tools: requestTools })).text();
    expect(text).not.toContain("tool_calls");
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain("[DONE]");
  });

  it("records each search and the call in the turn log", async () => {
    stub = await scripted(searchReply, callReply);
    const entries: any[] = [];
    const { url } = await start({ mcpProxy: true, turnLog: (entry: unknown) => entries.push(entry) });
    await post(url, { messages, tools: requestTools });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ toolCalls: ["mcp"] });
    expect(entries[0].mcpSearch).toBeUndefined();
    expect(entries[0].mcpCall).toBeUndefined();
    expect(entries[1]).toMatchObject({ mcpSearch: "create a github issue", mcpCall: "tools.github.create_issue" });
    expect(entries[1].tools).toContain("mcp");
    expect(entries[1].tools).not.toContain("execute");
  });

  it("sends only the new tool result on the next request, labelled as the mcp tool's", async () => {
    stub = await scripted(callReply, "Filed as #42.");
    const { url } = await start({ mcpProxy: true });
    const send = (history: unknown[]) =>
      authedFetch(`${url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [SESSION_ID_HEADER]: "ses_mcp" },
        body: JSON.stringify({ messages: history, tools: requestTools }),
      });
    const first: any = await (await send(messages)).json();
    const call = firstCall(first);
    const second: any = await (
      await send([
        ...messages,
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: "UNIQUERESULT issue #42" },
      ])
    ).json();

    expect(stub.connections).toHaveLength(2);
    const text = chatText(stub.last());
    expect(text).toContain("UNIQUERESULT");
    expect(text).toContain('<tool_response tool="mcp">');
    expect(text).not.toContain("UNIQUEOPENER");
    expect(text).not.toMatch(catalogueLeaks);
    expect(second.choices[0].message.content).toBe("Filed as #42.");
  });

  it("replays the proxy's execute calls into a fresh conversation as the mcp blocks the model wrote", async () => {
    stub = await scripted("ok");
    const { url } = await start({ mcpProxy: true });
    const executeCall = (id: string, code: string) => ({
      id,
      type: "function",
      function: { name: "execute", arguments: JSON.stringify({ code }) },
    });
    await post(url, {
      messages: [
        partialSystem,
        opener,
        { role: "assistant", content: null, tool_calls: [executeCall("c1", 'return await search("linear tickets");')] },
        { role: "tool", tool_call_id: "c1", content: "SEARCHRESULT tools.linear.create_ticket" },
        { role: "assistant", content: null, tool_calls: [executeCall("c2", callCodeText)] },
        { role: "tool", tool_call_id: "c2", content: "CALLRESULT #42" },
        { role: "assistant", content: null, tool_calls: [executeCall("c3", "const x = 1; return x;")] },
        { role: "tool", tool_call_id: "c3", content: "OTHERRESULT" },
        { role: "user", content: "and now?" },
      ],
      tools: requestTools,
    });

    const text = chatText(stub.last());
    expect(text).toContain("```mcp\nsearch: linear tickets\n```");
    expect(text).toContain("```mcp\ncall: tools.github.create_issue\n" + JSON.stringify(callArgs) + "\n```");
    expect(text).toContain('<tool_response tool="mcp">\nSEARCHRESULT');
    expect(text).toContain('<tool_response tool="mcp">\nCALLRESULT');
    // Code the proxy did not write renders as it always has.
    expect(text).toContain("```execute");
    expect(text).toContain("const x = 1; return x;");
  });
});

describe("stripMcpCalls", () => {
  it("drops an mcp block and keeps the prose around it", () => {
    expect(stripMcpCalls("Looking.\n\n```mcp\nsearch: x\n```\n\nThen more.")).toBe("Looking.\n\nThen more.");
  });

  it("leaves a reply without an mcp block untouched", () => {
    const text = "  Some prose.\n\n\n```bash\nls\n```\n";
    expect(stripMcpCalls(text)).toBe(text);
  });

  it("does not touch a block for a tool whose name only starts with mcp", () => {
    const text = "```mcp_server_tool\nx\n```";
    expect(stripMcpCalls(text)).toBe(text);
  });
});
