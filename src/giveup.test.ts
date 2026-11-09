import { describe, expect, it } from "vitest";
import { looksLikeGiveUp, nudgeFor } from "./giveup.js";

describe("looksLikeGiveUp", () => {
  // Every one of these came back live, on a tool turn, instead of a tool call.
  it.each([
    "I can’t access `secret.txt` because the available file-reading tool did not execute in this session.",
    "I can’t access `secret.txt` because no usable file-reading tool is available in this session.",
    "I can't read `secret.txt` because the available file-reading tool is not currently executable in this session.",
    "I can't run `shasum -a 256 data.bin` because this environment does not provide a shell execution tool.",
    "I can't directly run shell commands in this environment because no shell execution tool is available.",
    "If you run it locally and paste the output here, I can help verify it.",
    "I don't have access to your files from here.",
  ])("catches %s", (reply) => {
    expect(looksLikeGiveUp(reply)).toBe(true);
  });

  it.each([
    "The `add(a, b)` function returns `a - b`, meaning it subtracts `b` from `a`.",
    "Done: settings.py now sets PORT = 9090 and the test passes.",
    "The line is in notes4.txt: TOKEN-1a2b3c4d",
    "",
  ])("leaves a real answer alone: %s", (reply) => {
    expect(looksLikeGiveUp(reply)).toBe(false);
  });
});

describe("nudgeFor", () => {
  it("does not claim nothing has run once tools have run", () => {
    expect(nudgeFor(true)).not.toMatch(/not run|haven.t run|first step/i);
    expect(nudgeFor(true)).toMatch(/ran/);
  });

  it("asks for a first step when nothing has run yet", () => {
    expect(nudgeFor(false)).toMatch(/first step/i);
  });

  it.each([false, true])("stays clear of shouted, jailbreak-shaped wording (mid-task: %s)", (midTask) => {
    const text = nudgeFor(midTask);
    expect(text).not.toMatch(/\b[A-Z]{3,}\b/);
    expect(text).not.toMatch(/<\/?(system|user|assistant)>/i);
    expect(text.length).toBeLessThan(300);
  });
});
