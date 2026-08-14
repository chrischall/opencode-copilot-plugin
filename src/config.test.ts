import { describe, expect, it } from "vitest";
import type { ToolDef } from "./fenced.js";
import { DEFAULT_MODEL, LOCAL_TITLE_MODEL } from "./models.js";
import {
  DISENGAGE_TOOL_BUDGET,
  LEAN_FALLBACK_LIMIT,
  LEAN_TOOLS,
  PROVIDER_ID,
  applyPluginConfig,
  buildProviderConfig,
  buildToolProfile,
  describeToolSelection,
  mergeOpencodeConfig,
  resolveOptions,
  selectLeanTools,
} from "./config.js";

const names = (tools: readonly ToolDef[]) => tools.map((tool) => tool.function.name);

describe("provider config", () => {
  const provider = buildProviderConfig("http://127.0.0.1:4319/v1");

  it("points an openai-compatible provider at our local proxy", () => {
    expect(provider.npm).toBe("@ai-sdk/openai-compatible");
    expect(provider.options?.baseURL).toBe("http://127.0.0.1:4319/v1");
  });

  it("sends a placeholder api key so the sdk does not refuse to send a request", () => {
    // The proxy is unauthenticated and loopback-only, but @ai-sdk/openai-compatible
    // still expects the header to exist.
    expect(provider.options?.apiKey).toBeTruthy();
  });

  it("advertises every catalog model, including the local titler", () => {
    expect(Object.keys(provider.models ?? {})).toContain(DEFAULT_MODEL);
    expect(Object.keys(provider.models ?? {})).toContain(LOCAL_TITLE_MODEL);
  });

  it("declares tool_call support so opencode will send tools at all", () => {
    expect(provider.models?.[DEFAULT_MODEL]?.tool_call).toBe(true);
  });

  it("carries limits through from the catalog", () => {
    expect(provider.models?.[DEFAULT_MODEL]?.limit?.context).toBeGreaterThan(0);
  });

  it("gives every turn a generous timeout", () => {
    // Reasoning tones take 10-30s per turn and the default is 5 minutes; a whole
    // agentic turn with a slow tone can exceed that.
    expect(provider.options?.timeout).toBeGreaterThan(300_000);
  });
});

describe("lean tool profile", () => {
  it("keeps the toolset under the measured Disengage threshold", () => {
    expect(LEAN_TOOLS.length).toBeLessThan(DISENGAGE_TOOL_BUDGET);
  });

  it("keeps a shell tool, because shell-routing is the load-bearing lever", () => {
    expect(LEAN_TOOLS).toContain("bash");
  });

  it("keeps the tools needed to actually read and change code", () => {
    expect(LEAN_TOOLS).toEqual(expect.arrayContaining(["bash", "read", "edit", "write", "grep"]));
  });

  it("disables the heavy built-ins that push opencode over the threshold", () => {
    const profile = buildToolProfile();
    for (const tool of ["glob", "lsp", "skill", "todowrite", "webfetch", "websearch", "question", "task"]) {
      expect(profile[tool], `${tool} should be disabled`).toBe(false);
    }
  });

  it("keeps apply_patch, which is how this opencode version edits files", () => {
    expect(buildToolProfile().apply_patch).toBe(true);
  });

  it("explicitly enables the lean set rather than relying on defaults", () => {
    const profile = buildToolProfile();
    for (const tool of LEAN_TOOLS) expect(profile[tool]).toBe(true);
  });
});

