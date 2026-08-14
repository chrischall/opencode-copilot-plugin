/**
 * The M365 Copilot transport: SignalR over WebSocket.
 *
 * Things that are load-bearing and non-obvious, all of which fail *silently* when
 * you get them wrong:
 *
 * - The access token goes in the WebSocket URL **query string**, not a header.
 * - Node's built-in WebSocket is refused. The `ws` package plus a browser-shaped
 *   `Origin`/`User-Agent` is what the server accepts.
 * - Frames are JSON terminated by `0x1E` (record separator), and one WebSocket
 *   message can carry several of them.
 * - A `Metrics` frame must ride in the **same send** as the chat frame. Omit it and
 *   the turn simply never produces output — no error, just silence.
 * - Only bot messages with **no** `messageType` carry the answer. Everything with one
 *   is control traffic.
 * - `messageType: "Disengaged"` is a refusal with empty content. It looks exactly
 *   like rate limiting and must not be retried into.
 *
 * Each turn opens a fresh socket but reuses the conversation id, so the server keeps
 * threading context. The 600-message cap is per conversation, which is why we reuse.
 */

import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { createLogger, trunc } from "./log.js";

const log = createLogger("session");

/** Record separator: every SignalR frame ends with this byte. */
const RS = "\x1e";

const DEFAULT_ENDPOINT = "wss://substrate.office.com";

/** The upgrade is rejected without browser-shaped headers. */
const BROWSER_HEADERS = {
  Origin: "https://m365.cloud.microsoft",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:148.0) Gecko/20100101 Firefox/148.0",
};

/**
 * Feature flags copied from a captured first-party session.
 *
 * Cargo-culted on purpose: these are the values the real Office web client sends, and
 * which subset actually matters has never been established. Removing them is untested.
 */
const VARIANTS = [
  "feature.EnableWebSearch",
  "feature.EnableCodeInterpreter",
  "feature.EnableSydneyClientCompliance",
  "feature.EnableStreaming",
].join(",");

/** The message types we tell the server we are able to render. */
const ALLOWED_MESSAGE_TYPES = [
  "Chat",
  "Suggestion",
  "Progress",
  "EndOfRequest",
  "Disengaged",
  "InternalSearchQuery",
  "InternalSearchResult",
  "RenderCardRequest",
  "ReferencesListComplete",
  "GeneratedCode",
];

export interface JwtClaims {
  oid: string;
  tid: string;
  [claim: string]: unknown;
}

/** Read the object id and tenant id out of a Sydney token — they address the hub. */
export function decodeJwt(token: string): JwtClaims {
  const parts = token.split(".");
  if (parts.length < 2) throw new Error("Malformed JWT: expected three dot-separated segments");
  let claims: any;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    throw new Error("Malformed JWT: payload is not valid base64url JSON");
  }
  if (!claims || typeof claims !== "object") throw new Error("Malformed JWT: payload is not an object");
  return claims as JwtClaims;
}

/** M365 refused to engage with the prompt. Not a rate limit — do not retry into it. */
export class DisengagedError extends Error {
  readonly disengaged = true;
  constructor(message = "M365 Copilot disengaged from this conversation") {
    super(message);
    this.name = "DisengagedError";
  }
}

export interface ThrottleState {
  current: number;
  max: number;
}

export interface TurnResult {
  text: string;
  /** Per-conversation quota, when the server reported it. */
  throttle?: ThrottleState;
  /** Which backend answered — `DeepLeo` is the reasoning pipeline. */
  contentOrigin?: string;
  /** Server-side turn count for this conversation. */
  turnCount?: number;
  /** Classifier scores. `dea_violation` rises before Disengaged fires. */
  scores?: Record<string, number>;
}

export interface CopilotSessionOptions {
  /** Supplies a Sydney access token; called once per turn so refresh is transparent. */
  getToken: () => Promise<string>;
  /** Override the wss origin. Tests point this at a stub. */
  endpoint?: string;
  conversationId?: string;
  sessionId?: string;
}

export interface TurnOptions {
  /** Selects the model. There is no model parameter in this protocol. */
  tone?: string;
  /** Declarative agent id, when the turn needs server-side tool instructions. */
  agentId?: string | null;
  signal?: AbortSignal;
  onDelta?: (chunk: string) => void;
}

/**
 * One M365 conversation.
 *
 * Stateful across turns: the conversation and session ids persist so the server keeps
 * its own context, and follow-up turns only need to carry new messages.
 */
export class CopilotSession {
  conversationId: string;
  sessionId: string;
  turnIndex = 0;

  private readonly options: CopilotSessionOptions;

  constructor(options: CopilotSessionOptions) {
    this.options = options;
    this.conversationId = options.conversationId ?? randomUUID();
    this.sessionId = options.sessionId ?? randomUUID();
  }

