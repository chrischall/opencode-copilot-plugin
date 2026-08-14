/**
 * OpenAI ⇄ M365 translation.
 *
 * Two asymmetries drive the design:
 *
 * - **M365 is stateful, OpenAI is not.** An OpenAI client resends the whole history
 *   every turn; M365 keeps its own server-side context and charges 600 user messages
 *   per *conversation*. So we key conversations on the first user message and send
 *   only what is new.
 * - **M365 has no tool calls.** Tools go out as a fenced contract in the prompt and
 *   come back as fenced blocks, which `fenced.ts` converts in both directions.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { buildToolPrompt, parseToolCalls, type ParsedToolCall, type ToolDef } from "./fenced.js";
import type { TurnResult } from "./session.js";

// --- request schema -------------------------------------------------------------

const ContentPart = z.object({ type: z.string(), text: z.string().optional() }).passthrough();

const Message = z
  .object({
    role: z.string(),
    content: z.union([z.string(), z.array(ContentPart), z.null()]).optional(),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z
      .array(
        z.object({
          id: z.string(),
          type: z.literal("function").optional(),
          function: z.object({ name: z.string(), arguments: z.string() }),
        }),
      )
      .optional(),
  })
  .passthrough();

const Tool = z.object({
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.any().optional(),
  }),
});

export const ChatCompletionRequest = z.object({
  model: z.string().optional(),
  messages: z.array(Message).min(1),
  tools: z.array(Tool).optional(),
  tool_choice: z.any().optional(),
  stream: z.boolean().optional(),
  // Accepted and ignored: M365 exposes no sampling controls.
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().optional(),
});

export type ChatRequest = z.infer<typeof ChatCompletionRequest>;
export type ChatMessage = z.infer<typeof Message>;

// --- conversation pooling -------------------------------------------------------

export interface ConversationState {
  key: string;
  /** How many messages of the client's history M365 has already been told about. */
  sentMessageCount: number;
  lastAccessedAt: number;
  /** Set by the caller; the live M365 session for this conversation. */
  session?: unknown;
}

export interface PoolOptions {
  maxIdleMs?: number;
}

/**
 * Maps an OpenAI client's stateless history onto stateful M365 conversations.
 *
 * Identity is the first user message: an agent loop keeps resending the same opening
 * turn, so it is a stable handle for "this is still the same task".
 */
export class ConversationPool {
  private readonly conversations = new Map<string, ConversationState>();
  private readonly maxIdleMs: number;

  constructor(options: PoolOptions = {}) {
    this.maxIdleMs = options.maxIdleMs ?? 60 * 60 * 1000;
  }

  resolve(messages: ChatMessage[]): ConversationState {
    this.evictStale();

    const key = fingerprint(messages);
    const existing = this.conversations.get(key);
    if (existing) {
      // A shorter history than we have already sent means the client restarted the
      // task; the server-side context no longer matches.
      if (messages.length < existing.sentMessageCount) existing.sentMessageCount = 0;
      existing.lastAccessedAt = Date.now();
      return existing;
    }

    const state: ConversationState = { key, sentMessageCount: 0, lastAccessedAt: Date.now() };
    this.conversations.set(key, state);
    return state;
  }

  get size(): number {
    return this.conversations.size;
  }

  private evictStale(): void {
    const now = Date.now();
    for (const [key, state] of this.conversations) {
      if (now - state.lastAccessedAt >= this.maxIdleMs) this.conversations.delete(key);
    }
  }
}

function fingerprint(messages: ChatMessage[]): string {
  const firstUser = messages.find((message) => message.role === "user");
  const text = firstUser ? contentOf(firstUser) : "";
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return `c${hash}`;
}

