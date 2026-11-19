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
  /**
   * Ground turns on the signed-in mailbox (Outlook side-pane scenario +
   * `WorkSearch`). Off for coding/web models; on for the `work*` models.
   */
  grounded?: boolean;
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
 * This exists because a harness titles each session with a model call, by default on
 * the main model. That would open a *second* M365 conversation for every session,
 * which is precisely the thread-rate throttle signature: the limit tracks
 * conversations started, not messages. Any client can select this model by id; the
 * opencode plugin instead marks its title requests so the proxy answers them here.
 */
export const LOCAL_TITLE_MODEL = "local-title";

/**
 * Default when a request carries no model.
 *
 * A chat tone, because a coding backend has to call tools. Measured on a live tenant
 * (2026-11-09): `quick` made real tool calls 4/4, while `gpt-5.5-think-deeper` claimed
 * to have no tools 3/3 — matching `m365-copilot-api.md` quirk #13, and contradicting
 * the 100% that project's README reports for it.
 */
export const DEFAULT_MODEL = "quick";

export const MODELS: readonly ModelInfo[] = [
  // Mailbox-grounded models: select these in opencode (as `m365/work` /
  // `m365/work-think`) to ask about your own mail, calendar and files — Copilot
  // searches them server-side. The other models stay coding/web-only.
  m("work", "Ask your mail, Teams & files", "magic", false, true),
  m("work-think", "Ask your mail, Teams & files (Think Deeper)", "Gpt_5_5_Reasoning", true, true),
  // GPT-6 Sol: reasoning models on the included scenario, so every account can reach
  // them. They take the tool agent only on a premium account, so tool turns go
  // agent-less (see `toolRouteFor`). Tool use not yet measured here.
  m("gpt-6.2-sol", "GPT-6.2 Sol", "Gpt_62_Sol_Reasoning", true),
  m("gpt-6.1-sol", "GPT-6.1 Sol", "Gpt_61_Sol_Reasoning", true),
  m("gpt-6-sol", "GPT-6 Sol", "Gpt_6_Sol_Reasoning", true),
  m("gpt-5.6-think-deeper", "GPT-5.6 (Think Deeper)", "Gpt_5_6_Reasoning", true),
  m("gpt-5.5-think-deeper", "GPT-5.5 (Think Deeper)", "Gpt_5_5_Reasoning", true),
  m("m365-copilot", "M365 Copilot (Auto)", "magic", false),
  m("quick", "GPT-5.5 (Quick)", "Gpt_5_5_Chat", false),
  // Live, but it writes a tool call far less often than `quick`: the reference
  // project measured 7/30, and our one run made none. Listed after the default and
  // labelled, rather than dropped, because it is fine for plain chat.
  m("gpt-5.6-quick", "GPT-5.6 (Quick, unreliable tool calls)", "Gpt_5_6_Chat", false),
  m("claude-sonnet", "Claude Sonnet (via M365)", "Claude_Sonnet", false),
  m("claude-sonnet-think-deeper", "Claude Sonnet (Think Deeper)", "Claude_Sonnet_Reasoning", true),
  m("gpt-5.4-think-deeper", "GPT-5.4 (Think Deeper)", "Gpt_5_4_Reasoning", true),
  m("gpt-5.4-quick", "GPT-5.4 (Quick)", "Gpt_5_4_Chat", false),
  m("gpt-5.3-quick", "GPT-5.3 (Quick)", "Gpt_5_3_Chat", false),
  m("gpt-5.3-think-deeper", "GPT-5.3 (Think Deeper)", "Gpt_5_3_Reasoning", true),
  m("gpt-5.2-quick", "GPT-5.2 (Quick)", "Gpt_5_2_Chat", false),
  m("gpt-5.2-think-deeper", "GPT-5.2 (Think Deeper)", "Gpt_5_2_Reasoning", true),
  m(LOCAL_TITLE_MODEL, "Local titler (no M365 call)", null, false),
];

function m(id: string, name: string, tone: string | null, reasoning: boolean, grounded = false): ModelInfo {
  return {
    id,
    name: pickerName(name, tone, grounded),
    tone,
    reasoning,
    grounded,
    limit: { context: CONTEXT_TOKENS, output: OUTPUT_TOKENS },
  };
}

/**
 * Lead with what the model is for. opencode 2's `Model.Info` has no description, so
 * the name is the only thing that separates reading your account from writing code.
 * The local titler is neither.
 */
