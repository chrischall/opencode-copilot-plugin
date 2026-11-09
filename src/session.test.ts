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
import { CopilotSession, DisengagedError, decodeJwt, cleanAnswer } from "./session.js";

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

describe("mailbox grounding", () => {
  it("switches the URL to the Outlook side-pane scenario when grounded", async () => {
    stub = await startStubCopilot();
    await sessionFor(stub).run("what is in my inbox?", { grounded: true });
    const url = new URL(stub.last().url, "http://x");
    expect(url.searchParams.get("scenario")).toBe("OutlookSidepaneWorkCopilot");
    expect(url.searchParams.get("agentHost")).toBe("Bizchat.Sidepane");
    expect(url.searchParams.get("agent")).toBe("work");
  });

  it("keeps the full-screen scenario for an ordinary (ungrounded) turn", async () => {
    stub = await startStubCopilot();
    await sessionFor(stub).run("hi");
    expect(new URL(stub.last().url, "http://x").searchParams.get("scenario")).toBe("OfficeWebIncludedCopilot");
  });

  it("attaches the built-in WorkSearch agent that grounds on the mailbox", async () => {
    stub = await startStubCopilot();
    await sessionFor(stub).run("hi", { grounded: true });
    const arg = chatFrame(stub).arguments[0];
    expect(arg.gpts[0].id).toBe("bizchat-as-gpt-scenario");
    expect(arg.gpts[0].clientOverrides.capabilities).toEqual([{ name: "WebSearch" }, { name: "WorkSearch" }]);
    expect(arg.source).toBe("owahub");
  });

  it("lets grounding win over a declarative agentId", async () => {
    stub = await startStubCopilot();
    await sessionFor(stub).run("hi", { grounded: true, agentId: "T_123.abc.gpt.default" });
    expect(chatFrame(stub).arguments[0].gpts[0].id).toBe("bizchat-as-gpt-scenario");
    expect(chatFrame(stub).arguments[0].threadLevelGptId).toBeUndefined();
  });
});

describe("cleanAnswer", () => {
  it("strips citation control tokens, keeping the prose", () => {
    const raw = "You have 170 unread. citeturn1search23turn1search7 Done.【2-9c5ade】";
    expect(cleanAnswer(raw)).toBe("You have 170 unread. Done.");
  });

  it("leaves ordinary code/prose untouched", () => {
    expect(cleanAnswer("const x = 1; // fine")).toBe("const x = 1; // fine");
  });

  it("preserves code indentation while stripping tokens (grounded answers can hold code)", () => {
    const raw = "Here is the snippet: citeturn1search2\n\n    def f():\n        return 1\u30101-x\u3011";
    const clean = cleanAnswer(raw);
    expect(clean).toContain("\n    def f():");
    expect(clean).toContain("\n        return 1");
    expect(clean).not.toMatch(/cite|【/);
  });

  it("cleans citation tokens out of a streamed answer", async () => {
    stub = await startStubCopilot({
      respond: () => [delta("Reviewed. citeturn1search3 "), delta("All good."), completion()],
    });
    expect((await sessionFor(stub).run("hi", { grounded: true })).text).toBe("Reviewed. All good.");
  });

  it("does NOT run on an ungrounded turn, so coding indentation survives verbatim", async () => {
    // The regression the review caught: cleanAnswer must not touch a coding turn.
    stub = await startStubCopilot({ respond: () => [delta("def f():\n    if x:\n        return  1"), completion()] });
    const result = await sessionFor(stub).run("write a function"); // grounded defaults false
    expect(result.text).toBe("def f():\n    if x:\n        return  1");
  });
});

describe("images", () => {
  const PNG = "data:image/png;base64,iVBORw0KGgo=";

  it("uploads each image into this conversation, then points the chat message at it", async () => {
    stub = await startStubCopilot();
    const session = sessionFor(stub);
    await session.run("what is in this?", { images: [PNG, "data:image/jpeg;base64,/9j/"] });

    expect(stub.uploads.map((upload) => upload.form.get("conversationId"))).toEqual([
      session.conversationId,
      session.conversationId,
    ]);
    expect(stub.uploads[0]?.headers.authorization).toBe(`Bearer ${fakeToken()}`);

    const message = chatFrame(stub).arguments[0].message;
    expect(message.messageAnnotations.map((a: any) => [a.id, a.messageAnnotationMetadata.fileType])).toEqual([
      ["doc-1", "png"],
      ["doc-2", "jpg"],
    ]);
    expect(message.text).toBe("what is in this?");
  });

  it("sends no annotations on a turn without images", async () => {
    stub = await startStubCopilot();
    await sessionFor(stub).run("hi");
    expect(chatFrame(stub).arguments[0].message.messageAnnotations).toBeUndefined();
    expect(stub.uploads).toHaveLength(0);
  });

  it("works with the agent attached, which the upload does not depend on", async () => {
    stub = await startStubCopilot();
    await sessionFor(stub).run("look", { images: [PNG], agentId: "T_1.a.gpt.default" });
    expect(chatFrame(stub).arguments[0].message.messageAnnotations).toHaveLength(1);
  });

  it("tells the model an image did not arrive, so it does not describe one it never saw", async () => {
    stub = await startStubCopilot({
      upload: (upload) =>
        upload.form.get("FileBase64") === PNG ? { status: 500, body: "boom" } : { status: 200, body: { docId: "ok-1" } },
    });
    await sessionFor(stub).run("compare these", {
      images: [PNG, "https://example.com/remote.png", "data:image/gif;base64,R0lG"],
    });

    const message = chatFrame(stub).arguments[0].message;
    expect(message.messageAnnotations.map((a: any) => a.id)).toEqual(["ok-1"]);
    expect(message.text).toMatch(/^compare these/);
    expect(message.text).toMatch(/2 of the 3 attached images could not be/);
    // Only data URLs are uploaded; a remote URL is never fetched.
    expect(stub.uploads).toHaveLength(2);
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

  it("rejects when the socket drops mid-answer instead of returning a truncated turn", async () => {
    stub = await startStubCopilot({
      respond: (_chat, connection) => {
        setTimeout(() => connection.socket.close(1011, "server going away"), 30);
        return [delta("partial ans")];
      },
    });
    await expect(sessionFor(stub).run("hi")).rejects.toThrow(/closed before the turn completed.*1011.*server going away/);
  });

  it("rejects when the server closes before answering at all", async () => {
    stub = await startStubCopilot({
      respond: (_chat, connection) => {
        setTimeout(() => connection.socket.close(1008, "policy"), 10);
        return [];
      },
    });
    await expect(sessionFor(stub).run("hi")).rejects.toThrow(/closed before the turn completed.*1008/);
  });

  it("treats a clean close frame (type 7) as the end of the turn", async () => {
    stub = await startStubCopilot({ respond: () => [botMessage("done"), { type: 7 }] });
    expect((await sessionFor(stub).run("hi")).text).toBe("done");
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
