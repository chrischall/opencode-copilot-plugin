/**
 * The opencode plugin.
 *
 * opencode 1.18 loads a plugin module by its **default export**, which must be an
 * object with a `server()` function — verified against the shipped binary, which
 * rejects anything else with "must default export an object with server()".
 *
 * What the plugin does, in order of importance:
 *
 * 1. Starts the OpenAI-compatible proxy in-process and registers it as a provider.
 * 2. Trims opencode's toolset. This is not a nicety — M365's Disengaged filter fires
 *    persistently on a full coding-agent toolset, and opencode's is named in the
 *    reference project's notes as the case that fails. Without the trim you get
 *    empty replies that look like rate limiting.
 * 3. Condenses the system prompt M365 receives, dropping capability catalogues the
 *    trimmed toolset cannot act on (34k of a 53k prompt, measured against 1.18.18).
 *
 * Auth is deliberately not here: the plugin only refreshes silently, and tells the
 * user to run `opencode-m365 login` if it cannot. Launching a browser underneath a
 * TUI is not something a plugin should do.
 */

import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { createTokenClient } from "./auth.js";
import { getOrCreateAgent } from "./agent.js";
import { applyPluginConfig, resolveOptions, type PluginOptions } from "./config.js";
import { startServer, type ProxyHandle } from "./server.js";
import { createLogger } from "./log.js";

const log = createLogger("plugin");

/**
 * The system prompt used for M365 models.
 *
 * opencode's own prompt is long and carefully worded for frontier models. Measured
 * against M365, a shorter and blunter prompt produced markedly better tool
 * compliance — the same model confabulates ("I can't access the files, paste them")
 * under a longer, more polished assistant prompt.
 *
 * This is applied in the **proxy**, not through opencode's own hook. Verified
 * against opencode 1.18.18: `experimental.chat.system.transform` fires and happily
 * accepts a replacement `system` array, but the request that reaches the provider
 * still carries the original prompt; setting `agent.<name>.prompt` from the `config`
 * hook is ignored the same way. Since our provider only ever serves our own models,
 * doing it proxy-side is also correctly scoped — no other provider is affected.
 */
const LEAN_SYSTEM_PROMPT = [
  "You are a coding agent working in the user's real workspace on this machine.",
  "The files and commands are real, and anything you run actually runs.",
  "",
  "Work one step at a time: take an action, read the result, then decide the next step.",
  "Inspect before you change something, and check your change afterwards.",
  "Report what you actually did, not what you intended to do.",
].join("\n");

export const M365CopilotPlugin: Plugin = async (input: PluginInput, rawOptions?: Record<string, unknown>) => {
  const options = resolveOptions(rawOptions as Partial<PluginOptions> | undefined);
  const tokens = createTokenClient();

  let proxy: ProxyHandle | undefined;
  let baseUrl = options.baseUrl;

  if (!baseUrl) {
    proxy = await startServer({
      getToken: () => tokens.getToken(),
      // Provisioning the declarative agent needs Copilot Studio scopes and a few
      // round trips, so it happens lazily on the first turn that carries tools.
      resolveAgent: () => getOrCreateAgent({ getTokenForScope: (scopes) => tokens.getTokenForScope(scopes) }),
      lean: options.lean,
      ...(options.leanSystemPrompt ? { leanSystemPrompt: LEAN_SYSTEM_PROMPT } : {}),
    });
    baseUrl = `${proxy.url}/v1`;
    log.info(`M365 Copilot proxy listening on ${proxy.url}`);
  }

  await input.client.app
    .log({
      body: {
        service: "m365-copilot",
        level: "info",
        message: `Microsoft 365 Copilot ready at ${baseUrl}`,
        extra: { lean: options.lean },
      },
    })
    .catch(() => {
      /* logging must not break plugin load */
    });

  const hooks: Hooks = {
    async config(config) {
      applyPluginConfig(config as Record<string, any>, baseUrl!, options);
    },

    async dispose() {
      await proxy?.close();
    },
  };

  return hooks;
};

export default {
  id: "opencode-m365-copilot",
  server: M365CopilotPlugin,
};
