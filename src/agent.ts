/**
 * The Copilot Studio declarative agent.
 *
 * This is the lever that makes tool calling work at all. Microsoft's server-side
 * BizChat prompt sits above ours and defines the model as a retrieval chat assistant,
 * so per-request instructions to "emit a tool call" get answered in prose or
 * meta-analysed away. Instructions delivered through a declarative agent land in the
 * *server-side* system prompt instead, and the model obeys them.
 *
 * Two design constraints shape everything here:
 *
 * 1. **Instructions are baked in at creation** — the update API needs a change token
 *    only returned by create. So the agent is versioned by *name*: a short hash of
 *    the instructions. Change the instructions and the next request provisions a new
 *    agent.
 * 2. **Nothing is ever deleted.** Another host on the same tenant may be mid
 *    conversation with an agent we consider stale, and pulling it out from under them
 *    produces an instant empty reply that looks exactly like rate limiting. A few
 *    orphaned lightweight bots are the cheaper problem.
 *
 * Hosts sharing a tenant derive the same name from the same instructions, so they
 * converge on one agent with no coordination.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BAP_SCOPE, POWERPLATFORM_SCOPE } from "./auth.js";
import { AGENT_FILE } from "./paths.js";
import { createLogger } from "./log.js";

const log = createLogger("agent");

const BAP_ENVIRONMENT_URL =
  "https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments/~default?api-version=2023-06-01";
const COPILOT_STUDIO_API_VERSION = "2022-03-01-preview";

/**
 * The agent's server-side instructions.
 *
 * Kept short and purely about *format*. Heavy behavioural framing here backfired
 * badly in the reference project's measurements — it suppressed tool calls to zero.
 * Behaviour (first-move framing, anti-confabulation) lives in the per-request
 * `<tools>` block, where changing it does not cost a re-provision.
 */
export function agentInstructions(): string {
  return [
    "You help with software tasks in a real workspace.",
    "",
    "When a request lists tools, act by writing a fenced code block whose info string is the tool name.",
    "Argument lines of the form `name: value` come first, and any free-form content is the body of the block.",
    "An edit is written as a SEARCH/REPLACE diff inside the block.",
    "",
    "A fenced block of that shape is executed for you, and its result comes back before you continue.",
    "Write one block at a time and wait for the result before deciding the next step.",
  ].join("\n");
}

/** `m365-tool-agent-<8 hex>` — the same instructions always yield the same name. */
export function agentNameFor(instructions: string): string {
  const hash = createHash("sha256").update(instructions).digest("hex").slice(0, 8);
  return `m365-tool-agent-${hash}`;
}

/** The id M365 expects in `threadLevelGptId` / `gpts`. */
export function buildAgentId(titleId: string, botId: string): string {
  return `T_${titleId}.${botId}.gpt.default`;
}

/**
 * Power Platform hosts to try for this environment.
 *
 * The obvious full-length label frequently does not resolve; the host that works has
 * the last two characters trimmed. Rather than pick one, probe both.
 */
export function environmentHostCandidates(envId: string): string[] {
  const suffix = "df.environment.api.powerplatform.com";
  return [
    `default${envId}.${suffix}`,
    `default${envId.slice(0, -1)}.${suffix}`,
    `default${envId.slice(0, -2)}.${suffix}`,
  ];
}

export type DnsResolver = (host: string) => Promise<boolean>;

/** First candidate host that actually resolves. */
export async function resolveEnvironmentHost(
  envId: string,
  resolveDns: DnsResolver,
  override?: string,
): Promise<string> {
  if (override) return override;
  for (const candidate of environmentHostCandidates(envId)) {
    if (await resolveDns(candidate)) return candidate;
  }
  throw new Error(
    `Could not resolve a Power Platform host for environment ${envId}. Set M365_POWERPLATFORM_HOST to override.`,
  );
}

/** Default resolver: a DNS lookup, treating any failure as "does not resolve". */
export const dnsResolver: DnsResolver = async (host) => {
  try {
    const { lookup } = await import("node:dns/promises");
    await lookup(host);
    return true;
  } catch {
    return false;
  }
};

export interface AgentDeps {
  getTokenForScope: (scopes: string[]) => Promise<string>;
  fetch?: typeof globalThis.fetch;
  resolveDns?: DnsResolver;
  cacheFile?: string;
  /** Skip DNS probing (M365_POWERPLATFORM_HOST). */
  hostOverride?: string;
}

interface AgentCache {
  agentId: string;
  /** The agent *name*, which encodes the instructions hash. */
  instructionsHash: string;
}

/**
 * Resolve the declarative agent id, provisioning one if the tenant has none.
 *
 * Order: local cache → the tenant's existing bots → create + publish.
 */
