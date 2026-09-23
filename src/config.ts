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
 * The plugin's own id.
 *
 * opencode 2 requires one, scopes the plugin's storage by it, and names the plugin
 * by it in `plugin list` and diagnostics. opencode 1 from 1.18.29 registers an object
 * entrypoint under it too, so the two APIs must agree — `plugin-entry.test.ts` checks
 * that they do. Changing it is not cosmetic: it orphans anything stored under the old
 * one.
 */
export const PLUGIN_ID = "m365-copilot";

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
  /**
   * Keep session-title generation off M365.
   *
   * opencode 1 has a `small_model` setting, so we point that at the local titler.
   * opencode 2 dropped it, so the v2 plugin flags the title request instead and the
   * proxy answers it locally. Same guarantee, two mechanisms.
   */
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
  /**
   * The secret that external proxy demands (`opencode-m365 serve` prints it, or takes
   * it from `M365_PROXY_KEY`). Not needed for the in-process proxy, whose per-launch
   * secret is generated and handed over automatically.
   */
  apiKey?: string;
}

/** Where the proxy is, and the bearer secret it requires. */
export interface ProxyEndpoint {
  baseUrl: string;
  apiKey: string;
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
    apiKey: typeof options.apiKey === "string" && options.apiKey !== "" ? options.apiKey : undefined,
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
export function buildProviderConfig(baseUrl: string, apiKey: string): ProviderConfig {
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
      // The proxy's per-launch secret. The SDK sends it as `Authorization: Bearer`,
      // which is what stops every other process and web page from using the proxy.
      apiKey,
      // A reasoning tone takes 10-30s, and a turn can retry once behind the scenes.
      // opencode's default 5 minutes is not always enough.
      timeout: 900_000,
    },
    models,
  };
}

/**
 * opencode 2's `Provider.Info`, with its branded id types written as plain strings.
 *
 * Declared here rather than imported so the published package carries no runtime
 * dependency on `@opencode/plugin`. `config.test.ts` checks these records against
 * that package's own constructors, which is what catches drift — v2 swallows plugin
 * load failures, so a record that has fallen out of shape would otherwise show up
 * only as a provider that silently never appears.
 */
export interface ProviderInfoV2 {
  id: string;
  name: string;
  activation: "auto" | "enabled" | "disabled";
  package: string;
  settings?: Record<string, unknown>;
}

/** opencode 2's `Model.Info`, same caveat as {@link ProviderInfoV2}. */
export interface ModelInfoV2 {
  id: string;
  modelID: string;
  providerID: string;
  name: string;
  capabilities: { tools: boolean; input: string[]; output: string[] };
  variants: never[];
  time: { released: number };
  cost: Array<{ input: number; output: number; cache: { read: number; write: number } }>;
  status: "active";
  enabled: boolean;
  limit: { context: number; output: number };
}

/** The opencode 2 provider record pointing at our local OpenAI-compatible proxy. */
export function buildProviderInfo(baseUrl: string, apiKey: string): ProviderInfoV2 {
  return {
    id: PROVIDER_ID,
    name: "Microsoft 365 Copilot",
    // `auto` waits for a credential to arrive on an integration we never register,
    // so the provider would be present and permanently unusable.
    activation: "enabled",
    // v2 ships the openai-compatible driver, where v1 named an npm package for
    // opencode to install. Same driver, no install.
    package: "@opencode/ai/providers/openai-compatible",
    settings: {
      baseURL: baseUrl,
      // The proxy's per-launch secret, sent as `Authorization: Bearer`.
      apiKey,
      // A reasoning tone takes 10-30s, and a turn can retry once behind the scenes.
      // opencode's default 5 minutes is not always enough.
      timeout: 900_000,
    },
  };
}

/**
 * The opencode 2 model records, one per advertised model.
 *
 * Note what is *not* here: v1's per-model `reasoning` flag. `Model.Info` has no
 * equivalent field — opencode 2 expresses reasoning as selectable `variants` built
 * from a provider's `reasoning_options`, which is a different thing. Our reasoning
 * tones are not variants of a base model; each is its own id, because that is how
 * M365 exposes them. Setting a stray `reasoning: true` would decode without
 * complaint and then be dropped: the catalog rebuild copies `capabilities` field by
 * field and keeps nothing else.
 *
 * Nothing is lost by the omission. The flag is a catalog hint about parsing a
 * reasoning stream, and the proxy emits none — a "think deeper" tone simply takes
 * 10-30s and returns ordinary text.
 */
