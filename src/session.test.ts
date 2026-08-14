import { afterEach, describe, expect, it } from "vitest";
import {
  botMessage,
  completion,
  delta,
  disengaged,
  startStubCopilot,
  streamItem,
  throttling,
  type StubServer,
} from "../test/stub-copilot.js";
import { CopilotSession, DisengagedError, decodeJwt } from "./session.js";

/** A token carrying just the claims we read: object id and tenant id. */
function fakeToken(oid = "aaaa-oid", tid = "bbbb-tid"): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ oid, tid })}.sig`;
}

let stub: StubServer | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

function sessionFor(server: StubServer, overrides: Record<string, any> = {}) {
  return new CopilotSession({
    getToken: async () => fakeToken(),
    endpoint: server.origin,
    ...overrides,
  });
}

/** The chat invocation the client sent (type 4, target "chat"). */
function chatFrame(server: StubServer) {
  return server.last().frames.find((f) => f.type === 4 && f.target === "chat");
}

describe("decodeJwt", () => {
  it("reads oid and tid out of the token", () => {
    expect(decodeJwt(fakeToken("o1", "t1"))).toMatchObject({ oid: "o1", tid: "t1" });
  });

  it("throws on a malformed token rather than returning junk claims", () => {
    expect(() => decodeJwt("not-a-jwt")).toThrow();
  });
});

describe("connecting", () => {
  it("addresses the chathub as {oid}@{tid}", async () => {
    stub = await startStubCopilot();
    await sessionFor(stub).run("hi");
    expect(stub.last().url).toContain("/m365Copilot/Chathub/aaaa-oid@bbbb-tid");
  });

  it("puts the access token in the query string, where M365 expects it", async () => {
    stub = await startStubCopilot();
    await sessionFor(stub).run("hi");
    const url = new URL(stub.last().url, "http://x");
    expect(url.searchParams.get("access_token")).toBe(fakeToken());
  });

  it("carries the conversation id in the query string", async () => {
    stub = await startStubCopilot();
    const session = sessionFor(stub);
    await session.run("hi");
    const url = new URL(stub.last().url, "http://x");
    expect(url.searchParams.get("ConversationId")).toBe(session.conversationId);
  });

  it("performs the SignalR handshake before anything else", async () => {
    stub = await startStubCopilot();
    await sessionFor(stub).run("hi");
    expect(stub.last().frames[0]).toEqual({ protocol: "json", version: 1 });
  });
});

describe("sending a turn", () => {
  it("sends the mandatory Metrics frame — without it the turn never starts", async () => {
    stub = await startStubCopilot();
    await sessionFor(stub).run("hi");
    const metrics = stub.last().frames.find((f) => f.type === 1 && f.target === "Metrics");
    expect(metrics).toBeDefined();
    expect(metrics.arguments[0].Timestamps).toBeDefined();
  });

  it("puts the prompt text on the chat message", async () => {
    stub = await startStubCopilot();
    await sessionFor(stub).run("what is 7x8?");
    expect(chatFrame(stub).arguments[0].message.text).toBe("what is 7x8?");
  });

  it("selects the model with a tone, since there is no model parameter", async () => {
    stub = await startStubCopilot();
    await sessionFor(stub).run("hi", { tone: "Gpt_5_5_Reasoning" });
    expect(chatFrame(stub).arguments[0].tone).toBe("Gpt_5_5_Reasoning");
  });

  it("uses invocationId 0 for the chat frame", async () => {
    stub = await startStubCopilot();
    await sessionFor(stub).run("hi");
    expect(chatFrame(stub).invocationId).toBe("0");
  });

  it("marks only the first turn as the start of the session", async () => {
    stub = await startStubCopilot();
    const session = sessionFor(stub);
    await session.run("first");
    expect(chatFrame(stub).arguments[0].isStartOfSession).toBe(true);
    await session.run("second");
    expect(chatFrame(stub).arguments[0].isStartOfSession).toBe(false);
  });

  it("reuses the conversation across turns, because the 600 cap is per conversation", async () => {
    stub = await startStubCopilot();
    const session = sessionFor(stub);
    await session.run("first");
    await session.run("second");
    const ids = stub.connections.map((c) => new URL(c.url, "http://x").searchParams.get("ConversationId"));
    expect(new Set(ids).size).toBe(1);
  });

  it("opens a fresh websocket per turn", async () => {
    stub = await startStubCopilot();
    const session = sessionFor(stub);
    await session.run("first");
    await session.run("second");
    expect(stub.connections).toHaveLength(2);
  });

  it("starts a new conversation after reset", async () => {
    stub = await startStubCopilot();
    const session = sessionFor(stub);
    await session.run("first");
    const before = session.conversationId;
    session.reset();
    await session.run("second");
    expect(session.conversationId).not.toBe(before);
    expect(chatFrame(stub).arguments[0].isStartOfSession).toBe(true);
  });
});

describe("agent attachment", () => {
  it("references the declarative agent when one is supplied", async () => {
    stub = await startStubCopilot();
    await sessionFor(stub).run("hi", { agentId: "T_123.abc.gpt.default" });
    const message = chatFrame(stub).arguments[0];
    expect(message.threadLevelGptId).toEqual({ id: "T_123.abc.gpt.default", source: "MOS3" });
    expect(message.gpts[0].id).toBe("T_123.abc.gpt.default");
  });

  it("does not send the built-in plugins alongside an agent", async () => {
    stub = await startStubCopilot();
    await sessionFor(stub).run("hi", { agentId: "T_123.abc.gpt.default" });
    expect(chatFrame(stub).arguments[0].plugins).toBeUndefined();
  });

  it("sends the built-in search plugin when there is no agent", async () => {
    stub = await startStubCopilot();
    await sessionFor(stub).run("hi");
    expect(chatFrame(stub).arguments[0].plugins).toEqual([{ Id: "BingWebSearch", Source: "BuiltIn" }]);
  });
});

describe("receiving a response", () => {
  it("accumulates streamed deltas", async () => {
    stub = await startStubCopilot({
      respond: () => [delta("Hello"), delta(" there"), streamItem("Hello there"), completion()],
    });
    const result = await sessionFor(stub).run("hi");
    expect(result.text).toBe("Hello there");
  });

  it("reports deltas to the caller as they arrive", async () => {
    stub = await startStubCopilot({
      respond: () => [delta("a"), delta("b"), streamItem("ab"), completion()],
    });
    const chunks: string[] = [];
    await sessionFor(stub).run("hi", { onDelta: (chunk) => chunks.push(chunk) });
    expect(chunks).toEqual(["a", "b"]);
  });

  it("accepts a full message snapshot when no deltas arrive", async () => {
    stub = await startStubCopilot({
      respond: () => [botMessage("the whole answer"), streamItem("the whole answer"), completion()],
    });
    expect((await sessionFor(stub).run("hi")).text).toBe("the whole answer");
  });

  it("ignores bot messages that carry a messageType — those are control traffic", async () => {
    stub = await startStubCopilot({
      respond: () => [
        botMessage("Searching the web…", { messageType: "InternalSearchQuery" }),
        botMessage("real answer"),
        streamItem("real answer"),
        completion(),
      ],
    });
    const result = await sessionFor(stub).run("hi");
    expect(result.text).toBe("real answer");
  });

  it("keeps whichever of the delta stream and the snapshot is longer", async () => {
    stub = await startStubCopilot({
      respond: () => [delta("short"), botMessage("a considerably longer answer"), completion()],
    });
    expect((await sessionFor(stub).run("hi")).text).toBe("a considerably longer answer");
  });

  it("answers pings so the connection stays alive", async () => {
    stub = await startStubCopilot({ pingFirst: true });
    await sessionFor(stub).run("hi");
    await expect(stub.last().waitForFrame((f) => f.type === 6)).resolves.toBeDefined();
  });

  it("reads the per-conversation quota off the throttling frame", async () => {
    stub = await startStubCopilot({
      respond: () => [throttling(42), botMessage("ok"), completion()],
    });
    const result = await sessionFor(stub).run("hi");
    expect(result.throttle).toEqual({ current: 42, max: 600 });
  });

  it("surfaces the classifier scores that predict disengagement", async () => {
    stub = await startStubCopilot({
      respond: () => [
        streamItem("ok", { scores: [{ component: "dea_violation", score: 2.8e-6 }], contentOrigin: "DeepLeo" }),
        completion(),
      ],
    });
    const result = await sessionFor(stub).run("hi");
    expect(result.scores?.dea_violation).toBeCloseTo(2.8e-6);
    expect(result.contentOrigin).toBe("DeepLeo");
  });

  it("ends the turn on a completion frame", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("done"), completion()] });
    expect((await sessionFor(stub).run("hi")).text).toBe("done");
  });
});

describe("failure modes", () => {
  it("throws a distinct error on Disengaged, which is NOT rate limiting", async () => {
    // Empty content makes this look like throttling; retrying just disengages again
    // and burns the 600-message conversation quota.
    stub = await startStubCopilot({ respond: () => [disengaged(), completion()] });
    await expect(sessionFor(stub).run("hi")).rejects.toBeInstanceOf(DisengagedError);
  });

  it("reports a server-side invocation error", async () => {
    // An unknown tone comes back exactly like this.
    stub = await startStubCopilot({ respond: () => [completion("Failed to invoke 'Chat'")] });
    await expect(sessionFor(stub).run("hi")).rejects.toThrow(/Failed to invoke/);
  });

  it("returns an empty result rather than hanging when the turn produces nothing", async () => {
    stub = await startStubCopilot({ respond: () => [completion()] });
    const result = await sessionFor(stub).run("hi");
    expect(result.text).toBe("");
  });
});

describe("cancellation", () => {
  it("sends the stop frame and gives up when the caller aborts", async () => {
    stub = await startStubCopilot({ delayMs: 3000 });
    const controller = new AbortController();
    const session = sessionFor(stub);
    const running = session.run("hi", { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 150));
    controller.abort();

    await expect(running).rejects.toThrow(/abort/i);
    const stop = await stub.last().waitForFrame((f) => f.target === "stop");
    expect(stop).toMatchObject({ type: 1, target: "stop", invocationId: "1" });
  });

  it("rejects immediately if the signal is already aborted", async () => {
    stub = await startStubCopilot();
    await expect(sessionFor(stub).run("hi", { signal: AbortSignal.abort() })).rejects.toThrow(/abort/i);
  });
});