export async function getOrCreateAgent(deps: AgentDeps): Promise<string> {
  const cacheFile = deps.cacheFile ?? AGENT_FILE;
  const wantedName = agentNameFor(agentInstructions());

  const cached = readCache(cacheFile);
  if (cached?.instructionsHash === wantedName && cached.agentId) {
    log.info("using cached agent", cached.agentId);
    return cached.agentId;
  }

  const doFetch = deps.fetch ?? globalThis.fetch;
  const resolveDns = deps.resolveDns ?? dnsResolver;

  const envId = await discoverEnvironmentId(doFetch, deps.getTokenForScope);
  const host = await resolveEnvironmentHost(
    envId,
    resolveDns,
    deps.hostOverride ?? process.env.M365_POWERPLATFORM_HOST,
  );
  const token = await deps.getTokenForScope([POWERPLATFORM_SCOPE]);

  const existing = await findBot(doFetch, host, token, wantedName);
  if (existing) {
    const agentId = buildAgentId(existing.titleId, existing.botId);
    writeCache(cacheFile, { agentId, instructionsHash: wantedName });
    log.info("reusing existing agent", agentId);
    return agentId;
  }

  const botId = await createBot(doFetch, host, token, wantedName);
  const titleId = await publishBot(doFetch, host, token, botId);
  const agentId = buildAgentId(titleId, botId);
  writeCache(cacheFile, { agentId, instructionsHash: wantedName });
  log.info("provisioned agent", agentId);
  return agentId;
}

/** The environment id: the tenant GUID from BAP, dashes stripped. */
async function discoverEnvironmentId(
  doFetch: typeof globalThis.fetch,
  getTokenForScope: (scopes: string[]) => Promise<string>,
): Promise<string> {
  const token = await getTokenForScope([BAP_SCOPE]);
  const response = await doFetch(BAP_ENVIRONMENT_URL, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(await describeFailure("environment discovery", response));

  const body: any = await response.json();
  const name: string = body?.name ?? "";
  // `Default-<tenantGuid>`.
  const guid = name.replace(/^Default-/i, "");
  if (!guid) throw new Error(`Power Platform returned an unexpected environment name: ${JSON.stringify(name)}`);
  return guid.replace(/-/g, "");
}

interface BotRef {
  botId: string;
  titleId: string;
}

/**
 * Find a bot by name.
 *
 * Name lookup is reliable because Copilot Studio reflects the display name we set
 * into `shortBotName` byte for byte — hyphens, length and case all survive.
 */
async function findBot(
  doFetch: typeof globalThis.fetch,
  host: string,
  token: string,
  name: string,
): Promise<BotRef | undefined> {
  const url = `https://${host}/copilotstudio/minimalBots/api/botlist?api-version=${COPILOT_STUDIO_API_VERSION}`;
  const response = await doFetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(await describeFailure("listing agents", response));

  const body: any = await response.json();
  const bots: any[] = body?.value ?? body?.bots ?? [];
  const match = bots.find((bot) => bot?.shortBotName === name || bot?.displayName === name);
  if (!match) return undefined;
  if (!match.titleId || !match.botId) return undefined;
  return { botId: match.botId, titleId: match.titleId };
}

async function createBot(
  doFetch: typeof globalThis.fetch,
  host: string,
  token: string,
  name: string,
): Promise<string> {
  const url = `https://${host}/copilotstudio/minimalBots/api?api-version=${COPILOT_STUDIO_API_VERSION}`;
  const response = await doFetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      displayName: name,
      description: "Tool-calling format instructions for an OpenAI-compatible bridge.",
      gptComponent: {
        instructions: agentInstructions(),
        conversationStarters: [],
        aISettings: { useModelKnowledge: true },
      },
    }),
  });
  if (!response.ok) throw new Error(await describeFailure("creating the agent", response));

  const body: any = await response.json();
  const botId = body?.botId ?? body?.id;
  if (!botId) throw new Error("Copilot Studio created an agent but returned no bot id");
  return botId;
}

async function publishBot(
  doFetch: typeof globalThis.fetch,
  host: string,
  token: string,
  botId: string,
): Promise<string> {
  const url = `https://${host}/copilotstudio/minimalBots/api/publish?api-version=${COPILOT_STUDIO_API_VERSION}&botId=${encodeURIComponent(botId)}`;
  const response = await doFetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ botId }),
  });
  if (!response.ok) throw new Error(await describeFailure("publishing the agent", response));

  const body: any = await response.json();
  const titleId = body?.titleId ?? body?.TitleId;
  if (!titleId) throw new Error("Copilot Studio published the agent but returned no title id");
  return titleId;
}

async function describeFailure(what: string, response: { status: number; text?: () => Promise<string> }): Promise<string> {
  let detail = "";
  try {
    detail = (await response.text?.()) ?? "";
  } catch {
    /* body may not be readable */
  }
  const hint =
    response.status === 401 || response.status === 403
      ? " — this usually means the account lacks Copilot Studio / Power Platform access"
      : "";
  return `M365 rejected ${what} (HTTP ${response.status})${hint}${detail ? `: ${detail.slice(0, 300)}` : ""}`;
}

function readCache(file: string): AgentCache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed.agentId === "string") return parsed as AgentCache;
  } catch {
    /* absent or corrupt: re-resolve */
  }
  return undefined;
}

function writeCache(file: string, cache: AgentCache): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`);
  } catch (error) {
    // A cache miss costs one extra round trip, not correctness.
    log.warn("could not write the agent cache", String(error));
  }
}
