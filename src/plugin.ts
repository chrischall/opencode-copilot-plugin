/**
 * The plugin entry: one default export, the opencode 2 plugin.
 *
 * opencode 2 imports the package's root entry and validates its default export as
 * `{ id, setup }`. A shape it does not accept is not an error — the plugin simply
 * never loads — so `plugin-entry.test.ts` checks the built artefact.
 *
 * Two rules outlive opencode 1 support, and both are pinned there too:
 *
 * - **Exactly one export.** A loader that walks every export and finds a second
 *   plugin-shaped value starts the proxy twice; a non-plugin one can fail the load.
 * - **No `./server` export subpath in package.json.** That name is opencode's for a
 *   plugin's server entry. Ours once pointed it at the HTTP proxy, and that was #26.
 *
 * The definition is annotated as `Plugin.Plugin` rather than built with
 * `Plugin.define(...)`: that helper is the identity function, and calling it would
 * mean importing `@opencode/plugin` at runtime. A type-only import keeps the
 * published package free of it, which is also what keeps the dts bundler from
 * inlining effect (see `tsdown.config.ts`).
 */

import type { Plugin } from "@opencode/plugin";
import { PLUGIN_ID } from "./config.js";
import { setup } from "./plugin-v2.js";

const definition: Plugin.Plugin = { id: PLUGIN_ID, setup };

export default definition;
