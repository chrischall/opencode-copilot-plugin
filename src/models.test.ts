import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL,
  LOCAL_TITLE_MODEL,
  MODELS,
  isLocalModel,
  listModelIds,
  resolveModel,
  toneFor,
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
    expect(resolveModel("quick").name).not.toMatch(/unreliable/);
  });

  it("lists GPT-5.6 chat after the default", () => {
    const ids = MODELS.map((model) => model.id);
    expect(ids.indexOf("gpt-5.6")).toBeGreaterThan(ids.indexOf("quick"));
    expect(ids.indexOf("gpt-5.6-quick")).toBeGreaterThan(ids.indexOf("quick"));
  });

  it("does not badge the local titler, which is neither", () => {
    expect(resolveModel(LOCAL_TITLE_MODEL).name).not.toMatch(/^(Work|Code) · /);
  });
});
