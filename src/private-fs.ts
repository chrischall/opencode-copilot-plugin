/**
 * Owner-only filesystem writes for everything under the config directory.
 *
 * That directory holds the SSO browser profile, the MSAL cache, optional stored
 * credentials (password *and* TOTP seed) and a debug log that under `M365_TRACE`
 * contains the access token. None of it should be readable by other local users,
 * whatever the umask was when it was first created — so each helper also tightens
 * a file or directory that already exists with looser permissions.
 */

import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CONFIG_DIR } from "./paths.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Best effort: Windows ignores POSIX modes, and a file we do not own cannot be changed. */
function tighten(path: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, mode);
  } catch {
    /* not ours to change; the caller still gets its write */
  }
}

/** Create `dir` (and parents) owner-only, and tighten `dir` itself if it already existed. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  tighten(dir, DIR_MODE);
}

/**
 * Make sure `file`'s directory exists. A directory we create is owner-only; an
 * existing one is tightened only when it is our config directory — a path
 * overridden to `~/cache.json` must not chmod the user's home.
 */
function preparePrivateParent(file: string): void {
  const dir = dirname(file);
  if (resolve(dir) === resolve(CONFIG_DIR)) ensurePrivateDir(dir);
  else mkdirSync(dir, { recursive: true, mode: DIR_MODE });
}

/** Write `file` owner-only, creating its directory owner-only too. */
export function writePrivateFile(file: string, contents: string): void {
  preparePrivateParent(file);
  writeFileSync(file, contents, { mode: FILE_MODE });
  tighten(file, FILE_MODE);
}

/** Append to `file` owner-only, creating its directory owner-only too. */
export function appendPrivateFile(file: string, contents: string): void {
  preparePrivateParent(file);
  appendFileSync(file, contents, { mode: FILE_MODE });
  tighten(file, FILE_MODE);
}
