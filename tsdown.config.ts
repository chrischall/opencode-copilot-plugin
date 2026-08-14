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
  // opencode 1.18.18 fails to load an npm-installed plugin whose package.json carries
  // `dependencies` — `Plugin export is not a function`, before any of our code runs.
  // Bisected against the real loader: our package.json with trivial code fails, and the
  // same package.json minus `dependencies` loads. The export shape is not involved (a
  // minimal package using our exact `{ id, server }` default loads fine). See issue #17.
  //
  // `playwright` stays external and is an optional peer: it is only used by
  // `opencode-m365 login`, it is far too heavy to bundle, and it must never end up in
  // the plugin's install path.
  external: [/^node:/, "playwright", "@opencode-ai/plugin"],
  // tsdown externalises anything in `dependencies` by default, so listing them here is
  // what actually pulls them into the bundle.
  noExternal: ["zod", "ws", "otpauth", "@azure/msal-node"],
});
