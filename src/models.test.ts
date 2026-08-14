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
    expect(toneFor("quick")).toBe("Gpt_Quick");
    expect(toneFor("claude-sonnet")).toBe("Claude_Sonnet");
  });

  it("treats unknown model ids as the default rather than throwing", () => {
    // Harnesses send model ids we did not advertise; falling back beats a 400.
    expect(toneFor("something-we-never-shipped")).toBe(toneFor(DEFAULT_MODEL));
  });

  it("defaults to a reasoning model that their README measured as tool-compliant", () => {
    expect(DEFAULT_MODEL).toBe("gpt-5.5-think-deeper");
    expect(resolveModel(DEFAULT_MODEL).reasoning).toBe(true);
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
