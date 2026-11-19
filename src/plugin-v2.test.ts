import { describe, expect, it, vi } from "vitest";
import { PROVIDER_ID } from "./config.js";
import { DEFAULT_MODEL, LOCAL_TITLE_MODEL } from "./models.js";
import { AUX_REQUEST_KIND_HEADER, SESSION_ID_HEADER } from "./server.js";
import { setup } from "./plugin-v2.js";
import { METRICS_RPC, SessionMetricsStore } from "./metrics.js";
import { resolveModel } from "./models.js";
import { startRuntime } from "./runtime.js";

// The real startRuntime, spied on so one test can hand setup an in-process store.
vi.mock("./runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime.js")>();
  return { ...actual, startRuntime: vi.fn(actual.startRuntime) };
});

/**
 * A stand-in for the slice of opencode 2's plugin context we actually touch.
 *
 * The real `Context` is an entire server client; building one here would test
 * opencode rather than us. What matters is that each transform and hook is
 * registered on the right domain and does the right thing to the draft it is given,
 * so the fake records the callbacks and the tests run them by hand.
 */
function fakeContext(options: Record<string, unknown> = {}) {
  const providerTransforms: Array<(editor: any) => void> = [];
  const modelTransforms: Array<(editor: any) => void> = [];
  const hooks = new Map<string, (event: any) => void>();
  const rpcs: Array<{ definition: any; handlers: any; emitted: unknown[][]; disposed: boolean }> = [];

  const registration = { dispose: async () => {} };

  const ctx = {
    options,
    provider: {
      transform: vi.fn(async (callback: (editor: any) => void) => {
        providerTransforms.push(callback);
        return registration;
      }),
    },
    model: {
      transform: vi.fn(async (callback: (editor: any) => void) => {
        modelTransforms.push(callback);
        return registration;
      }),
    },
    session: {
      hook: vi.fn(async (name: string, callback: (event: any) => void) => {
        hooks.set(name, callback);
        return registration;
      }),
    },
    rpc: {
      register: vi.fn(async (definition: any, handlers: any) => {
        const entry = { definition, handlers, emitted: [] as unknown[][], disposed: false };
        rpcs.push(entry);
        return {
          dispose: async () => {
            entry.disposed = true;
          },
          events: {
            emit: async (...args: unknown[]) => {
              entry.emitted.push(args);
            },
          },
        };
      }),
    } as { register: (...args: any[]) => Promise<unknown> } | undefined,
  };

  return {
    ctx,
    /** Run every registered provider transform against a recording editor. */
    runProviderTransforms(added: any[] = []) {
      const editor = {
        // opencode's `get` answers a ProviderRecord: `{ provider, models }`.
        get: (id: string) => {
          const input = added.find((candidate) => candidate.info.id === id);
          return input ? { provider: input.info, models: new Map() } : undefined;
        },
        add: (input: any) => added.push(input),
      };
      for (const transform of providerTransforms) transform(editor);
      return added;
    },
    /** Run every registered model transform against a recording default slot. */
    runModelTransforms(current?: { providerID: string; modelID: string }) {
      let value = current;
      const editor = {
        default: {
          get: () => value,
          set: (providerID: string, modelID: string) => {
            value = { providerID, modelID };
          },
        },
      };
      for (const transform of modelTransforms) transform(editor);
      return value;
    },
    hook(name: string) {
      return hooks.get(name);
    },
    rpcs,
  };
}

/** Every test here uses an already-running proxy, so none of them start a server. */
const withProxy = (extra: Record<string, unknown> = {}) => ({
  baseUrl: "http://127.0.0.1:4319/v1",
  apiKey: "serve-secret",
  ...extra,
});

