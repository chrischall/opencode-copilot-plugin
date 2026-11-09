import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  agentInstructions,
  agentNameFor,
  buildAgentId,
  environmentHost,
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

/** The Copilot Studio surface as the live service shapes it. */
function studioRoutes(existing: object[], created: { botId?: string; titleId: string }): Array<[string, any]> {
  return [
    BAP_ROUTE,
    ["/publish?", () => ({ TitleId: created.titleId })],
    ["/copilotstudio/minimalBots/api?", (_url: string, init: any) =>
      init?.method === "POST" ? { bot: { schemaName: created.botId } } : existing],
  ];
}

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
    expect(buildAgentId("T_title9", "bot7")).toBe("T_title9.bot7.gpt.default");
  });
});

describe("environment host discovery", () => {
  it("splits the id's last two characters into their own DNS label", () => {
    expect(environmentHost("abc123ff")).toBe("defaultabc123.ff.environment.api.powerplatform.com");
  });

  it("does not hardcode the df label for tenants that end in something else", () => {
    expect(environmentHost(ENV_ID)).toBe(
      `default${ENV_ID.slice(0, -2)}.88.environment.api.powerplatform.com`,
    );
  });

  it("uses the powerplatform environment api domain", () => {
    expect(environmentHost(ENV_ID)).toMatch(/\.environment\.api\.powerplatform\.com$/);
  });

  it("returns the host when it resolves in DNS", async () => {
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
    const fetch = fakeFetch(studioRoutes([], { botId: "B1", titleId: "T_1" }));
    expect(await getOrCreateAgent(deps({ fetch }))).toBe("T_1.B1.gpt.default");
  });

  it("publishes at the bot's own path", async () => {
    const fetch = fakeFetch(studioRoutes([], { botId: "B1", titleId: "T_1" }));
    await getOrCreateAgent(deps({ fetch }));
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/minimalBots/api/B1/publish?"))).toBe(true);
  });

  it("re-publishes an agent another host provisioned, because the list has no title id", async () => {
    const name = agentNameFor(agentInstructions());
    const fetch = fakeFetch(studioRoutes([{ shortBotName: name, botId: "B9" }], { titleId: "T_9" }));
    expect(await getOrCreateAgent(deps({ fetch }))).toBe("T_9.B9.gpt.default");
    expect(fetch.mock.calls.some(([, init]) => init?.body)).toBe(false);
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
    const fetch = fakeFetch(studioRoutes([], { botId: "B2", titleId: "T_2" }));
    expect(await getOrCreateAgent(deps({ fetch, cacheFile }))).toBe("T_2.B2.gpt.default");
  });

  it("caches what it provisioned so the next process skips the work", async () => {
    const cacheFile = tempFile();
    const fetch = fakeFetch(studioRoutes([], { botId: "B3", titleId: "T_3" }));
    await getOrCreateAgent(deps({ fetch, cacheFile }));
    expect(JSON.parse(readFileSync(cacheFile, "utf8")).agentId).toBe("T_3.B3.gpt.default");
  });

  it("never deletes an existing agent", async () => {
    // Another host on the same tenant may be mid-conversation with it.
    const fetch = fakeFetch(
      studioRoutes([{ shortBotName: "m365-tool-agent-oldoldold", botId: "B0" }], { botId: "B4", titleId: "T_4" }),
    );
    await getOrCreateAgent(deps({ fetch }));
    expect(fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("creates the bot as a gpt component carrying the instructions and an icon", async () => {
    const fetch = fakeFetch(studioRoutes([], { botId: "B5", titleId: "T_5" }));
    await getOrCreateAgent(deps({ fetch }));
    const create = fetch.mock.calls.find(([url, init]) => init?.method === "POST" && init?.body && String(url).includes("minimalBots"));
    const body = JSON.parse(String(create?.[1]?.body));
    expect(body.bot.template).toBe("gpt-1.1.0");
    expect(body.bot.iconBase64.length).toBeGreaterThan(0);
    const component = body.botComponentChanges[0].component;
    expect(component.$kind).toBe("GptComponent");
    expect(component.metadata.instructions.segments[0].value).toContain("fenced");
  });

  it("fails rather than building an id when create returns no bot", async () => {
    const fetch = fakeFetch(studioRoutes([], { titleId: "T_6" }));
    await expect(getOrCreateAgent(deps({ fetch }))).rejects.toThrow(/no bot id/);
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

  it("carries the HTTP status on a rejection, so a caller can tell no-access from a blip", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (String(url).includes("api.bap.microsoft.com")) {
        return { ok: true, status: 200, json: async () => ({ name: `Default-${TENANT}` }) } as any;
      }
      return { ok: false, status: 403, json: async () => ({}), text: async () => "Forbidden" } as any;
    });
    await expect(getOrCreateAgent(deps({ fetch }))).rejects.toMatchObject({ status: 403 });
  });
});
