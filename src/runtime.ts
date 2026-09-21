/**
 * The part of the plugin that is the same under both opencode plugin APIs.
 *
 * v1 and v2 disagree about almost everything — how a plugin is declared, how it is
 * loaded, how it registers a provider — but they agree completely about what this
 * plugin *does*: stand up the OpenAI-compatible proxy, and hand back the URL it is
 * listening on. That is all this module is.
 *
 * Auth is deliberately not here: the plugin only refreshes silently, and tells the
 * user to run `opencode-m365 login` if it cannot. Launching a browser underneath a
 * TUI is not something a plugin should do.
 */

import { getOrCreateAgent } from "./agent.js";
import { createTokenClient } from "./auth.js";
import { resolveOptions, type PluginOptions } from "./config.js";
import { createLogger } from "./log.js";
import { startServer } from "./server.js";

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
 *
 * opencode 2 offers `session.hook("context")` as a working replacement for that dead
 * v1 hook. It has not been measured against a live tenant, and the proxy is the only
 * layer that is true for every harness, so the logic stays here until it has been.
 */
const LEAN_SYSTEM_PROMPT = [
  "You are a coding agent working in the user's real workspace on this machine.",
  "The files and commands are real, and anything you run actually runs.",
  "",
  "Work one step at a time: take an action, read the result, then decide the next step.",
  "Inspect before you change something, and check your change afterwards.",
  "Report what you actually did, not what you intended to do.",
].join("\n");

export interface M365Runtime {
  /** Where the OpenAI-compatible surface is, ready to hand to a provider entry. */
  baseUrl: string;
  options: PluginOptions;
  /** Stops the proxy, if this runtime is the one that started it. */
  close(): Promise<void>;
}

/**
 * Resolve options and bring the proxy up.
 *
 * With `baseUrl` set the caller already has a proxy running — `opencode-m365 serve`,
 * or a test — and we attach to it rather than binding a second port. `close()` is
 * then a no-op, because a runtime must not shut down a server it did not start.
 */
export async function startRuntime(rawOptions?: Record<string, unknown>): Promise<M365Runtime> {
  const options = resolveOptions(rawOptions as Partial<PluginOptions> | undefined);

  if (options.baseUrl) {
    return { baseUrl: options.baseUrl, options, close: async () => {} };
  }

  const tokens = createTokenClient();
  const proxy = await startServer({
    getToken: () => tokens.getToken(),
    // Provisioning the declarative agent needs Copilot Studio scopes and a few
    // round trips, so it happens lazily on the first turn that carries tools.
    resolveAgent: () => getOrCreateAgent({ getTokenForScope: (scopes) => tokens.getTokenForScope(scopes) }),
    lean: options.lean,
    ...(options.leanSystemPrompt ? { leanSystemPrompt: LEAN_SYSTEM_PROMPT } : {}),
  });

  log.info(`M365 Copilot proxy listening on ${proxy.url}`);
  return { baseUrl: `${proxy.url}/v1`, options, close: () => proxy.close() };
}
