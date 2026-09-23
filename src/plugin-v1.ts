/**
 * The opencode 1 plugin: the `server()` half of the entry in `plugin.ts`.
 *
 * What it does, in order of importance:
 *
 * 1. Starts the OpenAI-compatible proxy in-process and registers it as a provider.
 * 2. Trims opencode's toolset. This is not a nicety — M365's Disengaged filter fires
 *    persistently on a full coding-agent toolset, and opencode's is named in the
 *    reference project's notes as the case that fails. Without the trim you get
 *    empty replies that look like rate limiting.
 * 3. Condenses the system prompt M365 receives, dropping capability catalogues the
 *    trimmed toolset cannot act on (34k of a 53k prompt, measured against 1.18.18).
 *
 * Only (1) is expressed here. (2) and (3) live in the proxy, because opencode 1's
 * own levers for them were measured non-functional — see `runtime.ts` and AGENTS.md.
 */

import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { applyPluginConfig } from "./config.js";
import { startRuntime } from "./runtime.js";

export async function server(input: PluginInput, rawOptions?: Record<string, unknown>): Promise<Hooks> {
  const runtime = await startRuntime(rawOptions);

  await input.client.app
    .log({
      body: {
        service: "m365-copilot",
        level: "info",
        message: `Microsoft 365 Copilot ready at ${runtime.baseUrl}`,
        extra: { lean: runtime.options.lean },
      },
    })
    .catch(() => {
      /* logging must not break plugin load */
    });

  return {
    async config(config) {
      applyPluginConfig(config as Record<string, any>, runtime, runtime.options);
    },

    async dispose() {
      await runtime.close();
    },
  };
}
