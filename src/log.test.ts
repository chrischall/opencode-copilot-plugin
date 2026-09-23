import { chmodSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mode = (path: string) => statSync(path).mode & 0o777;

describe.runIf(process.platform !== "win32")("the debug log", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // The logger reads its switches and paths at import, so each test imports it fresh.
  async function freshLogger(dir: string) {
    vi.stubEnv("M365_DEBUG", "1");
    vi.stubEnv("M365_LOG_STDOUT", "");
    vi.stubEnv("M365_CONFIG_DIR", dir);
    vi.resetModules();
    const { createLogger } = await import("./log.js");
    return createLogger("test");
  }

  it("creates the log owner-only and sets it up only on the first line", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "m365-log-")), "config");
    const log = await freshLogger(dir);
    log.info("first");
    const file = join(dir, "debug.log");
    expect(mode(file)).toBe(0o600);
    expect(mode(dir)).toBe(0o700);

    // Every later line is a plain append: a chmod per line would pull these back.
    chmodSync(file, 0o644);
    chmodSync(dir, 0o755);
    log.warn("second");
    expect(mode(file)).toBe(0o644);
    expect(mode(dir)).toBe(0o755);
    expect(readFileSync(file, "utf8")).toMatch(/\[info\] \[test\] first\n.*\[warn\] \[test\] second\n$/);
  });
});
