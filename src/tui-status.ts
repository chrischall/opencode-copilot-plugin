/**
 * The TUI status: one compact line in the prompt footer and a few labelled lines in
 * the sidebar, showing what the proxy knows about the session — the conversation's
 * message quota, the model's priority-access allowance, credit-billed turns, the
 * estimated context size and the last refusal.
 *
 * The data comes from the server plugin over opencode's RPC domain
 * ({@link METRICS_RPC}): fetched when a slot first shows a session, and again when
 * the proxy announces a change (`updated`) or a model step ends or fails. Nothing polls.
 *
 * Rendering goes through the host's own Solid runtime, handed in as
 * {@link StatusRuntime}, so neither `@opentui/solid` nor `solid-js` is a dependency
 * of this package, and the formatting stays plain functions that tests can call.
 */

import type { Plugin } from "@opencode/plugin/tui";
import { PROVIDER_ID } from "./config.js";
import { METRICS_RPC, type AllowanceWindow, type SessionMetrics } from "./metrics.js";

type Metrics = SessionMetrics | null | undefined;

const SEPARATOR = " · ";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const windowText = (window: AllowanceWindow) =>
  window.limit === undefined ? `${window.remaining}` : `${window.remaining}/${window.limit}`;

/**
 * `M365 12/600 msgs · Opus 5.5 31/40 today · 3 credit turns`, with the parts that have
 * no data left out; undefined when none has any. The allowance is the session model's
 * own, daily window first.
 */
export function footerLine(metrics: Metrics): string | undefined {
  if (!metrics) return undefined;
  const parts: string[] = [];
  if (metrics.conversation) parts.push(`${metrics.conversation.used}/${metrics.conversation.max} msgs`);
  const budget = metrics.allowances?.budgets.find((candidate) => candidate.model === metrics.model.id);
  if (budget?.daily) parts.push(`${budget.name} ${windowText(budget.daily)} today`);
  else if (budget?.weekly) parts.push(`${budget.name} ${windowText(budget.weekly)} this week`);
  if (metrics.creditTurns > 0) parts.push(plural(metrics.creditTurns, "credit turn", "credit turns"));
  return parts.length > 0 ? `M365 ${parts.join(SEPARATOR)}` : undefined;
}

/** `48213` → `48.2k`; under a thousand as is. */
const tokens = (count: number) => (count < 1000 ? `${count}` : `${(count / 1000).toFixed(1)}k`);

/** Local wall-clock `HH:MM`. */
const clock = (iso: string) => {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};

const MAX_SIDEBAR_LINE = 100;
const shorten = (line: string) => (line.length <= MAX_SIDEBAR_LINE ? line : `${line.slice(0, MAX_SIDEBAR_LINE - 1)}…`);

/** The sidebar's labelled lines: a title, then only what is known. Empty without metrics. */
export function sidebarLines(metrics: Metrics): string[] {
  if (!metrics) return [];
  const lines = [`M365 Copilot${SEPARATOR}${metrics.model.name}`];
  if (metrics.conversation) lines.push(`Messages  ${metrics.conversation.used}/${metrics.conversation.max}`);
  if (metrics.contextTokens !== undefined) lines.push(`Context   ~${tokens(metrics.contextTokens)} tokens (estimated)`);
  if (metrics.turns > 0 || metrics.creditTurns > 0) {
    lines.push(`Turns     ${metrics.turns}${metrics.creditTurns > 0 ? `, ${metrics.creditTurns} on credits` : ""}`);
  }
  if (metrics.allowances && metrics.allowances.labels.length > 0) {
    lines.push(`Allowance as of ${clock(metrics.allowances.readAt)}`);
    for (const label of metrics.allowances.labels) lines.push(`  ${label}`);
  }
  if (metrics.lastRefusal) lines.push(shorten(`Refused   ${metrics.lastRefusal.reason}: ${metrics.lastRefusal.message}`));
  return lines;
}

/**
 * Per-session metrics, fetched on demand. A session is fetched the first time a slot
 * {@link watch}es it; {@link refresh} refetches only sessions already watched, and
 * refreshes that land while a fetch is in flight collapse into one more fetch. A failed
 * fetch reads as no data (`null`): a status line is never worth an error.
 */
export class MetricsFeed {
  private readonly cache = new Map<string, SessionMetrics | null>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private readonly listeners: Array<(sessionID: string) => void> = [];

  constructor(private readonly fetch: (sessionID: string) => Promise<SessionMetrics | null>) {}

  /** The cached metrics: undefined before the first fetch lands, null with none. */
  get(sessionID: string): SessionMetrics | null | undefined {
    return this.cache.get(sessionID);
  }

  onChange(listener: (sessionID: string) => void): void {
    this.listeners.push(listener);
  }

  /** Start showing a session: fetch it unless it is cached or being fetched. */
  watch(sessionID: string): void {
    if (this.cache.has(sessionID) || this.inFlight.has(sessionID)) return;
    this.load(sessionID);
  }

  /** The session changed: refetch it, if anything is showing it. */
  refresh(sessionID: string): void {
    if (this.inFlight.has(sessionID)) {
      this.again.add(sessionID);
      return;
    }
    if (this.cache.has(sessionID)) this.load(sessionID);
  }

