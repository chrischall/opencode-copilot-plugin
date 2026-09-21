import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/plugin.ts", "src/server.ts", "src/cli.ts"],
  format: "esm",
  outExtensions: () => ({ js: ".mjs" }),
  dts: true,
  clean: true,
  platform: "node",
  // Bundle everything the plugin needs at runtime, so the published package declares
  // NO dependencies for opencode to install.
  //
  // This is a packaging preference, not a fix. Issue #17 read the same
  // `Plugin export is not a function` as a dependency-loading bug, and the bisect
  // behind that reading was confounded: dropping `dependencies` also changed which
  // modules the bundle emitted. The real cause was the package's `./server` export
  // subpath shadowing opencode's plugin entry — see `src/plugin.ts` and issue #26.
  //
  // `playwright` stays external and is an optional peer: it is only used by
  // `opencode-m365 login`, it is far too heavy to bundle, and it must never end up in
  // the plugin's install path.
  // Both plugin API packages stay external. They are type-only imports, so nothing
  // of them reaches the bundle — but the *dts* bundler will happily inline their
  // whole type graph if they are not listed, and `@opencode/plugin` drags in
  // `@opencode/schema` and effect: 16 MB of `plugin.d.mts` when it is missed.
  external: [/^node:/, "playwright", "@opencode-ai/plugin", "@opencode/plugin"],
  // tsdown externalises anything in `dependencies` by default, so listing them here is
  // what actually pulls them into the bundle.
  noExternal: ["zod", "ws", "otpauth", "@azure/msal-node"],
});
