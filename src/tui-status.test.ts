import { describe, expect, it, vi } from "vitest";
import { METRICS_RPC, type SessionMetrics } from "./metrics.js";
import { MetricsFeed, footerLine, setupStatus, sidebarLines, type StatusRuntime } from "./tui-status.js";

const opus = (over: Partial<SessionMetrics> = {}): SessionMetrics => ({
  sessionID: "ses_1",
  model: { id: "claude-opus", name: "Claude Opus 5.5" },
  turns: 14,
  creditTurns: 0,
  ...over,
});

const opusAllowance = {
  // Local time, so the clock label does not depend on the test machine's zone.
  readAt: new Date(2026, 10, 19, 14, 5).toISOString(),
  budgets: [
    { name: "Opus 5.5", model: "claude-opus", daily: { remaining: 31, limit: 40 }, weekly: { remaining: 70, limit: 75 } },
    { name: "Sonnet 5.5", model: "claude-sonnet-5.5", daily: { remaining: 80, limit: 80 } },
  ],
  labels: ["Opus 5.5: 31/40 left today, 70/75 left this week", "Sonnet 5.5: 80/80 left today"],
};

describe("the footer line", () => {
  it("shows the conversation quota, this model's allowance and the credit turns", () => {
    const line = footerLine(opus({ conversation: { used: 12, max: 600 }, allowances: opusAllowance, creditTurns: 3 }));
    expect(line).toBe("M365 12/600 msgs · Opus 5.5 31/40 today · 3 credit turns");
  });

  it("leaves out the parts that have no data", () => {
    expect(footerLine(opus({ conversation: { used: 1, max: 600 } }))).toBe("M365 1/600 msgs");
    expect(footerLine(opus({ creditTurns: 1 }))).toBe("M365 1 credit turn");
  });

  it("says nothing when there is nothing to say", () => {
    expect(footerLine(opus())).toBeUndefined();
    expect(footerLine(undefined)).toBeUndefined();
    expect(footerLine(null)).toBeUndefined();
  });

  it("shows only the allowance of the session's model, falling back to the weekly window", () => {
    const sonnet = opus({ model: { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5" }, allowances: opusAllowance });
    expect(footerLine(sonnet)).toBe("M365 Sonnet 5.5 80/80 today");

    const weeklyOnly = opus({
      allowances: { ...opusAllowance, budgets: [{ name: "GPT-6.2 Sol", model: "claude-opus", weekly: { remaining: 9 } }] },
    });
    expect(footerLine(weeklyOnly)).toBe("M365 GPT-6.2 Sol 9 this week");

    const otherModel = opus({ model: { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" }, allowances: opusAllowance });
    expect(footerLine(otherModel)).toBeUndefined();
  });
});

describe("the sidebar lines", () => {
  it("labels the same data, plus context tokens, turns, every allowance and the last refusal", () => {
    const lines = sidebarLines(
      opus({
        conversation: { used: 12, max: 600 },
        contextTokens: 48_213,
        creditTurns: 3,
        allowances: opusAllowance,
        lastRefusal: { reason: "allowance", message: "You've reached your Opus limit for today.", at: opusAllowance.readAt },
      }),
    );
    expect(lines).toEqual([
      "M365 Copilot · Claude Opus 5.5",
      "Messages  12/600",
      "Context   ~48.2k tokens (estimated)",
      "Turns     14, 3 on credits",
      "Allowance as of 14:05",
      "  Opus 5.5: 31/40 left today, 70/75 left this week",
      "  Sonnet 5.5: 80/80 left today",
      "Refused   allowance: You've reached your Opus limit for today.",
    ]);
  });

  it("keeps to what is known", () => {
    expect(sidebarLines(opus({ turns: 1, contextTokens: 900 }))).toEqual([
      "M365 Copilot · Claude Opus 5.5",
      "Context   ~900 tokens (estimated)",
      "Turns     1",
    ]);
    expect(sidebarLines(undefined)).toEqual([]);
    expect(sidebarLines(null)).toEqual([]);
  });

  it("shortens a long refusal message", () => {
    const message = "x".repeat(200);
    const [, refused] = sidebarLines(opus({ turns: 0, lastRefusal: { reason: "licence", message, at: opusAllowance.readAt } }));
    expect(refused!.startsWith("Refused   licence: xxx")).toBe(true);
    expect(refused!.length).toBeLessThanOrEqual(100);
    expect(refused!.endsWith("…")).toBe(true);
  });
});

describe("the metrics feed", () => {
  it("fetches a session once on first sight, and again when it is refreshed", async () => {
    const fetch = vi.fn(async (sessionID: string) => opus({ sessionID }));
    const feed = new MetricsFeed(fetch);
    const changes: string[] = [];
    feed.onChange((id) => changes.push(id));

    expect(feed.get("ses_1")).toBeUndefined();
    feed.watch("ses_1");
    feed.watch("ses_1");
    await feed.settled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(feed.get("ses_1")).toMatchObject({ sessionID: "ses_1" });
    expect(changes).toEqual(["ses_1"]);

    feed.refresh("ses_1");
    await feed.settled();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("ignores refreshes for sessions nobody is showing", async () => {
    const fetch = vi.fn(async () => opus());
    const feed = new MetricsFeed(fetch);
    feed.refresh("ses_unseen");
    await feed.settled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("collapses refreshes that arrive while a fetch is in flight into one more fetch", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetch = vi.fn(async () => {
      await gate;
      return opus();
    });
    const feed = new MetricsFeed(fetch);
    feed.watch("ses_1");
    feed.refresh("ses_1");
    feed.refresh("ses_1");
    feed.refresh("ses_1");
    release();
    await feed.settled();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("treats a failed fetch as no data, and never throws", async () => {
    const feed = new MetricsFeed(async () => Promise.reject(new Error("rpc.unavailable")));
    feed.watch("ses_1");
    await feed.settled();
    expect(feed.get("ses_1")).toBeNull();
  });
});

/**
 * A stand-in for the host's Solid runtime: elements are plain records, and `insert`
 * keeps the accessor so a test can read what would be on screen now.
 */
function fakeRuntime() {
  type El = { tag: string; props: Record<string, unknown>; child?: unknown };
  const listeners: Array<() => void> = [];
  const runtime: StatusRuntime = {
    createElement: (tag: string) => ({ tag, props: {} }) as El,
    insert: (parent: unknown, value: unknown) => {
      (parent as El).child = value;
    },
    setProp: (node: unknown, name: string, value: unknown) => {
      (node as El).props[name] = value;
    },
    createSignal: <T,>(initial: T) => {
      let value = initial;
      return [
        () => value,
        (next: T | ((previous: T) => T)) => {
          value = typeof next === "function" ? (next as (previous: T) => T)(value) : next;
          for (const listener of listeners) listener();
          return value;
        },
      ] as const;
    },
  };
  /** What a rendered claim shows: its text, or null when it renders nothing. */
  const show = (rendered: unknown): unknown => {
    let value = rendered;
    while (typeof value === "function") value = (value as () => unknown)();
    if (value === null || value === undefined || value === false) return null;
    if (Array.isArray(value)) return value.map(show);
    const el = value as El;
    if (el.tag === "text") return show(el.child);
    if (el.tag === "box") return show(el.child);
    return value;
  };
  return { runtime, show };
}

function fakeContext(over: { model?: { providerID: string; modelID: string }; sessions?: Record<string, unknown> } = {}) {
  const claims: Array<{ claim: any; disposed: boolean }> = [];
  const rpcHandlers = new Map<string, (event: any) => void>();
  const dataHandlers = new Map<string, (event: any) => void>();
  const get = vi.fn(async (input: { sessionID: string }) => ({ metrics: opus({ sessionID: input.sessionID, conversation: { used: 2, max: 600 } }) }));
  const rpcFor = vi.fn((definition: unknown) => ({
    get,
    events: {
      on: (name: string, handler: (event: any) => void) => {
        rpcHandlers.set(name, handler);
        return () => rpcHandlers.delete(name);
      },
    },
    definition,
  }));
  const ctx = {
    location: { directory: "/work" },
    theme: { textMuted: "#888888" },
    client: { rpc: rpcFor },
    data: {
      on: (type: string, handler: (event: any) => void) => {
        dataHandlers.set(type, handler);
        return () => dataHandlers.delete(type);
      },
      session: { get: (id: string) => over.sessions?.[id] },
    },
    ui: {
      model: { current: () => over.model },
      slot: (claim: any) => {
        const entry = { claim, disposed: false };
        claims.push(entry);
        return () => {
          entry.disposed = true;
        };
      },
    },
  };
  return { ctx, claims, rpcFor, get, rpcHandlers, dataHandlers };
}

const claimAt = (claims: Array<{ claim: any }>, path: string) => claims.find((entry) => entry.claim.append === path)?.claim;

describe("the TUI status", () => {
  const m365 = { providerID: "m365", modelID: "claude-opus" };

  it("claims the prompt footer status and the sidebar content, through the metrics RPC", async () => {
    const { runtime } = fakeRuntime();
    const harness = fakeContext({ model: m365 });
    await setupStatus(harness.ctx as never, runtime);

    expect(harness.rpcFor).toHaveBeenCalledWith(METRICS_RPC);
    expect(claimAt(harness.claims, "prompt.footer.status")).toBeDefined();
    expect(claimAt(harness.claims, "sidebar.content")).toBeDefined();
  });

  it("shows the footer line for an m365 session once its metrics arrive", async () => {
    const { runtime, show } = fakeRuntime();
    const harness = fakeContext({ model: m365 });
    const status = await setupStatus(harness.ctx as never, runtime);
    const rendered = claimAt(harness.claims, "prompt.footer.status").render({ sessionID: "ses_1", mode: "normal", showDetails: false });

    expect(show(rendered)).toBeNull();
    await status.feed.settled();
    expect(show(rendered)).toBe("M365 2/600 msgs");
    expect(harness.get).toHaveBeenCalledWith({ sessionID: "ses_1" }, { location: { directory: "/work" } });
  });

  it("renders nothing for a session on another provider, and fetches nothing for it", async () => {
    const { runtime, show } = fakeRuntime();
    const harness = fakeContext({ model: { providerID: "anthropic", modelID: "claude" } });
    const status = await setupStatus(harness.ctx as never, runtime);
    const footer = claimAt(harness.claims, "prompt.footer.status").render({ sessionID: "ses_1", mode: "normal", showDetails: false });
    const sidebar = claimAt(harness.claims, "sidebar.content").render({ sessionID: "ses_1" });
    await status.feed.settled();

    expect(show(footer)).toBeNull();
    expect(show(sidebar)).toBeNull();
    expect(harness.get).not.toHaveBeenCalled();
  });

  it("renders nothing in the footer with no session", async () => {
    const { runtime, show } = fakeRuntime();
    const harness = fakeContext({ model: m365 });
    await setupStatus(harness.ctx as never, runtime);
    const footer = claimAt(harness.claims, "prompt.footer.status").render({ mode: "normal", showDetails: false });
    expect(show(footer)).toBeNull();
  });

  it("decides the sidebar's provider from the session's own model, using its location", async () => {
    const { runtime, show } = fakeRuntime();
    const harness = fakeContext({
      model: { providerID: "anthropic", modelID: "claude" },
      sessions: { ses_1: { model: { id: "claude-opus", providerID: "m365" }, location: { directory: "/other" } } },
    });
    const status = await setupStatus(harness.ctx as never, runtime);
    const sidebar = claimAt(harness.claims, "sidebar.content").render({ sessionID: "ses_1" });
    show(sidebar);
    await status.feed.settled();

    expect(show(sidebar)).toEqual(["M365 Copilot · Claude Opus 5.5", "Messages  2/600", "Turns     14"]);
    expect(harness.get).toHaveBeenCalledWith({ sessionID: "ses_1" }, { location: { directory: "/other" } });
  });

  it("refetches when the proxy says a session changed, and when a model step ends or fails", async () => {
    const { runtime, show } = fakeRuntime();
    const harness = fakeContext({ model: m365 });
    const status = await setupStatus(harness.ctx as never, runtime);
    show(claimAt(harness.claims, "prompt.footer.status").render({ sessionID: "ses_1", mode: "normal", showDetails: false }));
    await status.feed.settled();
    expect(harness.get).toHaveBeenCalledTimes(1);

    harness.rpcHandlers.get("updated")!({ data: { sessionID: "ses_1" } });
    await status.feed.settled();
    expect(harness.get).toHaveBeenCalledTimes(2);

    // opencode 2.2.5 never emits `session.idle` (measured live): a turn ends with
    // `session.step.ended`, a refused one with `session.step.failed`. With an external
    // proxy these are the only refresh, since its store announces nothing.
    expect(harness.dataHandlers.has("session.idle")).toBe(false);
    harness.dataHandlers.get("session.step.ended")!({ data: { sessionID: "ses_1" } });
    await status.feed.settled();
    expect(harness.get).toHaveBeenCalledTimes(3);
    harness.dataHandlers.get("session.step.failed")!({ data: { sessionID: "ses_1" } });
    await status.feed.settled();
    expect(harness.get).toHaveBeenCalledTimes(4);
  });

  it("releases its claims and listeners on cleanup", async () => {
    const { runtime } = fakeRuntime();
    const harness = fakeContext({ model: m365 });
    const status = await setupStatus(harness.ctx as never, runtime);
    await status.cleanup();

    expect(harness.claims.every((entry) => entry.disposed)).toBe(true);
    expect(harness.rpcHandlers.size).toBe(0);
    expect(harness.dataHandlers.size).toBe(0);
  });

  it("still loads when the client has no RPC: the status just stays empty", async () => {
    const { runtime, show } = fakeRuntime();
    const harness = fakeContext({ model: m365 });
    (harness.ctx.client as { rpc?: unknown }).rpc = undefined;
    const status = await setupStatus(harness.ctx as never, runtime);
    const footer = claimAt(harness.claims, "prompt.footer.status").render({ sessionID: "ses_1", mode: "normal", showDetails: false });
    show(footer);
    await status.feed.settled();
    expect(show(footer)).toBeNull();
  });
});
