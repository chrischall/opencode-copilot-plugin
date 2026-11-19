import { afterEach, describe, expect, it } from "vitest";
import { botMessage, completion, startStubCopilot, throttling, type StubServer } from "../test/stub-copilot.js";
import { startRuntime, type M365Runtime } from "./runtime.js";
import { SESSION_ID_HEADER, startServer, type ProxyHandle } from "./server.js";

let runtime: M365Runtime | undefined;
const savedKey = process.env.M365_PROXY_KEY;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  if (savedKey === undefined) delete process.env.M365_PROXY_KEY;
  else process.env.M365_PROXY_KEY = savedKey;
});

describe("the proxy secret the plugin hands opencode", () => {
  it("is the one the in-process proxy actually demands", async () => {
    runtime = await startRuntime({});
    expect(runtime.apiKey.length).toBeGreaterThanOrEqual(43);

    const authed = await fetch(`${runtime.baseUrl}/models`, { headers: { Authorization: `Bearer ${runtime.apiKey}` } });
    expect(authed.status).toBe(200);
    const anonymous = await fetch(`${runtime.baseUrl}/models`);
    expect(anonymous.status).toBe(401);
  });

  it("comes from the apiKey option when attaching to an external proxy", async () => {
    process.env.M365_PROXY_KEY = "from-env";
    runtime = await startRuntime({ baseUrl: "http://127.0.0.1:4141/v1", apiKey: "from-option" });
    expect(runtime.apiKey).toBe("from-option");
  });

  it("falls back to M365_PROXY_KEY for an external proxy", async () => {
    process.env.M365_PROXY_KEY = "from-env";
    runtime = await startRuntime({ baseUrl: "http://127.0.0.1:4141/v1" });
    expect(runtime.apiKey).toBe("from-env");
  });

  it("uses M365_PROXY_KEY for the in-process proxy too, when set", async () => {
    process.env.M365_PROXY_KEY = "a-shared-secret-for-the-in-process-proxy";
    runtime = await startRuntime({});
    expect(runtime.apiKey).toBe("a-shared-secret-for-the-in-process-proxy");
  });
});

describe("metrics when attached to an external proxy", () => {
  let stub: StubServer | undefined;
  let proxy: ProxyHandle | undefined;
  afterEach(async () => {
    await proxy?.close();
    await stub?.close();
    proxy = stub = undefined;
  });

  it("are read from that proxy, so the TUI status works with `serve` too", async () => {
    stub = await startStubCopilot({ respond: () => [throttling(9, 600), botMessage("ok"), completion()] });
    const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    proxy = await startServer({ getToken: async () => `${b64({ alg: "none" })}.${b64({ oid: "o", tid: "t" })}.sig`, endpoint: stub.origin });
    await fetch(`${proxy.url}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${proxy.apiKey}`, "Content-Type": "application/json", [SESSION_ID_HEADER]: "ses_e" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    runtime = await startRuntime({ baseUrl: `${proxy.url}/v1`, apiKey: proxy.apiKey });
    expect(runtime.metrics).toBeUndefined();
    expect(await runtime.remoteMetrics?.get("ses_e")).toMatchObject({ sessionID: "ses_e", conversation: { used: 9, max: 600 } });
  });
});
