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
import { DEFAULT_MODEL, isLocalModel } from "./models.js";
import { createLogger } from "./log.js";
import { startRuntime } from "./runtime.js";
import { AUX_REQUEST_KIND_HEADER, SESSION_ID_HEADER } from "./server.js";

const log = createLogger("plugin");

export const setup: Plugin.Plugin["setup"] = async (ctx: Plugin.Context) => {
  const runtime = await startRuntime(ctx.options as Record<string, unknown>);

  const info = buildProviderInfo(runtime.baseUrl, runtime.apiKey);
  const models = buildModelInfos();

  // `add` takes opencode's branded `Provider.ID`/`Model.ID` strings. We build the
  // records by hand — from plain literals, so the published package needs no runtime
  // dependency on `@opencode/plugin` — and the shapes are pinned against the real
  // constructors in `config.test.ts`.
  await ctx.provider.transform((editor) => {
    editor.add({ info, models } as never);
  });

  if (runtime.options.setDefaultModel) {
    await ctx.model.transform((editor) => {
      // Re-checked on every replay: the user's own choice must keep winning.
      if (editor.default.get()) return;
      editor.default.set(PROVIDER_ID as never, DEFAULT_MODEL as never);
    });
  }

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

  log.info(`Microsoft 365 Copilot ready at ${runtime.baseUrl}`);

  return () => runtime.close();
};
