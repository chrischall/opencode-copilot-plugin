import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendPrivateFile,
  createPrivateAppender,
  ensurePrivateDir,
  isHomeOrAbove,
  writePrivateFile,
} from "./private-fs.js";

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

describe.runIf(posix)("never tightening the user's home or anything above it", () => {
  // M365_CONFIG_DIR=$HOME is a legitimate (if odd) choice. Writing debug.log there
  // must not chmod the user's home to 0700 and lock every other tool out of it.
  let home: string;
  const previousHome = process.env.HOME;

  beforeEach(() => {
    home = join(scratch(), "home");
    mkdirSync(home, { mode: 0o755 });
    chmodSync(home, 0o755);
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = previousHome;
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("leaves the home directory alone", () => {
    ensurePrivateDir(home);
    expect(mode(home)).toBe(0o755);
  });

  it("leaves an ancestor of the home directory alone", () => {
    const parent = dirname(home);
    chmodSync(parent, 0o755);
    ensurePrivateDir(parent);
    expect(mode(parent)).toBe(0o755);
  });

  it("sees through a symlink to the home directory", () => {
    const link = join(dirname(home), "link-to-home");
    symlinkSync(home, link);
    ensurePrivateDir(link);
    expect(mode(home)).toBe(0o755);
  });

  it("sees through a home directory that is itself a symlink", () => {
    const link = join(dirname(home), "home-link");
    symlinkSync(home, link);
    process.env.HOME = link;
    ensurePrivateDir(home);
    expect(mode(home)).toBe(0o755);
  });

  it("never treats the filesystem root as tightenable", () => {
    expect(isHomeOrAbove("/")).toBe(true);
  });

  it("still tightens a directory below the home directory", () => {
    const config = join(home, ".config", "opencode-copilot");
    mkdirSync(config, { recursive: true, mode: 0o755 });
    chmodSync(config, 0o755);
    ensurePrivateDir(config);
    expect(mode(config)).toBe(0o700);
    expect(isHomeOrAbove(config)).toBe(false);
  });

  it("writes debug.log with M365_CONFIG_DIR=$HOME without chmodding home", async () => {
    vi.stubEnv("M365_CONFIG_DIR", home);
    vi.resetModules();
    const fresh = await import("./private-fs.js");
    fresh.appendPrivateFile(join(home, "debug.log"), "line\n");
    expect(mode(home)).toBe(0o755);
    expect(mode(join(home, "debug.log"))).toBe(0o600);
  });
});

describe.runIf(posix)("a one-shot private appender", () => {
  // Every debug line lands here, per stream delta under M365_TRACE, on opencode's
  // event loop: the mkdir and chmods belong on the first write only.
  it("creates the file and its directory owner-only on the first write", () => {
    const file = join(scratch(), "logs", "debug.log");
    const append = createPrivateAppender(file);
    append("one\n");
    expect(mode(file)).toBe(0o600);
    expect(mode(dirname(file))).toBe(0o700);
  });

  it("does not re-chmod on later writes", () => {
    const file = join(scratch(), "debug.log");
    const append = createPrivateAppender(file);
    append("one\n");
    // A later write that still chmodded would pull this back to 0600.
    chmodSync(file, 0o644);
    append("two\n");
    expect(mode(file)).toBe(0o644);
    expect(readFileSync(file, "utf8")).toBe("one\ntwo\n");
  });

  it("redoes the setup once the file has disappeared", () => {
    const dir = join(scratch(), "logs");
    const file = join(dir, "debug.log");
    const append = createPrivateAppender(file);
    append("one\n");
    rmSync(dir, { recursive: true });
    append("two\n");
    expect(readFileSync(file, "utf8")).toBe("two\n");
    expect(mode(file)).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
  });
});
