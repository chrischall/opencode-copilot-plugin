/**
 * Per-session metrics the proxy keeps for opencode's UI: the model, the conversation's
 * message quota, the estimated context size, turn counts and the last priority-access
 * allowances M365 reported.
 *
 * Keyed by opencode's session id (the `x-m365-session-id` header the plugin sets on
 * primary requests); a request without one is not recorded. Bounded, least recently
 * used first out, and in memory only: it describes this proxy's life, nothing more.
 *
 * The plugin serves it over opencode's RPC domain as {@link METRICS_RPC}. This module
 * imports nothing from `@opencode/plugin` at runtime: the definition is plain JSON
 * Schema, so the published package still has no runtime dependency on it.
 */

import type { ModelInfo } from "./models.js";
import type { ThrottleState } from "./session.js";

/** One window of a budget: turns left, and the cap when it has been measured. */
export interface AllowanceWindow {
  remaining: number;
  limit?: number;
}

/** A priority-access budget, by friendly name, and the model that spends it. */
export interface Allowance {
  name: string;
  model: string;
  daily?: AllowanceWindow;
  weekly?: AllowanceWindow;
}

export interface SessionMetrics {
  sessionID: string;
  /** The model of the latest turn or refusal. */
  model: { id: string; name: string };
  /** M365 messages used in this session's conversation, out of its cap (600). */
  conversation?: { used: number; max: number };
  /** The estimated size of the context opencode sent last, in tokens. */
  contextTokens?: number;
  /** M365 turns this session: a nudge or an answered `mcp` search is a turn too. */
  turns: number;
  /** Turns on a model billed to Copilot credits. A count: the charge is not reported. */
  creditTurns: number;
  /**
   * The last allowances M365 reported, and when. Only paid-scenario turns carry them,
   * so this is kept over later turns that do not.
   */
  allowances?: { readAt: string; budgets: Allowance[]; labels: string[] };
  /** Why the last turn was refused, until a later turn is answered. */
  lastRefusal?: { reason: RefusalReason; message: string; at: string };
}

/** `licence`: no premium Copilot licence. `allowance`: a priority-access allowance is used up. */
export type RefusalReason = "licence" | "allowance";

/**
 * The budgets M365's `metering` map carries that a model in the catalogue spends.
 * Caps are the measured ones (m365-copilot-proxy `docs/m365-copilot-api.md`); GPT-6.2's
 * are not measured, so only the remaining count is shown for them. Every other key
 * (`DeepResearch`, the `…Word` and `…Dev` variants) is left out.
 */
const BUDGETS: readonly {
  name: string;
  model: string;
  daily: string;
  weekly: string;
  limits?: { daily: number; weekly: number };
}[] = [
  { name: "Opus 5.5", model: "claude-opus", daily: "ClaudeOpusQueryDaily", weekly: "ClaudeOpusQuery75", limits: { daily: 40, weekly: 75 } },
  {
    name: "Sonnet 5.5",
    model: "claude-sonnet-5.5",
    daily: "ClaudeSonnet55QueryDaily",
    weekly: "ClaudeSonnet55QueryWeekly",
    limits: { daily: 80, weekly: 150 },
  },
  { name: "GPT-6.1 Sol", model: "gpt-6.1-sol", daily: "GPT61SolQueryDaily", weekly: "GPT61SolQueryWeekly", limits: { daily: 40, weekly: 75 } },
  { name: "GPT-6.2 Sol", model: "gpt-6.2-sol", daily: "GPT62SolQueryDaily", weekly: "GPT62SolQueryWeekly" },
  { name: "GPT-6.2 Astra", model: "gpt-6.2-astra", daily: "GPT62AstraQueryDaily", weekly: "GPT62AstraQueryWeekly" },
];

/** M365's `metering` (remaining turns by key) as named budgets; unknown keys dropped. */
export function describeAllowances(metering: Readonly<Record<string, number>>): Allowance[] {
  const budgets: Allowance[] = [];
  for (const budget of BUDGETS) {
    const daily = metering[budget.daily];
    const weekly = metering[budget.weekly];
    if (daily === undefined && weekly === undefined) continue;
    budgets.push({
      name: budget.name,
      model: budget.model,
      ...(daily !== undefined ? { daily: windowOf(daily, budget.limits?.daily) } : {}),
      ...(weekly !== undefined ? { weekly: windowOf(weekly, budget.limits?.weekly) } : {}),
    });
  }
  return budgets;
}

const windowOf = (remaining: number, limit: number | undefined): AllowanceWindow =>
  limit === undefined ? { remaining } : { remaining, limit };

/** `Opus 5.5: 31/40 left today, 70/75 left this week`. */
export function allowanceLabel(allowance: Allowance): string {
  const part = (window: AllowanceWindow | undefined, when: string) =>
    window ? `${window.limit === undefined ? window.remaining : `${window.remaining}/${window.limit}`} left ${when}` : null;
  const parts = [part(allowance.daily, "today"), part(allowance.weekly, "this week")].filter(Boolean);
  return `${allowance.name}: ${parts.join(", ")}`;
}

export interface TurnRecord {
  model: ModelInfo;
  throttle?: ThrottleState;
  metering?: Readonly<Record<string, number>>;
  contextTokens?: number;
  now?: Date;
}

export interface RefusalRecord {
  model: ModelInfo;
  reason: RefusalReason;
  message: string;
  now?: Date;
}

/** About as many sessions as anyone keeps open; each entry is a few hundred bytes. */
export const DEFAULT_METRICS_CAPACITY = 200;

