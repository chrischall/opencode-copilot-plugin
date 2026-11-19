import { describe, expect, it } from "vitest";
import { buildModelInfos } from "./config.js";
import {
  DEFAULT_MODEL,
  LOCAL_TITLE_MODEL,
  MODEL_ALIASES,
  MODELS,
  isLocalModel,
  listModelIds,
  resolveModel,
  toneFor,
  toolRouteFor,
} from "./models.js";

describe("model catalog", () => {
  it("maps every M365-backed model id to a non-empty tone", () => {
    // Locally-served models (the titler) deliberately carry no tone — that null is
    // exactly what marks them as "never open a conversation".
    for (const model of MODELS.filter((candidate) => !isLocalModel(candidate.id))) {
      expect(model.tone, `${model.id} has no tone`).toBeTruthy();
    }
  });

  it("marks the work models mailbox-grounded, and leaves coding models ungrounded", () => {
    expect(resolveModel("work").grounded).toBe(true);
    expect(resolveModel("work-think").grounded).toBe(true);
    expect(resolveModel("work").tone).toBeTruthy();
    expect(resolveModel("gpt-5.5").grounded).toBeFalsy();
    // Addressed as m365/<id> by opencode; the provider-stripped form resolves too.
    expect(resolveModel("m365/work").grounded).toBe(true);
  });

  it("has unique ids", () => {
    const ids = MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // The tone is what actually selects the model server-side — there is no `model`
  // parameter in the M365 protocol (docs/m365-copilot-api.md §5).
  it("resolves the documented tones", () => {
    expect(toneFor("gpt-5.5-think-deeper")).toBe("Gpt_5_5_Reasoning");
    expect(toneFor("gpt-5.6-think-deeper")).toBe("Gpt_5_6_Reasoning");
    expect(toneFor("m365-copilot")).toBe("magic");
    expect(toneFor("quick")).toBe("Gpt_5_5_Chat");
    expect(toneFor("think-deeper")).toBe("Gpt_5_5_Reasoning");
    expect(toneFor("gpt-5.4-quick")).toBe("Gpt_5_4_Chat");
    expect(toneFor("gpt-5.3")).toBe("Gpt_5_3_Chat");
    expect(toneFor("gpt-5.2-quick")).toBe("Gpt_5_2_Chat");
    expect(toneFor("claude-sonnet")).toBe("Claude_Sonnet");
  });

  // The server fails these with `Failed to invoke 'Chat'`, and every retry is wasted.
  it("advertises no retired tone", () => {
    const retired = /_Quick$|^Gpt_Chat$|^Gpt_Reasoning$/;
    for (const model of MODELS) {
      expect(model.tone ?? "", `${model.id} selects a retired tone`).not.toMatch(retired);
    }
  });

  it("treats unknown model ids as the default rather than throwing", () => {
    // Harnesses send model ids we did not advertise; falling back beats a 400.
    expect(toneFor("something-we-never-shipped")).toBe(toneFor(DEFAULT_MODEL));
  });

  it("defaults to a chat tone, the kind measured making tool calls on a live tenant", () => {
    expect(DEFAULT_MODEL).toBe("quick");
    expect(resolveModel(DEFAULT_MODEL).reasoning).toBe(false);
  });

  it("offers the GPT-5.6 chat tone", () => {
    expect(toneFor("gpt-5.6")).toBe("Gpt_5_6_Chat");
    expect(toneFor("gpt-5.6-quick")).toBe("Gpt_5_6_Chat");
  });

  it("marks reasoning models so opencode can render them correctly", () => {
    expect(resolveModel("gpt-5.5-think-deeper").reasoning).toBe(true);
    expect(resolveModel("gpt-5.5").reasoning).toBe(false);
    expect(resolveModel("quick").reasoning).toBe(false);
  });

  it("advertises a roomy context window", () => {
    // M365 accepts >=500k tokens of retrieval-backed input (their F9). A small
    // advertised window makes harnesses pre-truncate prompts for no reason.
    for (const model of MODELS) {
      expect(model.limit.context).toBeGreaterThanOrEqual(128_000);
      expect(model.limit.output).toBeGreaterThan(0);
    }
  });

  it("exposes a local title model that never reaches M365", () => {
    expect(isLocalModel(LOCAL_TITLE_MODEL)).toBe(true);
    expect(isLocalModel(DEFAULT_MODEL)).toBe(false);
  });

  it("includes the local title model in the advertised list", () => {
    expect(listModelIds()).toContain(LOCAL_TITLE_MODEL);
    expect(listModelIds()).toContain(DEFAULT_MODEL);
  });
});

describe("model picker names", () => {
  // opencode 2's Model.Info has no description, so `name` is all the picker shows.
  const withReach = MODELS.filter((model) => model.tone !== null);

  it("marks every grounded model as Work and every other model as Code", () => {
    for (const model of withReach) {
      expect(model.name, `model ${model.id} has the wrong purpose prefix`).toMatch(
        model.grounded ? /^Work · / : /^Code · /,
      );
    }
  });

  it("says what a Work model reads", () => {
    for (const model of withReach.filter((candidate) => candidate.grounded)) {
      expect(model.name, `model ${model.id} does not say what it reads`).toMatch(/mail, Teams & files/);
    }
  });

  it("warns in the name that GPT-5.6 chat is unreliable at calling tools", () => {
    // The reference project measured 7/30; ours 0/1. The name is the only place to say so.
    for (const id of ["gpt-5.6", "gpt-5.6-quick"]) expect(resolveModel(id).name).toMatch(/unreliable tool calls/);
    expect(resolveModel("gpt-5.6-quick").name).toContain("GPT-5.6 (Quick");
    expect(resolveModel("quick").name).not.toMatch(/unreliable/);
  });

  it("lists GPT-5.6 chat after the default", () => {
    const ids = MODELS.map((model) => model.id);
    expect(ids.indexOf("gpt-5.6-quick")).toBeGreaterThan(ids.indexOf("quick"));
  });

  it("does not badge the local titler, which is neither", () => {
    expect(resolveModel(LOCAL_TITLE_MODEL).name).not.toMatch(/^(Work|Code) · /);
  });
});

describe("how each tone is asked to call tools", () => {
  it("keeps the chat GPT tones on the agent with the default framing", () => {
    expect(toolRouteFor("Gpt_5_5_Chat")).toEqual({ framing: "default", agent: true });
    expect(toolRouteFor("magic")).toEqual({ framing: "default", agent: true });
  });

  it("gives the reasoning tones the relay framing and keeps the agent", () => {
    // Agent-less GPT-5.x made no tool calls in the reference project (0/4).
    expect(toolRouteFor("Gpt_5_5_Reasoning")).toEqual({ framing: "relay", agent: true });
  });

  it("sends Claude agent-less as a relay, since Sonnet's agent route is dead on a non-premium account", () => {
    for (const tone of ["Claude_Sonnet", "Claude_Sonnet_Reasoning", "Claude_Sonnet_5", "Claude_Fable"]) {
      expect(toolRouteFor(tone)).toEqual({ framing: "relay", agent: false });
    }
  });

  it("keeps the agent for Claude Opus, the one Claude tone that takes it", () => {
    expect(toolRouteFor("Claude_Opus")).toEqual({ framing: "relay", agent: true });
  });

  it("sends GPT-6 and GPT-6 Astra agent-less, which is dead with the agent on every account", () => {
    for (const tone of ["Gpt_6_Reasoning", "Gpt_6_Astra_Reasoning"]) {
      expect(toolRouteFor(tone)).toEqual({ framing: "relay", agent: false });
    }
  });

  it("routes GPT-6.2 Astra like GPT-6.2 Sol, steering it off the sandbox", () => {
    expect(toolRouteFor("Gpt_62_Astra_Reasoning")).toEqual(toolRouteFor("Gpt_62_Sol_Reasoning"));
    expect(toolRouteFor("Gpt_62_Astra_Reasoning").sandbox).toMatch(/\/mnt\/data/);
  });
});

describe("compatibility aliases", () => {
  // Each pair once showed twice in opencode's picker under one name.
  const pairs: Array<[alias: string, canonical: string]> = [
    ["auto", "m365-copilot"],
    ["claude", "claude-sonnet"],
    ["gpt-5.4", "gpt-5.4-think-deeper"],
    ["gpt-5.3", "gpt-5.3-quick"],
    ["gpt-5.2", "gpt-5.2-quick"],
    // The chat tones, folded too: one picker entry each.
    ["gpt-5.5", "quick"],
    ["gpt-5.5-quick", "quick"],
    ["gpt-5.6", "gpt-5.6-quick"],
    // And the reasoning tone's generic id.
    ["think-deeper", "gpt-5.5-think-deeper"],
    // The Claude models, by the versions M365 serves on each scenario.
    ["claude-sonnet-4.6", "claude-sonnet"],
    ["claude-sonnet-4.5", "claude-sonnet"],
    ["claude-opus-5.5", "claude-opus"],
    ["claude-opus-5", "claude-opus"],
    ["claude-opus-4.5", "claude-opus-4.8"],
    ["claude-fable-5.1", "claude-fable"],
  ];

  it("advertises one coding model per tone", () => {
    const coding = MODELS.filter((model) => model.tone && !model.grounded);
    // Keyed on the scenario too: one tone on the paid scenario can be another model.
    const tones = coding.map((model) => `${model.tone}|${model.scenario ?? "included"}`);
    expect(new Set(tones).size, `shared: ${tones.filter((t, i) => tones.indexOf(t) !== i)}`).toBe(tones.length);
  });

  it("advertises one chat model per chat tone and scenario", () => {
    // `Claude_Opus` is two models, Opus 5.5 on the paid scenario and Opus 4.8 on the
    // included one, so the pair is what has to be unique.
    const chat = MODELS.filter((model) => model.tone && !model.reasoning && !model.grounded);
    const tones = chat.map((model) => `${model.tone}/${model.scenario ?? "included"}`);
    expect(new Set(tones).size, `shared: ${tones.filter((t, i) => tones.indexOf(t) !== i)}`).toBe(tones.length);
  });

  it("names the default by its generation", () => {
    expect(resolveModel("quick").name).toContain("GPT-5.5 (Quick)");
  });

  it("advertises unique ids and no duplicate picker names", () => {
    const names = MODELS.map((model) => model.name);
    expect(new Set(names).size, `duplicate names: ${names.filter((n, i) => names.indexOf(n) !== i)}`).toBe(names.length);
    const ids = listModelIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("maps each alias to its canonical id", () => {
    expect(Object.entries(MODEL_ALIASES).sort()).toEqual([...pairs].sort());
  });

  it.each(pairs)("%s resolves to the same model as %s", (alias, canonical) => {
    expect(resolveModel(alias)).toBe(resolveModel(canonical));
    expect(resolveModel(alias).id).toBe(canonical);
  });

  it.each(pairs)("the prefixed m365/%s still resolves", (alias, canonical) => {
    expect(resolveModel(`m365/${alias}`).id).toBe(canonical);
  });

  it("keeps aliases out of every advertised list", () => {
    const aliases = Object.keys(MODEL_ALIASES);
    for (const id of [...listModelIds(), ...buildModelInfos().map((model) => model.id)]) {
      expect(aliases).not.toContain(id);
    }
  });

  it("leaves the canonical models' tone, reasoning and grounding unchanged", () => {
    expect(resolveModel("auto")).toMatchObject({ tone: "magic", reasoning: false, grounded: false });
    expect(resolveModel("claude")).toMatchObject({ tone: "Claude_Sonnet", reasoning: false });
    expect(resolveModel("gpt-5.4")).toMatchObject({ tone: "Gpt_5_4_Reasoning", reasoning: true });
    expect(resolveModel("gpt-5.3")).toMatchObject({ tone: "Gpt_5_3_Chat", reasoning: false });
    expect(resolveModel("gpt-5.2")).toMatchObject({ tone: "Gpt_5_2_Chat", reasoning: false });
  });

  it("keeps the catalogue order, with the local titler last", () => {
    expect(listModelIds().slice(0, 2)).toEqual(["work", "work-think"]);
    const ids = listModelIds();
    expect(ids.indexOf("gpt-5.6-think-deeper")).toBeLessThan(ids.indexOf("gpt-5.5-think-deeper"));
    expect(listModelIds().at(-1)).toBe(LOCAL_TITLE_MODEL);
  });
});

describe("GPT-6 Sol models", () => {
  // From the reference protocol notes: each serves on the included scenario on every
  // account, takes the tool agent only on a premium account (a dead route otherwise),
  // and agent-less has a remote bash sandbox of its own.
  const sol: Array<[id: string, tone: string]> = [
    ["gpt-6-sol", "Gpt_6_Sol_Reasoning"],
    ["gpt-6.1-sol", "Gpt_61_Sol_Reasoning"],
    ["gpt-6.2-sol", "Gpt_62_Sol_Reasoning"],
  ];

  it.each(sol)("%s selects %s, as a reasoning model", (id, tone) => {
    const model = resolveModel(id);
    expect(model.id).toBe(id);
    expect(model.tone).toBe(tone);
    expect(model.reasoning).toBe(true);
    expect(model.grounded).toBeFalsy();
    expect(resolveModel(`m365/${id}`).id).toBe(id);
  });

  it.each(sol)("%s goes agent-less on tool turns, as a relay that steers it off its own sandbox", (_id, tone) => {
    const route = toolRouteFor(tone);
    expect(route.agent).toBe(false);
    expect(route.framing).toBe("relay");
    expect(route.sandbox).toMatch(/\/mnt\/data/);
  });

  it("names them as in the M365 web client", () => {
    expect(resolveModel("gpt-6.1-sol").name).toContain("GPT-6.1 Sol");
  });

  it("leaves the default model alone", () => {
    expect(DEFAULT_MODEL).toBe("quick");
  });
});

describe("the models the reference project maps", () => {
  // From the reference project's protocol notes (`m365-copilot-api.md` §5) and its
  // `MODEL_TONES`, `PAID_SCENARIO_TONES`, `PAID_SCENARIO_MODELS` and
  // `INCLUDED_SCENARIO_MODELS`.
  const table: Array<{
    id: string;
    tone: string;
    reasoning: boolean;
    scenario?: "paid";
    credits?: boolean;
    metered?: boolean;
    name: string;
  }> = [
    { id: "gpt-6-think-deeper", tone: "Gpt_6_Reasoning", reasoning: true, scenario: "paid", name: "GPT-6 (Think Deeper)" },
    { id: "gpt-6-astra", tone: "Gpt_6_Astra_Reasoning", reasoning: true, scenario: "paid", credits: true, name: "GPT-6 Astra" },
    { id: "gpt-6.2-astra", tone: "Gpt_62_Astra_Reasoning", reasoning: true, credits: true, name: "GPT-6.2 Astra" },
    { id: "claude-opus", tone: "Claude_Opus", reasoning: false, scenario: "paid", metered: true, name: "Claude Opus 5.5" },
    { id: "claude-opus-4.8", tone: "Claude_Opus", reasoning: false, name: "Claude Opus 4.8" },
    { id: "claude-sonnet-5.5", tone: "Claude_Sonnet", reasoning: false, scenario: "paid", metered: true, name: "Claude Sonnet 5.5" },
    { id: "claude-sonnet-5", tone: "Claude_Sonnet_5", reasoning: false, scenario: "paid", name: "Claude Sonnet 5" },
    { id: "claude-fable", tone: "Claude_Fable", reasoning: false, credits: true, name: "Claude Fable 5.1" },
  ];

  it.each(table)("$id selects $tone", (row) => {
    const model = resolveModel(row.id);
    expect(model.id).toBe(row.id);
    expect(model.tone).toBe(row.tone);
    expect(model.reasoning).toBe(row.reasoning);
    expect(model.grounded).toBeFalsy();
    expect(resolveModel(`m365/${row.id}`).id).toBe(row.id);
  });

  it.each(table)("$id is on the $scenario scenario, with its credits and metering", (row) => {
    const model = resolveModel(row.id);
    expect(model.scenario).toBe(row.scenario);
    expect(Boolean(model.credits)).toBe(Boolean(row.credits));
    expect(Boolean(model.metered)).toBe(Boolean(row.metered));
  });

  it.each(table)("$id says what it is in the picker", (row) => {
    expect(resolveModel(row.id).name).toMatch(new RegExp(`^Code · ${row.name.replace(/[().]/g, "\\$&")}`));
  });

  it("marks every credit-billed model in its name, and no other", () => {
    for (const model of MODELS) {
      if (model.credits) expect(model.name, model.id).toMatch(/uses Copilot credits/);
      else expect(model.name, model.id).not.toMatch(/credits/);
    }
  });

  it("marks every paid-scenario model Premium, so a refusal is no surprise", () => {
    for (const model of MODELS.filter((candidate) => candidate.scenario === "paid")) {
      expect(model.name, model.id).toMatch(/Premium/);
    }
  });

  it("marks Opus 4.8 Premium too: it serves only on a premium account", () => {
    expect(resolveModel("claude-opus-4.8").scenario).toBeUndefined();
    expect(resolveModel("claude-opus-4.8").name).toMatch(/Premium/);
  });

  it("names the included Sonnet by its version", () => {
    expect(resolveModel("claude-sonnet").name).toContain("Claude Sonnet 4.6");
    expect(resolveModel("claude-sonnet").scenario).toBeUndefined();
  });

  it("leaves every model that was already listed on the included scenario, unmetered and free", () => {
    for (const id of ["quick", "work", "work-think", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.2-sol", "claude-sonnet", "claude-sonnet-think-deeper"]) {
      const model = resolveModel(id);
      expect(model.scenario, id).toBeUndefined();
      expect(model.credits, id).toBeFalsy();
      expect(model.metered, id).toBeFalsy();
    }
  });

  it("lists Opus 5.5 and Opus 4.8 as two models, though they share a tone", () => {
    const ids = listModelIds();
    expect(ids).toContain("claude-opus");
    expect(ids).toContain("claude-opus-4.8");
  });

  it("keeps the default model", () => {
    expect(DEFAULT_MODEL).toBe("quick");
  });

  it("puts every new model in opencode's catalogue, with tools on", () => {
    const infos = buildModelInfos();
    for (const row of table) {
      const info = infos.find((candidate) => candidate.id === row.id);
      expect(info, row.id).toBeDefined();
      expect(info!.capabilities.tools).toBe(true);
      expect(info!.name).toBe(resolveModel(row.id).name);
    }
  });
});
