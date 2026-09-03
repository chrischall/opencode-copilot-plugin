import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/plugin.ts", "src/server.ts", "src/cli.ts"],
  format: "esm",
  outExtensions: () => ({ js: ".mjs" }),
  dts: true,
  clean: true,
  platform: "node",
  // Bundle runtime dependencies into the published package so opencode does not
  // need to install a dependency tree into its plugin cache.
  //
  // PR #18 originally investigated whether npm-installed plugins were failing to
  // load because packages with runtime dependencies triggered a loader bug. That
  // hypothesis was not confirmed. Issue #26 was ultimately fixed by exporting the
  // plugin function as the module's default export.
  //
  // The bundling remains desirable because it makes the published package more
  // self-contained and avoids relying on dependency installation inside opencode's
  // plugin environment.
  //
  // `playwright` stays external and is an optional peer: it is only used by
  // `opencode-m365 login`, it is far too heavy to bundle, and it must never end up
  // in the plugin's install path.
  external: [/^node:/, "playwright", "@opencode-ai/plugin"],
  // tsdown externalizes packages listed in `dependencies` by default. Listing
  // them here forces them into the bundle.
  noExternal: ["zod", "ws", "otpauth", "@azure/msal-node"],
});
