import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";
import type { IMemoryStore } from "../memory/interface.js";
import type { IConversationStore } from "../memory/types.js";
import { HomeAssistantClient } from "../ha/client.js";
import { DeviceScanner } from "../ha/device-scanner.js";
import { TopologyScanner } from "../ha/topology-scanner.js";
import { buildSystemPrompt, type CachedSystemPrompt } from "./prompts.js";
import { HA_TOOLS } from "./tools.js";
import { randomUUID } from "node:crypto";
import { handleToolCall, extractAndStoreFacts, type ToolContext } from "./tool-handler.js";
import { describeLongBatch } from "./long-task.js";
import { TOOL_CAP_HINT } from "./forced-answer.js";
import { toStreamEvents } from "./interface.js";
import {
  readUsage,
  describeUsage,
  WRITTEN_OUTPUT_CAP,
  VOICE_OUTPUT_CAP,
  TRUNCATION_NOTICE,
  VOICE_TRUNCATION_NOTICE,
} from "./usage.js";
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamEvents,
  ChatError,
  StreamCallback,
  IChatEngine,
  IFactExtractor,
} from "./interface.js";

export type { ChatRequest, ChatResponse, StreamCallback };

/**
 * Hard cap on tool round-trips per user message — see the matching constant in
 * openai-client.ts. On the last iteration we re-ask with tool_choice "none" so
 * the user gets a written answer rather than a silent timeout.
 */
const MAX_TOOL_ITERATIONS = 8;

