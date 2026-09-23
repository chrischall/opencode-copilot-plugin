/**
 * The OpenAI-compatible HTTP surface.
 *
 * Small on purpose: `node:http` rather than a framework, because this runs inside
 * opencode's own process and every dependency here is one opencode has to install.
 * It binds loopback only, and loopback is not a trust boundary: every browser tab on
 * the machine can reach it too. So every request must also carry a per-launch secret
 * (`Authorization: Bearer <apiKey>`), must name a loopback `Host` (DNS rebinding), and
 * must not come from a browser `Origin` the caller did not allow. No CORS headers are
 * ever sent — opencode is a server-side client and needs none.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AuthRequiredError } from "./auth.js";
import type { ToolDef } from "./fenced.js";
import { DEFAULT_MODEL, isLocalModel, listModelIds, resolveModel } from "./models.js";
import { describeToolSelection, selectLeanTools } from "./config.js";
import { CopilotSession, DisengagedError } from "./session.js";
import {
  ChatCompletionRequest,
  ConversationPool,
  buildCompletion,
  buildTurnPrompt,
  buildUsage,
  generateTitle,
  streamChunk,
  streamDone,
  toOpenAiToolCall,
  type ChatRequest,
  type ConversationState,
} from "./translate.js";
import { parseToolCalls } from "./fenced.js";
import { createLogger } from "./log.js";

const log = createLogger("server");

/** See the warning in `handleChatCompletion`; this keeps it to once per process. */
let warnedAboutToolSelection = false;

/**
 * Header a harness uses to declare what an auxiliary request is *for*.
 *
 * Node lowercases incoming header names, so this must stay lowercase to match.
 *
 * Only `title` is acted on. Compaction and generation are real model work and belong
 * on the real model; titling is the one auxiliary request that would open a second
 * M365 conversation per session, which is precisely the throttle signature.
 */
export const AUX_REQUEST_KIND_HEADER = "x-m365-request-kind";

/**
 * Header a harness uses to name the session a request belongs to, so two sessions
 * that happen to open with the same message never share an M365 conversation.
 * Lowercase for the same reason as {@link AUX_REQUEST_KIND_HEADER}.
 */
export const SESSION_ID_HEADER = "x-m365-session-id";

export interface ServerDeps {
  /** Supplies a Sydney chat token. */
  getToken: () => Promise<string>;
  /**
   * Resolves the declarative agent id, or null to go without one.
   *
   * Called lazily and only once — provisioning is slow, and only tool requests need it.
   */
  resolveAgent?: () => Promise<string | null>;
  /** Override the M365 origin. Tests point this at a stub. */
  endpoint?: string;
  /** Keep every tool call the model emits rather than only the first. */
  allowMultiTool?: boolean;
  /**
   * Trim the harness's toolset before the model sees it.
   *
   * The enforcement point for lean mode — opencode's own `tools` config does not
   * filter the outgoing request. See `selectLeanTools`.
   */
  lean?: boolean;
  /**
   * Replace the harness's prose system prompt with this leaner one.
   *
   * Done here rather than in the plugin because opencode's own system-prompt hook
   * does not affect the outgoing request — see `condenseSystemPrompt`.
   */
  leanSystemPrompt?: string;
  port?: number;
  /** Loopback only: `127.0.0.1` (the default), `::1` or `localhost`. Anything else throws. */
  host?: string;
  /**
   * The bearer secret every request must carry. Omit it and a fresh 32-byte random
   * one is generated per launch, which is what the in-process plugin wants: it hands
   * the key straight to opencode's provider config and nobody else ever sees it.
   */
  apiKey?: string;
  /**
   * @deprecated Ignored, with a warning. Every request carrying an `Origin` is refused:
   * opencode sends none, so one means a web page — and no allowlist could have made
   * the proxy usable from a page anyway, since the bearer header forces a CORS
   * preflight and preflights are always refused. Kept only so an old caller that
   * still passes it keeps starting.
   */
  allowedOrigins?: readonly string[];
  /** Largest request body accepted, in bytes. */
  maxBodyBytes?: number;
}

export interface ProxyHandle {
  url: string;
  port: number;
  /** The bearer secret a client must send. */
  apiKey: string;
  close(): Promise<void>;
}