  /** Resolves once no fetch is in flight. */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all(this.inFlight.values());
  }

  private load(sessionID: string): void {
    const run = (async () => {
      let metrics: SessionMetrics | null;
      try {
        metrics = (await this.fetch(sessionID)) ?? null;
      } catch {
        metrics = null;
      }
      this.cache.set(sessionID, metrics);
      for (const listener of this.listeners) {
        try {
          listener(sessionID);
        } catch {
          // A listener's failure is not the feed's.
        }
      }
    })().finally(() => {
      this.inFlight.delete(sessionID);
      if (this.again.delete(sessionID)) this.load(sessionID);
    });
    this.inFlight.set(sessionID, run);
  }
}

/**
 * The slice of the host's Solid runtime (`@opentui/solid` and `solid-js`, which
 * opencode provides to TUI plugins) the status renders with.
 */
export interface StatusRuntime {
  createElement(tag: string): unknown;
  insert(parent: unknown, value: unknown): void;
  setProp(node: unknown, name: string, value: unknown): void;
  createSignal<T>(initial: T): readonly [() => T, (next: T | ((previous: T) => T)) => T];
}

/** The parts of the RPC client the status uses; typed here, not from `@opencode/client`. */
interface MetricsClient {
  get(input: { sessionID: string }, options?: { location?: { directory: string } }): Promise<{ metrics: SessionMetrics | null } | undefined>;
  events: { on(name: "updated", handler: (event: { data?: { sessionID?: unknown } }) => void): () => void };
}

type ModelRef = { providerID?: string } | undefined;

/**
 * The session events after which the proxy may know more: a model step that ended or
 * failed. Typed against the host's event union, so a renamed event fails to compile.
 */
const REFRESH_EVENTS = ["session.step.ended", "session.step.failed"] as const satisfies readonly Parameters<
  Plugin.Context["data"]["on"]
>[0][];

/**
 * Claim the footer and sidebar slots. Returns the feed (for tests) and a cleanup that
 * releases every claim and listener.
 */
export async function setupStatus(context: Plugin.Context, runtime: StatusRuntime) {
  const rpc = (context.client as unknown as { rpc?: (definition: typeof METRICS_RPC) => MetricsClient }).rpc;
  const client = typeof rpc === "function" ? rpc(METRICS_RPC) : undefined;
  const session = (sessionID: string) =>
    context.data.session.get(sessionID) as { model?: ModelRef; location?: { directory?: string } } | undefined;

  const feed = new MetricsFeed(async (sessionID) => {
    if (!client) return null;
    const directory = session(sessionID)?.location?.directory ?? context.location?.directory;
    const answer = await client.get({ sessionID }, directory ? { location: { directory } } : {});
    return answer?.metrics ?? null;
  });

  // Bumped on every change, so anything rendered from the feed re-reads it.
  const [version, setVersion] = runtime.createSignal(0);
  feed.onChange(() => setVersion((previous) => previous + 1));

  /** The session's metrics if it is on an m365 model, starting a fetch on first sight. */
  const metricsFor = (sessionID: string | undefined, model: ModelRef): SessionMetrics | null | undefined => {
    version();
    if (!sessionID || model?.providerID !== PROVIDER_ID) return undefined;
    feed.watch(sessionID);
    return feed.get(sessionID);
  };

  const muted = (context.theme as { textMuted?: unknown } | undefined)?.textMuted;
  const text = (content: () => string | undefined) => {
    const node = runtime.createElement("text");
    if (muted !== undefined) runtime.setProp(node, "fg", muted);
    runtime.insert(node, content);
    return node;
  };

  const disposers: Array<() => void> = [];

  disposers.push(
    context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        const line = () => footerLine(metricsFor(input.sessionID, context.ui.model.current()));
        const node = text(line);
        return (() => (line() ? node : null)) as never;
      },
    }),
  );

  disposers.push(
    context.ui.slot({
      append: "sidebar.content",
      render: (input) => {
        // The sidebar shows one session: its own model decides, the prompt's is the fallback.
        const lines = () => sidebarLines(metricsFor(input.sessionID, session(input.sessionID)?.model ?? context.ui.model.current()));
        const box = runtime.createElement("box");
        runtime.setProp(box, "flexDirection", "column");
        runtime.insert(box, () => lines().map((line) => text(() => line)));
        return (() => (lines().length > 0 ? box : null)) as never;
      },
    }),
  );

  if (client) disposers.push(client.events.on("updated", (event) => refreshFrom(event)));
  // Not `session.idle`: opencode 2.2.5 has the type but never emits it (measured live).
  // A turn ends with `session.step.ended`; a refused one with `session.step.failed`.
  for (const type of REFRESH_EVENTS) disposers.push(context.data.on(type, (event) => refreshFrom(event)));

  function refreshFrom(event: { data?: { sessionID?: unknown } }) {
    const sessionID = event?.data?.sessionID;
    if (typeof sessionID === "string") feed.refresh(sessionID);
  }

  return {
    feed,
    cleanup: async () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          // Already gone.
        }
      }
    },
  };
}