  /** Abandon the server-side context and start a fresh conversation. */
  reset(): void {
    this.conversationId = randomUUID();
    this.sessionId = randomUUID();
    this.turnIndex = 0;
  }

  async run(text: string, turn: TurnOptions = {}): Promise<TurnResult> {
    if (turn.signal?.aborted) throw abortError();

    const token = await this.options.getToken();
    const { oid, tid } = decodeJwt(token);
    const url = this.buildUrl(token, oid, tid);

    const socket = new WebSocket(url, { headers: BROWSER_HEADERS });
    try {
      const result = await this.pump(socket, text, turn);
      this.turnIndex += 1;
      return result;
    } finally {
      closeSocket(socket);
    }
  }

  private buildUrl(token: string, oid: string, tid: string): string {
    const origin = this.options.endpoint ?? DEFAULT_ENDPOINT;
    const params = new URLSearchParams({
      access_token: token,
      ConversationId: this.conversationId,
      chatsessionid: this.sessionId,
      "X-SessionId": this.sessionId,
      clientrequestid: randomUUID(),
      source: '"officeweb"',
      product: "Office",
      agentHost: "Bizchat.FullScreen",
      scenario: "OfficeWebIncludedCopilot",
      variants: VARIANTS,
    });
    return `${origin}/m365Copilot/Chathub/${oid}@${tid}?${params.toString()}`;
  }

  /** Drive one turn to completion. */
  private pump(socket: WebSocket, text: string, turn: TurnOptions): Promise<TurnResult> {
    return new Promise<TurnResult>((resolve, reject) => {
      let deltaText = "";
      let snapshotText = "";
      let handshakeDone = false;
      let settled = false;
      const result: TurnResult = { text: "" };

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        turn.signal?.removeEventListener("abort", onAbort);
        if (error) {
          reject(error);
          return;
        }
        // The server sends the answer twice — incrementally and as a snapshot — and
        // either can be the more complete one depending on where the turn ended.
        result.text = deltaText.length >= snapshotText.length ? deltaText : snapshotText;
        resolve(result);
      };

      const onAbort = () => {
        // The real client's Stop button: an invocation on the same socket, with a
        // different invocationId from the chat frame, then close.
        try {
          socket.send(`${JSON.stringify({ arguments: [{}], invocationId: "1", target: "stop", type: 1 })}${RS}`);
        } catch {
          /* the socket may already be gone */
        }
        finish(abortError());
      };
      turn.signal?.addEventListener("abort", onAbort, { once: true });

      socket.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
      socket.on("close", () => finish());

      socket.on("open", () => {
        socket.send(`${JSON.stringify({ protocol: "json", version: 1 })}${RS}`);
      });

      socket.on("message", (raw) => {
        for (const frame of splitFrames(raw.toString())) {
          // The handshake ack is `{}`; the chat frame goes out immediately after.
          if (!handshakeDone) {
            handshakeDone = true;
            this.sendChat(socket, text, turn);
            // An ack carries nothing else, but a server that batches may.
            if (Object.keys(frame).length === 0) continue;
          }

          switch (frame.type) {
            case 1:
              if (frame.target === "update") {
                for (const argument of frame.arguments ?? []) {
                  const applied = this.applyUpdate(argument, result, turn);
                  if (applied.disengaged) {
                    finish(new DisengagedError());
                    return;
                  }
                  deltaText += applied.delta;
                  if (applied.snapshot.length > snapshotText.length) snapshotText = applied.snapshot;
                }
              }
              break;

            case 2:
              this.applyStreamItem(frame.item, result);
              if (frame.item?.result?.message && frame.item.result.message.length > snapshotText.length) {
                snapshotText = frame.item.result.message;
              }
              break;

            case 3:
              if (frame.error) {
                finish(new Error(`M365 rejected the turn: ${frame.error}`));
                return;
              }
              finish();
              return;

            case 6:
              // Keepalive. Silence here gets the connection dropped mid-answer.
              socket.send(`${JSON.stringify({ type: 6 })}${RS}`);
              break;

            case 7:
              if (frame.error) {
                finish(new Error(`M365 closed the connection: ${frame.error}`));
                return;
              }
              finish();
              return;

            default:
              break;
          }
        }
      });
    });
  }

  /** The chat invocation and its mandatory Metrics companion, in one send. */
  private sendChat(socket: WebSocket, text: string, turn: TurnOptions): void {
    const now = new Date().toISOString();

    const message: Record<string, unknown> = {
      text,
      author: "user",
      inputMethod: "Keyboard",
      messageType: "Chat",
      locale: "en-US",
      timestamp: now,
      messageId: randomUUID(),
    };

    const argument: Record<string, unknown> = {
      message,
      tone: turn.tone ?? "magic",
      source: "officeweb",
      streamingMode: "ConciseWithPadding",
      isStartOfSession: this.turnIndex === 0,
      conversationId: this.conversationId,
      allowedMessageTypes: ALLOWED_MESSAGE_TYPES,
      optionsSets: [],
      clientInfo: {
        clientPlatform: "mcmcopilot-web",
        clientAppName: "Office",
// eslint-disable-next-line @typescript-eslint/naming-convention
        clientAppVersion: "1.0.0",
      },
      traceId: randomUUID(),
    };

    if (turn.agentId) {
      // With an agent attached, the declarative-agent fields replace `plugins`.
      argument.threadLevelGptId = { id: turn.agentId, source: "MOS3" };
      argument.gpts = [
        {
          id: turn.agentId,
          source: "MOS3",
          version: "1.0.0",
          clientOverrides: { capabilities: [], "deepResearchModels@odata.type": "Collection(String)" },
        },
      ];
    } else {
      argument.plugins = [{ Id: "BingWebSearch", Source: "BuiltIn" }];
    }

    const chat = { arguments: [argument], invocationId: "0", target: "chat", type: 4 };
    const metrics = {
      arguments: [
        {
          Timestamps: {
            ConnectionStart: now,
            UserInputStart: now,
            ConnectionEstablished: now,
            UserInputSubmit: now,
          },
        },
      ],
      target: "Metrics",
      type: 1,
    };

    log.info("sending turn", trunc({ tone: argument.tone, agent: Boolean(turn.agentId), text }));
    // Both frames, one send. This is the part that silently breaks everything.
    socket.send(`${JSON.stringify(chat)}${RS}${JSON.stringify(metrics)}${RS}`);
  }

  /** Fold one `update` argument into the accumulating result. */
  private applyUpdate(
    argument: any,
    result: TurnResult,
    turn: TurnOptions,
  ): { delta: string; snapshot: string; disengaged: boolean } {
    let deltaChunk = "";
    let snapshot = "";

    if (typeof argument?.writeAtCursor === "string") {
      deltaChunk = argument.writeAtCursor;
      turn.onDelta?.(deltaChunk);
    }

    if (argument?.throttling) {
      result.throttle = {
        current: argument.throttling.numUserMessagesInConversation,
        max: argument.throttling.maxNumUserMessagesInConversation,
      };
    }

    for (const message of argument?.messages ?? []) {
      if (message?.author !== "bot") continue;
      if (message.messageType === "Disengaged") return { delta: deltaChunk, snapshot, disengaged: true };
      // A messageType means control traffic, never the answer.
      if (message.messageType) continue;
      if (typeof message.text === "string" && message.text.length > snapshot.length) snapshot = message.text;
      absorbMetadata(message, result);
    }

    return { delta: deltaChunk, snapshot, disengaged: false };
  }

  private applyStreamItem(item: any, result: TurnResult): void {
    if (!item) return;
    if (item.throttling) {
      result.throttle = {
        current: item.throttling.numUserMessagesInConversation,
        max: item.throttling.maxNumUserMessagesInConversation,
      };
    }
    for (const message of item.messages ?? []) {
      if (message?.author === "bot" && !message.messageType) absorbMetadata(message, result);
    }
  }
}

