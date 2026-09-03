import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Regression cover for issue #26 — `Plugin export is not a function`.
 *
 * The error names the default export, which sent two attempts (#18, #27) after the
 * wrong thing. What opencode actually does, decompiled from the 1.18.27 binary:
 *
 * ```js
 * isFn       = v => typeof v === "function"
 * toPluginFn = v => isFn(v) ? v
 *   : (!v || typeof v !== "object" || !("server" in v)) ? undefined
 *   : isFn(v.server) ? v.server : undefined
 * collect    = mod => { for (const v of Object.values(mod))   // EVERY export, deduped
 *   if (!toPluginFn(v)) throw TypeError("Plugin export is not a function") }
 * ```
 *
 * Two things follow, and this file pins both:
 *
 * 1. The entry opencode imports is the package's **`./server` export subpath** when
 *    one exists, falling back to the root entry otherwise — `./server` is its name
 *    for the server-side plugin, not a subpath a package may use for its own
 *    "server" module. We had ours pointing at the HTTP proxy, whose `DEFAULT_MODEL`
 *    string export is what actually threw. Verified against the real binary: with
 *    `./server` pointed at a module whose default throws a marker, the marker is
 *    what surfaces.
 * 2. It walks *every* export, so one non-plugin export anywhere in that module
 *    breaks loading, and two distinct plugin-shaped exports load the plugin twice.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const pkg = require(path.join(repoRoot, "package.json")) as {
  main?: string;
  exports?: Record<string, { import?: string } | string>;
};

/** opencode's own resolution order for a `kind: "server"` plugin entry. */
const resolvePluginEntry = () => {
  const subpath = pkg.exports?.["./server"] ?? pkg.exports?.["."] ?? pkg.main;
  const target = typeof subpath === "string" ? subpath : subpath?.import;
  if (!target) throw new Error("package.json exposes no importable entry");
  return path.join(repoRoot, target);
};

const isFn = (value: unknown): value is (...args: never[]) => unknown => typeof value === "function";

const toPluginFn = (value: unknown) => {
  if (isFn(value)) return value;
  if (!value || typeof value !== "object" || !("server" in value)) return undefined;
  const server = (value as { server: unknown }).server;
  return isFn(server) ? server : undefined;
};

const collect = (mod: Record<string, unknown>) => {
  const seen = new Set<unknown>();
  const plugins: unknown[] = [];
  for (const value of Object.values(mod)) {
    if (seen.has(value)) continue;
    seen.add(value);
    const plugin = toPluginFn(value);
    if (!plugin) throw new TypeError("Plugin export is not a function");
    plugins.push(plugin);
  }
  return plugins;
};

describe("the entry opencode loads", () => {
  let entry: string;
  let namespace: Record<string, unknown>;

  beforeAll(async () => {
    entry = resolvePluginEntry();
    // CI builds before it tests; a bare `npm test` may not have, and this assertion
    // is only meaningful against the artefact opencode actually imports.
    if (!existsSync(entry)) {
      execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "ignore", timeout: 180_000 });
    }
    namespace = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
  }, 200_000);

  it("does not hand opencode a module full of proxy internals", () => {
    // `./server` is opencode's plugin entry, not ours to use for the HTTP proxy.
    expect(entry).toBe(path.join(repoRoot, "dist/plugin.mjs"));
  });

  it("survives the loader's every-export check", () => {
    expect(() => collect(namespace)).not.toThrow();
  });

  it("registers the plugin exactly once", () => {
    // The named export and the default must be the *same* object, or the loader's
    // identity dedupe misses them and starts the proxy twice.
    expect(collect(namespace)).toHaveLength(1);
  });
});
