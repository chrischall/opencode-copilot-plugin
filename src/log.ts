import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG_DIR, LOG_FILE } from "./paths.js";

const DEBUG = process.env.M365_DEBUG === "1" || process.env.M365_TRACE === "1";
const TRACE = process.env.M365_TRACE === "1";
const TO_STDOUT = process.env.M365_LOG_STDOUT === "1";

let ready = false;

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
      if (!ready) {
        mkdirSync(dirname(LOG_FILE) || CONFIG_DIR, { recursive: true });
        ready = true;
      }
      appendFileSync(LOG_FILE, `${line}\n`);
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
