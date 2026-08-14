/**
 * opencode configuration: the provider entry, and the lean tool profile that makes
 * M365 willing to engage at all.
 *
 * Everything here is pure — it takes a base URL and returns/mutates plain objects —
 * so the interesting decisions are testable without opencode, a network, or a tenant.
 */

import { MODELS, LOCAL_TITLE_MODEL, DEFAULT_MODEL, isLocalModel } from "./models.js";
import { findShellTool, type ToolDef } from "./fenced.js";

/** The provider id opencode addresses models by: `m365/<model>`. */
export const PROVIDER_ID = "m365";

/**
 * The measured point at which M365's Disengaged filter starts firing.
 *
 * From the protocol notes: ~1 tool is fine, ~12 is borderline (disengages once,
 * recovers on retry), and a full coding-agent toolset (~15+, opencode's is named
 * explicitly) disengages *persistently*. We stay comfortably below it.
 *
 * Note the trigger is prompt *shape*, not byte count — 500k tokens of benign filler
 * never disengaged. It is the number of tool blocks that matters.
 */
export const DISENGAGE_TOOL_BUDGET = 12;

/**
 * The tools we leave enabled.
 *
 * `bash` is not optional. M365's chat-tuned model refuses to "act as an agent" on
 * demand, but reflexively writes a ```bash block — routing that block to the shell
 * tool is the single lever that took the reference implementation's benchmark from
 * 0/5 to real multi-turn loops. Remove bash and tool calling largely stops working.
 *
 * The rest is the minimum needed to read and change code.
 */
export const LEAN_TOOLS = ["bash", "read", "edit", "write", "apply_patch", "grep"] as const;

/**
 * How many tools to keep when we recognise none of the harness's names.
 *
 * This is the path a future opencode rename drops us on — `apply_patch` replaced
 * `edit`/`write` once already — so it must not sit at the edge of the threshold.
 * ~12 is where the filter "disengages once and recovers on retry"; landing there by
 * accident would look like flakiness rather than a drifted allowlist.
 */
export const LEAN_FALLBACK_LIMIT = 5;

/**
 * opencode built-ins we switch off in lean mode.
 *
 * Each one is a tool block in the injected prompt, and the count is what trips the
 * filter. `glob`/`grep` overlap and `bash` can do both; `webfetch`/`websearch` are
 * rarely load-bearing for a coding turn; `todowrite`/`question`/`skill` are harness
 * ergonomics rather than capability.
 */
export const DISABLED_TOOLS = [
  "glob",
  "lsp",
  "patch",
  "skill",
  "todowrite",
  "todoread",
  "webfetch",
  "websearch",
  "question",
  "task",
] as const;

/**
 * Cut a harness's toolset down to something M365 will engage with.
 *
 * This is the enforcement point, and it has to be. opencode's own `tools` config —
 * which the plugin also sets — is resolved into the config but **not applied to the
 * request**: verified against 1.18.18, where a config disabling eight tools still
 * produced a request offering all nine. The proxy sees the final request, so it is
 * the only place the trim reliably happens.
 *
 * Two rules, in order:
 *   1. Keep the tools we recognise as load-bearing for a coding loop.
 *   2. If we recognise none of them — a harness with its own vocabulary — fall back
 *      to a hard cap, keeping any shell tool first.
 */
export function selectLeanTools(tools: readonly ToolDef[]): ToolDef[] {
  if (tools.length === 0) return [...tools];

  const wanted = new Set<string>(LEAN_TOOLS);
  const kept = tools.filter((tool) => wanted.has(tool.function.name.toLowerCase()));
  if (kept.length > 0) return kept;

  // Unknown vocabulary. Keep the shell tool if we can spot one, then fill up to the
  // cap in the order the harness offered them.
  const shell = findShellTool(tools);
  const rest = tools.filter((tool) => tool !== shell);
  const remaining = shell ? LEAN_FALLBACK_LIMIT - 1 : LEAN_FALLBACK_LIMIT;
  return [...(shell ? [shell] : []), ...rest.slice(0, remaining)];
}

