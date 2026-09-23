/**
 * Owner-only filesystem writes for everything under the config directory.
 *
 * That directory holds the SSO browser profile, the MSAL cache, optional stored
 * credentials (password *and* TOTP seed) and a debug log that under `M365_TRACE`
 * contains the access token. None of it should be readable by other local users,
 * whatever the umask was when it was first created — so each helper also tightens
 * a file or directory that already exists with looser permissions.
 */

import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  mkdirSync,
  openSync,
  realpathSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, parse, resolve, sep } from "node:path";
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

/** The canonical path, following symlinks — or the plain resolved one if it does not exist. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Is `dir` the user's home directory, one of its ancestors, or the filesystem root?
 *
 * Those are shared with every other tool the user runs, so they are never ours to
 * chmod — even when `M365_CONFIG_DIR=$HOME` makes one of them our config directory.
 * Compared by real path, so a symlink on either side cannot slip past.
 */
export function isHomeOrAbove(dir: string): boolean {
  const target = canonical(dir);
  if (target === parse(target).root) return true;
  const home = canonical(homedir());
  return home === target || home.startsWith(target.endsWith(sep) ? target : `${target}${sep}`);
}

/**
 * Create `dir` (and parents) owner-only, and tighten `dir` itself if it already
 * existed — unless it is the home directory or above, which stays as it is.
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  if (!isHomeOrAbove(dir)) tighten(dir, DIR_MODE);
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

/**
 * An appender for a file written often, like the debug log.
 *
 * The first write goes through `appendPrivateFile` — directory created, both
 * tightened. Later writes only append, so a log line per stream delta does not pay
 * for a mkdir and two chmods each time on opencode's event loop. If the file has
 * disappeared since (a user clearing the log), the next write does the full setup
 * again rather than recreating it with whatever the umask allows.
 */
export function createPrivateAppender(file: string): (contents: string) => void {
  let ready = false;
  return (contents) => {
    if (ready) {
      let fd: number | undefined;
      try {
        // No O_CREAT: a vanished file fails here instead of being quietly recreated.
        fd = openSync(file, constants.O_WRONLY | constants.O_APPEND);
      } catch {
        ready = false;
      }
      if (fd !== undefined) {
        try {
          writeSync(fd, contents);
        } finally {
          closeSync(fd);
        }
        return;
      }
    }
    appendPrivateFile(file, contents);
    ready = true;
  };
}