/** Message content as plain text, flattening the array-of-parts form. */
export function contentOf(message: ChatMessage): string {
  const { content } = message;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// --- prompt construction --------------------------------------------------------

/**
 * Capability catalogues a harness injects into its system prompt, and the tool each
 * one needs in order to be actionable.
 *
 * Measured against opencode 1.18: `<available_skills>` alone was 34k of a 53k-char
 * system prompt — and lean mode disables the `skill` tool, so every entry in it named
 * something the model had no way to invoke. Advertising unusable capabilities is
 * worse than saying nothing: it invites the model to claim it did something it cannot.
 */
const CAPABILITY_CATALOGUES: ReadonlyArray<{ tag: string; requires: readonly string[] }> = [
  { tag: "available_skills", requires: ["skill"] },
  { tag: "available_agents", requires: ["task", "agent"] },
];

export interface CondenseOptions {
  /**
   * Replace the free prose of the system prompt with this, keeping structured
   * blocks like `<env>`.
   *
   * A long, polished assistant prompt measurably reduces M365's tool compliance
   * relative to a short blunt one — the same model that complies under a terse
   * prompt will confabulate ("I can't access the files, paste them") under a
   * carefully-written one.
   */
  replaceProseWith?: string;
}

/**
 * Trim a harness system prompt down to what this toolset can actually act on.
 *
 * This happens here rather than in the plugin because opencode's own hooks cannot do
 * it: `experimental.chat.system.transform` fires and accepts a new `system` array,
 * but the request still carries the original prompt (verified against 1.18.18), and
 * `agent.<name>.prompt` set from the config hook is ignored the same way. The proxy
 * sees the final request, so it is the one place the change reliably lands.
 */
export function condenseSystemPrompt(
  text: string,
  tools: readonly ToolDef[],
  options: CondenseOptions = {},
): string {
  const toolNames = new Set(tools.map((tool) => tool.function.name.toLowerCase()));
  let result = text;

  for (const { tag, requires } of CAPABILITY_CATALOGUES) {
    if (requires.some((name) => toolNames.has(name))) continue;
    result = result.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"), "");
  }

  if (options.replaceProseWith !== undefined) {
    // Keep the structured blocks — `<env>` and anything the project added carry
    // context the model needs — and drop the prose around them.
    const blocks = result.match(/<([a-z_][a-z0-9_-]*)>[\s\S]*?<\/\1>/gi) ?? [];
    result = [options.replaceProseWith, ...blocks].join("\n\n");
  }

  return result.replace(/\n{3,}/g, "\n\n").trim();
}

export interface PromptOptions {
  /** Replace the harness's prose system prompt with a lean one. */
  leanSystemPrompt?: string;
}

/**
 * Build the single prompt string for this turn.
 *
 * Only messages beyond `sentMessageCount` are included — the server already has the
 * rest. The tool block is repeated every turn: it is the contract, and the model
 * drifts away from it if it falls out of view.
 */
export function buildTurnPrompt(
  messages: ChatMessage[],
  tools: readonly ToolDef[],
  sentMessageCount: number,
  options: PromptOptions = {},
): string {
  const parts: string[] = [];
  const isFirstTurn = sentMessageCount === 0;

  if (isFirstTurn) {
    const systemText = messages
      .filter((message) => message.role === "system" || message.role === "developer")
      .map(contentOf)
      .filter(Boolean)
      .join("\n\n");
    if (systemText) {
      parts.push(
        condenseSystemPrompt(systemText, tools, {
          ...(options.leanSystemPrompt !== undefined ? { replaceProseWith: options.leanSystemPrompt } : {}),
        }),
      );
    }
  }

  if (tools.length > 0) parts.push(buildToolPrompt(tools));

  // Correlate tool results back to the call that produced them, so the label can say
  // what the output actually is.
  const callsById = new Map<string, { name: string; arguments: string }>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) callsById.set(call.id, call.function);
  }

  for (const message of messages.slice(sentMessageCount)) {
    if (message.role === "system" || message.role === "developer") continue;

    if (message.role === "tool") {
      parts.push(renderToolResult(message, callsById));
      continue;
    }

    if (message.role === "assistant") {
      // The server already has its own replies; only surface an assistant turn the
      // client synthesised.
      const text = contentOf(message);
      if (text) parts.push(text);
      continue;
    }

    const text = contentOf(message);
    if (text) parts.push(text);
  }

  return parts.filter(Boolean).join("\n\n");
}

/**
 * Wrap a tool result so the model can tell what it is looking at.
 *
 * An unlabelled blob is routinely misread — an `ls` listing taken for file contents,
 * an empty stdout taken for an empty file.
 */
function renderToolResult(
  message: ChatMessage,
  callsById: Map<string, { name: string; arguments: string }>,
): string {
  const call = message.tool_call_id ? callsById.get(message.tool_call_id) : undefined;
  const attributes: string[] = [];

  if (call?.name) attributes.push(`tool="${escapeAttribute(call.name)}"`);
  const summary = summariseArguments(call?.arguments);
  if (summary) attributes.push(`command="${escapeAttribute(summary)}"`);

  const open = attributes.length > 0 ? `<tool_response ${attributes.join(" ")}>` : "<tool_response>";
  return `${open}\n${contentOf(message)}\n</tool_response>`;
}

