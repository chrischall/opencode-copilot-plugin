import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Regression cover for issue #26 — `Plugin export is not a function` — and for the
 * dual v1/v2 entry shape that replaced it.
 *
 * ## v1, the every-export fallback
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
 *
 * ## v1, the object-entrypoint path
 *
 * A second path runs *first*, and it is the one that lets a single module serve both
 * plugin APIs. Decompiled from the 1.18.31 binary (`rQ`, called as
 * `rQ(mod, spec, "server", "detect")`):
 *
 * ```js
 * const def = mod.default;
 * if (!isObject(def)) { if (mode === "detect") return; throw ... }
 * if (mode === "detect" && !("id" in def) && !("server" in def) && !("tui" in def)) return;
 * const server = "server" in def ? def.server : undefined;
 * const tui    = "tui"    in def ? def.tui    : undefined;
 * if (server !== undefined && !isFn(server)) throw TypeError(`... invalid server export`);
 * if (tui    !== undefined && !isFn(tui))    throw TypeError(`... invalid tui export`);
 * if (server !== undefined && tui !== undefined) throw TypeError(`... server() or tui(), not both`);
 * if (kind === "server" && server === undefined)
 *   throw TypeError(`... must default export an object with server()`);
 * return def;
 * ```
 *
 * The trap is the first `in` check: **`id` alone arms detection**. A bare v2 default
 * export (`{ id, setup }`) therefore does not get politely skipped by a v1 opencode —
 * it reaches the last line and throws. The combined object is the only shape that
 * survives both loaders, which is why it is asserted rather than assumed.
 *
 * opencode's docs say the object form is "supported in OpenCode 1.18.29". Measured
 * against the real darwin-arm64 binaries, 1.18.0 — the bottom of our declared peer
 * range — already carries the identical `(mod, spec, "server", "detect")` call site
 * and the same `"id" in def` short-circuit, as does 1.18.28. Both paths below are
 * therefore live across the whole range we support, and both are asserted.
 *
 * ## v2
 *
 * opencode 2 validates the module against `{ default: { id, setup } | { id, effect } }`
 * and ignores `server()`. Its failures are swallowed, so a wrong shape here is a
 * plugin that silently never loads.
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

/** opencode 1's object-entrypoint detection, for `kind: "server"`. */
const detectObjectEntry = (mod: Record<string, unknown>) => {
  const def = mod.default;
  if (!def || typeof def !== "object") return undefined;
  const has = (key: string) => key in (def as Record<string, unknown>);
  if (!has("id") && !has("server") && !has("tui")) return undefined;

  const entry = def as { id?: unknown; server?: unknown; tui?: unknown };
  if (entry.server !== undefined && !isFn(entry.server)) {
    throw new TypeError("Plugin has invalid server export");
  }
  if (entry.tui !== undefined && !isFn(entry.tui)) {
    throw new TypeError("Plugin has invalid tui export");
  }
  if (entry.server !== undefined && entry.tui !== undefined) {
    throw new TypeError("Plugin must default export either server() or tui(), not both");
  }
  if (entry.server === undefined) {
    throw new TypeError("Plugin must default export an object with server()");
  }
  return entry;
};

/** opencode 2's schema for the plugin module, in the shape its decoder accepts. */
const decodeV2Entry = (mod: Record<string, unknown>) => {
  const def = mod.default;
  if (!def || typeof def !== "object") throw new TypeError("default export is not an object");
  const entry = def as { id?: unknown; setup?: unknown; effect?: unknown };
  if (typeof entry.id !== "string" || entry.id.trim() === "") {
    throw new TypeError("default export has no id");
  }
  if (!isFn(entry.setup) && !isFn(entry.effect)) {
    throw new TypeError("default export has neither setup() nor effect()");
  }
  return entry;
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

  describe("opencode 1, the every-export fallback", () => {
    it("survives the loader's every-export check", () => {
      expect(() => collect(namespace)).not.toThrow();
    });

    it("registers the plugin exactly once", () => {
      // This path is reached only when detection declines, but it still walks every
      // export and dedupes by identity, so a second plugin-shaped export would start
      // the proxy twice. One export is the safe answer.
      expect(collect(namespace)).toHaveLength(1);
      expect(Object.keys(namespace)).toEqual(["default"]);
    });
  });

  describe("opencode 1, the object-entrypoint path", () => {
    it("is detected as an object entrypoint with a server()", () => {
      const detected = detectObjectEntry(namespace);
      expect(detected).toBeDefined();
      expect(isFn(detected!.server)).toBe(true);
    });

    it("carries the id the loader registers it under", () => {
      // A path-sourced plugin is rejected outright without one.
      expect(typeof detectObjectEntry(namespace)!.id).toBe("string");
      expect(detectObjectEntry(namespace)!.id).not.toBe("");
    });

    it("does not also export tui(), which the loader rejects alongside server()", () => {
      expect(namespace.default).not.toHaveProperty("tui");
    });
  });

  describe("opencode 2", () => {
    it("decodes as a v2 plugin definition", () => {
      const entry = decodeV2Entry(namespace);
      expect(isFn(entry.setup)).toBe(true);
    });

    it("uses the same id under both APIs", () => {
      expect(decodeV2Entry(namespace).id).toBe(detectObjectEntry(namespace)!.id);
    });
  });
});
