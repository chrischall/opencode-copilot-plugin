import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import tsdownConfig from "../tsdown.config.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("packaging", () => {
  // Whatever tsdown inlines is what actually ships, and npm audit on a consumer
  // cannot see a bundled copy — a fix has to come from a release of this package.
  // Dependabot prefixes development bumps `chore`, which release-please never
  // releases, so a bundled package listed as a devDependency gets its security
  // fixes merged and never published (b14e1df did exactly that to zod).
  const bundled = ((tsdownConfig as { noExternal?: unknown[] }).noExternal ?? []).filter(
    (entry): entry is string => typeof entry === "string",
  );

  it("bundles the runtime packages it relies on", () => {
    expect(bundled).toEqual(expect.arrayContaining(["zod", "ws", "otpauth", "@azure/msal-node"]));
  });

  it.each(["zod", "ws", "otpauth", "@azure/msal-node"])("declares bundled %s as a runtime dependency, so its bumps release", (name) => {
    expect(bundled).toContain(name);
    expect(pkg.dependencies?.[name]).toBeTruthy();
    expect(pkg.devDependencies?.[name]).toBeUndefined();
  });
});
