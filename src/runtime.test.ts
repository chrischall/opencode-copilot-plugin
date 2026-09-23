import { afterEach, describe, expect, it } from "vitest";
import { startRuntime, type M365Runtime } from "./runtime.js";

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
