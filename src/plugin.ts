/**
 * The plugin entry. One default export, serving both opencode plugin APIs.
 *
 * ## Which file opencode imports
 *
 * opencode 1 does NOT load this file because it is the package's main entry. It loads
 * whatever the package's **`./server` export subpath** resolves to, falling back to
 * the root entry only when there is no such subpath — `./server` is opencode's name
 * for the server-side plugin, so a package must not use it for a module of its own.
 * We did, pointing it at the HTTP proxy, and that is what issue #26 actually was.
 * opencode 2 imports the root entry. With no `./server` subpath, both land here.
 *
 * ## What the export has to look like
 *
 * opencode 1 looks first for an **object** default export and accepts it when it
 * carries `server()`. opencode 2 looks at that same default export for `id` and
 * `setup()`, and ignores `server()`. So a single object satisfies both — which is
 * the documented way to support the two APIs from one package.
 *
 * When detection declines, opencode 1 falls back to walking **every** export and
 * requiring each one to be either a function or an object with a `server()` function.
 * One non-plugin export (the proxy's `DEFAULT_MODEL` string, in our case) is enough
 * to fail the whole load with "Plugin export is not a function", which is why that
 * message sent #18 and #27 hunting the wrong thing. That walk also dedupes by
 * identity before it collects, so two distinct plugin-shaped exports load the plugin
 * twice and start the proxy twice. Hence: exactly one export from this module, ever.
 *
 * The trap is in the older loader's detection test, decompiled from 1.18.31:
 *
 * ```js
 * if (mode === "detect" && !("id" in def) && !("server" in def) && !("tui" in def)) return;
 * ...
 * if (kind === "server" && server === undefined)
 *   throw TypeError(`Plugin ${spec} must default export an object with server()`);
 * ```
 *
 * **`id` alone arms detection.** A bare v2 default export is therefore not politely
 * skipped by opencode 1 — it reaches that last line and throws. The two halves have
 * to travel together or not at all. `plugin-entry.test.ts` pins every rule above.
 *
 * opencode's docs say the object form is "supported in OpenCode 1.18.29". Measured
 * against the real binaries, 1.18.0 — the bottom of our declared peer range — already
 * has the identical detect call site, so the peer floor did not have to move.
 *
 * The v2 half is annotated as `Plugin.Plugin` on its own and then spread in, so it is
 * type-checked without `server()` in the way. opencode's own docs reach the same end
 * by spreading a `Plugin.define(...)` call — that helper is the identity function, and
 * calling it would mean importing `@opencode/plugin` at runtime. A type-only import
 * keeps the published package free of any runtime dependency on it, which is also what
 * keeps the dts bundler from inlining effect (see `tsdown.config.ts`).
 */

import type { Plugin } from "@opencode/plugin";
import { PLUGIN_ID } from "./config.js";
import { server } from "./plugin-v1.js";
import { setup } from "./plugin-v2.js";

const definition: Plugin.Plugin = { id: PLUGIN_ID, setup };

export default { ...definition, server };
