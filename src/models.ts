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
  /**
   * `paid`: the turn goes out on M365's paid scenario (`OfficeWebPaidCopilot`), the
   * only one that serves this model. Absent means the included scenario. A seat
   * without a premium Copilot licence is refused on the paid scenario.
   */
  scenario?: "paid";
  /** M365 charges each turn to the user's Copilot credits. */
  credits?: boolean;
  /** Each turn spends a small priority-access allowance that resets at midnight UTC. */
  metered?: boolean;
  limit: { context: number; output: number };
}

/** What sets a model apart beyond its tone; every flag defaults to off. */
interface ModelOptions {
  grounded?: boolean;
  scenario?: "paid";
  credits?: boolean;
  metered?: boolean;
  /** Serves only on a premium account, though on the included scenario (Opus 4.8). */
  premium?: boolean;
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
  m("work", "Ask your mail, Teams & files", "magic", false, { grounded: true }),
  m("work-think", "Ask your mail, Teams & files (Think Deeper)", "Gpt_5_5_Reasoning", true, { grounded: true }),
  // GPT-6 Sol: reasoning models on the included scenario, so every account can reach
  // them. GPT-6 and 6.1 Sol take the tool agent only on a premium account, which is
  // learned by trying; GPT-6.2 Sol goes agent-less (see `toolRouteFor`). Tool use not
  // yet measured here.
  m("gpt-6.2-sol", "GPT-6.2 Sol", "Gpt_62_Sol_Reasoning", true),
  // GPT-6.2 Astra: the included scenario, like GPT-6.2 Sol, but every turn is charged
  // to the user's Copilot credits.
  m("gpt-6.2-astra", "GPT-6.2 Astra", "Gpt_62_Astra_Reasoning", true, { credits: true }),
  m("gpt-6.1-sol", "GPT-6.1 Sol", "Gpt_61_Sol_Reasoning", true),
  m("gpt-6-sol", "GPT-6 Sol", "Gpt_6_Sol_Reasoning", true),
  // GPT-6 and GPT-6 Astra serve only on the paid scenario: the included one answers
  // with M365's canned apology. Astra is also billed to Copilot credits.
  m("gpt-6-astra", "GPT-6 Astra", "Gpt_6_Astra_Reasoning", true, { scenario: "paid", credits: true }),
  m("gpt-6-think-deeper", "GPT-6 (Think Deeper)", "Gpt_6_Reasoning", true, { scenario: "paid" }),
  m("gpt-5.6-think-deeper", "GPT-5.6 (Think Deeper)", "Gpt_5_6_Reasoning", true),
  m("gpt-5.5-think-deeper", "GPT-5.5 (Think Deeper)", "Gpt_5_5_Reasoning", true),
  m("m365-copilot", "M365 Copilot (Auto)", "magic", false),
  m("quick", "GPT-5.5 (Quick)", "Gpt_5_5_Chat", false),
  // Live, but it writes a tool call far less often than `quick`: the reference
  // project measured 7/30, and our one run made none. Listed after the default and
  // labelled, rather than dropped, because it is fine for plain chat.
  m("gpt-5.6-quick", "GPT-5.6 (Quick, unreliable tool calls)", "Gpt_5_6_Chat", false),
  // Claude. A tone is not always one model: M365 picks the version by scenario.
  // `Claude_Opus` is Opus 5.5 on the paid scenario (metered by a priority-access
  // allowance) and Opus 4.8 on the included one (premium accounts only, unmetered).
  // `Claude_Sonnet` is Sonnet 4.6 on the included scenario and Sonnet 5.5 on the paid
  // one (metered). `Claude_Sonnet_5` is Sonnet 5 on the paid scenario.
  m("claude-opus", "Claude Opus 5.5", "Claude_Opus", false, { scenario: "paid", metered: true }),
  m("claude-opus-4.8", "Claude Opus 4.8", "Claude_Opus", false, { premium: true }),
  m("claude-sonnet-5.5", "Claude Sonnet 5.5", "Claude_Sonnet", false, { scenario: "paid", metered: true }),
  m("claude-sonnet-5", "Claude Sonnet 5", "Claude_Sonnet_5", false, { scenario: "paid" }),
  m("claude-sonnet", "Claude Sonnet 4.6", "Claude_Sonnet", false),
  m("claude-sonnet-think-deeper", "Claude Sonnet (Think Deeper)", "Claude_Sonnet_Reasoning", true),
  // Claude Fable 5.1: the included scenario, billed to Copilot credits.
  m("claude-fable", "Claude Fable 5.1", "Claude_Fable", false, { credits: true }),
  m("gpt-5.4-think-deeper", "GPT-5.4 (Think Deeper)", "Gpt_5_4_Reasoning", true),
  m("gpt-5.4-quick", "GPT-5.4 (Quick)", "Gpt_5_4_Chat", false),
  m("gpt-5.3-quick", "GPT-5.3 (Quick)", "Gpt_5_3_Chat", false),
  m("gpt-5.3-think-deeper", "GPT-5.3 (Think Deeper)", "Gpt_5_3_Reasoning", true),
  m("gpt-5.2-quick", "GPT-5.2 (Quick)", "Gpt_5_2_Chat", false),
  m("gpt-5.2-think-deeper", "GPT-5.2 (Think Deeper)", "Gpt_5_2_Reasoning", true),
  m(LOCAL_TITLE_MODEL, "Local titler (no M365 call)", null, false),
];