describe("selecting the toolset the model actually sees", () => {
  const tool = (name: string): ToolDef => ({
    type: "function",
    function: { name, parameters: { type: "object", properties: {} } },
  });

  // opencode 1.18.18 offers exactly these, regardless of what `config.tools` says.
  const opencodeTools = ["apply_patch", "bash", "glob", "grep", "read", "skill", "task", "todowrite", "webfetch"].map(tool);

  it("cuts opencode's toolset below the Disengage threshold", () => {
    expect(selectLeanTools(opencodeTools).length).toBeLessThan(DISENGAGE_TOOL_BUDGET);
  });

  it("keeps the shell tool, without which tool calling largely stops working", () => {
    expect(names(selectLeanTools(opencodeTools))).toContain("bash");
  });

  it("keeps a way to edit files", () => {
    // This opencode version ships `apply_patch` rather than `edit`/`write`.
    expect(names(selectLeanTools(opencodeTools))).toContain("apply_patch");
  });

  it("drops the tools that only inflate the tool block", () => {
    const kept = names(selectLeanTools(opencodeTools));
    for (const dropped of ["glob", "skill", "task", "todowrite", "webfetch"]) {
      expect(kept, `${dropped} should be dropped`).not.toContain(dropped);
    }
  });

  it("preserves the order the harness sent them in", () => {
    const kept = names(selectLeanTools(opencodeTools));
    expect(kept).toEqual([...kept].sort((a, b) => names(opencodeTools).indexOf(a) - names(opencodeTools).indexOf(b)));
  });

  it("passes a small toolset through untouched", () => {
    const small = [tool("read"), tool("bash")];
    expect(selectLeanTools(small)).toEqual(small);
  });

  it("falls back to a cap well clear of the threshold, not just under it", () => {
    // The fallback is the path a future opencode rename lands us on, so it must not
    // sit at the "borderline, disengages once" edge. Comfortably below, not 11.
    const unknown = Array.from({ length: 20 }, (_, i) => tool(`custom_${i}`));
    expect(selectLeanTools(unknown)).toHaveLength(LEAN_FALLBACK_LIMIT);
    expect(LEAN_FALLBACK_LIMIT).toBeLessThanOrEqual(DISENGAGE_TOOL_BUDGET / 2);
  });

  it("reports when the trim left no way to edit a file", () => {
    // Survivable — bash heredocs still work — but it means opencode renamed its
    // editing tools and our allowlist has drifted.
    expect(describeToolSelection([tool("bash"), tool("read")])).toMatch(/no editing tool/i);
    expect(describeToolSelection([tool("bash"), tool("apply_patch")])).toBeUndefined();
  });

  it("reports when the trim left no shell tool, which breaks shell-routing", () => {
    expect(describeToolSelection([tool("read"), tool("edit")])).toMatch(/shell/i);
  });

  it("says nothing when the toolset came through intact", () => {
    expect(describeToolSelection([tool("bash"), tool("read"), tool("edit")])).toBeUndefined();
  });

  it("keeps an unrecognised shell tool when capping", () => {
    // Any name can be the shell tool; losing it is the one unrecoverable mistake.
    const unknown = [...Array.from({ length: 20 }, (_, i) => tool(`custom_${i}`)), tool("run_command")];
    expect(names(selectLeanTools(unknown))).toContain("run_command");
  });

  it("returns an empty toolset unchanged", () => {
    expect(selectLeanTools([])).toEqual([]);
  });
});

describe("plugin options", () => {
  it("defaults to lean mode on", () => {
    expect(resolveOptions(undefined).lean).toBe(true);
    expect(resolveOptions({}).lean).toBe(true);
  });

  it("can be opted out of", () => {
    expect(resolveOptions({ lean: false }).lean).toBe(false);
  });

  it("does not replace the harness's system prompt by default", () => {
    // Trimming the toolset is a measured necessity; replacing the prose prompt is
    // not, and it costs the project's own AGENTS.md rules if it goes wrong. Lean
    // mode should not imply it.
    expect(resolveOptions({}).leanSystemPrompt).toBe(false);
    expect(resolveOptions({ lean: true }).leanSystemPrompt).toBe(false);
  });

  it("can be opted into explicitly", () => {
    expect(resolveOptions({ leanSystemPrompt: true }).leanSystemPrompt).toBe(true);
  });

  it("defaults to managing the model default and the small model", () => {
    const options = resolveOptions({});
    expect(options.setDefaultModel).toBe(true);
    expect(options.setSmallModel).toBe(true);
  });

  it("ignores option values of the wrong type instead of crashing the plugin", () => {
    // opencode passes plugin options straight from user JSON.
    expect(resolveOptions({ lean: "yes" as unknown as boolean }).lean).toBe(true);
  });
});

