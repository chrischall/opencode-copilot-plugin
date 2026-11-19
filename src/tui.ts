/**
 * The TUI entry, exported as `./tui`: opencode 2 resolves a package's TUI plugin as
 * `<package>/tui` and accepts a default export of `{ id, setup }`. The status it draws
 * lives in `tui-status.ts`.
 *
 * Like the root entry, this module exports `default` and nothing else, and imports
 * nothing from `@opencode/plugin` at runtime (the type is annotated, not built with
 * `Plugin.define`, which is the identity function).
 *
 * `@opentui/solid` and `solid-js` are provided by opencode to TUI plugins; they are
 * not dependencies of this package, and must not be bundled, or the status would
 * render with a second Solid instance the host's tree does not know. They are reached
 * by dynamic import inside `setup`, so the module still imports anywhere (the
 * packaging test does), and a host without them gets no status rather than a plugin
 * that fails to load — opencode swallows that failure silently.
 */

import type { Plugin } from "@opencode/plugin/tui";
import { PLUGIN_ID } from "./config.js";
import { setupStatus, type StatusRuntime } from "./tui-status.js";

/** The host's Solid runtime, or undefined outside opencode. */
async function loadRuntime(): Promise<StatusRuntime | undefined> {
  try {
    // Literal specifiers, so the host's module rewriting sees them; typed by hand,
    // because neither package is installed here.
    const [opentui, solid] = (await Promise.all([import("@opentui/solid" as string), import("solid-js" as string)])) as [
      Pick<StatusRuntime, "createElement" | "insert" | "setProp">,
      Pick<StatusRuntime, "createSignal">,
    ];
    if (typeof opentui.createElement !== "function" || typeof solid.createSignal !== "function") return undefined;
    return {
      createElement: opentui.createElement,
      insert: opentui.insert,
      setProp: opentui.setProp,
      createSignal: solid.createSignal,
    };
  } catch {
    return undefined;
  }
}

const definition: Plugin.Definition = {
  id: PLUGIN_ID,
  setup: async (context) => {
    const runtime = await loadRuntime();
    if (!runtime) return undefined;
    try {
      const status = await setupStatus(context, runtime);
      return status.cleanup;
    } catch {
      // A status line is not worth a failed plugin.
      return undefined;
    }
  },
};

export default definition;