/** The most identifying argument value, for the label. */
function summariseArguments(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    const value = parsed.command ?? parsed.filePath ?? parsed.path ?? parsed.pattern ?? parsed.query;
    if (typeof value !== "string") return undefined;
    return value.length > 120 ? `${value.slice(0, 117)}…` : value;
  } catch {
    return undefined;
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/"/g, "&quot;").replace(/\n/g, " ");
}

// --- response construction ------------------------------------------------------

export interface CompletionOptions {
  model: string;
  tools: readonly ToolDef[];
  allowMultiple?: boolean;
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    };
    finish_reason: "stop" | "tool_calls";
  }>;
  usage: ReturnType<typeof buildUsage>;
}

export function buildCompletion(result: TurnResult, options: CompletionOptions): ChatCompletion {
  const { toolCalls, text } = parseToolCalls(result.text, options.tools, {
    allowMultiple: options.allowMultiple ?? false,
  });

  const hasCalls = toolCalls.length > 0;
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: options.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: hasCalls ? null : text,
          ...(hasCalls ? { tool_calls: toolCalls.map(toOpenAiToolCall) } : {}),
        },
        finish_reason: hasCalls ? "tool_calls" : "stop",
      },
    ],
    usage: buildUsage(result),
  };
}

export function toOpenAiToolCall(call: ParsedToolCall) {
  return {
    id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "function" as const,
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  };
}

/**
 * Usage, plus M365-specific extensions.
 *
 * M365 never reports token counts, so the standard fields are zero. The extensions
 * carry what it *does* report: the per-conversation message quota — the closest thing
 * to context-window utilisation available — and the classifier score that rises
 * before the Disengaged filter fires. Clients that ignore unknown fields are fine.
 */
export function buildUsage(result: TurnResult) {
  const usage: Record<string, any> = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };

  if (result.throttle) {
    const { current, max } = result.throttle;
    usage.x_m365_conversation_messages = current;
    usage.x_m365_conversation_max = max;
    usage.x_m365_conversation_remaining = Math.max(0, max - current);
    usage.x_m365_conversation_pct = max > 0 ? Math.round((current / max) * 100) : 0;
  }
  if (result.contentOrigin) usage.x_m365_content_origin = result.contentOrigin;
  if (typeof result.turnCount === "number") usage.x_m365_turn_count = result.turnCount;
  if (result.scores) {
    usage.x_m365_classifier_scores = result.scores;
    if (typeof result.scores.dea_violation === "number") usage.x_m365_dea_score = result.scores.dea_violation;
  }

  return usage;
}

// --- streaming ------------------------------------------------------------------

export interface ChunkDelta {
  content?: string;
  finishReason?: "stop" | "tool_calls";
  toolCalls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

/** One `chat.completion.chunk` as a server-sent event frame. */
export function streamChunk(id: string, model: string, delta: ChunkDelta): string {
  const payload = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          ...(delta.content !== undefined ? { content: delta.content } : {}),
          ...(delta.toolCalls ? { tool_calls: delta.toolCalls.map((call, index) => ({ index, ...call })) } : {}),
        },
        finish_reason: delta.finishReason ?? null,
      },
    ],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function streamDone(): string {
  return "data: [DONE]\n\n";
}

// --- local title generation -----------------------------------------------------

/** Instruction wrappers a harness puts around a title request, which are not the subject. */
const TITLE_INSTRUCTION = /generate|summar|title|respond with|in a few words|short phrase/i;

/**
 * Name a session without spending an M365 conversation on it.
 *
 * opencode's `small_model` defaults to the main model, so titling would open a second
 * conversation for every session — and the throttle counts conversations started, not
 * messages. This is not as good as a model-written title; it is free, and it keeps
 * the account out of the throttle.
 */
export function generateTitle(messages: ChatMessage[]): string {
  const subject = messages
    .filter((message) => message.role === "user")
    .map(contentOf)
    .filter((text) => text.trim() !== "" && !TITLE_INSTRUCTION.test(firstLine(text)))
    .join("\n");

  const cleaned = (subject || messages.map(contentOf).join("\n"))
    // Drop fenced code, which is never a good title.
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/<tool_response[\s\S]*?<\/tool_response>/g, " ")
    .replace(/[#*_>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned === "") return "New session";

  const words = cleaned.split(" ").slice(0, 8).join(" ");
  const title = words.length > 50 ? `${words.slice(0, 47).trimEnd()}…` : words;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}