export class SessionMetricsStore {
  // A Map iterates in insertion order: re-inserting on use makes the first key the LRU.
  private readonly entries = new Map<string, SessionMetrics>();
  private readonly listeners: Array<(sessionID: string) => void> = [];

  constructor(private readonly capacity = DEFAULT_METRICS_CAPACITY) {}

  get size(): number {
    return this.entries.size;
  }

  /** A copy of the session's metrics, or undefined if it has none. */
  get(sessionID: string): SessionMetrics | undefined {
    const entry = this.entries.get(sessionID);
    if (!entry) return undefined;
    this.touch(sessionID, entry);
    return structuredClone(entry);
  }

  /** Called with the session id after every change. */
  onChange(listener: (sessionID: string) => void): void {
    this.listeners.push(listener);
  }

  /** One M365 turn that was answered. */
  recordTurn(sessionID: string, turn: TurnRecord): void {
    const entry = this.entryFor(sessionID, turn.model);
    entry.turns += 1;
    if (turn.model.credits) entry.creditTurns += 1;
    if (turn.throttle) entry.conversation = { used: turn.throttle.current, max: turn.throttle.max };
    if (turn.contextTokens !== undefined) entry.contextTokens = turn.contextTokens;
    if (turn.metering) {
      const budgets = describeAllowances(turn.metering);
      entry.allowances = {
        readAt: (turn.now ?? new Date()).toISOString(),
        budgets,
        labels: budgets.map(allowanceLabel),
      };
    }
    delete entry.lastRefusal;
    this.changed(sessionID);
  }

  /** A turn M365 refused for the licence or an allowance. Costs no turn. */
  recordRefusal(sessionID: string, refusal: RefusalRecord): void {
    const entry = this.entryFor(sessionID, refusal.model);
    entry.lastRefusal = { reason: refusal.reason, message: refusal.message, at: (refusal.now ?? new Date()).toISOString() };
    this.changed(sessionID);
  }

  private entryFor(sessionID: string, model: ModelInfo): SessionMetrics {
    let entry = this.entries.get(sessionID);
    if (!entry) {
      entry = { sessionID, model: { id: model.id, name: model.name }, turns: 0, creditTurns: 0 };
      this.entries.set(sessionID, entry);
      while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    } else {
      entry.model = { id: model.id, name: model.name };
      this.touch(sessionID, entry);
    }
    return entry;
  }

  private touch(sessionID: string, entry: SessionMetrics): void {
    this.entries.delete(sessionID);
    this.entries.set(sessionID, entry);
  }

  private changed(sessionID: string): void {
    for (const listener of this.listeners) {
      try {
        listener(sessionID);
      } catch {
        // A listener's failure is not the turn's.
      }
    }
  }
}

/**
 * The server-to-TUI channel, registered on the plugin context's RPC domain. Portable:
 * plain JSON Schema, so neither side needs effect or `@opencode/plugin` at runtime.
 * `get` answers a session's metrics, `null` when there are none; `updated` fires after
 * every change, carrying the session id, so a TUI can fetch instead of polling.
 */
export const METRICS_RPC = {
  id: "m365-copilot.metrics",
  methods: {
    get: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
      },
      output: {
        type: "object",
        properties: { metrics: { anyOf: [{ type: "object" }, { type: "null" }] } },
        required: ["metrics"],
      },
    },
  },
  events: {
    updated: {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
      },
    },
  },
} as const;

/** Where the RPC reads a session's metrics: the in-process store, or an external proxy. */
export interface MetricsSource {
  get(sessionID: string): SessionMetrics | null | undefined | Promise<SessionMetrics | null | undefined>;
}

/** The external proxy's metrics route, under its `/v1` base. */
export const METRICS_PATH = "/m365/metrics/";

/** Long enough for a loopback round trip; short enough that a dead proxy is not a hang. */
const REMOTE_METRICS_TIMEOUT_MS = 2000;

/**
 * An external proxy's metrics (`opencode-m365 serve`, attached with `baseUrl`), read from
 * its `GET <baseUrl>/m365/metrics/<sessionID>` with the same bearer secret as every other
 * route. Anything but a well-formed answer reads as no data (`null`).
 */
export function remoteMetrics(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch): MetricsSource {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    async get(sessionID) {
      try {
        const response = await fetchImpl(`${base}${METRICS_PATH}${encodeURIComponent(sessionID)}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(REMOTE_METRICS_TIMEOUT_MS),
        });
        if (!response.ok) return null;
        const body = (await response.json()) as { metrics?: unknown } | null;
        const metrics = body?.metrics;
        return metrics && typeof metrics === "object" ? (metrics as SessionMetrics) : null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * The handlers for {@link METRICS_RPC}. `source` is read per call: the in-process
 * proxy's store, an external proxy's {@link remoteMetrics}, or nothing (`null`).
 */
export function metricsRpcHandlers(source: () => MetricsSource | undefined) {
  return {
    // A JSON Schema input arrives typed `unknown`; opencode has validated it, but a
    // malformed one still answers null rather than throwing.
    get: async (input: unknown): Promise<{ metrics: SessionMetrics | null }> => {
      const sessionID = (input as { sessionID?: unknown } | null)?.sessionID;
      if (typeof sessionID !== "string") return { metrics: null };
      try {
        return { metrics: (await source()?.get(sessionID)) ?? null };
      } catch {
        return { metrics: null };
      }
    },
  };
}
