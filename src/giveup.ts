/**
 * Spotting a tool turn where the model gave up instead of acting.
 *
 * M365's chat tones sometimes answer a tool turn by claiming they have no tools or
 * cannot reach the files, without trying. It is stochastic: the same tone acts on the
 * next try. Returned to opencode as-is, that prose ends the agent loop, so the proxy
 * asks once more in the same conversation instead. The reference project measured
 * that recovering roughly 16/30 → 25/30 tasks on `Gpt_5_5_Chat`.
 */

const GIVE_UP_PATTERNS: readonly RegExp[] = [
  // "I can't access / run / read …", with or without "to" and "directly".
  /\b(?:unable|not able|can.?t|cannot)\s+(?:to\s+)?(?:directly\s+)?(?:access|inspect|list|read|run|execute|retrieve|fetch|open|see|edit|modify|write|create|change)\b/i,
  /\bdon.?t\s+have\s+(?:access|any\s+(?:way|tool)|a\s+(?:way|tool))\b/i,
  // "no usable file-reading tool is available", "no shell execution tool is available"
  /\bno\s+(?:[\w-]+\s+){0,3}tools?\s+(?:is|are)\s+(?:currently\s+)?(?:available|accessible|executable)\b/i,
  // "the available file-reading tool is not currently executable / did not execute"
  /\btools?\b[^.\n]{0,40}\b(?:(?:is|are)\s+not\s+(?:currently\s+)?(?:available|executable|accessible)|unavailable|no\s+longer\s+available|did\s*n.?o?t\s+execute)\b/i,
  // "this environment does not provide a shell execution tool"
  /\b(?:does\s+not|doesn.?t)\s+(?:provide|have|expose)\s+(?:a|any)\s+[\w\s-]{0,30}\btool\b/i,
  /\bpaste\s+(?:the\s+|its\s+)?(?:contents?|files?|code|output)\b/i,
  /\b(?:different|another|new)\s+(?:session|environment|conversation)\b/i,
];

export function looksLikeGiveUp(reply: string): boolean {
  const text = reply.trim();
  return text.length >= 12 && GIVE_UP_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * The follow-up. Soft on purpose: shouted absolutes read as manipulation to the
 * Disengaged filter. Once tools have run it must not say nothing has — a prompt that
 * contradicts the transcript is one the model stops trusting.
 */
export function nudgeFor(midTask: boolean): string {
  return midTask
    ? "Your earlier tool blocks really ran on this machine, and their results are in this conversation. Please continue with one tool block for the next step."
    : "The files are on this machine, and the tools listed earlier run here for you when you write a tool block. Please take the first step now with one tool block.";
}
