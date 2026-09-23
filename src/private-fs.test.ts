import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendPrivateFile, ensurePrivateDir, writePrivateFile } from "./private-fs.js";

const mode = (path: string) => statSync(path).mode & 0o777;
const scratch = () => mkdtempSync(join(tmpdir(), "m365-private-"));
const posix = process.platform !== "win32";

describe.runIf(posix)("owner-only files and directories", () => {
  // The config dir holds the SSO browser profile, the token cache, stored
  // credentials and a debug log that can contain an access token.
  it("creates a directory owner-only, whatever the umask", () => {
    const dir = join(scratch(), "a", "config");
    const previous = process.umask(0o022);
    try {
      ensurePrivateDir(dir);
    } finally {
      process.umask(previous);
    }
    expect(mode(dir)).toBe(0o700);
  });

  it("tightens a directory that already exists world-readable", () => {
    const dir = join(scratch(), "config");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    ensurePrivateDir(dir);
    expect(mode(dir)).toBe(0o700);
  });

  it("appends to a log owner-only, tightening one created earlier at 0644", () => {
    const file = join(scratch(), "debug.log");
    writeFileSync(file, "old\n", { mode: 0o644 });
    chmodSync(file, 0o644);
    appendPrivateFile(file, "new\n");
    expect(mode(file)).toBe(0o600);
  });

  it("creates a fresh log owner-only", () => {
    const file = join(scratch(), "nested", "debug.log");
    appendPrivateFile(file, "line\n");
    expect(mode(file)).toBe(0o600);
    expect(mode(join(file, ".."))).toBe(0o700);
  });

  it("leaves an existing parent it does not own alone", () => {
    // M365_CACHE_FILE=~/cache.json must not chmod the user's home directory.
    const dir = scratch();
    chmodSync(dir, 0o755);
    writePrivateFile(join(dir, "cache.json"), "{}");
    expect(mode(dir)).toBe(0o755);
  });

  it("writes a file owner-only, even over an existing looser one", () => {
    const file = join(scratch(), "agent-id.json");
    writeFileSync(file, "{}", { mode: 0o644 });
    chmodSync(file, 0o644);
    writePrivateFile(file, "{\"agentId\":\"x\"}");
    expect(mode(file)).toBe(0o600);
  });
});