describe("the opencode 2 setup", () => {
  it("registers the provider and its whole catalog", async () => {
    const harness = fakeContext(withProxy());
    await setup(harness.ctx as never);

    const added = harness.runProviderTransforms();
    expect(added).toHaveLength(1);
    expect(added[0].info.id).toBe(PROVIDER_ID);
    expect(added[0].info.settings.baseURL).toBe("http://127.0.0.1:4319/v1");
    expect(added[0].info.settings.apiKey).toBe("serve-secret");
    expect(added[0].models.map((model: any) => model.id)).toContain(DEFAULT_MODEL);
  });

  it("registers the provider once when the plugin is loaded twice", async () => {
    // Seen on a work install: every m365 model listed twice. Two plugin entries (say
    // the npm package and a local checkout) each ran setup and each added the provider.
    const first = fakeContext(withProxy());
    const second = fakeContext(withProxy());
    await setup(first.ctx as never);
    await setup(second.ctx as never);

    const added: any[] = [];
    first.runProviderTransforms(added);
    second.runProviderTransforms(added);
    expect(added).toHaveLength(1);

    // A replay of the registry rebuild must not add it again either.
    first.runProviderTransforms(added);
    expect(added).toHaveLength(1);
  });

  it("selects our default model when the user has not chosen one", async () => {
    const harness = fakeContext(withProxy());
    await setup(harness.ctx as never);

    expect(harness.runModelTransforms()).toEqual({
      providerID: PROVIDER_ID,
      modelID: DEFAULT_MODEL,
    });
  });

  it("moves a saved default that names an alias onto its canonical id", async () => {
    // opencode looks the default up in the catalogue, which no longer lists aliases.
    const harness = fakeContext(withProxy());
    await setup(harness.ctx as never);
    expect(harness.runModelTransforms({ providerID: PROVIDER_ID, modelID: "gpt-5.5" })).toEqual({
      providerID: PROVIDER_ID,
      modelID: "quick",
    });
    expect(harness.runModelTransforms({ providerID: PROVIDER_ID, modelID: "auto" })).toEqual({
      providerID: PROVIDER_ID,
      modelID: "m365-copilot",
    });
  });

  it("does so even with setDefaultModel off", async () => {
    const harness = fakeContext(withProxy({ setDefaultModel: false }));
    await setup(harness.ctx as never);
    expect(harness.runModelTransforms({ providerID: PROVIDER_ID, modelID: "gpt-5.6" })?.modelID).toBe("gpt-5.6-quick");
  });

  it("leaves a model the user already chose alone", async () => {
    // Transforms replay on every rebuild, so an unconditional `set` would keep
    // stealing the selection back.
    const harness = fakeContext(withProxy());
    await setup(harness.ctx as never);

    const chosen = { providerID: "anthropic", modelID: "claude-sonnet" };
    expect(harness.runModelTransforms(chosen)).toEqual(chosen);
  });

  it("does not touch the default when the option is off", async () => {
    const harness = fakeContext(withProxy({ setDefaultModel: false }));
    await setup(harness.ctx as never);

    expect(harness.runModelTransforms()).toBeUndefined();
  });

  describe("keeping session titles off M365", () => {
    // opencode 2 has no `small_model` to point at the local titler. The title
    // request's model is read-only on the hook,
    // but its headers are not — see models.ts for why a second conversation per
    // session is the throttle signature we must avoid.
    const titleRequest = (overrides: Record<string, unknown> = {}) => ({
      kind: "title",
      model: { providerID: PROVIDER_ID, id: DEFAULT_MODEL },
      headers: {} as Record<string, string>,
      ...overrides,
    });

    it("flags a title request bound for our provider", async () => {
      const harness = fakeContext(withProxy());
      await setup(harness.ctx as never);

      const event = titleRequest();
      harness.hook("model.request")!(event);
      expect(event.headers[AUX_REQUEST_KIND_HEADER]).toBe("title");
    });

    it("leaves another provider's title request untouched", async () => {
      const harness = fakeContext(withProxy());
      await setup(harness.ctx as never);

      const event = titleRequest({ model: { providerID: "anthropic", id: "claude-sonnet" } });
      harness.hook("model.request")!(event);
      expect(event.headers).toEqual({});
    });

    it("leaves compaction and generate to the real model", async () => {
      const harness = fakeContext(withProxy());
      await setup(harness.ctx as never);

      for (const kind of ["primary", "compaction", "generate"]) {
        const event = titleRequest({ kind });
        harness.hook("model.request")!(event);
        expect(event.headers[AUX_REQUEST_KIND_HEADER]).toBeUndefined();
      }
    });

    it("does not bother when the local titler is already the model in play", async () => {
      const harness = fakeContext(withProxy());
      await setup(harness.ctx as never);

      const event = titleRequest({ model: { providerID: PROVIDER_ID, id: LOCAL_TITLE_MODEL } });
      harness.hook("model.request")!(event);
      expect(event.headers).toEqual({});
    });
  });

  describe("naming the session", () => {
    it("tells the proxy which opencode session a primary request belongs to", async () => {
      // Two sessions opening with the same message must not share an M365 conversation.
      const harness = fakeContext(withProxy());
      await setup(harness.ctx as never);

      const event = { kind: "primary", sessionID: "ses_1", model: { providerID: PROVIDER_ID, id: DEFAULT_MODEL }, headers: {} as Record<string, string> };
      harness.hook("model.request")!(event);
      expect(event.headers[SESSION_ID_HEADER]).toBe("ses_1");
    });

    it("does so even with title routing turned off", async () => {
      const harness = fakeContext(withProxy({ setSmallModel: false }));
      await setup(harness.ctx as never);

      const event = { kind: "primary", sessionID: "ses_1", model: { providerID: PROVIDER_ID, id: DEFAULT_MODEL }, headers: {} as Record<string, string> };
      harness.hook("model.request")!(event);
      expect(event.headers[SESSION_ID_HEADER]).toBe("ses_1");
    });

    it("still leaves titles alone when title routing is off", async () => {
      const harness = fakeContext(withProxy({ setSmallModel: false }));
      await setup(harness.ctx as never);

      const event = { kind: "title", sessionID: "ses_1", model: { providerID: PROVIDER_ID, id: DEFAULT_MODEL }, headers: {} as Record<string, string> };
      harness.hook("model.request")!(event);
      expect(event.headers).toEqual({});
    });

    it("leaves other providers' requests alone", async () => {
      const harness = fakeContext(withProxy());
      await setup(harness.ctx as never);

      const event = { kind: "primary", sessionID: "ses_1", model: { providerID: "anthropic", id: "claude" }, headers: {} as Record<string, string> };
      harness.hook("model.request")!(event);
      expect(event.headers).toEqual({});
    });
  });

  describe("serving per-session metrics to the TUI", () => {
    it("registers the metrics RPC, which answers null when attached to an external proxy", async () => {
      const harness = fakeContext(withProxy());
      await setup(harness.ctx as never);

      expect(harness.rpcs).toHaveLength(1);
      expect(harness.rpcs[0]!.definition).toBe(METRICS_RPC);
      await expect(harness.rpcs[0]!.handlers.get({ sessionID: "ses_1" }, {})).resolves.toEqual({ metrics: null });
    });

    it("answers from the in-process proxy's store, and says when a session changed", async () => {
      const metrics = new SessionMetricsStore();
      const actual = await vi.importActual<typeof import("./runtime.js")>("./runtime.js");
      const external = await actual.startRuntime(withProxy());
      vi.mocked(startRuntime).mockResolvedValueOnce({ ...external, metrics });

      const harness = fakeContext(withProxy());
      const cleanup = (await setup(harness.ctx as never)) as () => Promise<void>;
      metrics.recordTurn("ses_1", { model: resolveModel("claude-opus"), throttle: { current: 3, max: 600 } });

      const answer = await harness.rpcs[0]!.handlers.get({ sessionID: "ses_1" }, {});
      expect(answer.metrics).toMatchObject({ sessionID: "ses_1", conversation: { used: 3, max: 600 } });
      expect(harness.rpcs[0]!.emitted).toEqual([["updated", { sessionID: "ses_1" }]]);

      await cleanup();
      expect(harness.rpcs[0]!.disposed).toBe(true);
    });

    it("still loads when the context has no RPC domain, or registering fails", async () => {
      // opencode swallows a plugin that throws during load: the provider must survive.
      const missing = fakeContext(withProxy());
      missing.ctx.rpc = undefined;
      await setup(missing.ctx as never);
      expect(missing.runProviderTransforms()).toHaveLength(1);

      const failing = fakeContext(withProxy());
      failing.ctx.rpc = { register: async () => Promise.reject(new Error("no rpc here")) };
      await setup(failing.ctx as never);
      expect(failing.runProviderTransforms()).toHaveLength(1);
    });
  });

  it("hands back a cleanup function for the proxy it owns", async () => {
    const harness = fakeContext(withProxy());
    const cleanup = await setup(harness.ctx as never);
    expect(typeof cleanup).toBe("function");
    await expect((cleanup as () => Promise<void>)()).resolves.toBeUndefined();
  });
});