/** Tool names that mean "change a file", across opencode versions and harnesses. */
const EDITING_TOOLS = ["edit", "write", "apply_patch", "patch", "str_replace", "create"];

/**
 * Describe anything worrying about the trimmed toolset, or undefined if it is fine.
 *
 * The allowlist in `LEAN_TOOLS` is coupled to what the harness calls its tools, and
 * that has already changed once. When the trim silently removes the ability to edit
 * or to run a command, the model degrades quietly — worth a line in the log rather
 * than a mystery.
 */
export function describeToolSelection(requested: readonly ToolDef[]): string | undefined {
  if (requested.length === 0) return undefined;
  const kept = selectLeanTools(requested);
  const names = kept.map((tool) => tool.function.name.toLowerCase());

  if (!findShellTool(kept)) {
    return "the trimmed toolset has no shell tool, so shell-routing is unavailable and tool calling will be markedly less reliable";
  }
  if (!names.some((name) => EDITING_TOOLS.includes(name))) {
    return "the trimmed toolset has no editing tool — the model can only change files through the shell. The harness may have renamed its tools; check LEAN_TOOLS.";
  }
  return undefined;
}

export interface PluginOptions {
  /** Trim opencode's toolset and system prompt to something M365 will engage with. */
  lean: boolean;
  /** Set `model` when the user has not chosen one. */
  setDefaultModel: boolean;
  /** Point `small_model` at the local titler so title generation never hits M365. */
  setSmallModel: boolean;
  /**
   * Replace the harness's prose system prompt with a lean one.
   *
   * Off by default, and deliberately NOT implied by `lean`. Trimming the toolset is
   * a measured necessity; replacing the prose is an unverified bet borrowed from
   * another harness's measurements, and it costs the user's own AGENTS.md rules if
   * the preservation logic is ever wrong.
   */
  leanSystemPrompt: boolean;
  /** Use an already-running proxy instead of starting one in-process. */
  baseUrl?: string;
}

/**
 * Normalise the options object opencode hands us.
 *
 * These come straight out of user-authored JSON, so anything can be anything. A bad
 * value falls back to the default rather than throwing — a plugin that throws during
 * load takes opencode's whole config with it.
 */
export function resolveOptions(raw: Partial<PluginOptions> | undefined): PluginOptions {
  const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
  const options = raw ?? {};
  return {
    lean: bool(options.lean, true),
    setDefaultModel: bool(options.setDefaultModel, true),
    setSmallModel: bool(options.setSmallModel, true),
    leanSystemPrompt: bool(options.leanSystemPrompt, false),
    baseUrl: typeof options.baseUrl === "string" ? options.baseUrl : undefined,
  };
}

/** `{ bash: true, ..., webfetch: false, ... }` — opencode's `tools` config shape. */
export function buildToolProfile(): Record<string, boolean> {
  const profile: Record<string, boolean> = {};
  for (const tool of LEAN_TOOLS) profile[tool] = true;
  for (const tool of DISABLED_TOOLS) profile[tool] = false;
  return profile;
}

export interface ProviderModelConfig {
  name: string;
  tool_call?: boolean;
  reasoning?: boolean;
  attachment?: boolean;
  limit?: { context: number; output: number };
  cost?: { input: number; output: number; cache_read: number; cache_write: number };
}

export interface ProviderConfig {
  npm: string;
  name: string;
  options: Record<string, unknown>;
  models: Record<string, ProviderModelConfig>;
}

/** The `provider.m365` entry pointing opencode at our local OpenAI-compatible proxy. */
export function buildProviderConfig(baseUrl: string): ProviderConfig {
  const models: Record<string, ProviderModelConfig> = {};
  for (const model of MODELS) {
    models[model.id] = {
      name: model.name,
      // Without this opencode will not send `tools` at all, and the whole
      // fenced-tool-call path never gets exercised.
      tool_call: !isLocalModel(model.id),
      reasoning: model.reasoning,
      attachment: false,
      limit: model.limit,
      // Billed to the M365 licence, not per token.
      cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    };
  }

  return {
    npm: "@ai-sdk/openai-compatible",
    name: "Microsoft 365 Copilot",
    options: {
      baseURL: baseUrl,
      // Loopback and unauthenticated, but the SDK still wants a bearer value.
      apiKey: "m365-local",
      // A reasoning tone takes 10-30s, and a turn can retry once behind the scenes.
      // opencode's default 5 minutes is not always enough.
      timeout: 900_000,
    },
    models,
  };
}