describe("applying config in the opencode config hook", () => {
  it("registers the provider", () => {
    const config: Record<string, any> = {};
    applyPluginConfig(config, "http://127.0.0.1:4319/v1", resolveOptions({}));
    expect(config.provider[PROVIDER_ID].options.baseURL).toBe("http://127.0.0.1:4319/v1");
  });

  it("routes the small model to the local titler so title generation never hits M365", () => {
    const config: Record<string, any> = {};
    applyPluginConfig(config, "http://127.0.0.1:4319/v1", resolveOptions({}));
    expect(config.small_model).toBe(`${PROVIDER_ID}/${LOCAL_TITLE_MODEL}`);
  });

  it("sets a default model only when the user has not chosen one", () => {
    const config: Record<string, any> = { model: "anthropic/claude-sonnet-4-5" };
    applyPluginConfig(config, "http://127.0.0.1:4319/v1", resolveOptions({}));
    expect(config.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("does not clobber a small model the user already chose", () => {
    const config: Record<string, any> = { small_model: "anthropic/claude-haiku-4-5" };
    applyPluginConfig(config, "http://127.0.0.1:4319/v1", resolveOptions({}));
    expect(config.small_model).toBe("anthropic/claude-haiku-4-5");
  });

  it("applies the lean tool profile", () => {
    const config: Record<string, any> = {};
    applyPluginConfig(config, "http://127.0.0.1:4319/v1", resolveOptions({}));
    expect(config.tools.webfetch).toBe(false);
    expect(config.tools.bash).toBe(true);
  });

  it("leaves the toolset alone when lean mode is off", () => {
    const config: Record<string, any> = {};
    applyPluginConfig(config, "http://127.0.0.1:4319/v1", resolveOptions({ lean: false }));
    expect(config.tools).toBeUndefined();
  });

  it("does not cripple another provider's toolset", () => {
    // `tools` is global in opencode, so trimming it while the user is driving
    // Anthropic would take away tools that provider handles perfectly well. The
    // trim only applies when an M365 model is the one actually in use.
    const config: Record<string, any> = { model: "anthropic/claude-sonnet-4-5" };
    applyPluginConfig(config, "http://127.0.0.1:4319/v1", resolveOptions({}));
    expect(config.tools).toBeUndefined();
  });

  it("applies the trim when an M365 model is the default", () => {
    const config: Record<string, any> = { model: `${PROVIDER_ID}/gpt-5.5-think-deeper` };
    applyPluginConfig(config, "http://127.0.0.1:4319/v1", resolveOptions({}));
    expect(config.tools?.webfetch).toBe(false);
  });

  it("respects a tool the user explicitly re-enabled", () => {
    const config: Record<string, any> = { tools: { webfetch: true } };
    applyPluginConfig(config, "http://127.0.0.1:4319/v1", resolveOptions({}));
    expect(config.tools.webfetch).toBe(true);
  });

  it("preserves other providers", () => {
    const config: Record<string, any> = { provider: { anthropic: { name: "Anthropic" } } };
    applyPluginConfig(config, "http://127.0.0.1:4319/v1", resolveOptions({}));
    expect(config.provider.anthropic.name).toBe("Anthropic");
    expect(config.provider[PROVIDER_ID]).toBeDefined();
  });
});

describe("merging into an on-disk opencode.json", () => {
  it("adds the plugin reference without dropping existing plugins", () => {
    const merged = mergeOpencodeConfig({ plugin: ["opencode-wakatime"] }, { pluginRef: "opencode-m365-copilot" });
    expect(merged.plugin).toContain("opencode-wakatime");
    expect(merged.plugin).toContain("opencode-m365-copilot");
  });

  it("is idempotent", () => {
    const once = mergeOpencodeConfig({}, { pluginRef: "opencode-m365-copilot" });
    const twice = mergeOpencodeConfig(once, { pluginRef: "opencode-m365-copilot" });
    expect(twice.plugin).toEqual(["opencode-m365-copilot"]);
  });

  it("replaces a stale reference to the same plugin at a different path", () => {
    const merged = mergeOpencodeConfig(
      { plugin: ["/old/path/dist/plugin.mjs"] },
      { pluginRef: "/new/path/dist/plugin.mjs" },
    );
    expect(merged.plugin).toEqual(["/new/path/dist/plugin.mjs"]);
  });

  it("keeps the schema reference so editors still validate the file", () => {
    const merged = mergeOpencodeConfig({}, { pluginRef: "opencode-m365-copilot" });
    expect(merged.$schema).toBe("https://opencode.ai/config.json");
  });

  it("does not touch unrelated settings", () => {
    const merged = mergeOpencodeConfig({ theme: "gruvbox" }, { pluginRef: "opencode-m365-copilot" });
    expect(merged.theme).toBe("gruvbox");
  });
});
