#!/usr/bin/env node
/**
 * `opencode-m365` — sign in, wire up opencode, and check the plumbing.
 *
 * The plugin can do everything except sign in, because signing in means opening a
 * browser and a plugin running under a TUI must not do that. This is where that
 * happens, plus the one-time config write.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTokenClient } from "./auth.js";
import { getOrCreateAgent } from "./agent.js";
import { PROVIDER_ID, mergeOpencodeConfig } from "./config.js";
import { DEFAULT_MODEL, LOCAL_TITLE_MODEL } from "./models.js";
import { startServer } from "./server.js";
import { AGENT_FILE, CACHE_FILE, CONFIG_DIR, SECRETS_FILE } from "./paths.js";

const OPENCODE_CONFIG = join(homedir(), ".config", "opencode", "opencode.json");

async function main(): Promise<void> {
  const [command = "help", ...rest] = process.argv.slice(2);

  switch (command) {
    case "login":
      return doLogin(rest);
    case "setup":
      return doSetup(rest);
    case "serve":
      return doServe(rest);
    case "doctor":
      return doDoctor();
    case "help":
    case "--help":
    case "-h":
      return printHelp();
    default:
      console.error(`Unknown command: ${command}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

function printHelp(): void {
  console.log(`opencode-m365 — use Microsoft 365 Copilot as opencode's model backend

  login [--interactive]   Sign in to Microsoft 365 and store the token cache
  setup [--local]         Add the plugin to ~/.config/opencode/opencode.json
  serve [--port <n>]      Run the OpenAI-compatible proxy standalone
  doctor                  Check auth, the agent, and the proxy

Config lives in ${CONFIG_DIR}

Sign-in needs either a TOTP seed in secrets.json (headless), or --interactive
to complete SSO/MFA by hand once — the only option on tenants with push-only
MFA, FIDO2, or a federated IdP.`);
}

async function doLogin(args: string[]): Promise<void> {
  // Imported here so the heavy browser dependency never loads for other commands.
  const { login } = await import("./login.js");
  const interactive = args.includes("--interactive");

  try {
    const account = await login({ interactive, onStatus: (message) => console.log(`  ${message}`) });
    console.log(`\nSigned in as ${account}.`);
    console.log(`Token cache written to ${CACHE_FILE}`);
    console.log("\nNext: opencode-m365 setup");
  } catch (error) {
    console.error(`\nSign-in failed: ${(error as Error).message}`);
    if (!interactive) {
      console.error("\nIf your tenant has no TOTP option (push-only MFA, FIDO2, Okta/Ping/Duo),");
      console.error("try: opencode-m365 login --interactive");
    }
    process.exitCode = 1;
  }
}

async function doSetup(args: string[]): Promise<void> {
  // A local checkout is referenced by its built entrypoint; an npm install by name.
  const local = args.includes("--local");
  const pluginRef = local ? resolve(dirname(fileURLToPath(import.meta.url)), "plugin.mjs") : "opencode-m365-copilot";

  if (local && !existsSync(pluginRef)) {
    console.error(`No build at ${pluginRef}. Run \`pnpm build\` first.`);
    process.exitCode = 1;
    return;
  }

  let existing: Record<string, any> = {};
  if (existsSync(OPENCODE_CONFIG)) {
    try {
      existing = JSON.parse(readFileSync(OPENCODE_CONFIG, "utf8"));
    } catch (error) {
      console.error(`${OPENCODE_CONFIG} is not valid JSON — fix or move it first.\n  ${String(error)}`);
      process.exitCode = 1;
      return;
    }
  }

  const merged = mergeOpencodeConfig(existing, { pluginRef });
  mkdirSync(dirname(OPENCODE_CONFIG), { recursive: true });
  writeFileSync(OPENCODE_CONFIG, `${JSON.stringify(merged, null, 2)}\n`);

  console.log(`Added ${pluginRef} to ${OPENCODE_CONFIG}`);
  console.log(`\nThe plugin registers the provider itself on startup, so there is nothing`);
  console.log(`else to configure. Models appear as ${PROVIDER_ID}/<model>, defaulting to`);
  console.log(`${PROVIDER_ID}/${DEFAULT_MODEL}.`);
  console.log(`\nNote: it also trims opencode's toolset when an ${PROVIDER_ID} model is`);
  console.log(`selected. M365 refuses to engage with a full coding-agent toolset — see the`);
  console.log(`README. Pass { "lean": false } in the plugin options to opt out.`);
  console.log(`\nCheck it with: opencode models | grep ${PROVIDER_ID}`);
}

async function doServe(args: string[]): Promise<void> {
  const portIndex = args.indexOf("--port");
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 4141;
  const tokens = createTokenClient();

  const proxy = await startServer({
    getToken: () => tokens.getToken(),
    resolveAgent: () => getOrCreateAgent({ getTokenForScope: (scopes) => tokens.getTokenForScope(scopes) }),
    port,
  });

  console.log(`M365 Copilot proxy listening on ${proxy.url}`);
  console.log(`  models:      ${proxy.url}/v1/models`);
  console.log(`  completions: ${proxy.url}/v1/chat/completions`);
  console.log("\nUnauthenticated and loopback-only. Ctrl+C to stop.");

  process.on("SIGINT", () => {
    void proxy.close().then(() => process.exit(0));
  });
}

async function doDoctor(): Promise<void> {
  let failures = 0;
  const check = (label: string, ok: boolean, detail = "") => {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures += 1;
  };

  console.log("Config");
  check("config directory", existsSync(CONFIG_DIR), CONFIG_DIR);
  check("token cache", existsSync(CACHE_FILE), existsSync(CACHE_FILE) ? CACHE_FILE : "run `opencode-m365 login`");
  console.log(`  ..    stored credentials — ${existsSync(SECRETS_FILE) ? "present" : "absent (interactive login only)"}`);

  console.log("\nAuthentication");
  const tokens = createTokenClient();
  let signedIn = false;
  try {
    const token = await tokens.getToken();
    signedIn = true;
    check("chat token", true, `${token.length} chars`);
  } catch (error) {
    check("chat token", false, (error as Error).message);
  }

  console.log("\nDeclarative agent");
  if (!signedIn) {
    console.log("  skip  needs a signed-in account");
  } else {
    try {
      const agentId = await getOrCreateAgent({ getTokenForScope: (scopes) => tokens.getTokenForScope(scopes) });
      check("agent", true, agentId);
    } catch (error) {
      // Not fatal: without it tool calling is less reliable, but chat still works.
      console.log(`  warn  agent unavailable — ${(error as Error).message}`);
      console.log("        Tool calling will be markedly less reliable without it.");
    }
  }
  console.log(`  ..    cache — ${existsSync(AGENT_FILE) ? AGENT_FILE : "not yet provisioned"}`);

  console.log("\nProxy");
  try {
    const proxy = await startServer({ getToken: () => tokens.getToken(), port: 0 });
    const response = await fetch(`${proxy.url}/health`);
    check("starts and serves /health", response.ok, proxy.url);
    const models: any = await (await fetch(`${proxy.url}/v1/models`)).json();
    check("advertises models", models.data?.length > 0, `${models.data?.length ?? 0} models`);
    check("local titler present", models.data?.some((m: any) => m.id === LOCAL_TITLE_MODEL));
    await proxy.close();
  } catch (error) {
    check("starts", false, (error as Error).message);
  }

  console.log("\nopencode");
  const configured = existsSync(OPENCODE_CONFIG) && readFileSync(OPENCODE_CONFIG, "utf8").includes("m365");
  check("plugin registered", configured, configured ? OPENCODE_CONFIG : "run `opencode-m365 setup`");

  process.exitCode = failures > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