/** Generous: a long agent history is a few MB of JSON; this only stops abuse. */
export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** A fresh per-launch secret: 32 random bytes, base64url. */
export function generateApiKey(): string {
  return randomBytes(32).toString("base64url");
}

interface Conversation extends ConversationState {
  session?: CopilotSession;
  /** Tail of this conversation's turn queue: one M365 session runs one turn at a time. */
  turn?: Promise<void>;
}

export async function startServer(deps: ServerDeps): Promise<ProxyHandle> {
  const pool = new ConversationPool();
  const host = deps.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`Refusing to bind ${host}: the proxy only listens on loopback (127.0.0.1, ::1, localhost)`);
  }
  const apiKey = deps.apiKey || generateApiKey();
  if (deps.allowedOrigins !== undefined) {
    process.emitWarning(
      "startServer's allowedOrigins option is ignored: the proxy refuses every request carrying an Origin, since browsers cannot use it.",
      { type: "DeprecationWarning", code: "M365_ALLOWED_ORIGINS" },
    );
  }
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  // Resolved once, then reused: provisioning an agent is slow and only the first
  // tool request should pay for it.
  let agentPromise: Promise<string | null> | undefined;
  const agentId = async (): Promise<string | null> => {
    if (!deps.resolveAgent) return null;
    agentPromise ??= deps.resolveAgent().catch((error) => {
      // Without Copilot Studio access we still work, just less reliably: the model
      // gets the fenced contract per-request instead of server-side.
      log.warn("could not resolve a declarative agent; continuing without one", String(error));
      return null;
    });
    return agentPromise;
  };

  const portOf = () => (server.address() as AddressInfo).port;
  const server = createServer((request, response) => {
    handle(request, response, { deps, pool, agentId, apiKey, maxBodyBytes, port: portOf() }).catch((error) => {
      log.error("unhandled request failure", String(error));
      sendError(response, 500, "internal_error", String(error));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.port ?? 0, host, resolve);
  });

  const { port } = server.address() as AddressInfo;
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return {
    url: `http://${urlHost}:${port}`,
    port,
    apiKey,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

interface Context {
  deps: ServerDeps;
  pool: ConversationPool;
  agentId: () => Promise<string | null>;
  apiKey: string;
  maxBodyBytes: number;
  port: number;
}

class PayloadTooLargeError extends Error {}

/**
 * Is `Host` one of the names this listener is actually reachable by?
 *
 * A DNS-rebound page talks to 127.0.0.1 while its `Host` still names the attacker's
 * domain, so anything but a loopback name on our own port is refused.
 */
function isLoopbackHost(header: string | undefined, port: number): boolean {
  if (!header) return false;
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(header.trim().toLowerCase());
  if (!match) return false;
  const name = match[1]!.replace(/^\[|\]$/g, "");
  return LOOPBACK_HOSTS.has(name) && Number(match[2] ?? 80) === port;
}

/** Constant-time check of `Authorization: Bearer <key>`. */
function hasApiKey(header: string | undefined, apiKey: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match) return false;
  const given = Buffer.from(match[1]!.trim());
  const expected = Buffer.from(apiKey);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function handle(request: IncomingMessage, response: ServerResponse, context: Context): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const method = (request.method ?? "GET").toUpperCase();

  // Order matters: the browser-shaped refusals come first, so a web page learns
  // nothing — not even whether it guessed the secret.
  if (!isLoopbackHost(request.headers.host, context.port)) {
    sendError(response, 403, "forbidden", "Host must be a loopback address");
    return;
  }

  // opencode sends no Origin; a request carrying one came from a web page.
  if (request.headers.origin !== undefined) {
    sendError(response, 403, "forbidden", "Browser origins may not use this proxy");
    return;
  }

  // Never grant a preflight: opencode does not send one, and a page that needs one
  // is exactly what this proxy must not serve.
  if (method === "OPTIONS") {
    sendError(response, 403, "forbidden", "CORS is not supported");
    return;
  }

  // Liveness only — carries nothing worth protecting, and lets a script check the
  // port without the secret.
  if (method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (!hasApiKey(request.headers.authorization, context.apiKey)) {
    sendError(
      response,
      401,
      "invalid_api_key",
      "Missing or wrong proxy secret. Send `Authorization: Bearer <key>` with the key the proxy printed or was given (M365_PROXY_KEY).",
    );
    return;
  }

  if (method === "GET" && url.pathname === "/v1/models") {
    sendJson(response, 200, {
      object: "list",
      data: listModelIds().map((id) => ({
        id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "microsoft",
      })),
    });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/chat/completions") {
    await handleChatCompletion(request, response, context);
    return;
  }

  sendError(response, 404, "not_found", `No route for ${method} ${url.pathname}`);
}

async function handleChatCompletion(
  request: IncomingMessage,
  response: ServerResponse,
  context: Context,
): Promise<void> {
  let body: ChatRequest;
  try {
    body = ChatCompletionRequest.parse(JSON.parse(await readBody(request, context.maxBodyBytes)));
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      sendError(response, 413, "request_too_large", error.message);
      request.resume();
      return;
    }
    sendError(response, 400, "invalid_request_error", String((error as Error)?.message ?? error));
    return;
  }

  const model = resolveModel(body.model);
  const requested = (body.tools ?? []) as ToolDef[];
  const tools = context.deps.lean === false ? requested : selectLeanTools(requested);
  if (tools.length !== requested.length) {
    log.info(`trimmed toolset ${requested.length} -> ${tools.length}`, tools.map((t) => t.function.name).join(","));
    // Reached only when the trim actually removed something, which cannot happen
    // with lean off. Warn once per process rather than per turn: a drifted
    // allowlist is a standing condition, not a per-request event.
    const concern = describeToolSelection(requested);
    if (concern && !warnedAboutToolSelection) {
      warnedAboutToolSelection = true;
      log.warn(concern);
    }
  }

  // The titler never touches M365 — see models.ts for why that matters. A harness
  // that cannot select the titler by id says so on the header instead; opencode 2
  // dropped `small_model`, and its title hook cannot change the model.
  if (isLocalModel(model.id) || request.headers[AUX_REQUEST_KIND_HEADER] === "title") {
    respondWithTitle(response, body, model.id);
    return;
  }

  const sessionHeader = request.headers[SESSION_ID_HEADER];
  const sessionId = typeof sessionHeader === "string" && sessionHeader !== "" ? sessionHeader : undefined;
  const conversation = context.pool.resolve(body.messages, sessionId ? { sessionId } : {}) as Conversation;

  // Serialise turns per conversation: two overlapping requests on one CopilotSession
  // would race its turn index and our sent-message count.
  const previous = conversation.turn ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => (release = resolve));
  conversation.turn = previous.then(() => current);
  await previous;
  try {
    await runTurn(request, response, context, body, conversation, model, tools);
  } finally {
    release();
  }
}

