import { LOG_FILE } from "./paths.js";
import { createPrivateAppender } from "./private-fs.js";

const DEBUG = process.env.M365_DEBUG === "1" || process.env.M365_TRACE === "1";
const TRACE = process.env.M365_TRACE === "1";
const TO_STDOUT = process.env.M365_LOG_STDOUT === "1";

/**
 * One appender for every scope, since they all share the file. Owner-only (under
 * M365_TRACE this log carries the access token), with the mkdir and chmods paid on
 * the first line only — this runs per stream delta on opencode's event loop.
 */
const appendLog = createPrivateAppender(LOG_FILE);

/** Truncate a payload for the log unless full tracing is on. */
export function trunc(value: unknown, max = 400): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (TRACE || text == null) return String(text);
  return text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text;
}

export interface Logger {
  info(...parts: unknown[]): void;
  warn(...parts: unknown[]): void;
  error(...parts: unknown[]): void;
}

/**
 * A file logger, off unless `M365_DEBUG=1`.
 *
 * The plugin runs inside opencode's server process, so writing to stdout would
 * corrupt the TUI. Everything goes to a file unless explicitly asked otherwise.
 */
export function createLogger(scope: string): Logger {
  const write = (level: string, parts: unknown[]) => {
    if (!DEBUG) return;
    const line = `${new Date().toISOString()} [${level}] [${scope}] ${parts.map((p) => trunc(p)).join(" ")}`;
    if (TO_STDOUT) process.stdout.write(`${line}\n`);
    try {
      appendLog(`${line}\n`);
    } catch {
      /* logging must never take the caller down */
    }
  };

  return {
    info: (...parts) => write("info", parts),
    warn: (...parts) => write("warn", parts),
    error: (...parts) => write("error", parts),
  };
}