/** Pull the diagnostic fields off a final bot message. */
function absorbMetadata(message: any, result: TurnResult): void {
  if (typeof message.contentOrigin === "string") result.contentOrigin = message.contentOrigin;
  if (typeof message.turnCount === "number") result.turnCount = message.turnCount;
  if (Array.isArray(message.scores)) {
    result.scores ??= {};
    for (const score of message.scores) {
      if (typeof score?.component === "string") result.scores[score.component] = score.score;
    }
  }
}

/** One WebSocket message can carry several `0x1E`-terminated frames. */
function splitFrames(raw: string): any[] {
  const frames: any[] = [];
  for (const chunk of raw.split(RS)) {
    if (chunk.trim() === "") continue;
    try {
      frames.push(JSON.parse(chunk));
    } catch {
      log.warn("unparseable frame", trunc(chunk));
    }
  }
  return frames;
}

/**
 * Shut a turn's socket down without losing anything still buffered.
 *
 * `terminate()` destroys the socket immediately and drops queued frames — which is
 * how a pong or the stop frame can be sent and still never arrive. `close()` flushes
 * first; the timer is the backstop for a server that never completes the handshake.
 */
function closeSocket(socket: WebSocket): void {
  if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) return;
  try {
    socket.close();
  } catch {
    socket.terminate();
    return;
  }
  const timer = setTimeout(() => socket.terminate(), 1000);
  timer.unref?.();
  socket.once("close", () => clearTimeout(timer));
}

function abortError(): Error {
  const error = new Error("The M365 turn was aborted");
  error.name = "AbortError";
  return error;
}