export function buildModelInfos(): ModelInfoV2[] {
  return MODELS.map((model) => ({
    id: model.id,
    modelID: model.id,
    providerID: PROVIDER_ID,
    name: model.name,
    capabilities: {
      // Without this opencode will not send `tools` at all, and the whole
      // fenced-tool-call path never gets exercised.
      tools: !isLocalModel(model.id),
      // The proxy carries text only; an attachment has nowhere to go.
      input: ["text"],
      output: ["text"],
    },
    variants: [],
    time: { released: 0 },
    // Billed to the M365 licence, not per token.
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    status: "active",
    enabled: true,
    limit: model.limit,
  }));
}

/**
 * Mutate opencode's in-memory config during the plugin's `config` hook.
 *
 * Deliberately additive: anything the user set explicitly wins. We are a plugin
 * making someone else's config work, not the owner of it.
 */
export function applyPluginConfig(
  config: Record<string, any>,
  endpoint: ProxyEndpoint,
  options: PluginOptions,
): void {
  config.provider ??= {};
  config.provider[PROVIDER_ID] = buildProviderConfig(endpoint.baseUrl, endpoint.apiKey);

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
 *
 * Both keys are written. They are genuinely different settings: opencode 1 reads
 * `plugin`, opencode 2 reads `plugins`, and the entry forms differ too — v1 takes a
 * `[spec, options]` tuple where v2 takes `{ package, options }`. Each version drops
 * the key it does not know rather than complaining, verified against 1.18.31, which
 * resolved a config carrying `plugins` with no diagnostic and simply left it out. So
 * one file can serve both, which is the whole point of the dual entry in `plugin.ts`.
 *
 * They also need different *references* for a local checkout. opencode 1 wants the
 * built entrypoint; opencode 2 insists on a directory and drops a file path with
 * `configured plugin path must be a directory` — measured against 2.0.11, and since
 * v2 swallows plugin load failures nothing else reports it. `pluginDir` is that
 * directory. An npm install needs neither, because the package name serves both.
 */
/** What the filesystem says about a plugin path in the config. */
export interface PluginPathInfo {
  exists: boolean;
  /** The `name` in the package.json that owns the path, when one could be read. */
  packageName?: string;
}

/** The npm name this package publishes under — what a checkout's package.json says. */
export const PACKAGE_NAME = "opencode-m365-copilot";

/** Every option key this plugin reads; anything else belongs to another plugin. */
const OUR_OPTION_KEYS: ReadonlySet<string> = new Set<keyof PluginOptions>([
  "lean",
  "setDefaultModel",
  "setSmallModel",
  "leanSystemPrompt",
  "baseUrl",
  "apiKey",
]);

export function mergeOpencodeConfig(
  existing: Record<string, any>,
  opts: {
    pluginRef: string;
    pluginDir?: string;
    /**
     * Look a local plugin path up on disk. The CLI passes a real one; without it every
     * path is treated as vanished, which is the conservative reading below.
     */
    inspect?: (path: string) => PluginPathInfo;
  },
): Record<string, any> {
  const merged: Record<string, any> = { ...existing };
  merged.$schema ??= "https://opencode.ai/config.json";
  const pluginDir = opts.pluginDir ?? opts.pluginRef;

  const inspect = opts.inspect ?? (() => ({ exists: false }));

  const v1 = withOurRef(merged.plugin, opts.pluginRef, inspect);
  // A stale v2 entry is a bare directory, so its name says nothing about us — but it
  // is the directory that *contains* the stale v1 entrypoint we just dropped, and
  // that does. Anything else is somebody else's plugin and stays.
  const v2 = withOurRef(merged.plugins, pluginDir, inspect, v1.dropped);

  // Options ride on the entry, so replacing ours would otherwise silently undo a
  // `{ "lean": false }` the user set by hand. The two versions spell the entry
  // differently: v1 takes a `[spec, options]` tuple, v2 a `{ package, options }`.
  merged.plugin = [...v1.kept, v1.options ? [opts.pluginRef, v1.options] : opts.pluginRef];
  merged.plugins = [...v2.kept, v2.options ? { package: pluginDir, options: v2.options } : pluginDir];
  return merged;
}

/**
 * Split a plugin list into the entries that are ours and the ones that are not.
 *
 * Dropping the earlier reference to ourselves — including one pointing at a stale
 * build path — is what stops a re-run of setup, after the checkout moved, from
 * leaving opencode trying to load a file that no longer exists.
 */
function withOurRef(
  existing: unknown,
  pluginRef: string,
  inspect: (path: string) => PluginPathInfo,
  containing: readonly string[] = [],
): { kept: unknown[]; dropped: string[]; options?: Record<string, unknown> } {
  const entries: unknown[] = Array.isArray(existing) ? [...existing] : [];
  const kept: unknown[] = [];
  const dropped: string[] = [];
  let options: Record<string, unknown> | undefined;

  for (const entry of entries) {
    const spec = specifierOf(entry);
    const ours =
      isOurPluginRef(spec, pluginRef, optionsOf(entry), inspect) || containing.some((path) => isWithin(spec, path));
    if (!ours) {
      kept.push(entry);
      continue;
    }
    dropped.push(spec);
    // Last one wins, which matters only for a config that somehow lists us twice.
    options = optionsOf(entry) ?? options;
  }

  return { kept, dropped, ...(options ? { options } : {}) };
}

/** The options out of any entry form either version accepts, if it carries some. */
function optionsOf(entry: unknown): Record<string, unknown> | undefined {
  const raw = Array.isArray(entry)
    ? entry[1]
    : entry && typeof entry === "object" && "options" in entry
      ? (entry as { options: unknown }).options
      : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const options = raw as Record<string, unknown>;
  return Object.keys(options).length > 0 ? options : undefined;
}

/** Is `path` inside the directory `dir`? Both are absolute, or neither matches. */
function isWithin(dir: string, path: string): boolean {
  if (!dir || !path) return false;
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  return path.startsWith(prefix);
}

/** The package-or-path out of any entry form either version accepts. */
function specifierOf(entry: unknown): string {
  if (typeof entry === "string") return entry;
  // v1's tuple form, `[spec, options]`.
  if (Array.isArray(entry)) return String(entry[0] ?? "");
  // v2's object form, `{ package, options }`.
  if (entry && typeof entry === "object" && "package" in entry) {
    return String((entry as { package: unknown }).package ?? "");
  }
  return "";
}

/**
 * Does `ref` point at this plugin?
 *
 * Certain when it is the npm package name or this repo's directory name. A local
 * install is an absolute path to `.../dist/plugin.mjs`, but that layout is common to
 * many plugins, so a shared path tail alone proves nothing:
 *
 * - a path that exists is ours only if its package.json names this package;
 * - a path that no longer exists (the usual moved-checkout case) is taken as a stale
 *   copy of us when it carries no options, or only ours — so another plugin's options
 *   are never swallowed. An option-less vanished entry is taken even if it was someone
 *   else's: setup writes a bare entry by default, so that is what a moved checkout of
 *   ours usually leaves, and a foreign one was already failing to load.
 */
function isOurPluginRef(
  ref: string,
  incoming: string,
  options: Record<string, unknown> | undefined,
  inspect: (path: string) => PluginPathInfo,
): boolean {
  if (ref === incoming) return true;
  if (ref.includes(PACKAGE_NAME) || ref.includes("opencode-copilot-plugin")) return true;
  if (tail(ref) === "" || tail(ref) !== tail(incoming)) return false;

  const info = inspect(ref);
  if (info.exists) return info.packageName === PACKAGE_NAME;
  // No options at all counts as ours — see the doc comment for why.
  return Object.keys(options ?? {}).every((key) => OUR_OPTION_KEYS.has(key));
}

/** The last two path segments, which for a local install are `dist/plugin.mjs`. */
function tail(ref: string): string {
  if (!ref.includes("/")) return "";
  return ref.split("/").slice(-2).join("/");
}
