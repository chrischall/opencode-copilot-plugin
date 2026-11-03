import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The entry opencode 2 loads, checked against the built artefact.
 *
 * opencode 2 validates the module against `{ default: { id, setup } | { id, effect } }`.
 * Its failures are swallowed, so a wrong shape here is a plugin that silently never
 * loads — nothing in the UI or the log says why.
 *
 * Two older lessons still hold, though opencode 1 support is gone:
 *
 * - The package must not expose a `./server` export subpath. That is opencode's own
 *   name for a plugin's server entry; ours once pointed it at the HTTP proxy, which is
 *   what issue #26 was.
 * - The module exports `default` and nothing else, so no loader that walks exports
 *   can find a second plugin-shaped value and start the proxy twice.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const pkg = require(path.join(repoRoot, "package.json")) as {
  main?: string;
  exports?: Record<string, { import?: string } | string>;
};

/** The package's importable entry, with the `./server` subpath taken first as a loader would. */
const resolvePluginEntry = () => {
  const subpath = pkg.exports?.["./server"] ?? pkg.exports?.["."] ?? pkg.main;
  const target = typeof subpath === "string" ? subpath : subpath?.import;
  if (!target) throw new Error("package.json exposes no importable entry");
  return path.join(repoRoot, target);
};

const isFn = (value: unknown): value is (...args: never[]) => unknown => typeof value === "function";

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

  it("exports the plugin as the default and nothing else", () => {
    expect(Object.keys(namespace)).toEqual(["default"]);
  });

  describe("opencode 2", () => {
    it("decodes as a v2 plugin definition", () => {
      const entry = decodeV2Entry(namespace);
      expect(isFn(entry.setup)).toBe(true);
    });

    it("carries only the v2 API: no opencode 1 server() half", () => {
      expect(namespace.default).not.toHaveProperty("server");
    });
  });
});