function m(id: string, name: string, tone: string | null, reasoning: boolean, options: ModelOptions = {}): ModelInfo {
  const { grounded = false, scenario, credits, metered, premium } = options;
  return {
    id,
    name: pickerName(withLabels(name, { premium: premium || scenario === "paid", credits }), tone, grounded),
    tone,
    reasoning,
    grounded,
    ...(scenario ? { scenario } : {}),
    ...(credits ? { credits } : {}),
    ...(metered ? { metered } : {}),
    limit: { context: CONTEXT_TOKENS, output: OUTPUT_TOKENS },
  };
}

/**
 * Say in the name what a user should know before picking: that the model needs a
 * premium Copilot licence (so a refusal is no surprise), and that it spends credits.
 */
function withLabels(name: string, labels: { premium?: boolean; credits?: boolean }): string {
  const tags = [labels.premium ? "Premium" : null, labels.credits ? "uses Copilot credits" : null].filter(Boolean);
  return tags.length ? `${name} (${tags.join(", ")})` : name;
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
  // The Claude models by version, as the reference project accepts them.
  "claude-sonnet-4.6": "claude-sonnet",
  "claude-sonnet-4.5": "claude-sonnet",
  "claude-opus-5.5": "claude-opus",
  "claude-opus-5": "claude-opus",
  "claude-opus-4.5": "claude-opus-4.8",
  "claude-fable-5.1": "claude-fable",
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

/** The tone sets `toolRouteFor` routes by; see its comment for the evidence. */
const SOL_TONE = /^Gpt_\d+_Sol_Reasoning$/;
const SOL_SANDBOX = "the bash sandbox with /mnt/data and /home/oai";
const SANDBOXED_TONES: ReadonlySet<string> = new Set(["Gpt_62_Astra_Reasoning"]);
const AGENTLESS_TONES: ReadonlySet<string> = new Set(["Gpt_6_Reasoning", "Gpt_6_Astra_Reasoning"]);
const AGENT_CLAUDE_TONES: ReadonlySet<string> = new Set(["Claude_Opus"]);

/**
 * Tones whose agent route serves only on a premium account (the reference project's
 * `PREMIUM_ONLY_AGENT_TONES`, agent-tone-probe 2026-10-02 and 2026-10-06). On a
 * non-premium account the agent-attached turn is a dead route: a BotConnection
 * apology in the final item, `result: InternalError`, no content. Agent-less, the same
 * tone serves on either account.
 *
 * Nothing on the token says which kind of account it is, so the proxy finds out by
 * trying: the first tool turn carries the agent, and a dead route marks the tone
 * agent-dead (`AgentRouteMemory`) and is re-sent agent-less. A premium account
 * produces the same wire state as a rare one-off (about 1 in 250 agent turns), so once
 * the agent has answered for a tone, an `InternalError` is just a refusal.
 *
 * `M365_FORCE_AGENT` overrides this for these tones only: `0` never attaches the
 * agent, `1` always does and never falls back.
 */
export const PREMIUM_ONLY_AGENT_TONES: ReadonlySet<string> = new Set(["Gpt_6_Sol_Reasoning", "Gpt_61_Sol_Reasoning"]);

/**
 * What one proxy has learned about the agent route, per tone. A proxy serves one
 * account, so this is per-account knowledge; a restart learns it again.
 */
export class AgentRouteMemory {
  private readonly dead = new Set<string>();
  private readonly alive = new Set<string>();

  /**
   * Record that this account's agent route does not serve `tone`. Returns false, and
   * records nothing, when the agent has already answered for it: then the failure
   * was a one-off.
   */
  noteDead(tone: string): boolean {
    if (this.alive.has(tone)) return false;
    this.dead.add(tone);
    return true;
  }

  /** Record that the agent answered for `tone` on this account. */
  noteAlive(tone: string): void {
    this.alive.add(tone);
  }

  isAlive(tone: string): boolean {
    return this.alive.has(tone);
  }

  isDead(tone: string): boolean {
    return this.dead.has(tone);
  }
}

/** `M365_FORCE_AGENT`: `true` for `1`, `false` for `0`, otherwise undecided. */
export function forcedAgent(): boolean | undefined {
  const force = process.env.M365_FORCE_AGENT;
  return force === "1" ? true : force === "0" ? false : undefined;
}

/**
 * How each tone is asked to call tools. These routes come from the reference
 * project's measurements (`m365-copilot-api.md` and `AGENTLESS_TOOL_TONES`,
 * `AGENT_CLAUDE_TONES` in its `copilot.ts`), not from live runs of this plugin.
 *
 * - Chat GPT tones work as they are: the agent, the default framing.
 * - Reasoning GPT-5.x tones keep the agent (agent-less GPT-5.x made no tool calls in
 *   the reference project, 0/4), but under the default framing they say they cannot
 *   reach the workspace, even after a command succeeded. The `relay` framing, where
 *   the user asks to be guided through their own terminal, took that to 30/30.
 * - Claude goes agent-less, as a relay. On a non-premium account the agent route does
 *   not serve Claude Sonnet at all (BotConnection apology, `InternalError`), and
 *   agent-less Claude tool-calls reliably. `Claude_Opus` is the exception: both Opus
 *   models take the agent, and Opus 4.8 without it works in its own code interpreter.
 * - GPT-6 (`Gpt_6_Reasoning`) is the same dead route with the agent on every account,
 *   premium or not; agent-less it answers. The Astra tones go agent-less too.
 * - Sol tones run commands in a remote bash sandbox of their own when agent-less, so
 *   the relay note names it and asks for the user's terminal instead (the Sol rows and
 *   quirk #21). GPT-6 Sol and GPT-6.1 Sol serve with the agent only on a premium
 *   account, so whether they get it is learned (`PREMIUM_ONLY_AGENT_TONES`). GPT-6.2
 *   Sol always goes agent-less, and GPT-6.2 Astra is routed like it.
 */
export function toolRouteFor(tone: string | null, memory?: AgentRouteMemory): ToolRoute {
  if (tone && PREMIUM_ONLY_AGENT_TONES.has(tone)) {
    const agent = forcedAgent() ?? !memory?.isDead(tone);
    return { framing: "relay", agent, sandbox: SOL_SANDBOX };
  }
  if (tone && (SOL_TONE.test(tone) || SANDBOXED_TONES.has(tone))) return { framing: "relay", agent: false, sandbox: SOL_SANDBOX };
  if (tone && AGENTLESS_TONES.has(tone)) return { framing: "relay", agent: false };
  if (tone?.startsWith("Claude_")) return { framing: "relay", agent: AGENT_CLAUDE_TONES.has(tone) };
  if (tone?.startsWith("Gpt_") && tone.endsWith("_Reasoning")) return { framing: "relay", agent: true };
  return { framing: "default", agent: true };
}
