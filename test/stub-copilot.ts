/**
 * A stand-in for M365's SignalR endpoint.
 *
 * Speaks enough of the real protocol to drive `CopilotSession` end to end: the
 * `0x1E`-terminated JSON framing, the handshake, ping frames, and the `update` /
 * stream-item / completion frames a turn is made of. Every frame the client sends is
 * captured so tests can assert on things the real server would silently punish us
 * for getting wrong — most importantly the mandatory `Metrics` frame.
 */

import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";

export const RS = "\x1e";

export interface StubConnection {
  url: string;
  /** Every frame received from the client, parsed, in arrival order. */
  frames: any[];
  socket: WebSocket;
  /**
   * Wait for a frame matching `predicate`.
   *
   * Frames the client sends *after* the turn resolves — a pong, or the stop frame on
   * abort — are still in flight when the awaited call returns, so asserting on
   * `frames` directly is a race. This waits for the frame to actually arrive.
   */
  waitForFrame(predicate: (frame: any) => boolean, timeoutMs?: number): Promise<any>;
}

export interface StubOptions {
  /**
   * Called once the client's chat frame arrives. Return the frames to send back,
   * as objects; they are serialised and `0x1E`-terminated for you.
   */
  respond?: (chat: any, connection: StubConnection) => unknown[] | Promise<unknown[]>;
  /** Send a ping before responding, to exercise keepalive handling. */
  pingFirst?: boolean;
  /** Delay in ms before the response frames go out. */
  delayMs?: number;
}

export interface StubServer {
  /** `ws://127.0.0.1:<port>` — pass as the session's endpoint override. */
  origin: string;
  connections: StubConnection[];
  /** The most recent connection, which is what a single-turn test wants. */
  last(): StubConnection;
  close(): Promise<void>;
}

export async function startStubCopilot(options: StubOptions = {}): Promise<StubServer> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const connections: StubConnection[] = [];

  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const { port } = wss.address() as AddressInfo;

  wss.on("connection", (socket, request) => {
    const connection: StubConnection = {
      url: request.url ?? "",
      frames: [],
      socket,
      waitForFrame: (predicate, timeoutMs = 3000) =>
        new Promise((resolve, reject) => {
          const found = connection.frames.find(predicate);
          if (found) return resolve(found);
          const deadline = Date.now() + timeoutMs;
          const poll = setInterval(() => {
            const match = connection.frames.find(predicate);
            if (match) {
              clearInterval(poll);
              resolve(match);
            } else if (Date.now() > deadline) {
              clearInterval(poll);
              reject(new Error("timed out waiting for a matching frame"));
            }
          }, 10);
        }),
    };
    connections.push(connection);

    socket.on("message", async (raw) => {
      const chunks = raw.toString().split(RS).filter((chunk) => chunk.trim() !== "");
      for (const chunk of chunks) {
        let frame: any;
        try {
          frame = JSON.parse(chunk);
        } catch {
          continue;
        }
        connection.frames.push(frame);

        // The SignalR handshake: `{"protocol":"json","version":1}` gets an empty ack.
        if (frame.protocol === "json") {
          socket.send(`{}${RS}`);
          continue;
        }

        // A chat invocation is type 4 / target "chat".
        if (frame.type === 4 && frame.target === "chat") {
          if (options.pingFirst) socket.send(`${JSON.stringify({ type: 6 })}${RS}`);
          if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
          const responses = (await options.respond?.(frame, connection)) ?? defaultResponse();
          for (const response of responses) socket.send(`${JSON.stringify(response)}${RS}`);
        }
      }
    });
  });

  return {
    origin: `ws://127.0.0.1:${port}`,
    connections,
    last: () => connections[connections.length - 1]!,
    close: () =>
      new Promise<void>((resolve) => {
        for (const connection of connections) connection.socket.terminate();
        wss.close(() => resolve());
      }),
  };
}

// --- frame builders -------------------------------------------------------------

/** An incremental text delta (`writeAtCursor`). */
export function delta(text: string) {
  return { type: 1, target: "update", arguments: [{ writeAtCursor: text, streamingMode: "Delta" }] };
}

/**
 * A full message snapshot.
 *
 * A bot message counts as content only when it has NO `messageType` — everything
 * with one is control traffic (Progress, ReferencesListComplete, Disengaged, ...).
 */
export function botMessage(text: string, extra: Record<string, unknown> = {}) {
  return { type: 1, target: "update", arguments: [{ messages: [{ author: "bot", text, ...extra }] }] };
}

/** The Disengaged refusal: a control message with no answer text at all. */
export function disengaged() {
  return {
    type: 1,
    target: "update",
    arguments: [
      {
        messages: [
          { author: "bot", messageType: "Disengaged", hiddenText: "> Conversation disengaged", offense: "None" },
        ],
      },
    ],
  };
}

export function throttling(current: number, max = 600) {
  return {
    type: 1,
    target: "update",
    arguments: [
      {
        throttling: {
          numUserMessagesInConversation: current,
          maxNumUserMessagesInConversation: max,
          numLongDocSummaryUserMessagesInConversation: 0,
        },
      },
    ],
  };
}

/** The `type:2` stream item that closes a turn. */
export function streamItem(text: string, extra: Record<string, unknown> = {}) {
  return {
    type: 2,
    item: {
      messages: [{ author: "bot", text, ...extra }],
      result: { value: "Success", message: text, serviceVersion: "1.0.03443.34112" },
      turnState: "Completed",
    },
  };
}

export function completion(error?: string) {
  return error ? { type: 3, error } : { type: 3 };
}

function defaultResponse() {
  return [delta("Hello"), delta(" world"), streamItem("Hello world"), completion()];
}
