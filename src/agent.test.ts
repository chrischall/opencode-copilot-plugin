import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  agentInstructions,
  agentNameFor,
  buildAgentId,
  environmentHostCandidates,
  getOrCreateAgent,
  resolveEnvironmentHost,
} from "./agent.js";

const tempFile = () => join(mkdtempSync(join(tmpdir(), "m365-agent-")), "agent-id.json");

const TENANT = "11112222-3333-4444-5555-666677778888";
const ENV_ID = TENANT.replace(/-/g, "");

/** A fetch stand-in that dispatches on URL substring. */
function fakeFetch(routes: Array<[string, (url: string, init: any) => any]>) {
  return vi.fn(async (url: string, init: any) => {
    for (const [needle, handler] of routes) {
      if (url.includes(needle)) {
        const body = handler(url, init);
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as any;
      }
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" } as any;
  });
}

function deps(overrides: Record<string, any> = {}) {
  return {
    getTokenForScope: async () => "token",
    resolveDns: async (host: string) => host.startsWith(`default${ENV_ID.slice(0, -2)}.`),
    cacheFile: tempFile(),
    ...overrides,
  };
}

const BAP_ROUTE: [string, any] = ["api.bap.microsoft.com", () => ({ name: `Default-${TENANT}` })];

describe("agent instructions", () => {
  it("describe the fenced format the parser expects", () => {
    expect(agentInstructions()).toMatch(/fenc|code block/i);
  });

  it("stay minimal and format-only", () => {
    // Heavy behavioural framing baked into the agent measurably backfired — it
    // suppressed tool calls to zero. Behavioural framing belongs in the per-request
    // <tools> block, where it can be changed without re-provisioning an agent.
    expect(agentInstructions().length).toBeLessThan(1200);
  });

  it("avoid the jailbreak shapes that trip the Disengaged filter", () => {
    const instructions = agentInstructions();
    expect(instructions).not.toMatch(/<\/?system>|<\/?user>|<\/?assistant>/i);
    expect(instructions).not.toMatch(/STRICT RULES|ONLY JSON|NEVER describe/);
  });
});

describe("agent naming", () => {
  it("derives a stable name from the instructions", () => {
    expect(agentNameFor("abc")).toBe(agentNameFor("abc"));
    expect(agentNameFor("abc")).toMatch(/^m365-tool-agent-[0-9a-f]{8}$/);
  });

  it("changes when the instructions change, so a new agent gets provisioned", () => {
    // Instructions are baked in at creation and cannot be cheaply updated in place.
    expect(agentNameFor("abc")).not.toBe(agentNameFor("abd"));
  });

  it("gives every host on a tenant the same name for the same instructions", () => {
    // Which is what lets independent hosts converge on one agent with no coordination.
    expect(agentNameFor(agentInstructions())).toBe(agentNameFor(agentInstructions()));
  });
});

describe("agent id", () => {
  it("assembles the id M365 expects on the chat frame", () => {
    expect(buildAgentId("title9", "bot7")).toBe("T_title9.bot7.gpt.default");
  });
});

describe("environment host discovery", () => {
  it("tries the full label and the label with the last two characters trimmed", () => {
    // The full-length label frequently fails to resolve; the trimmed one is what
    // actually works.
    const candidates = environmentHostCandidates(ENV_ID);
    expect(candidates[0]).toContain(`default${ENV_ID}.`);
    expect(candidates.some((host) => host.includes(`default${ENV_ID.slice(0, -2)}.`))).toBe(true);
  });

  it("uses the powerplatform environment api domain", () => {
    expect(environmentHostCandidates(ENV_ID)[0]).toMatch(/\.environment\.api\.powerplatform\.com$/);
  });

  it("picks the first candidate that resolves in DNS", async () => {
    const host = await resolveEnvironmentHost(ENV_ID, async (candidate) =>
      candidate.startsWith(`default${ENV_ID.slice(0, -2)}.`),
    );
    expect(host).toContain(`default${ENV_ID.slice(0, -2)}.`);
  });

  it("fails with a useful message when nothing resolves", async () => {
    await expect(resolveEnvironmentHost(ENV_ID, async () => false)).rejects.toThrow(/resolve/i);
  });

  it("honours an explicit override without touching DNS", async () => {
    const resolveDns = vi.fn(async () => true);
    const host = await resolveEnvironmentHost(ENV_ID, resolveDns, "my.host.example");
    expect(host).toBe("my.host.example");
    expect(resolveDns).not.toHaveBeenCalled();
  });
});

describe("getOrCreateAgent", () => {
  it("creates and publishes an agent when the tenant has none", async () => {
    const fetch = fakeFetch([
      BAP_ROUTE,
      ["minimalBots/api/botlist", () => ({ value: [] })],
      ["minimalBots/api/publish", () => ({ titleId: "T1" })],
      ["minimalBots/api", () => ({ botId: "B1" })],
    ]);
    const id = await getOrCreateAgent(deps({ fetch }));
    expect(id).toBe("T_T1.B1.gpt.default");
  });

  it("reuses an agent another host already provisioned for the same instructions", async () => {
    const name = agentNameFor(agentInstructions());
    const fetch = fakeFetch([
      BAP_ROUTE,
      ["minimalBots/api/botlist", () => ({ value: [{ shortBotName: name, botId: "B9", titleId: "T9" }] })],
    ]);
    const id = await getOrCreateAgent(deps({ fetch }));
    expect(id).toBe("T_T9.B9.gpt.default");
    expect(fetch.mock.calls.some(([url]) => String(url).includes("publish"))).toBe(false);
  });

  it("uses the cached id without any network at all", async () => {
    const cacheFile = tempFile();
    writeFileSync(
      cacheFile,
      JSON.stringify({ agentId: "T_cached.bot.gpt.default", instructionsHash: agentNameFor(agentInstructions()) }),
    );
    const fetch = vi.fn();
    expect(await getOrCreateAgent(deps({ fetch, cacheFile }))).toBe("T_cached.bot.gpt.default");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ignores a cache entry whose instructions have since changed", async () => {
    const cacheFile = tempFile();
    writeFileSync(cacheFile, JSON.stringify({ agentId: "T_stale.bot.gpt.default", instructionsHash: "m365-tool-agent-deadbeef" }));
    const fetch = fakeFetch([
      BAP_ROUTE,
      ["minimalBots/api/botlist", () => ({ value: [] })],
      ["minimalBots/api/publish", () => ({ titleId: "T2" })],
      ["minimalBots/api", () => ({ botId: "B2" })],
    ]);
    expect(await getOrCreateAgent(deps({ fetch, cacheFile }))).toBe("T_T2.B2.gpt.default");
  });

  it("caches what it provisioned so the next process skips the work", async () => {
    const cacheFile = tempFile();
    const fetch = fakeFetch([
      BAP_ROUTE,
      ["minimalBots/api/botlist", () => ({ value: [] })],
      ["minimalBots/api/publish", () => ({ titleId: "T3" })],
      ["minimalBots/api", () => ({ botId: "B3" })],
    ]);
    await getOrCreateAgent(deps({ fetch, cacheFile }));
    expect(JSON.parse(readFileSync(cacheFile, "utf8")).agentId).toBe("T_T3.B3.gpt.default");
  });

  it("never deletes an existing agent", async () => {
    // Another host on the same tenant may be mid-conversation with it.
    const fetch = fakeFetch([
      BAP_ROUTE,
      ["minimalBots/api/botlist", () => ({ value: [{ shortBotName: "m365-tool-agent-oldoldold", botId: "B0", titleId: "T0" }] })],
      ["minimalBots/api/publish", () => ({ titleId: "T4" })],
      ["minimalBots/api", () => ({ botId: "B4" })],
    ]);
    await getOrCreateAgent(deps({ fetch }));
    expect(fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("sends the instructions when creating the bot", async () => {
    const fetch = fakeFetch([
      BAP_ROUTE,
      ["minimalBots/api/botlist", () => ({ value: [] })],
      ["minimalBots/api/publish", () => ({ titleId: "T5" })],
      ["minimalBots/api", () => ({ botId: "B5" })],
    ]);
    await getOrCreateAgent(deps({ fetch }));
    const create = fetch.mock.calls.find(
      ([url, init]) => String(url).includes("minimalBots/api") && init?.method === "POST" && !String(url).includes("publish"),
    );
    expect(String(create?.[1]?.body)).toContain("fenced");
  });

  it("surfaces a licensing or permission failure rather than returning a bogus id", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (String(url).includes("api.bap.microsoft.com")) {
        return { ok: true, status: 200, json: async () => ({ name: `Default-${TENANT}` }) } as any;
      }
      return { ok: false, status: 403, json: async () => ({}), text: async () => "Forbidden" } as any;
    });
    await expect(getOrCreateAgent(deps({ fetch }))).rejects.toThrow(/403|Forbidden/);
  });
});
