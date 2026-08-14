/**
 * The M365 Copilot model catalog.
 *
 * M365 has no `model` parameter. The model is selected by a **tone** string on the
 * chat invocation (`docs/m365-copilot-api.md` §5 of the m365-copilot-proxy notes).
 * This module is the single place that maps the OpenAI-style model ids we advertise
 * to those tones.
 *
 * A tone that the server accepts is not automatically a tone that works: there are
 * three outcomes, not two — live (`contentOrigin: "DeepLeo"`), rejected (a `type:3`
 * error in ~250ms), and *registered but dead* (a canned apology with
 * `contentOrigin: "BotConnection"`). Only tones observed live are listed here.
 */

export interface ModelInfo {
  /** The id we advertise over the OpenAI API and to opencode. */
  id: string;
  /** Human-readable name shown in opencode's model picker. */
  name: string;
  /** The M365 `tone` string this id selects. `null` for locally-served models. */
  tone: string | null;
  /** Whether this is a reasoning tone (10-30s per turn). */
  reasoning: boolean;
  limit: { context: number; output: number };
}

/**
 * Advertised context/output limits.
 *
 * Input is retrieval-backed and enormous — benign payloads of ~500k tokens never
 * tripped anything. Output soft-caps far lower, but M365 signals that by *concluding
 * early* rather than truncating, so a small advertised output limit only causes
 * harnesses to clip our prompts. Advertise roomy numbers and let the server decide.
 */
const CONTEXT_TOKENS = 1_000_000;
const OUTPUT_TOKENS = 128_000;

/**
 * A synthetic model served entirely by our own proxy — it never opens a WebSocket
 * to M365.
 *
 * This exists because opencode's `small_model` (session title generation) defaults
 * to the main model. That would open a *second* M365 conversation for every session,
 * which is precisely the thread-rate throttle signature: the limit tracks
 * conversations started, not messages. Pointing `small_model` here costs nothing.
 */
export const LOCAL_TITLE_MODEL = "local-title";

/**
 * Default when a request carries no model.
 *
 * Their README measures `gpt-5.5-think-deeper` at 100% tool compliance with the
 * declarative agent + fenced/shell-routing path, and a request with no model already
 * defaults to it there. Note this conflicts with `m365-copilot-api.md` quirk #13,
 * which says reasoning tones meta-analyse the injected prompt and disengage — that
 * note predates the GPT-5.5 measurements. See README for the full story.
 */
export const DEFAULT_MODEL = "gpt-5.5-think-deeper";

export const MODELS: readonly ModelInfo[] = [
  m("gpt-5.6-think-deeper", "GPT-5.6 (Think Deeper)", "Gpt_5_6_Reasoning", true),
  m("gpt-5.5-think-deeper", "GPT-5.5 (Think Deeper)", "Gpt_5_5_Reasoning", true),
  m("gpt-5.5", "GPT-5.5", "Gpt_5_5_Chat", false),
  m("gpt-5.5-quick", "GPT-5.5 (Quick)", "Gpt_5_5_Chat", false),
  m("m365-copilot", "M365 Copilot (Auto)", "magic", false),
  m("auto", "M365 Copilot (Auto)", "magic", false),
  m("quick", "GPT (Quick)", "Gpt_Quick", false),
  m("think-deeper", "GPT (Think Deeper)", "Gpt_Reasoning", true),
  m("claude-sonnet", "Claude Sonnet (via M365)", "Claude_Sonnet", false),
  m("claude", "Claude Sonnet (via M365)", "Claude_Sonnet", false),
  m("claude-sonnet-think-deeper", "Claude Sonnet (Think Deeper)", "Claude_Sonnet_Reasoning", true),
  m("gpt-5.4", "GPT-5.4 (Think Deeper)", "Gpt_5_4_Reasoning", true),
  m("gpt-5.4-think-deeper", "GPT-5.4 (Think Deeper)", "Gpt_5_4_Reasoning", true),
  m("gpt-5.4-quick", "GPT-5.4 (Quick)", "Gpt_5_4_Quick", false),
  m("gpt-5.3", "GPT-5.3 (Quick)", "Gpt_5_3_Quick", false),
  m("gpt-5.3-quick", "GPT-5.3 (Quick)", "Gpt_5_3_Quick", false),
  m("gpt-5.3-think-deeper", "GPT-5.3 (Think Deeper)", "Gpt_5_3_Reasoning", true),
  m("gpt-5.2", "GPT-5.2 (Quick)", "Gpt_5_2_Quick", false),
  m("gpt-5.2-quick", "GPT-5.2 (Quick)", "Gpt_5_2_Quick", false),
  m("gpt-5.2-think-deeper", "GPT-5.2 (Think Deeper)", "Gpt_5_2_Reasoning", true),
  m(LOCAL_TITLE_MODEL, "Local titler (no M365 call)", null, false),
];

function m(id: string, name: string, tone: string | null, reasoning: boolean): ModelInfo {
  return { id, name, tone, reasoning, limit: { context: CONTEXT_TOKENS, output: OUTPUT_TOKENS } };
}

const BY_ID = new Map(MODELS.map((model) => [model.id, model]));

/**
 * Look up a model, falling back to the default for anything we do not know.
 *
 * Harnesses routinely send ids we never advertised (aliases, stale config, a model
 * string typed by hand). Answering on the default beats rejecting the request.
 */
export function resolveModel(id: string | undefined | null): ModelInfo {
  if (id) {
    const exact = BY_ID.get(id);
    if (exact) return exact;
    // Tolerate a "provider/model" form — opencode addresses models as `m365/<id>`.
    const suffix = id.slice(id.lastIndexOf("/") + 1);
    const stripped = BY_ID.get(suffix);
    if (stripped) return stripped;
  }
  return BY_ID.get(DEFAULT_MODEL)!;
}

/** The M365 `tone` for a model id. */
export function toneFor(id: string | undefined | null): string | null {
  return resolveModel(id).tone;
}

/** True when the model is served locally and must never open an M365 conversation. */
export function isLocalModel(id: string | undefined | null): boolean {
  return resolveModel(id).tone === null;
}

/** Every advertised model id, in catalog order. */
export function listModelIds(): string[] {
  return MODELS.map((model) => model.id);
}