export class LLMClient implements IChatEngine {
  private anthropic: Anthropic;
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
    this.anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
    this.memory = memory;
    this.conversations = conversations;
    this.extractor = extractor;
    this.ha = ha;
    this.scanner = scanner;
    this.topology = topology;
  }

  /**
   * Chat with streaming - uses Anthropic's streaming API for faster time-to-first-token.
   * Optional onChunk callback receives text chunks as they arrive.
   */
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

    // 1. Load user's memory (pass current message as context for Shodh's proactive retrieval)
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
    const systemPrompt = buildSystemPrompt(factContents, isVoice, customPrompt, deviceCheatSheet, homeLayout, language, this.config.ttsVoiceGender);

    // 3. Load conversation history if we have a conversationId
    const messages: Anthropic.MessageParam[] = [];

    if (conversationId) {
      const history = await this.conversations.getConversationHistory(conversationId, 10);
      for (const msg of history) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    // 4. Add current user message (multimodal when images are present)
    if (request.images && request.images.length > 0) {
      const imageBlocks: Anthropic.ImageBlockParam[] = request.images.map((img) => {
        const m = /^data:([^;]+);base64,(.*)$/s.exec(img);
        if (m) {
          return {
            type: "image",
            source: {
              type: "base64",
              media_type: m[1] as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: m[2],
            },
          };
        }
        // Plain URL
        return { type: "image", source: { type: "url", url: img } };
      });
      messages.push({
        role: "user",
        content: [{ type: "text", text: message }, ...imageBlocks],
      });
    } else {
      messages.push({ role: "user", content: message });
    }

    // Store user message in conversation history (text only; images are ephemeral)
    if (conversationId) {
      this.conversations.storeMessage(conversationId, userId, "user", message);
    }

    events.onTurn?.();
    let response = await this.streamMessage(
      systemPrompt,
      messages,
      isVoice,
      onChunk
    );

    // 4. Handle tool calls in a loop
    let iterations = 0;
    while (response.stop_reason === "tool_use") {
      iterations++;
      const assistantContent = response.content;
      messages.push({ role: "assistant", content: assistantContent });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      // Execute tools in parallel for better performance
      const toolBlocks = assistantContent.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );

      // Same moment as in the OpenAI engine: the batch is known, nothing has
      // run, and the person waiting can be told it will take a while.
      if (!announced) {
        const heads = describeLongBatch(
          toolBlocks.map((b) => ({ name: b.name, args: b.input as Record<string, unknown> }))
        );
        if (heads) {
          announced = true;
          const wrote = assistantContent.some(
            (b): b is Anthropic.TextBlock => b.type === "text" && b.text.trim() !== ""
          );
          if (!wrote) events.onStatus?.(heads);
        }
      }

      const toolPromises = toolBlocks.map(async (block) => {
        toolsUsed.push(block.name);
        const result = await handleToolCall(
          this.ha,
          block.name,
          block.input as Record<string, unknown>,
          toolCtx
        );
        return {
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: JSON.stringify(result, null, 2),
        };
      });

      const results = await Promise.all(toolPromises);
      toolResults.push(...results);

      messages.push({ role: "user", content: toolResults });

      // Continue with streaming for the follow-up response. On the final allowed
      // iteration, stop the model issuing more calls so it has to answer.
      const forceAnswer = iterations >= MAX_TOOL_ITERATIONS;
      if (forceAnswer) {
        console.warn(
          `[llm] tool loop hit ${MAX_TOOL_ITERATIONS} iterations — forcing a final answer`
        );
      }
      events.onTurn?.();
      response = await this.streamMessage(
        systemPrompt,
        messages,
        isVoice,
        onChunk,
        forceAnswer
      );
      if (forceAnswer) break;
    }

    // 5. Extract final text response
    const textContent = response.content.find((c) => c.type === "text");
    const responseText = textContent?.type === "text" ? textContent.text : "";

    // 6. Store assistant response in conversation history
    if (conversationId && responseText) {
      this.conversations.storeMessage(conversationId, userId, "assistant", responseText);
    }

    // 7. Extract and store new facts (async, don't block response). Memories a
    // forget_memory call touched this turn are filtered out of the extraction
    // so they can't be re-learned from the "forget that X" transcript.
    extractAndStoreFacts(
      this.memory,
      this.extractor,
      userId,
      message,
      responseText,
      toolCtx.forgetTargets
    ).catch((err) => console.error("Fact extraction failed:", err));

    // 8. Nothing usable came back: say why, so the integration can show a real
    // hint instead of "I received your request but got no response."
    //
    // A model that still asks for a tool on the forced last turn has given no
    // answer: the loop has stopped and the call is not run. Say so, as the
    // OpenAI engine does, rather than return an empty reply that looks like
    // success. (The loop only reaches MAX_TOOL_ITERATIONS by forcing that turn.)
    const toolUseCount = response.content.filter((c) => c.type === "tool_use").length;
    const error: ChatError | undefined =
      responseText !== ""
        ? undefined
        : toolUseCount === 0
          ? this.classifyEmptyResponse(response.stop_reason)
          : iterations >= MAX_TOOL_ITERATIONS
            ? { code: "EMPTY_CONTENT", hint: TOOL_CAP_HINT }
            : undefined;

    // A reply that ran out of room but did write something is the common case,
    // and the integration returns text whenever there is any, so `error` would
    // never reach the reader. Say so in the reply itself.
    const truncated = response.stop_reason === "max_tokens" && responseText !== "";
    const finalText = truncated
      ? responseText + (isVoice ? VOICE_TRUNCATION_NOTICE : TRUNCATION_NOTICE)
      : responseText;

    // Count facts learned (we don't wait for extraction, so return 0 for now)
    return {
      response: finalText,
      toolsUsed,
      factsLearned: 0,
      ...(error ? { error } : {}),
    };
  }

  private classifyEmptyResponse(stopReason: string | null): ChatError {
    if (stopReason === "max_tokens") {
      // Anthropic reports no separate reasoning count, so unlike the OpenAI
      // engine there is nothing here to distinguish "spent it thinking" from
      // "prompt too large". The advice is the same either way.
      return {
        code: "MAX_TOKENS_TRUNCATED",
        hint:
          "Nives ran out of room before it could finish the answer. A shorter " +
          "time range, or fewer sensors in one question, will usually get it " +
          "through.",
      };
    }
    return {
      code: "EMPTY_CONTENT",
      hint:
        "The model returned no text and no tool calls. If this keeps happening " +
        "with a particular question, try rephrasing it.",
    };
  }

  /**
   * Stream a message and return the final message object.
   * Calls onChunk with text deltas as they arrive.
   * Uses prompt caching for the static system prompt.
   */

  /** Ceiling on one reply; see WRITTEN_OUTPUT_CAP for why it is what it is. */
  private maxOutputTokens(isVoice: boolean): number {
    return this.config.maxOutputTokens ?? (isVoice ? VOICE_OUTPUT_CAP : WRITTEN_OUTPUT_CAP);
  }

  private async streamMessage(
    systemPrompt: CachedSystemPrompt,
    messages: Anthropic.MessageParam[],
    isVoice: boolean,
    onChunk?: StreamCallback,
    disableTools = false
  ): Promise<Anthropic.Message> {
    const cap = this.maxOutputTokens(isVoice);
    const startedAt = Date.now();
    const stream = this.anthropic.messages.stream({
      model: this.config.llmModel,
      max_tokens: cap,
      system: systemPrompt,
      tools: HA_TOOLS,
      // Keep the tool list (history references it) but stop further calls.
      ...(disableTools ? { tool_choice: { type: "none" as const } } : {}),
      messages,
    });

    // Stream text chunks to callback if provided
    if (onChunk) {
      stream.on("text", (textDelta) => {
        onChunk(textDelta);
      });
    }

    // Wait for the complete message
    const message = await stream.finalMessage();

    // Anthropic always reports usage on the final message, so unlike the OpenAI
    // engine nothing has to be requested for it. Same two lines as over there:
    // a cap running out is a warning whatever it interrupted, and what a
    // successful turn cost is what says how much margin is left.
    const usage = readUsage(message.usage);
    const visibleChars = message.content
      .filter((c): c is Anthropic.TextBlock => c.type === "text")
      .reduce((n, c) => n + c.text.length, 0);
    const toolUses = message.content.filter((c) => c.type === "tool_use").length;
    if (message.stop_reason === "max_tokens") {
      console.warn(
        `[llm] output cap reached: cap=${cap} ${describeUsage(usage)} ` +
          `visible_chars=${visibleChars} tool_calls=${toolUses} model=${this.config.llmModel}`
      );
    } else if (this.config.logLevel === "debug") {
      console.log(
        `[llm] turn ok: cap=${cap} ${describeUsage(usage)} ` +
          `finish=${message.stop_reason ?? "none"} tool_calls=${toolUses} ` +
          `ms=${Date.now() - startedAt}`
      );
    }

    return message;
  }
}
