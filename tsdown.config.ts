import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/plugin.ts", "src/server.ts", "src/cli.ts"],
  format: "esm",
  outExtensions: () => ({ js: ".mjs" }),
  dts: true,
  clean: true,
  platform: "node",
  // Bundle everything the plugin needs at runtime, so the published bundle never
  // resolves a dependency from whatever opencode happens to have installed.
  //
  // The bundled packages are nonetheless listed under `dependencies`, not
  // `devDependencies`: what is inlined here is what ships, so their bumps must
  // release. Dependabot prefixes dev bumps `chore`, which release-please never
  // releases — a security fix in ws or msal-node would merge and never reach npm
  // (b14e1df did that to zod). `src/packaging.test.ts` pins this. The cost is that
  // npm installs copies the bundle does not use; that is the cheaper failure.
  //
  // Bundling is a packaging preference, not a fix. Issue #17 read the same
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
  // what actually pulls them into the bundle. Keep this list and `dependencies` in step.
  noExternal: ["zod", "ws", "otpauth", "@azure/msal-node"],
});
