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
import { readFileSync } from "node:fs";
import { BAP_SCOPE, POWERPLATFORM_SCOPE } from "./auth.js";
import { AGENT_FILE } from "./paths.js";
import { createLogger } from "./log.js";
import { writePrivateFile } from "./private-fs.js";

const log = createLogger("agent");

const BAP_ENVIRONMENT_URL =
  "https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments/~default?api-version=2023-06-01";
const COPILOT_STUDIO_API_VERSION = "2022-03-01-preview";

/** A plain 48×48 square: the portal always sends an icon, so we do too. */
const BOT_ICON_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAOklEQVR42u3OQQ0AAAgEoCtjMuNbwhbOBxsBSPW8EiEhISEhISEhISEhISEhISEhISEhISEhISGhOwsQ7wvEcqrbYwAAAABJRU5ErkJggg==";

const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";

function studioHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "x-ms-user-agent": "PVA-Portal/1.0.0 (Web; ReactNative: false)",
  };
}

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

/** The id M365 expects in `threadLevelGptId` / `gpts`. `titleId` arrives already `T_`-prefixed. */
export function buildAgentId(titleId: string, botId: string): string {
  return `${titleId}.${botId}.gpt.default`;
}

/**
 * The Power Platform host for this environment.
 *
 * The id is split across two DNS labels: all but its last two characters, then those
 * two. It looks like a fixed `.df.` on any tenant whose id happens to end in `df`.
 */
export function environmentHost(envId: string): string {
  return `default${envId.slice(0, -2)}.${envId.slice(-2)}.environment.api.powerplatform.com`;
}

export type DnsResolver = (host: string) => Promise<boolean>;

/** The environment's host, checked in DNS so a wrong one fails with a usable message. */
export async function resolveEnvironmentHost(
  envId: string,
  resolveDns: DnsResolver,
  override?: string,
): Promise<string> {
  if (override) return override;
  const host = environmentHost(envId);
  if (await resolveDns(host)) return host;
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
 * Order: local cache → the tenant's existing bot, else create → publish (which is also
 * the only way to learn an existing bot's title id).
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

  const botId = (await findBot(doFetch, host, token, wantedName)) ?? (await createBot(doFetch, host, token, wantedName));
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
  if (!response.ok) throw new AgentHttpError(await describeFailure("environment discovery", response), response.status);

  const body: any = await response.json();
  const name: string = body?.name ?? "";
  // `Default-<tenantGuid>`.
  const guid = name.replace(/^Default-/i, "");
  if (!guid) throw new Error(`Power Platform returned an unexpected environment name: ${JSON.stringify(name)}`);
  return guid.replace(/-/g, "");
}

/**
 * Find a bot by name.
 *
 * Name lookup is reliable because Copilot Studio reflects the display name we set
 * into `shortBotName` byte for byte — hyphens, length and case all survive. The list
 * carries no title id.
 */
async function findBot(
  doFetch: typeof globalThis.fetch,
  host: string,
  token: string,
  name: string,
): Promise<string | undefined> {
  const url = `https://${host}/copilotstudio/minimalBots/api?api-version=${COPILOT_STUDIO_API_VERSION}`;
  const response = await doFetch(url, { headers: studioHeaders(token) });
  if (!response.ok) throw new AgentHttpError(await describeFailure("listing agents", response), response.status);

  const bots: any = await response.json();
  if (!Array.isArray(bots)) throw new Error("Copilot Studio returned an unexpected agent list");
  return bots.find((bot) => bot?.shortBotName === name)?.botId;
}

/** The change set the Copilot Studio portal posts to create a GPT-template bot. */
function createBotBody(name: string): unknown {
  const noDiagnostics = { diagnostics: [] };
  return {
    botComponentChanges: [
      {
        $kind: "BotComponentInsert",
        component: {
          ...noDiagnostics,
          $kind: "GptComponent",
          id: EMPTY_GUID,
          displayName: name,
          description: "Tool-calling format instructions for an OpenAI-compatible bridge.",
          schemaName: `${EMPTY_GUID}.gpt.default`,
          metadata: {
            ...noDiagnostics,
            $kind: "GptComponentMetadata",
            tools: [],
            conversationStarters: [],
            instructions: {
              ...noDiagnostics,
              $kind: "TemplateLine",
              segments: [{ ...noDiagnostics, $kind: "TextSegment", value: agentInstructions() }],
            },
            knowledgeSources: { ...noDiagnostics, $kind: "SearchAllKnowledgeSources" },
            gptCapabilities: {
              ...noDiagnostics,
              $kind: "GptCapabilities",
              codeInterpreter: false,
              generateImages: false,
              webBrowsing: false,
              searchOneDriveAndSharePoint: false,
              searchTeams: false,
              searchMeetings: false,
              searchEmails: false,
              searchPeople: false,
            },
            aISettings: { ...noDiagnostics, $kind: "AISettings", useModelKnowledge: true },
          },
        },
      },
    ],
    cloudFlowDefinitionChanges: [],
    connectorDefinitionChanges: [],
    environmentVariableChanges: [],
    connectionReferenceChanges: [],
    aIPluginOperationChanges: [],
    componentCollectionChanges: [],
    dataverseTableSearchChanges: [],
    dataverseTableSearchEntityConfigurationChanges: [],
    dataverseTableSearchGlossaryConfigurationChanges: [],
    dataverseTableSearchEntityColumnSynonymChanges: [],
    aIModelChanges: [],
    connectedAgentDefinitionChanges: [],
    bot: {
      $kind: "BotEntity",
      authorizedSecurityGroupIds: [],
      supportedLanguages: [],
      diagnostics: [],
      displayName: name,
      language: 1033,
      schemaName: EMPTY_GUID,
      template: "gpt-1.1.0",
      iconBase64: BOT_ICON_BASE64,
    },
  };
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
    headers: studioHeaders(token),
    body: JSON.stringify(createBotBody(name)),
  });
  if (!response.ok) throw new AgentHttpError(await describeFailure("creating the agent", response), response.status);

  const body: any = await response.json();
  const botId = body?.bot?.schemaName ?? body?.bot?.cdsBotId;
  if (!botId) throw new Error("Copilot Studio created an agent but returned no bot id");
  return botId;
}

async function publishBot(
  doFetch: typeof globalThis.fetch,
  host: string,
  token: string,
  botId: string,
): Promise<string> {
  const url = `https://${host}/copilotstudio/minimalBots/api/${encodeURIComponent(botId)}/publish?api-version=${COPILOT_STUDIO_API_VERSION}`;
  const response = await doFetch(url, { method: "POST", headers: studioHeaders(token) });
  if (!response.ok) throw new AgentHttpError(await describeFailure("publishing the agent", response), response.status);

  const body: any = await response.json();
  const titleId = body?.TitleId;
  if (!titleId) throw new Error("Copilot Studio published the agent but returned no title id");
  return titleId;
}

/** A Copilot Studio / Power Platform call answered with a non-2xx status. */
export class AgentHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AgentHttpError";
  }
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
    writePrivateFile(file, `${JSON.stringify(cache, null, 2)}\n`);
  } catch (error) {
    // A cache miss costs one extra round trip, not correctness.
    log.warn("could not write the agent cache", String(error));
  }
}
