import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { PLUGIN_ID } from "./config.js";

/**
 * The TUI entry opencode 2 loads, checked against the built artefact.
 *
 * opencode resolves a package's TUI entry as `<package>/tui` through its exports, and
 * accepts it only if its default export is `{ id, setup }` — anything else is
 * swallowed as an unloaded plugin, so these checks run against `dist/`. The host
 * provides `@opentui/solid` and `solid-js` to TUI plugins; the module reaches them
 * by dynamic import inside `setup`, so importing it here, outside opencode, works.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
  exports: Record<string, { import?: string; types?: string } | string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

const HOST_PROVIDED = ["@opencode/plugin", "@opentui/solid", "@opentui/core", "solid-js"];

describe("the TUI entry", () => {
  const tuiExport = pkg.exports["./tui"];
  const target = typeof tuiExport === "string" ? tuiExport : tuiExport?.import;
  let file: string;
  let source: string;
  let namespace: Record<string, unknown>;
  let root: Record<string, unknown>;

  beforeAll(async () => {
    if (!target) throw new Error("package.json exports no ./tui");
    file = path.join(repoRoot, target);
    if (!existsSync(file) || !existsSync(path.join(repoRoot, "dist/plugin.mjs"))) {
      execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "ignore", timeout: 180_000 });
    }
    source = readFileSync(file, "utf8");
    namespace = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    root = (await import(pathToFileURL(path.join(repoRoot, "dist/plugin.mjs")).href)) as Record<string, unknown>;
  }, 200_000);

  it("is exported as ./tui, its own built module", () => {
    expect(target).toBe("./dist/tui.mjs");
    expect(typeof tuiExport === "object" && tuiExport.types).toBe("./dist/tui.d.mts");
  });

  it("default-exports a TUI definition, and nothing else", () => {
    expect(Object.keys(namespace)).toEqual(["default"]);
    const definition = namespace.default as { id?: unknown; setup?: unknown };
    expect(definition.id).toBe(PLUGIN_ID);
    expect(typeof definition.setup).toBe("function");
  });

  it("leaves the root module with exactly one export", () => {
    expect(Object.keys(root)).toEqual(["default"]);
  });

  it("imports nothing host-provided at load time", () => {
    // A static import of these would fail anywhere but inside opencode, and a bundled
    // copy would be a second Solid instance that cannot render into the host's tree.
    for (const name of HOST_PROVIDED) {
      expect(source).not.toMatch(new RegExp(`from\\s*["']${name}`));
      expect(source).not.toMatch(new RegExp(`require\\(["']${name}`));
    }
    expect(source).not.toMatch(/import\(["']@opencode\/plugin/);
  });

  it("does not make any host-provided package a runtime dependency", () => {
    for (const name of HOST_PROVIDED) {
      expect(pkg.dependencies?.[name]).toBeUndefined();
      if (pkg.peerDependencies?.[name]) expect(pkg.peerDependenciesMeta?.[name]?.optional).toBe(true);
    }
  });

  it("degrades to no status, not a failed load, when the host runtime is missing", async () => {
    // Outside opencode `@opentui/solid` does not resolve: setup must still resolve.
    const definition = namespace.default as { setup: (context: unknown) => Promise<unknown> };
    await expect(definition.setup({ ui: { slot: () => () => {} } })).resolves.toBeUndefined();
  });
});