function pickerName(name: string, tone: string | null, grounded: boolean): string {
  if (tone === null) return name;
  return `${grounded ? "Work" : "Code"} · ${name}`;
}

/**
 * Ids we accept but no longer advertise, each mapped to the canonical id it means.
 *
 * Each pair used to be advertised twice under one picker name, so opencode listed the
 * model twice. The canonical id is the descriptive one: `m365-copilot` is the id the
 * README documents and measured, and the GPT ids carry their tone suffix like their
 * siblings (`-quick`, `-think-deeper`). The short forms stay accepted, with or without
 * the `m365/` prefix, so saved configs keep working.
 */
export const MODEL_ALIASES: Readonly<Record<string, string>> = {
  auto: "m365-copilot",
  claude: "claude-sonnet",
  "gpt-5.4": "gpt-5.4-think-deeper",
  "gpt-5.3": "gpt-5.3-quick",
  "gpt-5.2": "gpt-5.2-quick",
  // One entry per chat tone. `quick` stays canonical, not `gpt-5.5-quick`: it is the
  // default and the id the README measures, and a default the catalogue lacks would
  // not load in opencode.
  "gpt-5.5": "quick",
  "gpt-5.5-quick": "quick",
  "gpt-5.6": "gpt-5.6-quick",
  // `think-deeper` is the generic id for GPT-5.5's reasoning tone; the descriptive id
  // is the one the README measures.
  "think-deeper": "gpt-5.5-think-deeper",
};

/** The canonical id for an alias, or the id unchanged. */
export function canonicalModelId(id: string): string {
  return MODEL_ALIASES[id] ?? id;
}

const BY_ID = new Map<string, ModelInfo>(MODELS.map((model) => [model.id, model]));
for (const [alias, canonical] of Object.entries(MODEL_ALIASES)) {
  const model = BY_ID.get(canonical);
  if (!model) throw new Error(`model alias ${alias} points at unknown id ${canonical}`);
  BY_ID.set(alias, model);
}

/**
 * Look up a model, falling back to the default for anything we do not know.
 *
 * Harnesses routinely send ids we never advertised (`MODEL_ALIASES`, stale config, a model
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

/** How a tool turn is put to M365 for a given tone. */
export interface ToolRoute {
  /** `relay`: the user asks to be guided through their own terminal, one command at a time. */
  framing: "default" | "relay";
  /** Attach the declarative agent. */
  agent: boolean;
  /** The model's own sandbox tools, named so the relay note can steer it away from them. */
  sandbox?: string;
}

/**
 * - Reasoning GPT tones keep the agent (agent-less GPT-5.x made no tool calls in the
 *   reference project, 0/4), but under the default framing they say they cannot reach
 *   the workspace, even after a command succeeded. The reference project's `relay`
 *   framing, where the user asks to be guided through their own terminal, took that to
 *   30/30. Ours said it on the first reply in 8 of 8 runs.
 * - Chat GPT tones work as they are.
 * - Claude stays as it was: with the agent, which M365 answers on GPT. The reference
 *   project ran Claude without the agent and with `relay` (193/200), but without the
 *   agent an account with no Claude licence refuses every tool turn
 *   (`ClaudeUnavailableForLicense`), where today it quietly gets GPT. Unmeasured on a
 *   licensed account, so not adopted.
 */
/**
 * GPT-6 Sol tones. With the declarative agent attached they serve only on a premium
 * account; on any other account that is a dead route (`InternalError`, no content).
 * Nothing on the token says which kind of account it is, so they always go agent-less.
 * Agent-less, Sol runs commands in a remote bash sandbox of its own, so the relay note
 * names it and asks for the user's terminal instead. From the reference project's
 * protocol notes (`m365-copilot-api.md`, the Sol rows and quirk #21).
 */
const SOL_TONE = /^Gpt_\d+_Sol_Reasoning$/;
const SOL_SANDBOX = "the bash sandbox with /mnt/data and /home/oai";

export function toolRouteFor(tone: string | null): ToolRoute {
  if (tone && SOL_TONE.test(tone)) return { framing: "relay", agent: false, sandbox: SOL_SANDBOX };
  if (tone?.startsWith("Gpt_") && tone.endsWith("_Reasoning")) return { framing: "relay", agent: true };
  return { framing: "default", agent: true };
}
