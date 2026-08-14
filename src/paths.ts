import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where we keep auth state.
 *
 * Deliberately NOT `~/.config/opencode-m365/` — that belongs to the
 * m365-copilot-proxy project, and sharing it would mean two independent tools
 * writing the same MSAL cache and agent-id file.
 */
export const CONFIG_DIR = process.env.M365_CONFIG_DIR || join(homedir(), ".config", "opencode-copilot");

export const CACHE_FILE = process.env.M365_CACHE_FILE || join(CONFIG_DIR, "msal-cache.json");
export const SECRETS_FILE = process.env.M365_SECRETS_FILE || join(CONFIG_DIR, "secrets.json");
export const AGENT_FILE = process.env.M365_AGENT_FILE || join(CONFIG_DIR, "agent-id.json");
export const LOG_FILE = join(CONFIG_DIR, "debug.log");
