/**
 * The opencode 2 plugin: the `setup()` that `plugin.ts` exports.
 *
 * v2 has no single mutable config object. Every change is registered against the
 * domain that owns it, as a **transform** — a synchronous, replayable edit that
 * opencode re-runs from scratch whenever the registry rebuilds. That has one
 * consequence worth stating plainly, because it is the difference between a plugin
 * that is additive and one that fights the user: a transform runs again every time,
 * so "set it only if the user has not" has to be re-checked inside the callback
 * rather than decided once at setup.
 *
 * The toolset trim and the system-prompt condense stay in the proxy. opencode 2 offers
 * hooks for both (`tool.transform`, `session.hook("context")`), where opencode 1's
 * equivalents were measured dead, but neither has been measured against a live
 * tenant, and the proxy is the only layer that holds for every harness. See AGENTS.md
 * before moving either.
 */

import type { Plugin } from "@opencode/plugin";
import { PROVIDER_ID, buildModelInfos, buildProviderInfo } from "./config.js";
import { DEFAULT_MODEL, canonicalModelId, isLocalModel } from "./models.js";
import { createLogger } from "./log.js";
import { METRICS_RPC, metricsRpcHandlers } from "./metrics.js";
import { startRuntime } from "./runtime.js";
import { AUX_REQUEST_KIND_HEADER, SESSION_ID_HEADER } from "./server.js";

const log = createLogger("plugin");

let warnedAboutDuplicate = false;

export const setup: Plugin.Plugin["setup"] = async (ctx: Plugin.Context) => {
  const runtime = await startRuntime(ctx.options as Record<string, unknown>);

  const info = buildProviderInfo(runtime.baseUrl, runtime.apiKey);
  const models = buildModelInfos();

  // `add` takes opencode's branded `Provider.ID`/`Model.ID` strings. We build the
  // records by hand — from plain literals, so the published package needs no runtime
  // dependency on `@opencode/plugin` — and the shapes are pinned against the real
  // constructors in `config.test.ts`.
  // Loaded twice — two plugin entries, say the npm package and a local checkout — each
  // setup would add the provider, and opencode lists every model twice (seen on a work
  // install). The first registration wins; checked inside the transform, because
  // transforms replay from scratch on every registry rebuild.
  await ctx.provider.transform((editor) => {
    const existing = editor.get?.(PROVIDER_ID);
    if (existing && existing.provider.name === info.name) {
      if (!warnedAboutDuplicate) {
        warnedAboutDuplicate = true;
        log.warn(
          "opencode-m365-copilot is loaded more than once; keeping the first. Check your opencode config for a second plugin entry (an npm name and a checkout directory, or opencode.json and opencode.jsonc).",
        );
      }
      return;
    }
    editor.add({ info, models } as never);
  });

  await ctx.model.transform((editor) => {
    const current = editor.default.get();
    // A saved default that names an id we now only accept as an alias (`m365/auto`,
    // `m365/gpt-5.5`) is not in the catalogue, so opencode could not load it. Move it
    // to the canonical id: the same model, so the user's choice still stands.
    if (current?.providerID === PROVIDER_ID) {
      const canonical = canonicalModelId(String(current.modelID));
      if (canonical !== current.modelID) editor.default.set(PROVIDER_ID as never, canonical as never);
      return;
    }
    // Re-checked on every replay: the user's own choice must keep winning.
    if (current || !runtime.options.setDefaultModel) return;
    editor.default.set(PROVIDER_ID as never, DEFAULT_MODEL as never);
  });

  // opencode 2 has no `small_model` to point at the local titler, and the title
  // request's model is read-only here. Its headers are not, so we mark the kind and
  // let the proxy answer locally. A second
  // M365 conversation per session is exactly the throttle signature; see models.ts.
  //
  // The same hook names the session on primary requests, so the proxy keys its M365
  // conversation on opencode's session rather than on the opening message — two
  // sessions that both start "fix the failing tests" must not share one.
  await ctx.session.hook("model.request", (event) => {
    if (event.model.providerID !== PROVIDER_ID) return;
    if (event.kind === "primary" && event.sessionID) {
      event.headers[SESSION_ID_HEADER] = String(event.sessionID);
      return;
    }
    if (!runtime.options.setSmallModel) return;
    if (event.kind !== "title") return;
    if (isLocalModel(event.model.id)) return;
    event.headers[AUX_REQUEST_KIND_HEADER] = event.kind;
  });

  const metricsRpc = await serveMetrics(ctx, runtime);

  log.info(`Microsoft 365 Copilot ready at ${runtime.baseUrl}`);

  return async () => {
    await metricsRpc?.dispose().catch(() => {});
    await runtime.close();
  };
};

/**
 * Serve the proxy's per-session metrics to the TUI over opencode's RPC domain, and
 * announce each change of the in-process store as an `updated` event. Attached to an
 * external proxy, the answer is read from it, and the TUI refreshes when a model step ends. Best effort: a failure here is logged
 * and the plugin loads without it, because opencode swallows a plugin whose setup
 * throws, and losing the provider over a status line would be the worse outcome.
 */
async function serveMetrics(ctx: Plugin.Context, runtime: Awaited<ReturnType<typeof startRuntime>>) {
  const rpc = (ctx as { rpc?: Plugin.Context["rpc"] }).rpc;
  if (!rpc?.register) return undefined;
  try {
    const registration = await rpc.register(METRICS_RPC, metricsRpcHandlers(() => runtime.metrics ?? runtime.remoteMetrics));
    runtime.metrics?.onChange((sessionID) => {
      registration.events.emit("updated", { sessionID }).catch(() => {});
    });
    return registration;
  } catch (error) {
    log.warn("could not register the metrics RPC; the TUI status will stay empty", String(error));
    return undefined;
  }
}
