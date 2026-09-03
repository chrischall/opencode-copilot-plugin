/**
 * The opencode plugin.
 *
 * opencode does NOT load this file because it is the package's main entry. It loads
 * whatever the package's **`./server` export subpath** resolves to, falling back to
 * the root entry only when there is no such subpath — `./server` is opencode's name
 * for the server-side plugin, so a package must not use it for a module of its own.
 * We did, pointing it at the HTTP proxy, and that is what issue #26 actually was.
 *
 * Once it has that module the loader walks **every** export and requires each one to
 * be either a function or an object with a `server()` function — both shapes are
 * accepted, so the default export's shape was never the problem. One non-plugin
 * export (the proxy's `DEFAULT_MODEL` string, in our case) is enough to fail the
 * whole load with "Plugin export is not a function", which is why that message sent
 * #18 and #27 hunting the wrong thing. `src/plugin-entry.test.ts` pins both rules.
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

// The default must be the *same object* as the named export, not a wrapper around it.
// The loader dedupes by identity before it collects, so `{ id, server: M365CopilotPlugin }`
// and `M365CopilotPlugin` read as two plugins and start the proxy twice.
//
// This line is Tess Hoffman's, from #27. It did not fix #26 — that was the `./server`
// export subpath, above — but it is right on its own merits, and #29 squashed without
// carrying their authorship across.
export default M365CopilotPlugin;
