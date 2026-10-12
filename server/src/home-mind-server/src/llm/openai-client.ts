import OpenAI from "openai";
import type { Config } from "../config.js";
import type { IMemoryStore } from "../memory/interface.js";
import type { IConversationStore } from "../memory/types.js";
import { HomeAssistantClient } from "../ha/client.js";
import { DeviceScanner } from "../ha/device-scanner.js";
import { TopologyScanner } from "../ha/topology-scanner.js";
import { buildSystemPromptText } from "./prompts.js";
import { TOOL_DEFINITIONS, toOpenAITools } from "./tool-definitions.js";
import { randomUUID } from "node:crypto";
import { handleToolCall, extractAndStoreFacts, type ToolContext } from "./tool-handler.js";
import { withTokenCap } from "./token-cap.js";
import { withReasoningEffort } from "./reasoning-effort.js";
import { describeLongBatch } from "./long-task.js";
import {
  readUsage,
  describeUsage,
  spentBudgetOnReasoning,
  WRITTEN_OUTPUT_CAP,
  VOICE_OUTPUT_CAP,
  TRUNCATION_NOTICE,
  VOICE_TRUNCATION_NOTICE,
  type TokenUsage,
} from "./usage.js";
import { toStreamEvents } from "./interface.js";
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamEvents,
  ChatError,
  StreamCallback,
  IChatEngine,
  IFactExtractor,
} from "./interface.js";

type FunctionToolCall = OpenAI.ChatCompletionMessageFunctionToolCall;

const OPENAI_TOOLS = toOpenAITools(TOOL_DEFINITIONS);

/**
 * Hard cap on tool round-trips per user message. A model that loops (repeatedly
 * re-searching entities, retrying a tool it misreads as failing) otherwise burns
 * the user's OpenRouter allowance until HA's 120s client timeout cuts it off,
 * with nothing to show for it. On the last iteration we re-ask with tool calling
 * disabled so the user still gets a written answer instead of silence.
 */
const MAX_TOOL_ITERATIONS = 8;

/**
 * A provider-specific field some OpenAI-compatible endpoints attach to a tool
 * call and require back, unchanged, on the next turn. It is not in the OpenAI
 * schema, so the SDK types do not know it.
 */
function extraContentOf(tc: object): unknown {
  return (tc as { extra_content?: unknown }).extra_content;
}

export class OpenAIChatEngine implements IChatEngine {
  private client: OpenAI;
  private memory: IMemoryStore;
  private conversations: IConversationStore;
  private extractor: IFactExtractor;
  private ha: HomeAssistantClient;
  private scanner: DeviceScanner;
  private topology: TopologyScanner;
  private config: Config;

  constructor(
    config: Config,
    memory: IMemoryStore,
    conversations: IConversationStore,
    extractor: IFactExtractor,
    ha: HomeAssistantClient,
    scanner: DeviceScanner,
    topology: TopologyScanner
  ) {
    this.config = config;
    this.client = new OpenAI({
      apiKey: config.openaiApiKey,
      baseURL: config.openaiBaseUrl,
      defaultHeaders: {
        "HTTP-Referer": "https://nives.house",
        "X-OpenRouter-Title": "Nives",
        "X-OpenRouter-Categories": "personal-agent",
      },
    });
    this.memory = memory;
    this.conversations = conversations;
    this.extractor = extractor;
    this.ha = ha;
    this.scanner = scanner;
    this.topology = topology;
  }

  async chat(
    request: ChatRequest,
    streamArg?: StreamCallback | ChatStreamEvents
  ): Promise<ChatResponse> {
    const events = toStreamEvents(streamArg);
    const onChunk = events.onChunk;
    const { message, userId, conversationId, isVoice = false, customPrompt, language } = request;
    const toolsUsed: string[] = [];
    let announced = false;
    const turnId = randomUUID(); // nonce for this turn — powers the automation confirmation gate
    // ONE shared context for the whole turn — forget_memory writes
    // suppressExtraction back onto it, so per-call literals would drop the flag.
    const toolCtx: ToolContext = { conversationId, turnId, userId, memory: this.memory };

    // 1. Load user's memory
    const facts = await this.memory.getFactsWithinTokenLimit(
      userId,
      this.config.memoryTokenLimit,
      message
    );
    const factContents = facts.map((f) => f.content);
    if (this.config.logLevel === "debug") {
      const approxTokens = Math.ceil(factContents.join(" ").length / 4);
      console.debug(
        `[recall] userId=${userId} factCount=${factContents.length} tokens=${approxTokens}`
      );
    }

    // 2. Refresh device profiles and home layout if stale, then build system prompt
    await Promise.all([this.scanner.refreshIfStale(), this.topology.refreshIfStale()]);
    const deviceCheatSheet = this.scanner.hasProfiles()
      ? this.scanner.formatCheatSheet()
      : undefined;
    const homeLayout = this.topology.hasLayout() ? this.topology.formatSection() : undefined;
    const systemPrompt = buildSystemPromptText(factContents, isVoice, customPrompt, deviceCheatSheet, homeLayout, language, this.config.ttsVoiceGender);

    // 3. Load conversation history
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
    ];

