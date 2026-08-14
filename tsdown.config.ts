import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/plugin.ts", "src/server.ts", "src/cli.ts"],
  format: "esm",
  outExtensions: () => ({ js: ".mjs" }),
  dts: true,
  clean: true,
  platform: "node",
  // Everything we depend on stays external. Bundling would drag playwright (and its
  // native fsevents binary) into the output, and opencode installs our declared
  // dependencies for us anyway.
  external: [/^node:/, "@azure/msal-node", "otpauth", "ws", "zod", "playwright", "@opencode-ai/plugin"],
});
