/**
 * The OpenAI-compatible HTTP surface.
 *
 * Small on purpose: `node:http` rather than a framework, because this runs inside
 * opencode's own process and every dependency here is one opencode has to install.
 * It binds loopback only — the proxy is unauthenticated and speaks to a paid account
 * with your credentials.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
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
  host?: string;
}

export interface ProxyHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

interface Conversation extends ConversationState {
  session?: CopilotSession;
}

export async function startServer(deps: ServerDeps): Promise<ProxyHandle> {
  const pool = new ConversationPool();
  const host = deps.host ?? "127.0.0.1";

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

  const server = createServer((request, response) => {
    handle(request, response, { deps, pool, agentId }).catch((error) => {
      log.error("unhandled request failure", String(error));
      sendError(response, 500, "internal_error", String(error));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.port ?? 0, host, resolve);
  });

  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${host}:${port}`,
    port,
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
}

async function handle(request: IncomingMessage, response: ServerResponse, context: Context): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const method = (request.method ?? "GET").toUpperCase();

  if (method === "OPTIONS") {
    response.writeHead(204, corsHeaders()).end();
    return;
  }

  if (method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: "ok" });
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
    body = ChatCompletionRequest.parse(JSON.parse(await readBody(request)));
  } catch (error) {
    sendError(response, 400, "invalid_request_error", String((error as Error)?.message ?? error));
    return;
  }

  const model = resolveModel(body.model);
  const requested = (body.tools ?? []) as ToolDef[];
  const tools = context.deps.lean === false ? requested : selectLeanTools(requested);
  if (tools.length !== requested.length) {
    log.info(`trimmed toolset ${requested.length} -> ${tools.length}`, tools.map((t) => t.function.name).join(","));
    // Warn once per process rather than per turn: a drifted allowlist is a standing
    // condition, not a per-request event, and an agent loop would flood the log.
    const concern = context.deps.lean === false ? undefined : describeToolSelection(requested);
    if (concern && !warnedAboutToolSelection) {
      warnedAboutToolSelection = true;
      log.warn(concern);
    }
  }

  // The titler never touches M365 — see models.ts for why that matters.
  if (isLocalModel(model.id)) {
    respondWithTitle(response, body, model.id);
    return;
  }

  const conversation = context.pool.resolve(body.messages) as Conversation;
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

    conversation.sentMessageCount = body.messages.length;

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
    ...corsHeaders(),
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json", ...corsHeaders() });
  response.end(payload);
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  if (response.writableEnded) return;
  sendJson(response, status, { error: { message, type: code, code } });
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export { DEFAULT_MODEL };