    if (conversationId) {
      const history = await this.conversations.getConversationHistory(conversationId, 10);
      for (const msg of history) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    // 4. Add current user message (multimodal when images are present)
    if (request.images && request.images.length > 0) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: message },
          ...request.images.map((url) => ({
            type: "image_url" as const,
            // detail:"low" keeps token cost bounded for routine snapshots
            image_url: { url, detail: "low" as const },
          })),
        ],
      });
    } else {
      messages.push({ role: "user", content: message });
    }

    // Persist only the text to conversation history (images are ephemeral to this turn).
    if (conversationId) {
      this.conversations.storeMessage(conversationId, userId, "user", message);
    }

    // 5. Stream and handle tool call loop
    events.onTurn?.();
    let result = await this.streamCompletion(messages, isVoice, onChunk, false, conversationId);

    let iterations = 0;
    // Run whatever tool calls arrived, whatever the finish_reason says: some
    // OpenAI-compatible endpoints report "stop" on a turn that calls tools.
    while (result.toolCalls.length > 0) {
      iterations++;

      // Add assistant message with tool calls
      messages.push({
        role: "assistant",
        content: result.text || null,
        tool_calls: result.toolCalls,
      });

      // The batch is known and nothing has run yet: this is the one moment to
      // warn the person waiting that it will take a while. If the model wrote
      // a sentence of its own before the calls, that sentence has already been
      // streamed and is the warning; otherwise the server's own goes out.
      if (!announced) {
        const heads = describeLongBatch(
          result.toolCalls.map((tc) => ({ name: tc.function.name, args: parseArgs(tc) }))
        );
        if (heads) {
          announced = true;
          if (result.text.trim() === "") events.onStatus?.(heads);
        }
      }

      // Execute all tool calls in parallel
      const toolPromises = result.toolCalls.map(async (tc: FunctionToolCall) => {
        toolsUsed.push(tc.function.name);

        // Cheap models sometimes emit truncated or non-JSON arguments. Hand that
        // back as a tool error the model can recover from — throwing here would
        // reject the whole Promise.all and fail the user's request outright.
        let args: Record<string, unknown>;
        try {
          args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          console.warn(
            `[tool] ${tc.function.name} got unparseable arguments: ${tc.function.arguments}`
          );
          return {
            role: "tool" as const,
            tool_call_id: tc.id,
            content: JSON.stringify({
              error:
                `Arguments for ${tc.function.name} were not valid JSON and could not be read. ` +
                `Call the tool again with valid JSON arguments.`,
            }),
          };
        }

        const toolResult = await handleToolCall(this.ha, tc.function.name, args, toolCtx);
        return {
          role: "tool" as const,
          tool_call_id: tc.id,
          content: JSON.stringify(toolResult, null, 2),
        };
      });

      const toolResults = await Promise.all(toolPromises);
      messages.push(...toolResults);

      // Continue streaming. On the final allowed iteration, disable tool calling
      // so the model has to answer in words rather than loop again.
      const forceAnswer = iterations >= MAX_TOOL_ITERATIONS;
      if (forceAnswer) {
        console.warn(
          `[llm] tool loop hit ${MAX_TOOL_ITERATIONS} iterations — forcing a final answer`
        );
      }
      events.onTurn?.();
      result = await this.streamCompletion(messages, isVoice, onChunk, forceAnswer, conversationId);
      if (forceAnswer) break;
    }

    const responseText = result.text;

    // 6. Store assistant response
    if (conversationId && responseText) {
      this.conversations.storeMessage(conversationId, userId, "assistant", responseText);
    }

    // 7. Extract and store facts (fire-and-forget). Memories a forget_memory
    // call touched this turn are filtered out of the extraction so they can't
    // be re-learned from the "forget that X" transcript.
    extractAndStoreFacts(
      this.memory,
      this.extractor,
      userId,
      message,
      responseText,
      toolCtx.forgetTargets
    ).catch((err) => console.error("Fact extraction failed:", err));

    // 8. If the model produced no usable response, attach a structured error
    // so the HA integration can surface a useful hint instead of the generic
    // "I received your request but got no response." fallback. The `finish_reason`
    // from the final stream tells us which diagnostic applies.
    const error = responseText === "" && result.toolCalls.length === 0
      ? this.classifyEmptyResponse(result.finishReason, result.usage)
      : undefined;

    // A reply that ran out of room but did write something is the *common* case,
    // and it used to be delivered silently: the integration returns the text
    // whenever there is any, so `error` never reached the reader and a sentence
    // stopping in the middle looked like the assistant's own choice. Say so in
    // the reply itself, which is the only channel every caller shares.
    const truncated = result.finishReason === "length" && responseText !== "";
    const response = truncated
      ? responseText + (isVoice ? VOICE_TRUNCATION_NOTICE : TRUNCATION_NOTICE)
      : responseText;

    return {
      response,
      toolsUsed,
      factsLearned: 0,
      ...(error ? { error } : {}),
    };
  }

  private classifyEmptyResponse(
    finishReason: string | null,
    usage?: TokenUsage
  ): ChatError {
    if (finishReason === "length") {
      // The output cap covers hidden reasoning as well as the visible answer, so
      // a reasoning-heavy turn can exhaust it without writing a single word.
      // That needs different advice from a prompt being too large, and the two
      // are only distinguishable from the reported token counts. This used to be
      // decided by which spelling of the cap parameter the model accepted, which
      // told us nothing on providers that accept both.
      const hint = spentBudgetOnReasoning(usage)
        ? "Nives ran out of room before it could write the answer. The model " +
          "spent this turn's budget working the problem out and had none left " +
          "for the reply. A shorter time range, or fewer sensors in one " +
          "question, will usually get it through."
        : "Nives ran out of room before it could finish the answer. A shorter " +
          "time range, or fewer sensors in one question, will usually get it " +
          "through.";
      return { code: "MAX_TOKENS_TRUNCATED", hint };
    }
    if (finishReason === "content_filter") {
      return {
        code: "CONTENT_FILTERED",
        hint:
          "The provider blocked the response (content filter). " +
          "If this happens on benign smart-home commands, try a different model.",
      };
    }
    return {
      code: "EMPTY_CONTENT",
      hint:
        "The model returned no text and no tool calls. " +
        "If you're routing through an OpenAI-compatible shim/proxy, verify it streams " +
        "OpenAI-format SSE chunks. For local models, ensure the model emits a final " +
        "answer rather than just thinking. For the fact extractor specifically, set " +
        "OPENAI_RESPONSE_FORMAT=json_object on picky providers (e.g. some Ollama models).",
    };
  }


  /** Ceiling on one reply; see WRITTEN_OUTPUT_CAP for why it is what it is. */
  private maxOutputTokens(isVoice: boolean): number {
    return this.config.maxOutputTokens ?? (isVoice ? VOICE_OUTPUT_CAP : WRITTEN_OUTPUT_CAP);
  }

  /** True when the endpoint is OpenRouter, where its own request fields apply. */
  private isOpenRouter(): boolean {
    return /openrouter\.ai/i.test(this.config.openaiBaseUrl ?? "");
  }

  /**
   * True when the endpoint is Mistral, which rejects any field outside its own
   * schema (422 "Extra inputs are not permitted"). It has no `stream_options`
   * and reports usage on the last chunk unasked.
   */
  private isMistral(): boolean {
    return /api\.mistral\.ai/i.test(this.config.openaiBaseUrl ?? "");
  }

  private async streamCompletion(
    messages: OpenAI.ChatCompletionMessageParam[],
    isVoice: boolean,
    onChunk?: StreamCallback,
    disableTools = false,
    sessionId?: string
  ): Promise<{
    text: string;
    finishReason: string | null;
    toolCalls: FunctionToolCall[];
    usage?: TokenUsage;
  }> {
    const cap = this.maxOutputTokens(isVoice);
    const startedAt = Date.now();
    const stream = await withTokenCap(this.config.llmModel, cap, (capParam) =>
      withReasoningEffort(
        this.config.llmModel,
        this.config.reasoningEffort,
        (reasoning) =>
          this.client.chat.completions.create({
            model: this.config.llmModel,
            ...capParam,
            ...reasoning,
            messages,
            tools: OPENAI_TOOLS,
            // Keep the tool list in the request (history already references it) but
            // stop the model from issuing more calls.
            ...(disableTools ? { tool_choice: "none" as const } : {}),
            stream: true,
            // Ask for the token breakdown. Without this a streamed call reports no
            // usage at all, which is why a cap being spent entirely on reasoning
            // looked identical to a prompt being too large. Mistral is exempt: it
            // answers the field with a 422 and sends usage on the last chunk anyway.
            ...(this.isMistral() ? {} : { stream_options: { include_usage: true } }),
            // OpenRouter only: a stable session id pins the follow-up turns of one
            // conversation to the provider endpoint that already holds the warm
            // prompt cache, instead of re-balancing every turn. Other endpoints
            // reject unknown fields, so it is not sent to them.
            ...(this.isOpenRouter() && sessionId ? { session_id: sessionId } : {}),
          }),
        this.client.baseURL
      )
    );

    let text = "";
    let finishReason: string | null = null;
    let usage: TokenUsage | undefined;
    // OpenRouter names the provider that served the request on every chunk.
    // Which one it was is the difference between a 1 s and a 3 s first token.
    let provider: string | undefined;

    // Tool calls in arrival order. OpenAI streams one call over several deltas
    // that share an `index`; other OpenAI-compatible endpoints send each call
    // whole, with its own `id` and no `index`. A delta continues the call its
    // index points at (or, without an index, the latest one) unless it carries
    // a different id, which always opens a new call.
    const calls: { id: string; name: string; arguments: string; extraContent?: unknown }[] = [];
    const callAtIndex = new Map<number, number>();

    for await (const chunk of stream) {
      // The usage chunk arrives last and carries no choices, so read it before
      // the guard below skips it.
      if (chunk.usage) usage = readUsage(chunk.usage);
      const served = (chunk as { provider?: unknown }).provider;
      if (typeof served === "string" && served) provider = served;

      const choice = chunk.choices[0];
      if (!choice) continue;

      // Accumulate text
      if (choice.delta?.content) {
        text += choice.delta.content;
        if (onChunk) {
          onChunk(choice.delta.content);
        }
      }

      // Accumulate tool call deltas
      if (choice.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          const at = tc.index === undefined ? calls.length - 1 : callAtIndex.get(tc.index);
          const existing = at === undefined ? undefined : calls[at];
          const isOtherCall = Boolean(existing && tc.id && existing.id && tc.id !== existing.id);
          if (existing && !isOtherCall) {
            // Append to existing tool call's arguments
            if (tc.function?.arguments) {
              existing.arguments += tc.function.arguments;
            }
            existing.extraContent ??= extraContentOf(tc);
          } else {
            calls.push({
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
              extraContent: extraContentOf(tc),
            });
            if (tc.index !== undefined) callAtIndex.set(tc.index, calls.length - 1);
          }
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }

    // Convert accumulated tool calls to the expected format
    const toolCalls: FunctionToolCall[] = [];
    for (const tc of calls) {
      toolCalls.push({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
        // Handed back untouched in the assistant message; absent when not sent.
        ...(tc.extraContent !== undefined ? { extra_content: tc.extraContent } : {}),
      });
    }

    // A cap that runs out is worth a line in the log whatever it interrupted.
    // It cuts tool-call arguments mid-JSON as readily as it cuts an answer, and
    // that case leaves no trace at all in the reply the user sees.
    if (finishReason === "length") {
      console.warn(
        `[llm] output cap reached: cap=${cap} ${describeUsage(usage)} ` +
          `visible_chars=${text.length} tool_calls=${toolCalls.length} ` +
          `model=${this.config.llmModel}${provider ? ` provider=${provider}` : ""}`
      );
    } else if (this.config.logLevel === "debug") {
      // Knowing what a *successful* turn cost is what tells you how close the
      // ceiling is. Reading usage only from failures shows the cases that
      // already went wrong and nothing about the margin on the rest.
      console.log(
        `[llm] turn ok: cap=${cap} ${describeUsage(usage)} ` +
          `finish=${finishReason ?? "none"} tool_calls=${toolCalls.length} ` +
          `ms=${Date.now() - startedAt}${provider ? ` provider=${provider}` : ""}`
      );
    }

    return { text, finishReason, toolCalls, usage };
  }
}

/** Tool-call arguments as an object; `{}` when they are not valid JSON. */
function parseArgs(tc: FunctionToolCall): Record<string, unknown> {
  try {
    const parsed = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