/**
 * Mutate opencode's in-memory config during the plugin's `config` hook.
 *
 * Deliberately additive: anything the user set explicitly wins. We are a plugin
 * making someone else's config work, not the owner of it.
 */
export function applyPluginConfig(
  config: Record<string, any>,
  baseUrl: string,
  options: PluginOptions,
): void {
  config.provider ??= {};
  config.provider[PROVIDER_ID] = buildProviderConfig(baseUrl);

  if (options.setDefaultModel && !config.model) {
    config.model = `${PROVIDER_ID}/${DEFAULT_MODEL}`;
  }

  if (options.setSmallModel && !config.small_model) {
    config.small_model = `${PROVIDER_ID}/${LOCAL_TITLE_MODEL}`;
  }

  // Belt and braces only — this is NOT what enforces the lean toolset. opencode
  // 1.18.18 resolves `tools` into its config and then sends every tool anyway, so
  // the real trim happens in the proxy (`selectLeanTools`). Setting it here still
  // declares the intent, shows up in `opencode debug config`, and will start
  // working for free if a future version honours it.
  //
  // `tools` is global — there is no per-provider toolset — so only set it when an
  // M365 model is the one actually in use, or we would be trimming tools away from
  // providers that handle them perfectly well.
  if (options.lean && usesOurProvider(config)) {
    // User-set values win: someone who re-enabled `webfetch` on purpose keeps it.
    config.tools = { ...buildToolProfile(), ...(config.tools ?? {}) };
  }
}

function usesOurProvider(config: Record<string, any>): boolean {
  return typeof config.model === "string" && config.model.startsWith(`${PROVIDER_ID}/`);
}

/**
 * Merge our plugin reference into an on-disk `opencode.json`, non-destructively.
 *
 * `pluginRef` is either the npm package name or an absolute path to the built
 * plugin — the CLI uses the latter for a local checkout.
 */
export function mergeOpencodeConfig(
  existing: Record<string, any>,
  opts: { pluginRef: string },
): Record<string, any> {
  const merged: Record<string, any> = { ...existing };
  merged.$schema ??= "https://opencode.ai/config.json";

  const plugins: unknown[] = Array.isArray(merged.plugin) ? [...merged.plugin] : [];
  // Drop any earlier reference to *this* plugin — including one pointing at a stale
  // build path — before adding the current one, so re-running setup after moving the
  // checkout does not leave opencode trying to load a file that no longer exists.
  const kept = plugins.filter((entry) => {
    const name = typeof entry === "string" ? entry : Array.isArray(entry) ? String(entry[0]) : "";
    return !isOurPluginRef(name, opts.pluginRef);
  });
  kept.push(opts.pluginRef);
  merged.plugin = kept;

  return merged;
}

/**
 * Does `ref` point at this plugin?
 *
 * Three ways it can: the npm package name, this repo's directory name, or the same
 * build artifact at a different location — a local install is an absolute path to
 * `.../dist/plugin.mjs`, and only the directory changes when the checkout moves.
 */
function isOurPluginRef(ref: string, incoming: string): boolean {
  if (ref === incoming) return true;
  if (ref.includes("opencode-m365-copilot") || ref.includes("opencode-copilot-plugin")) return true;
  return tail(ref) !== "" && tail(ref) === tail(incoming);
}

/** The last two path segments, which for a local install are `dist/plugin.mjs`. */
function tail(ref: string): string {
  if (!ref.includes("/")) return "";
  return ref.split("/").slice(-2).join("/");
}
