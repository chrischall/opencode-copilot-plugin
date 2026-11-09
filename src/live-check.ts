/**
 * Ask M365 whether each tone we advertise still serves.
 *
 * Tones get retired without notice, and a retired tone only shows up when a turn
 * fails. All tones share one conversation because the account throttle counts
 * conversations started, and no agent is attached so the tone is what gets tested.
 */

import type { ModelInfo } from "./models.js";
import type { CopilotSession } from "./session.js";

export interface ToneResult {
  tone: string;
  ok: boolean;
  detail: string;
}

export function distinctTones(models: readonly ModelInfo[]): string[] {
  return [...new Set(models.flatMap((model) => (model.tone ? [model.tone] : [])))];
}

export async function checkTones(
  session: Pick<CopilotSession, "run">,
  tones: readonly string[],
): Promise<ToneResult[]> {
  const results: ToneResult[] = [];
  for (const tone of tones) {
    try {
      const { text, contentOrigin } = await session.run("Please reply with the word ok.", { tone });
      // BotConnection is the canned apology of a tone that is registered but dead.
      const ok = text.trim() !== "" && contentOrigin !== "BotConnection";
      results.push({ tone, ok, detail: text.trim() === "" ? "empty reply" : (contentOrigin ?? "replied") });
    } catch (error) {
      results.push({ tone, ok: false, detail: (error as Error).message });
    }
  }
  return results;
}
