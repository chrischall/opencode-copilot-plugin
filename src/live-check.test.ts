import { afterEach, describe, expect, it } from "vitest";
import { completion, delta, disengaged, startStubCopilot, streamItem, type StubServer } from "../test/stub-copilot.js";
import { checkTones, distinctTones } from "./live-check.js";
import { MODELS } from "./models.js";
import { CopilotSession } from "./session.js";

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${b64({ alg: "none" })}.${b64({ oid: "o", tid: "t" })}.sig`;

let stub: StubServer | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

const sessionFor = (server: StubServer) =>
  new CopilotSession({ getToken: async () => token, endpoint: server.origin });

describe("distinctTones", () => {
  it("lists each M365 tone once and skips local models", () => {
    const tones = distinctTones(MODELS);
    expect(new Set(tones).size).toBe(tones.length);
    expect(tones).toContain("Gpt_5_5_Chat");
    expect(tones).not.toContain(null);
  });
});

describe("checkTones", () => {
  it("passes a tone that answers", async () => {
    stub = await startStubCopilot({ respond: () => [delta("ok"), streamItem("ok", { contentOrigin: "DeepLeo" }), completion()] });
    expect(await checkTones(sessionFor(stub), ["Gpt_5_5_Chat"])).toEqual([
      { tone: "Gpt_5_5_Chat", ok: true, detail: "DeepLeo" },
    ]);
  });

  it("fails a tone the server rejects, and carries on to the next", async () => {
    stub = await startStubCopilot({
      respond: (chat) =>
        chat.arguments[0].tone === "Gone" ? [completion("Failed to invoke 'Chat'")] : [delta("ok"), completion()],
    });
    const results = await checkTones(sessionFor(stub), ["Gone", "Live"]);
    expect(results.map((result) => result.ok)).toEqual([false, true]);
    expect(results[0]!.detail).toMatch(/Failed to invoke/);
  });

  it("fails a registered-but-dead tone even though it replied", async () => {
    stub = await startStubCopilot({ respond: () => [delta("Sorry"), streamItem("Sorry", { contentOrigin: "BotConnection" }), completion()] });
    const [result] = await checkTones(sessionFor(stub), ["Dead"]);
    expect(result!.ok).toBe(false);
    expect(result!.detail).toMatch(/BotConnection/);
  });

  it("fails an empty reply and a disengage", async () => {
    let turn = 0;
    stub = await startStubCopilot({ respond: () => (turn++ === 0 ? [completion()] : [disengaged(), completion()]) });
    const results = await checkTones(sessionFor(stub), ["Empty", "Refused"]);
    expect(results.map((result) => result.ok)).toEqual([false, false]);
  });

  it("uses one conversation for every tone, since the throttle counts conversations", async () => {
    stub = await startStubCopilot({ respond: () => [delta("ok"), completion()] });
    await checkTones(sessionFor(stub), ["A", "B"]);
    const ids = stub.connections.map((connection) =>
      connection.frames.find((frame) => frame.target === "chat").arguments[0].conversationId,
    );
    expect(new Set(ids).size).toBe(1);
  });
});