async function runTurn(
  request: IncomingMessage,
  response: ServerResponse,
  context: Context,
  body: ChatRequest,
  conversation: Conversation,
  model: ReturnType<typeof resolveModel>,
  tools: ToolDef[],
): Promise<void> {
  // The pool's restart check ran before we queued; re-run it now that the previous
  // turn has recorded what it sent.
  if (body.messages.length < conversation.sentMessageCount) conversation.sentMessageCount = 0;
  conversation.session ??= new CopilotSession({
    getToken: context.deps.getToken,
    ...(context.deps.endpoint ? { endpoint: context.deps.endpoint } : {}),
  });

  const prompt = buildTurnPrompt(body.messages, tools, conversation.sentMessageCount, {
    ...(context.deps.leanSystemPrompt !== undefined ? { leanSystemPrompt: context.deps.leanSystemPrompt } : {}),
  });

  // The agent overrides the tone and forces GPT, so attach it only when the turn
  // actually needs tool instructions. Plain chat then reaches the tone's real model.
  const agent = tools.length > 0 ? await context.agentId() : null;

  const abort = new AbortController();
  request.on("close", () => {
    if (!response.writableEnded) abort.abort();
  });

  const streaming = body.stream === true;
  const streamId = `chatcmpl-${randomUUID()}`;
  // Only a tool-less turn can stream: a fenced tool call is not parseable until the
  // fence closes, so a tool turn has to be buffered and emitted at the end.
  const canStreamText = streaming && tools.length === 0;

  if (streaming) startSse(response);

  try {
    const result = await conversation.session.run(prompt, {
      ...(model.tone ? { tone: model.tone } : {}),
      agentId: agent,
      signal: abort.signal,
      ...(canStreamText
        ? { onDelta: (chunk: string) => response.write(streamChunk(streamId, model.id, { content: chunk })) }
        : {}),
    });

    // +1 for the reply the client is about to append to its history: M365 already
    // has that turn, and sending it back would paste its own answer in as user input.
    conversation.sentMessageCount = body.messages.length + 1;

    if (!streaming) {
      sendJson(response, 200, buildCompletion(result, { model: model.id, tools, allowMultiple: context.deps.allowMultiTool ?? false }));
      return;
    }

    finishStream(response, streamId, model.id, result, tools, canStreamText, context.deps.allowMultiTool ?? false);
  } catch (error) {
    handleTurnFailure(response, error, streaming, tools.length);
  }
}

