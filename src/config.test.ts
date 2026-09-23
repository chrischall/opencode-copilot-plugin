import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { ToolDef } from "./fenced.js";
import { DEFAULT_MODEL, LOCAL_TITLE_MODEL } from "./models.js";
import {
  DISENGAGE_TOOL_BUDGET,
  LEAN_FALLBACK_LIMIT,
  LEAN_TOOLS,
  PROVIDER_ID,
  applyPluginConfig,
  buildModelInfos,
  buildProviderConfig,
  buildProviderInfo,
  buildToolProfile,
  describeToolSelection,
  mergeOpencodeConfig,
  resolveOptions,
  selectLeanTools,
} from "./config.js";

const names = (tools: readonly ToolDef[]) => tools.map((tool) => tool.function.name);

describe("provider config", () => {
  const provider = buildProviderConfig("http://127.0.0.1:4319/v1", "per-launch-secret");

  it("points an openai-compatible provider at our local proxy", () => {
    expect(provider.npm).toBe("@ai-sdk/openai-compatible");
    expect(provider.options?.baseURL).toBe("http://127.0.0.1:4319/v1");
  });

  it("hands opencode the proxy's per-launch secret as the api key", () => {
    // The SDK sends it as `Authorization: Bearer`, which is what the proxy checks.
    // A constant here would let any web page on the machine use the proxy.
    expect(provider.options?.apiKey).toBe("per-launch-secret");
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

  it("takes the secret of an external proxy as a string option", () => {
    expect(resolveOptions({ apiKey: "from-serve" }).apiKey).toBe("from-serve");
    expect(resolveOptions({ apiKey: 42 as unknown as string }).apiKey).toBeUndefined();
    expect(resolveOptions({}).apiKey).toBeUndefined();
  });

  it("ignores option values of the wrong type instead of crashing the plugin", () => {
    // opencode passes plugin options straight from user JSON.
    expect(resolveOptions({ lean: "yes" as unknown as boolean }).lean).toBe(true);
  });
});

const ENDPOINT = { baseUrl: "http://127.0.0.1:4319/v1", apiKey: "per-launch-secret" };

describe("applying config in the opencode config hook", () => {
  it("points the provider at the proxy with its secret", () => {
    const config: Record<string, any> = {};
    applyPluginConfig(config, ENDPOINT, resolveOptions({}));
    expect(config.provider.m365.options.baseURL).toBe(ENDPOINT.baseUrl);
    expect(config.provider.m365.options.apiKey).toBe("per-launch-secret");
  });

  it("registers the provider", () => {
    const config: Record<string, any> = {};
    applyPluginConfig(config, ENDPOINT, resolveOptions({}));
    expect(config.provider[PROVIDER_ID].options.baseURL).toBe("http://127.0.0.1:4319/v1");
  });

  it("routes the small model to the local titler so title generation never hits M365", () => {
    const config: Record<string, any> = {};
    applyPluginConfig(config, ENDPOINT, resolveOptions({}));
    expect(config.small_model).toBe(`${PROVIDER_ID}/${LOCAL_TITLE_MODEL}`);
  });

  it("sets a default model only when the user has not chosen one", () => {
    const config: Record<string, any> = { model: "anthropic/claude-sonnet-4-5" };
    applyPluginConfig(config, ENDPOINT, resolveOptions({}));
    expect(config.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("does not clobber a small model the user already chose", () => {
    const config: Record<string, any> = { small_model: "anthropic/claude-haiku-4-5" };
    applyPluginConfig(config, ENDPOINT, resolveOptions({}));
    expect(config.small_model).toBe("anthropic/claude-haiku-4-5");
  });

  it("applies the lean tool profile", () => {
    const config: Record<string, any> = {};
    applyPluginConfig(config, ENDPOINT, resolveOptions({}));
    expect(config.tools.webfetch).toBe(false);
    expect(config.tools.bash).toBe(true);
  });

  it("leaves the toolset alone when lean mode is off", () => {
    const config: Record<string, any> = {};
    applyPluginConfig(config, ENDPOINT, resolveOptions({ lean: false }));
    expect(config.tools).toBeUndefined();
  });

  it("does not cripple another provider's toolset", () => {
    // `tools` is global in opencode, so trimming it while the user is driving
    // Anthropic would take away tools that provider handles perfectly well. The
    // trim only applies when an M365 model is the one actually in use.
    const config: Record<string, any> = { model: "anthropic/claude-sonnet-4-5" };
    applyPluginConfig(config, ENDPOINT, resolveOptions({}));
    expect(config.tools).toBeUndefined();
  });

  it("applies the trim when an M365 model is the default", () => {
    const config: Record<string, any> = { model: `${PROVIDER_ID}/gpt-5.5-think-deeper` };
    applyPluginConfig(config, ENDPOINT, resolveOptions({}));
    expect(config.tools?.webfetch).toBe(false);
  });

  it("respects a tool the user explicitly re-enabled", () => {
    const config: Record<string, any> = { tools: { webfetch: true } };
    applyPluginConfig(config, ENDPOINT, resolveOptions({}));
    expect(config.tools.webfetch).toBe(true);
  });

  it("preserves other providers", () => {
    const config: Record<string, any> = { provider: { anthropic: { name: "Anthropic" } } };
    applyPluginConfig(config, ENDPOINT, resolveOptions({}));
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

  it("writes both the v1 and the v2 key, so one file serves either opencode", () => {
    // They are different settings with different names, and each version silently
    // drops the one it does not know: verified against 1.18.31, which resolved a
    // config carrying `plugins` without a diagnostic and simply left it out.
    const merged = mergeOpencodeConfig({}, { pluginRef: "opencode-m365-copilot" });
    expect(merged.plugin).toEqual(["opencode-m365-copilot"]);
    expect(merged.plugins).toEqual(["opencode-m365-copilot"]);
  });

  it("is idempotent across both keys", () => {
    const once = mergeOpencodeConfig({}, { pluginRef: "opencode-m365-copilot" });
    const twice = mergeOpencodeConfig(once, { pluginRef: "opencode-m365-copilot" });
    expect(twice.plugins).toEqual(["opencode-m365-copilot"]);
  });

  it("keeps other people's v2 plugins, including the object form", () => {
    const merged = mergeOpencodeConfig(
      { plugins: ["opencode-wakatime", { package: "@acme/plugin", options: { strict: true } }] },
      { pluginRef: "opencode-m365-copilot" },
    );
    expect(merged.plugins).toContainEqual("opencode-wakatime");
    expect(merged.plugins).toContainEqual({ package: "@acme/plugin", options: { strict: true } });
    expect(merged.plugins).toContainEqual("opencode-m365-copilot");
  });

  it("replaces a stale reference in both keys when the checkout has moved", () => {
    // The real shape of a re-run after moving a checkout: setup wrote both keys last
    // time, so both are stale. The v2 entry is a bare directory whose name says
    // nothing about us — what identifies it is that it contains the v1 entrypoint we
    // are already dropping.
    const merged = mergeOpencodeConfig(
      {
        plugin: [["/old/checkout/dist/plugin.mjs", { lean: false }]],
        plugins: [{ package: "/old/checkout", options: { lean: false } }],
      },
      { pluginRef: "/new/checkout/dist/plugin.mjs", pluginDir: "/new/checkout" },
    );
    expect(merged.plugin).toEqual([["/new/checkout/dist/plugin.mjs", { lean: false }]]);
    expect(merged.plugins).toEqual([
      { package: "/new/checkout", options: { lean: false } },
    ]);
  });

  it("does not mistake an unrelated directory for a stale copy of us", () => {
    const merged = mergeOpencodeConfig(
      { plugin: [], plugins: [{ package: "/somewhere/else" }] },
      { pluginRef: "/checkout/dist/plugin.mjs", pluginDir: "/checkout" },
    );
    expect(merged.plugins).toEqual([{ package: "/somewhere/else" }, "/checkout"]);
  });

  it("gives opencode 2 a directory, because it rejects a file path outright", () => {
    // Measured against 2.0.11: a `plugins` entry pointing at a file is dropped with
    // `configured plugin path must be a directory`, and — since v2 swallows plugin
    // load failures — nothing else says so. opencode 1 wants the built entrypoint,
    // so the two keys genuinely need different references for a local checkout.
    const merged = mergeOpencodeConfig(
      {},
      { pluginRef: "/checkout/dist/plugin.mjs", pluginDir: "/checkout" },
    );
    expect(merged.plugin).toEqual(["/checkout/dist/plugin.mjs"]);
    expect(merged.plugins).toEqual(["/checkout"]);
  });

  it("keeps the options the user set when it replaces our own entry", () => {
    // A `setup` re-run must not silently undo `{ "lean": false }`. Both entry forms
    // carry options, and both are preserved.
    const merged = mergeOpencodeConfig(
      {
        plugin: [["opencode-m365-copilot", { lean: false }]],
        plugins: [{ package: "opencode-m365-copilot", options: { lean: false } }],
      },
      { pluginRef: "opencode-m365-copilot" },
    );
    expect(merged.plugin).toEqual([["opencode-m365-copilot", { lean: false }]]);
    expect(merged.plugins).toEqual([
      { package: "opencode-m365-copilot", options: { lean: false } },
    ]);
  });

  it("carries options across a moved checkout, onto the new reference", () => {
    const merged = mergeOpencodeConfig(
      {
        plugin: [["/old/checkout/dist/plugin.mjs", { leanSystemPrompt: true }]],
        plugins: [{ package: "/old/checkout", options: { leanSystemPrompt: true } }],
      },
      { pluginRef: "/new/checkout/dist/plugin.mjs", pluginDir: "/new/checkout" },
    );
    expect(merged.plugin).toEqual([["/new/checkout/dist/plugin.mjs", { leanSystemPrompt: true }]]);
    expect(merged.plugins).toEqual([
      { package: "/new/checkout", options: { leanSystemPrompt: true } },
    ]);
  });

  it("stays a bare specifier when there are no options to keep", () => {
    const merged = mergeOpencodeConfig(
      { plugin: ["opencode-m365-copilot"], plugins: ["opencode-m365-copilot"] },
      { pluginRef: "opencode-m365-copilot" },
    );
    expect(merged.plugin).toEqual(["opencode-m365-copilot"]);
    expect(merged.plugins).toEqual(["opencode-m365-copilot"]);
  });

  describe("telling our stale entries from someone else's local plugin", () => {
    // `dist/plugin.mjs` is a very common build layout; a shared path tail proves nothing.
    const fs = (packages: Record<string, string | null>) => ({
      inspect: (path: string) => {
        const dir = path.replace(/\/dist\/plugin\.mjs$/, "");
        if (!(dir in packages)) return { exists: false };
        const name = packages[dir];
        return name === null ? { exists: true } : { exists: true, packageName: name };
      },
    });

    it("keeps another local plugin that shares the dist/plugin.mjs layout, with its options", () => {
      const merged = mergeOpencodeConfig(
        {
          plugin: [["/Users/x/other-plugin/dist/plugin.mjs", { strict: true }]],
          plugins: [{ package: "/Users/x/other-plugin", options: { strict: true } }],
        },
        { pluginRef: "/checkout/dist/plugin.mjs", pluginDir: "/checkout", ...fs({ "/Users/x/other-plugin": "other-plugin" }) },
      );
      expect(merged.plugin).toEqual([["/Users/x/other-plugin/dist/plugin.mjs", { strict: true }], "/checkout/dist/plugin.mjs"]);
      expect(merged.plugins).toEqual([{ package: "/Users/x/other-plugin", options: { strict: true } }, "/checkout"]);
    });

    it("keeps an existing local plugin whose package it cannot identify", () => {
      const merged = mergeOpencodeConfig(
        { plugin: ["/Users/x/mystery/dist/plugin.mjs"] },
        { pluginRef: "/checkout/dist/plugin.mjs", pluginDir: "/checkout", ...fs({ "/Users/x/mystery": null }) },
      );
      expect(merged.plugin).toEqual(["/Users/x/mystery/dist/plugin.mjs", "/checkout/dist/plugin.mjs"]);
    });

    it("replaces an existing checkout whose package.json says it is us", () => {
      const merged = mergeOpencodeConfig(
        { plugin: [["/old/place/dist/plugin.mjs", { lean: false }]], plugins: [{ package: "/old/place", options: { lean: false } }] },
        { pluginRef: "/checkout/dist/plugin.mjs", pluginDir: "/checkout", ...fs({ "/old/place": "opencode-m365-copilot" }) },
      );
      expect(merged.plugin).toEqual([["/checkout/dist/plugin.mjs", { lean: false }]]);
      expect(merged.plugins).toEqual([{ package: "/checkout", options: { lean: false } }]);
    });

    it("keeps a vanished plugin whose options are not ours to take", () => {
      const merged = mergeOpencodeConfig(
        { plugin: [["/gone/elsewhere/dist/plugin.mjs", { strict: true }]] },
        { pluginRef: "/checkout/dist/plugin.mjs", pluginDir: "/checkout", ...fs({}) },
      );
      expect(merged.plugin).toEqual([["/gone/elsewhere/dist/plugin.mjs", { strict: true }], "/checkout/dist/plugin.mjs"]);
    });

    it("takes a vanished option-less entry as our stale copy, in both keys", () => {
      // Deliberate, and the one case a foreign plugin can lose its entry: setup writes
      // a bare entry unless the user added options, so a moved checkout usually leaves
      // exactly this. Keeping it would leave opencode loading a file that is gone —
      // and a vanished foreign entry was already failing to load.
      const merged = mergeOpencodeConfig(
        { plugin: ["/gone/elsewhere/dist/plugin.mjs"], plugins: ["/gone/elsewhere"] },
        { pluginRef: "/checkout/dist/plugin.mjs", pluginDir: "/checkout", ...fs({}) },
      );
      expect(merged.plugin).toEqual(["/checkout/dist/plugin.mjs"]);
      expect(merged.plugins).toEqual(["/checkout"]);
    });

    it("keeps a vanished entry whose options mix ours with someone else's", () => {
      const merged = mergeOpencodeConfig(
        { plugin: [["/gone/elsewhere/dist/plugin.mjs", { lean: true, strict: true }]] },
        { pluginRef: "/checkout/dist/plugin.mjs", pluginDir: "/checkout", ...fs({}) },
      );
      expect(merged.plugin).toEqual([
        ["/gone/elsewhere/dist/plugin.mjs", { lean: true, strict: true }],
        "/checkout/dist/plugin.mjs",
      ]);
    });
  });

  it("uses the package name for both keys when installed from npm", () => {
    const merged = mergeOpencodeConfig({}, { pluginRef: "opencode-m365-copilot" });
    expect(merged.plugin).toEqual(["opencode-m365-copilot"]);
    expect(merged.plugins).toEqual(["opencode-m365-copilot"]);
  });
});

describe("the v2 catalog entry", () => {
  const baseUrl = "http://127.0.0.1:4319/v1";
  const info = buildProviderInfo(baseUrl, "per-launch-secret");
  const models = buildModelInfos();

  it("registers a provider opencode 2 will actually talk to", () => {
    expect(info.id).toBe(PROVIDER_ID);
    // v2 bundles the openai-compatible driver rather than installing an npm package,
    // so the v1 `npm: "@ai-sdk/openai-compatible"` has no equivalent here.
    expect(info.package).toBe("@opencode/ai/providers/openai-compatible");
    expect(info.settings?.baseURL).toBe(baseUrl);
  });

  it("carries the proxy's per-launch secret as the api key", () => {
    expect(info.settings?.apiKey).toBe("per-launch-secret");
  });

  it("is enabled outright rather than waiting to be activated", () => {
    // `auto` waits for a credential to show up on an integration we do not register.
    expect(info.activation).toBe("enabled");
  });

  it("still sends the placeholder api key the driver insists on", () => {
    expect(info.settings?.apiKey).toBeTruthy();
  });

  it("keeps the generous per-turn timeout", () => {
    expect(Number(info.settings?.timeout)).toBeGreaterThan(300_000);
  });

  it("advertises the same catalog as v1, including the local titler", () => {
    const ids = models.map((model) => model.id);
    expect(ids).toContain(DEFAULT_MODEL);
    expect(ids).toContain(LOCAL_TITLE_MODEL);
    expect(ids).toEqual(Object.keys(buildProviderConfig(baseUrl, "k").models));
  });

  it("declares tool support everywhere except the local titler", () => {
    const byId = new Map(models.map((model) => [model.id, model]));
    expect(byId.get(DEFAULT_MODEL)?.capabilities.tools).toBe(true);
    expect(byId.get(LOCAL_TITLE_MODEL)?.capabilities.tools).toBe(false);
  });

  it("offers no image input, because the proxy cannot carry attachments", () => {
    for (const model of models) expect(model.capabilities.input).toEqual(["text"]);
  });

  it("prices every model at zero, since M365 bills the licence not the token", () => {
    for (const model of models) {
      expect(model.cost).toHaveLength(1);
      expect(model.cost[0]).toMatchObject({ input: 0, output: 0, cache: { read: 0, write: 0 } });
    }
  });

  it("carries limits through from the catalog", () => {
    const model = models.find((candidate) => candidate.id === DEFAULT_MODEL)!;
    expect(model.limit.context).toBeGreaterThan(0);
    expect(model.limit.output).toBeGreaterThan(0);
  });
});

describe("the v2 catalog entry, against opencode 2's own schema", () => {
  // These decode our hand-built records through opencode 2's real schemas. We build
  // the records from plain literals so the published package needs no runtime
  // dependency on `@opencode/plugin` — it is a **dev** dependency only — and v2's
  // loader swallows plugin load failures, so a record that has drifted out of shape
  // would otherwise surface as nothing at all: a provider that never appears.
  //
  // Decoding, rather than comparing key names, is what checks the nested
  // `capabilities`/`cost`/`limit` shapes and the `activation`/`status` enums.

  /**
   * opencode 2's schemas are built with the `effect` that `@opencode/schema` itself
   * resolves. Our root `effect` is a different, older copy (pinned by
   * `@opencode-ai/plugin`), and decoding a schema with a mismatched copy fails on
   * every field — so reach the matching one deliberately rather than by luck.
   */
  const loadSchema = async () => {
    const schemaEntry = fileURLToPath(import.meta.resolve("@opencode/schema/model"));
    const effectPath = createRequire(schemaEntry).resolve("effect");
    const { Schema } = (await import(pathToFileURL(effectPath).href)) as {
      Schema: { decodeUnknownSync: (schema: unknown) => (input: unknown) => unknown };
    };
    return Schema;
  };

  it("decodes as a provider opencode 2 accepts", async () => {
    const [Schema, { Provider }] = await Promise.all([loadSchema(), import("@opencode/plugin")]);
    const decode = Schema.decodeUnknownSync(Provider.Info);
    expect(() => decode(buildProviderInfo("http://127.0.0.1:4319/v1", "k"))).not.toThrow();
  });

  it("decodes every model opencode 2 would be offered", async () => {
    const [Schema, { Model }] = await Promise.all([loadSchema(), import("@opencode/plugin")]);
    const decode = Schema.decodeUnknownSync(Model.Info);
    for (const model of buildModelInfos()) {
      expect(() => decode(model), `model ${model.id} is not a valid Model.Info`).not.toThrow();
    }
  });

  it("would notice a record that has drifted out of shape", async () => {
    // Guards the guard: a decode that accepts anything would pass the two above
    // while telling us nothing.
    const [Schema, { Model }] = await Promise.all([loadSchema(), import("@opencode/plugin")]);
    const decode = Schema.decodeUnknownSync(Model.Info);
    const [model] = buildModelInfos();
    expect(() => decode({ ...model, status: "retired" })).toThrow();
    expect(() => decode({ ...model, limit: { context: "lots", output: 1 } })).toThrow();
    expect(() => decode({ ...model, capabilities: { tools: true, input: ["text"] } })).toThrow();
  });
});