/** Emit the closing frames of a streamed turn. */
function finishStream(
  response: ServerResponse,
  streamId: string,
  model: string,
  result: { text: string },
  tools: readonly ToolDef[],
  alreadyStreamedText: boolean,
  allowMultiple: boolean,
): void {
  const { toolCalls, text } = parseToolCalls(result.text, tools, { allowMultiple });

  if (toolCalls.length > 0) {
    response.write(streamChunk(streamId, model, { toolCalls: toolCalls.map(toOpenAiToolCall) }));
    response.write(streamChunk(streamId, model, { finishReason: "tool_calls" }));
  } else {
    // If we streamed deltas the client already has the text; sending it again would
    // duplicate the answer.
    if (!alreadyStreamedText && text) response.write(streamChunk(streamId, model, { content: text }));
    response.write(streamChunk(streamId, model, { finishReason: "stop" }));
  }

  response.write(streamDone());
  response.end();
}

function handleTurnFailure(response: ServerResponse, error: unknown, streaming: boolean, toolCount: number): void {
  if (error instanceof AuthRequiredError) {
    finishWithError(response, streaming, 401, "authentication_required", error.message);
    return;
  }

  if (error instanceof DisengagedError) {
    // Empty content makes this look like rate limiting. It is not, and retrying just
    // disengages again while burning the 600-message conversation quota.
    const hint =
      toolCount >= 12
        ? ` The request carried ${toolCount} tools; M365 disengages persistently above roughly 12. Reduce the toolset — see the lean profile in the opencode plugin.`
        : " M365 refused to engage with this prompt. Retrying will not help; reduce the toolset or simplify the prompt.";
    finishWithError(response, streaming, 502, "m365_disengaged", `M365 Copilot disengaged.${hint}`);
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  if ((error as Error)?.name === "AbortError") {
    if (!response.writableEnded) response.end();
    return;
  }

  finishWithError(response, streaming, 502, "upstream_error", message);
}

/** Report an error, in whichever shape the client is already reading. */
function finishWithError(
  response: ServerResponse,
  streaming: boolean,
  status: number,
  code: string,
  message: string,
): void {
  if (!streaming) {
    sendError(response, status, code, message);
    return;
  }
  // Headers are already out on a stream; the error has to ride in the body.
  if (!response.writableEnded) {
    response.write(`data: ${JSON.stringify({ error: { message, code, type: code } })}\n\n`);
    response.write(streamDone());
    response.end();
  }
}

function respondWithTitle(response: ServerResponse, body: ChatRequest, model: string): void {
  const title = generateTitle(body.messages);

  if (body.stream !== true) {
    sendJson(response, 200, {
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: title }, finish_reason: "stop" }],
      usage: buildUsage({ text: title }),
    });
    return;
  }

  const streamId = `chatcmpl-${randomUUID()}`;
  startSse(response);
  response.write(streamChunk(streamId, model, { content: title }));
  response.write(streamChunk(streamId, model, { finishReason: "stop" }));
  response.write(streamDone());
  response.end();
}

// --- plumbing -------------------------------------------------------------------

function startSse(response: ServerResponse): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(payload);
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  if (response.writableEnded) return;
  sendJson(response, status, { error: { message, type: code, code } });
}

async function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    throw new PayloadTooLargeError(`Request body exceeds ${limit} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new PayloadTooLargeError(`Request body exceeds ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export { DEFAULT_MODEL };
