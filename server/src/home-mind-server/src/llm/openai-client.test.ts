import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Config } from "../config.js";
import type { IMemoryStore } from "../memory/interface.js";
import type { IConversationStore } from "../memory/types.js";
import type { IFactExtractor } from "./interface.js";
import type { HomeAssistantClient } from "../ha/client.js";
import { DeviceScanner } from "../ha/device-scanner.js";
import { TopologyScanner } from "../ha/topology-scanner.js";

// Async iterator helper for simulating OpenAI streams
function makeStream(chunks: object[]) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < chunks.length)
            return { value: chunks[i++], done: false as const };
          return { value: undefined, done: true as const };
        },
      };
    },
  };
}

const mockCreate = vi.fn();

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: mockCreate,
        },
      };
    },
  };
});

vi.mock("./tool-handler.js", () => ({
  handleToolCall: vi.fn().mockResolvedValue({ state: "on" }),
  extractAndStoreFacts: vi.fn().mockResolvedValue(1),
}));

import { OpenAIChatEngine } from "./openai-client.js";
import { resetTokenCapCache } from "./token-cap.js";
import { resetReasoningEffortCache } from "./reasoning-effort.js";
import { handleToolCall, extractAndStoreFacts } from "./tool-handler.js";

describe("OpenAIChatEngine", () => {
  let engine: OpenAIChatEngine;
  let memory: IMemoryStore;
  let conversations: IConversationStore;
  let extractor: IFactExtractor;
  let ha: HomeAssistantClient;
  let config: Config;

  beforeEach(() => {
    resetTokenCapCache();
    resetReasoningEffortCache();
    mockCreate.mockReset();
    vi.mocked(handleToolCall).mockReset();
    vi.mocked(extractAndStoreFacts).mockReset();

    vi.mocked(handleToolCall).mockResolvedValue({ state: "on" });
    vi.mocked(extractAndStoreFacts).mockResolvedValue(1);

    memory = {
      getFactsWithinTokenLimit: vi.fn().mockResolvedValue([]),
    } as unknown as IMemoryStore;

    conversations = {
      getConversationHistory: vi.fn().mockReturnValue([]),
      storeMessage: vi.fn(),
      getKnownUsers: vi.fn().mockReturnValue([]),
      cleanupOldConversations: vi.fn().mockReturnValue(0),
      close: vi.fn(),
    } as unknown as IConversationStore;

    extractor = {} as IFactExtractor;

    ha = {} as HomeAssistantClient;

    config = {
      llmProvider: "openai",
      llmModel: "gpt-4o-mini",
      openaiApiKey: "test-key",
      memoryTokenLimit: 1500,
    } as Config;

    const mockScanner = {
      refreshIfStale: vi.fn().mockResolvedValue(undefined),
      hasProfiles: vi.fn().mockReturnValue(false),
      formatCheatSheet: vi.fn().mockReturnValue(""),
    } as unknown as DeviceScanner;
    const mockTopology = {
      refreshIfStale: vi.fn().mockResolvedValue(undefined),
      hasLayout: vi.fn().mockReturnValue(false),
      formatSection: vi.fn().mockReturnValue(""),
    } as unknown as TopologyScanner;
    engine = new OpenAIChatEngine(config, memory, conversations, extractor, ha, mockScanner, mockTopology);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("accumulates text from stream deltas", async () => {
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
        { choices: [{ delta: { content: " world" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    const result = await engine.chat({
      message: "Hi",
      userId: "user-1",
    });

    expect(result.response).toBe("Hello world");
  });

  it("sends images as image_url content blocks when provided", async () => {
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "ok" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    await engine.chat({
      message: "What's in this image?",
      userId: "user-1",
      images: ["data:image/png;base64,AAAA"],
    });

    const sent = mockCreate.mock.calls[0][0];
    const userMsg = [...sent.messages].reverse().find((m: { role: string }) => m.role === "user");
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content[0]).toEqual({ type: "text", text: "What's in this image?" });
    expect(userMsg.content[1]).toMatchObject({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAAA" },
    });
  });

  it("sends a plain string user message when no images", async () => {
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "ok" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    await engine.chat({ message: "Hello", userId: "user-1" });

    const sent = mockCreate.mock.calls[0][0];
    const userMsg = [...sent.messages].reverse().find((m: { role: string }) => m.role === "user");
    expect(userMsg.content).toBe("Hello");
  });

  it("fires onChunk callback for each text delta", async () => {
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "A" }, finish_reason: null }] },
        { choices: [{ delta: { content: "B" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    const chunks: string[] = [];
    await engine.chat({ message: "Hi", userId: "user-1" }, (chunk) =>
      chunks.push(chunk)
    );

    expect(chunks).toEqual(["A", "B"]);
  });

  it("accumulates tool call deltas across chunks", async () => {
    // First stream: tool call
    mockCreate.mockResolvedValueOnce(
      makeStream([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    function: { name: "get_state", arguments: '{"entity' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '_id":"light.kitchen"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ])
    );

    // Second stream: final response after tool result
    mockCreate.mockResolvedValueOnce(
      makeStream([
        {
          choices: [
            { delta: { content: "The light is on" }, finish_reason: null },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    const result = await engine.chat({ message: "Is the light on?", userId: "user-1" });

    expect(handleToolCall).toHaveBeenCalledWith(
      ha,
      "get_state",
      { entity_id: "light.kitchen" },
      expect.objectContaining({ turnId: expect.any(String) })
    );
    expect(result.response).toBe("The light is on");
    expect(result.toolsUsed).toEqual(["get_state"]);
  });

  it("handles multiple tool calls in one response", async () => {
    // First stream: two tool calls
    mockCreate.mockResolvedValueOnce(
      makeStream([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    function: {
                      name: "get_state",
                      arguments: '{"entity_id":"sensor.temp"}',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 1,
                    id: "call-2",
                    function: {
                      name: "get_state",
                      arguments: '{"entity_id":"sensor.humidity"}',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ])
    );

    // Second stream: final response
    mockCreate.mockResolvedValueOnce(
      makeStream([
        { choices: [{ delta: { content: "22°C, 45%" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    const result = await engine.chat({ message: "temp and humidity?", userId: "user-1" });

    expect(handleToolCall).toHaveBeenCalledTimes(2);
    expect(result.toolsUsed).toEqual(["get_state", "get_state"]);
  });

  describe("OpenAI-compatible endpoints that stream differently", () => {
    const toolDelta = (toolCall: object, finish_reason: string | null = null) => ({
      choices: [{ delta: { tool_calls: [toolCall] }, finish_reason }],
    });
    const answer = (text: string) =>
      makeStream([{ choices: [{ delta: { content: text }, finish_reason: "stop" }] }]);
    const assistantToolCalls = (call: number) =>
      mockCreate.mock.calls[call][0].messages.find(
        (m: { role: string }) => m.role === "assistant"
      ).tool_calls;

    it("runs the tool calls of a turn that reports finish_reason stop", async () => {
      mockCreate.mockResolvedValueOnce(
        makeStream([
          toolDelta(
            { index: 0, id: "call-1", function: { name: "get_state", arguments: '{"entity_id":"sensor.t"}' } },
            "stop"
          ),
        ])
      );
      mockCreate.mockResolvedValueOnce(answer("20 °C"));

      const result = await engine.chat({ message: "temperature?", userId: "user-1" });

      expect(handleToolCall).toHaveBeenCalledWith(
        ha,
        "get_state",
        { entity_id: "sensor.t" },
        expect.anything()
      );
      expect(result.toolsUsed).toEqual(["get_state"]);
      expect(result.response).toBe("20 °C");
      expect(result.error).toBeUndefined();
    });

    it("keeps parallel calls apart when each arrives whole with its own id and no index", async () => {
      mockCreate.mockResolvedValueOnce(
        makeStream([
          toolDelta({
            id: "call_a",
            type: "function",
            function: { name: "get_state", arguments: '{"entity_id":"climate.living_room"}' },
          }),
          toolDelta({
            id: "call_b",
            type: "function",
            function: { name: "search_entities", arguments: '{"query":"living room"}' },
          }),
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ])
      );
      mockCreate.mockResolvedValueOnce(answer("ok"));

      await engine.chat({ message: "living room?", userId: "user-1" });

      const sent = assistantToolCalls(1);
      expect(sent.map((c: { id: string }) => c.id)).toEqual(["call_a", "call_b"]);
      expect(sent[0].function).toEqual({
        name: "get_state",
        arguments: '{"entity_id":"climate.living_room"}',
      });
      expect(sent[1].function).toEqual({
        name: "search_entities",
        arguments: '{"query":"living room"}',
      });
      expect(handleToolCall).toHaveBeenCalledTimes(2);
    });

    it("opens a new call when a delta brings a new id under an index already in use", async () => {
      mockCreate.mockResolvedValueOnce(
        makeStream([
          toolDelta({ index: 0, id: "call_a", function: { name: "get_state", arguments: '{"entity_id":"a.b"}' } }),
          toolDelta({ index: 0, id: "call_b", function: { name: "get_state", arguments: '{"entity_id":"c.d"}' } }),
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ])
      );
      mockCreate.mockResolvedValueOnce(answer("ok"));

      await engine.chat({ message: "both?", userId: "user-1" });

      const sent = assistantToolCalls(1);
      expect(sent.map((c: { id: string }) => c.id)).toEqual(["call_a", "call_b"]);
      expect(sent[1].function.arguments).toBe('{"entity_id":"c.d"}');
    });

    it("still joins calls streamed in pieces under their index, even interleaved", async () => {
      mockCreate.mockResolvedValueOnce(
        makeStream([
          toolDelta({ index: 0, id: "call-1", function: { name: "get_state", arguments: '{"entity_id":' } }),
          toolDelta({ index: 1, id: "call-2", function: { name: "get_state", arguments: '{"entity_id":' } }),
          toolDelta({ index: 0, function: { arguments: '"sensor.temp"}' } }),
          toolDelta({ index: 1, function: { arguments: '"sensor.humidity"}' } }),
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ])
      );
      mockCreate.mockResolvedValueOnce(answer("22 °C, 45 %"));

      const result = await engine.chat({ message: "temp and humidity?", userId: "user-1" });

      const sent = assistantToolCalls(1);
      expect(sent.map((c: { id: string }) => c.id)).toEqual(["call-1", "call-2"]);
      expect(sent[0].function.arguments).toBe('{"entity_id":"sensor.temp"}');
      expect(sent[1].function.arguments).toBe('{"entity_id":"sensor.humidity"}');
      expect(result.response).toBe("22 °C, 45 %");
    });

    it("hands a tool call's extra_content back untouched on the next turn", async () => {
      const extra = { vendor: { signature: "sig-abc" } };
      mockCreate.mockResolvedValueOnce(
        makeStream([
          toolDelta({
            index: 0,
            id: "call-1",
            function: { name: "get_state", arguments: '{"entity_id":"light.a"}' },
            extra_content: extra,
          }),
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ])
      );
      mockCreate.mockResolvedValueOnce(answer("On"));

      await engine.chat({ message: "light?", userId: "user-1" });

      expect(assistantToolCalls(1)[0].extra_content).toEqual(extra);
    });

    it("keeps extra_content with its own call when parallel calls arrive whole", async () => {
      const extra = { vendor: { signature: "sig" } };
      mockCreate.mockResolvedValueOnce(
        makeStream([
          toolDelta({
            id: "call_a",
            function: { name: "get_state", arguments: "{}" },
            extra_content: extra,
          }),
          toolDelta({ id: "call_b", function: { name: "get_state", arguments: "{}" } }),
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ])
      );
      mockCreate.mockResolvedValueOnce(answer("ok"));

      await engine.chat({ message: "x", userId: "user-1" });

      const sent = assistantToolCalls(1);
      expect(sent[0].extra_content).toEqual(extra);
      expect(sent[1]).not.toHaveProperty("extra_content");
    });

    it("omits extra_content when the endpoint sends none", async () => {
      mockCreate.mockResolvedValueOnce(
        makeStream([
          toolDelta({ index: 0, id: "call-1", function: { name: "get_state", arguments: "{}" } }, "tool_calls"),
        ])
      );
      mockCreate.mockResolvedValueOnce(answer("ok"));

      await engine.chat({ message: "x", userId: "user-1" });

      expect(assistantToolCalls(1)[0]).not.toHaveProperty("extra_content");
    });

    it("keeps the empty-response diagnosis when a tool turn ends without a word", async () => {
      // No canned reply is substituted: the voice path and the integration
      // decide what to say, in the user's language.
      mockCreate.mockResolvedValueOnce(
        makeStream([
          toolDelta({ index: 0, id: "call-1", function: { name: "call_service", arguments: "{}" } }, "stop"),
        ])
      );
      mockCreate.mockResolvedValueOnce(
        makeStream([{ choices: [{ delta: {}, finish_reason: "stop" }] }])
      );

      const result = await engine.chat({ message: "lights on", userId: "user-1" });

      expect(result.response).toBe("");
      expect(result.error?.code).toBe("EMPTY_CONTENT");
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it("still bounds the loop and forces an answer when every turn reports stop", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      mockCreate.mockImplementation(async () =>
        makeStream([
          toolDelta({ index: 0, id: "call-1", function: { name: "get_state", arguments: "{}" } }, "stop"),
        ])
      );

      await engine.chat({ message: "x", userId: "user-1" });

      // One opening request plus eight tool rounds; the last one may not call tools.
      expect(mockCreate).toHaveBeenCalledTimes(9);
      expect(mockCreate.mock.calls[8][0].tool_choice).toBe("none");
      expect(mockCreate.mock.calls[7][0]).not.toHaveProperty("tool_choice");
    });
  });

  describe("reasoning_effort", () => {
    const reply = () =>
      makeStream([{ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }]);

    it("is not sent when unconfigured", async () => {
      mockCreate.mockResolvedValue(reply());

      await engine.chat({ message: "x", userId: "user-1" });

      expect(mockCreate.mock.calls[0][0]).not.toHaveProperty("reasoning_effort");
    });

    it("is sent when configured", async () => {
      config.reasoningEffort = "low";
      mockCreate.mockResolvedValue(reply());

      await engine.chat({ message: "x", userId: "user-1" });

      expect(mockCreate.mock.calls[0][0].reasoning_effort).toBe("low");
    });

    it("is dropped, and stays dropped, for a model that rejects it", async () => {
      vi.spyOn(console, "info").mockImplementation(() => {});
      config.reasoningEffort = "low";
      const rejection = Object.assign(
        new Error("400 Unrecognized request argument supplied: reasoning_effort"),
        { status: 400 }
      );
      mockCreate.mockRejectedValueOnce(rejection).mockImplementation(async () => reply());

      const first = await engine.chat({ message: "x", userId: "user-1" });
      await engine.chat({ message: "y", userId: "user-1" });

      expect(first.response).toBe("hi");
      expect(mockCreate).toHaveBeenCalledTimes(3);
      expect(mockCreate.mock.calls[0][0].reasoning_effort).toBe("low");
      expect(mockCreate.mock.calls[1][0]).not.toHaveProperty("reasoning_effort");
      expect(mockCreate.mock.calls[2][0]).not.toHaveProperty("reasoning_effort");
    });

    it("surfaces an unrelated 400 instead of retrying", async () => {
      config.reasoningEffort = "low";
      const unrelated = Object.assign(new Error("400 model not found"), { status: 400 });
      mockCreate.mockRejectedValueOnce(unrelated);

      await expect(engine.chat({ message: "x", userId: "user-1" })).rejects.toBe(unrelated);
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it("works alongside the max_tokens negotiation", async () => {
      vi.spyOn(console, "info").mockImplementation(() => {});
      config.reasoningEffort = "medium";
      const capRejection = Object.assign(
        new Error("400 Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead."),
        { status: 400, param: "max_tokens", code: "unsupported_parameter" }
      );
      const effortRejection = Object.assign(new Error("400 Unknown parameter: reasoning_effort"), {
        status: 400,
        param: "reasoning_effort",
      });
      mockCreate
        .mockRejectedValueOnce(capRejection)
        .mockRejectedValueOnce(effortRejection)
        .mockImplementation(async () => reply());

      const result = await engine.chat({ message: "x", userId: "user-1" });

      expect(result.response).toBe("hi");
      expect(mockCreate).toHaveBeenCalledTimes(3);
      const last = mockCreate.mock.calls[2][0];
      expect(last.max_completion_tokens).toBe(8192);
      expect(last).not.toHaveProperty("max_tokens");
      expect(last).not.toHaveProperty("reasoning_effort");
    });
  });

  it("loads conversation history when conversationId provided", async () => {
    (conversations.getConversationHistory as ReturnType<typeof vi.fn>).mockReturnValue([
      { role: "user", content: "previous question" },
      { role: "assistant", content: "previous answer" },
    ]);

    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "Response" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    await engine.chat({
      message: "follow up",
      userId: "user-1",
      conversationId: "conv-1",
    });

    expect(conversations.getConversationHistory).toHaveBeenCalledWith("conv-1", 10);

    // Check messages passed to OpenAI include history
    const createCall = mockCreate.mock.calls[0][0];
    expect(createCall.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "previous question" }),
        expect.objectContaining({
          role: "assistant",
          content: "previous answer",
        }),
      ])
    );
  });

  it("stores user and assistant messages when conversationId present", async () => {
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "Hi!" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    await engine.chat({
      message: "Hello",
      userId: "user-1",
      conversationId: "conv-1",
    });

    expect(conversations.storeMessage).toHaveBeenCalledWith(
      "conv-1",
      "user-1",
      "user",
      "Hello"
    );
    expect(conversations.storeMessage).toHaveBeenCalledWith(
      "conv-1",
      "user-1",
      "assistant",
      "Hi!"
    );
  });

  it("does not store messages when conversationId absent", async () => {
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "Hi!" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    await engine.chat({ message: "Hello", userId: "user-1" });

    expect(conversations.storeMessage).not.toHaveBeenCalled();
  });

  it("uses max_tokens 500 for voice mode", async () => {
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "Short" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    await engine.chat({
      message: "Hi",
      userId: "user-1",
      isVoice: true,
    });

    const createCall = mockCreate.mock.calls[0][0];
    expect(createCall.max_tokens).toBe(500);
  });

  it("honours a configured output cap, which OPENAI_MAX_TOKENS never reached before", async () => {
    // The documented setting only ever reached the fact extractor, so a user
    // whose replies were being truncated could set it and see no change.
    config.maxOutputTokens = 8000;
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "Hi!" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    await engine.chat({ message: "Hello", userId: "user-1" });

    expect(mockCreate.mock.calls[0][0].max_tokens).toBe(8000);
  });

  it("uses max_tokens 8192 for non-voice mode", async () => {
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "Long" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    await engine.chat({ message: "Hi", userId: "user-1" });

    const createCall = mockCreate.mock.calls[0][0];
    expect(createCall.max_tokens).toBe(8192);
  });

  it("retries with max_completion_tokens when the model rejects max_tokens (issue #60)", async () => {
    const rejection = Object.assign(
      new Error(
        "400 Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."
      ),
      { status: 400, param: "max_tokens", code: "unsupported_parameter" }
    );
    mockCreate.mockRejectedValueOnce(rejection).mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    const result = await engine.chat({ message: "Hi", userId: "user-1" });

    expect(result.response).toBe("Hello");
    expect(mockCreate.mock.calls[0][0].max_tokens).toBe(8192);
    expect(mockCreate.mock.calls[0][0].max_completion_tokens).toBeUndefined();
    expect(mockCreate.mock.calls[1][0].max_completion_tokens).toBe(8192);
    expect(mockCreate.mock.calls[1][0].max_tokens).toBeUndefined();
  });

  it("fires extractAndStoreFacts after response", async () => {
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "Response" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    await engine.chat({ message: "Remember I like 22°C", userId: "user-1" });

    expect(extractAndStoreFacts).toHaveBeenCalledWith(
      memory,
      extractor,
      "user-1",
      "Remember I like 22°C",
      "Response",
      undefined // no forget_memory in this turn → nothing to filter out
    );
  });

  it("catches extraction errors without failing the response", async () => {
    vi.mocked(extractAndStoreFacts).mockRejectedValue(
      new Error("extraction failed")
    );

    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "OK" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    // Should not throw
    const result = await engine.chat({ message: "Hi", userId: "user-1" });
    expect(result.response).toBe("OK");

    // Wait for the fire-and-forget to settle
    await new Promise((r) => setTimeout(r, 10));
  });

  it("skips empty choices in stream", async () => {
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [] },
        { choices: [{ delta: { content: "data" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    const result = await engine.chat({ message: "Hi", userId: "user-1" });

    expect(result.response).toBe("data");
  });

  it("includes customPrompt in system message when provided", async () => {
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "Hey!" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    await engine.chat({
      message: "Hi",
      userId: "user-1",
      customPrompt: "You are Ava, a sarcastic AI.",
    });

    const createCall = mockCreate.mock.calls[0][0];
    const systemMsg = createCall.messages[0];
    expect(systemMsg.role).toBe("system");
    expect(systemMsg.content).toMatch(/^You are Ava, a sarcastic AI\./);
    expect(systemMsg.content).not.toContain("You are Nives, a helpful smart home assistant");
  });

  it("uses default identity when customPrompt absent", async () => {
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "Hi" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    await engine.chat({ message: "Hi", userId: "user-1" });

    const createCall = mockCreate.mock.calls[0][0];
    const systemMsg = createCall.messages[0];
    expect(systemMsg.content).toContain("You are Nives, a helpful smart home assistant");
  });

  it("returns factsLearned as 0", async () => {
    mockCreate.mockResolvedValue(
      makeStream([
        { choices: [{ delta: { content: "Hi" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ])
    );

    const result = await engine.chat({ message: "Hi", userId: "user-1" });

    expect(result.factsLearned).toBe(0);
  });

  describe("empty-response diagnostics", () => {
    it("attaches EMPTY_CONTENT error when finish_reason=stop with no text and no tool calls", async () => {
      mockCreate.mockResolvedValue(
        makeStream([{ choices: [{ delta: {}, finish_reason: "stop" }] }])
      );

      const result = await engine.chat({ message: "Hi", userId: "user-1" });

      expect(result.response).toBe("");
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe("EMPTY_CONTENT");
      expect(result.error?.hint).toMatch(/OpenAI-compatible|tool calls/);
    });

    it("attaches MAX_TOKENS_TRUNCATED error when finish_reason=length with empty text", async () => {
      mockCreate.mockResolvedValue(
        makeStream([{ choices: [{ delta: {}, finish_reason: "length" }] }])
      );

      const result = await engine.chat({ message: "Hi", userId: "user-1" });

      expect(result.error?.code).toBe("MAX_TOKENS_TRUNCATED");
      expect(result.error?.hint).toMatch(/ran out of room/);
    });

    it("blames reasoning only when the provider reports reasoning tokens", async () => {
      mockCreate.mockResolvedValue(
        makeStream([
          { choices: [{ delta: {}, finish_reason: "length" }] },
          {
            choices: [],
            usage: {
              prompt_tokens: 45231,
              completion_tokens: 4096,
              completion_tokens_details: { reasoning_tokens: 3612 },
            },
          },
        ])
      );

      const result = await engine.chat({ message: "Hi", userId: "user-1" });

      expect(result.error?.code).toBe("MAX_TOKENS_TRUNCATED");
      expect(result.error?.hint).toMatch(/working the problem out/);
    });

    it("does not blame reasoning when the count is absent", async () => {
      // An endpoint that reports no reasoning tokens is not telling us there
      // were none, so the answer must not claim the model was thinking.
      mockCreate.mockResolvedValue(
        makeStream([
          { choices: [{ delta: {}, finish_reason: "length" }] },
          { choices: [], usage: { prompt_tokens: 900, completion_tokens: 4096 } },
        ])
      );

      const result = await engine.chat({ message: "Hi", userId: "user-1" });

      expect(result.error?.hint).not.toMatch(/working the problem out/);
      expect(result.error?.hint).toMatch(/ran out of room/);
    });

    it("says so when a written answer was cut off part way", async () => {
      // The integration returns the text whenever there is any, so `error` never
      // reaches the reader. Without this the sentence simply stops.
      mockCreate.mockResolvedValue(
        makeStream([
          { choices: [{ delta: { content: "The kitchen sensor reads" }, finish_reason: "length" }] },
        ])
      );

      const result = await engine.chat({ message: "Hi", userId: "user-1" });

      expect(result.response).toContain("The kitchen sensor reads");
      expect(result.response).toContain("ran out of room");
      expect(result.error).toBeUndefined();
    });

    it("keeps the spoken version of that notice short", async () => {
      mockCreate.mockResolvedValue(
        makeStream([
          { choices: [{ delta: { content: "It is 21 degrees" }, finish_reason: "length" }] },
        ])
      );

      const result = await engine.chat({ message: "Hi", userId: "user-1", isVoice: true });

      expect(result.response).toContain("It is 21 degrees");
      expect(result.response).toContain("ran out of room");
      expect(result.response).not.toContain("add-on settings");
    });

    it("leaves a complete answer untouched", async () => {
      mockCreate.mockResolvedValue(
        makeStream([
          { choices: [{ delta: { content: "It is 21 degrees." }, finish_reason: "stop" }] },
        ])
      );

      const result = await engine.chat({ message: "Hi", userId: "user-1" });

      expect(result.response).toBe("It is 21 degrees.");
    });

    it("asks the endpoint for a usage breakdown on every streamed call", async () => {
      mockCreate.mockResolvedValue(
        makeStream([{ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }])
      );

      await engine.chat({ message: "Hi", userId: "user-1" });

      expect(mockCreate.mock.calls[0][0].stream_options).toEqual({
        include_usage: true,
      });
    });

    it("attaches CONTENT_FILTERED error when finish_reason=content_filter with empty text", async () => {
      mockCreate.mockResolvedValue(
        makeStream([{ choices: [{ delta: {}, finish_reason: "content_filter" }] }])
      );

      const result = await engine.chat({ message: "Hi", userId: "user-1" });

      expect(result.error?.code).toBe("CONTENT_FILTERED");
    });

    it("does NOT attach error when the model returns text", async () => {
      mockCreate.mockResolvedValue(
        makeStream([
          { choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] },
        ])
      );

      const result = await engine.chat({ message: "Hi", userId: "user-1" });

      expect(result.response).toBe("Done");
      expect(result.error).toBeUndefined();
    });
  });

  describe("shared tool context & extraction suppression", () => {
    const toolCallTurn = (name: string, args: string) =>
      makeStream([
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "call-1", function: { name, arguments: args } }],
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]);

    it("passes forgetTargets from the turn's tool calls into extraction", async () => {
      // Extraction still RUNS on a forget turn (so "…my name is now Y" is
      // learned); the touched memory is handed over to be filtered out.
      vi.mocked(handleToolCall).mockImplementation(
        async (_ha, _name, _input, ctx?: { forgetTargets?: string[] }) => {
          if (ctx) ctx.forgetTargets = ["User's name is X"];
          return { confirmation_required: true };
        }
      );
      mockCreate.mockResolvedValueOnce(toolCallTurn("forget_memory", '{"query":"my name is X"}'));
      mockCreate.mockResolvedValueOnce(
        makeStream([
          { choices: [{ delta: { content: "Shall I forget it?" }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ])
      );

      await engine.chat({ message: "forget that my name is X", userId: "user-1" });

      expect(handleToolCall).toHaveBeenCalledTimes(1);
      expect(extractAndStoreFacts).toHaveBeenCalledWith(
        memory,
        extractor,
        "user-1",
        "forget that my name is X",
        "Shall I forget it?",
        ["User's name is X"]
      );
    });

    it("passes undefined forgetTargets on an ordinary turn", async () => {
      mockCreate.mockResolvedValue(
        makeStream([
          { choices: [{ delta: { content: "Hi" }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ])
      );

      await engine.chat({ message: "Hello", userId: "user-1" });

      expect(extractAndStoreFacts).toHaveBeenCalledWith(
        memory, extractor, "user-1", "Hello", "Hi", undefined
      );
    });

    it("passes the SAME context object to every tool call in a turn", async () => {
      mockCreate.mockResolvedValueOnce(
        makeStream([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call-1", function: { name: "get_state", arguments: '{"entity_id":"a.b"}' } },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 1, id: "call-2", function: { name: "get_state", arguments: '{"entity_id":"c.d"}' } },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ])
      );
      mockCreate.mockResolvedValueOnce(
        makeStream([
          { choices: [{ delta: { content: "done" }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ])
      );

      await engine.chat({ message: "check both", userId: "user-1", conversationId: "conv-1" });

      const calls = vi.mocked(handleToolCall).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0][3]).toBe(calls[1][3]);
      expect(calls[0][3]).toMatchObject({ userId: "user-1", conversationId: "conv-1", memory });
    });
  });
});

describe("stream events: turn boundaries and the long-lookup heads-up", () => {
  // The bare-function form of the second argument is the old API; these use
  // the events object. Both are accepted.
  let engine: OpenAIChatEngine;

  const toolCallStream = (name: string, args: Record<string, unknown>, text?: string) =>
    makeStream([
      ...(text ? [{ choices: [{ delta: { content: text }, finish_reason: null }] }] : []),
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "c1", function: { name, arguments: JSON.stringify(args) } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
  const answerStream = (text: string) =>
    makeStream([
      { choices: [{ delta: { content: text }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
  const weekAgo = () => new Date(Date.now() - 7 * 86400000).toISOString();

  beforeEach(() => {
    resetTokenCapCache();
    mockCreate.mockReset();
    vi.mocked(handleToolCall).mockReset().mockResolvedValue({ kind: "raw", points: [] });
    const config = {
      llmProvider: "openai",
      llmModel: "gpt-test",
      openaiApiKey: "k",
      memoryTokenLimit: 1500,
      logLevel: "info",
    } as Config;
    const memory = { getFactsWithinTokenLimit: vi.fn().mockResolvedValue([]) } as unknown as IMemoryStore;
    const conversations = {
      getConversationHistory: vi.fn().mockReturnValue([]),
      storeMessage: vi.fn(),
    } as unknown as IConversationStore;
    const scanner = {
      refreshIfStale: vi.fn().mockResolvedValue(undefined),
      hasProfiles: vi.fn().mockReturnValue(false),
      formatCheatSheet: vi.fn().mockReturnValue(""),
    } as unknown as DeviceScanner;
    const topology = {
      refreshIfStale: vi.fn().mockResolvedValue(undefined),
      hasLayout: vi.fn().mockReturnValue(false),
      formatSection: vi.fn().mockReturnValue(""),
    } as unknown as TopologyScanner;
    engine = new OpenAIChatEngine(
      config,
      memory,
      conversations,
      {} as IFactExtractor,
      {} as HomeAssistantClient,
      scanner,
      topology
    );
  });

  it("sends the heads-up before a week-long history batch the model did not announce itself", async () => {
    mockCreate
      .mockResolvedValueOnce(toolCallStream("get_history", { entity_id: "sensor.voc", start_time: weekAgo() }))
      .mockResolvedValueOnce(answerStream("VOC peaks every evening."));
    const events: string[] = [];
    const result = await engine.chat(
      { message: "analyse VOC", userId: "u" },
      {
        onTurn: () => events.push("turn"),
        onStatus: (t) => events.push(`status:${t}`),
        onChunk: (t) => events.push(`chunk:${t}`),
      }
    );
    expect(events).toEqual([
      "turn",
      "status:Give me a moment. I'm reading 7 days of history from one sensor.",
      "turn",
      "chunk:VOC peaks every evening.",
    ]);
    // The heads-up is not part of the reply.
    expect(result.response).toBe("VOC peaks every evening.");
  });

  it("stays quiet when the model wrote its own sentence before the batch", async () => {
    mockCreate
      .mockResolvedValueOnce(
        toolCallStream("get_history", { entity_id: "sensor.voc", start_time: weekAgo() }, "Give me a moment, reading a week of VOC.")
      )
      .mockResolvedValueOnce(answerStream("Done."));
    const events: string[] = [];
    await engine.chat(
      { message: "analyse VOC", userId: "u" },
      { onStatus: (t) => events.push(`status:${t}`), onChunk: (t) => events.push(`chunk:${t}`) }
    );
    expect(events).toEqual(["chunk:Give me a moment, reading a week of VOC.", "chunk:Done."]);
  });

  it("never sends a heads-up for a quick action", async () => {
    mockCreate
      .mockResolvedValueOnce(toolCallStream("call_service", { domain: "light", service: "turn_off", entity_id: "light.kitchen" }))
      .mockResolvedValueOnce(answerStream("The kitchen light is off."));
    const status: string[] = [];
    const result = await engine.chat(
      { message: "turn off the kitchen light", userId: "u" },
      { onStatus: (t) => status.push(t) }
    );
    expect(status).toEqual([]);
    expect(result.response).toBe("The kitchen light is off.");
  });

  it("still accepts a bare onChunk function", async () => {
    mockCreate.mockResolvedValueOnce(answerStream("Hi there."));
    const chunks: string[] = [];
    await engine.chat({ message: "hi", userId: "u" }, (c) => chunks.push(c));
    expect(chunks).toEqual(["Hi there."]);
  });
});

// An engine pointed at one OpenAI-compatible endpoint, everything else stubbed.
const build = (baseUrl?: string) => {
  const config = {
    llmProvider: "openai",
    llmModel: "gpt-test",
    openaiApiKey: "k",
    openaiBaseUrl: baseUrl,
    memoryTokenLimit: 1500,
    logLevel: "info",
  } as Config;
  const memory = { getFactsWithinTokenLimit: vi.fn().mockResolvedValue([]) } as unknown as IMemoryStore;
  const conversations = {
    getConversationHistory: vi.fn().mockReturnValue([]),
    storeMessage: vi.fn(),
  } as unknown as IConversationStore;
  const scanner = {
    refreshIfStale: vi.fn().mockResolvedValue(undefined),
    hasProfiles: vi.fn().mockReturnValue(false),
    formatCheatSheet: vi.fn().mockReturnValue(""),
  } as unknown as DeviceScanner;
  const topology = {
    refreshIfStale: vi.fn().mockResolvedValue(undefined),
    hasLayout: vi.fn().mockReturnValue(false),
    formatSection: vi.fn().mockReturnValue(""),
  } as unknown as TopologyScanner;
  return new OpenAIChatEngine(config, memory, conversations, {} as IFactExtractor, {} as HomeAssistantClient, scanner, topology);
};

describe("OpenRouter session affinity", () => {
  const reply = () =>
    makeStream([
      { choices: [{ delta: { content: "ok" }, finish_reason: null }], provider: "OpenAI" },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);

  beforeEach(() => {
    resetTokenCapCache();
    mockCreate.mockReset();
  });

  it("sends the conversation id as session_id when the endpoint is OpenRouter", async () => {
    mockCreate.mockResolvedValueOnce(reply());
    await build("https://openrouter.ai/api/v1").chat({ message: "hi", userId: "u", conversationId: "conv-9" });
    expect(mockCreate.mock.calls[0][0].session_id).toBe("conv-9");
  });

  it("sends no session_id to any other OpenAI-compatible endpoint", async () => {
    mockCreate.mockResolvedValueOnce(reply());
    await build("http://homeassistant:11434/v1").chat({ message: "hi", userId: "u", conversationId: "conv-9" });
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty("session_id");
  });

  it("names the serving provider in the turn log when the chunks carry it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mockCreate.mockResolvedValueOnce(reply());
    const engine = build("https://openrouter.ai/api/v1");
    (engine as unknown as { config: Config }).config.logLevel = "debug";
    await engine.chat({ message: "hi", userId: "u", conversationId: "conv-9" });
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes("turn ok"));
    expect(line).toContain("provider=OpenAI");
    log.mockRestore();
  });
});

describe("Mistral request shape", () => {
  const reply = () =>
    makeStream([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);

  beforeEach(() => {
    resetTokenCapCache();
    mockCreate.mockReset();
  });

  // Mistral answers any field outside its schema with a 422 before the first chunk.
  it("sends neither stream_options nor session_id to Mistral", async () => {
    mockCreate.mockResolvedValueOnce(reply());
    await build("https://api.mistral.ai/v1").chat({ message: "hi", userId: "u", conversationId: "conv-9" });
    const request = mockCreate.mock.calls[0][0];
    expect(request).not.toHaveProperty("stream_options");
    expect(request).not.toHaveProperty("session_id");
    expect(request.stream).toBe(true);
  });

  it.each([
    ["OpenRouter", "https://openrouter.ai/api/v1"],
    ["a local OpenAI-compatible server", "http://homeassistant:11434/v1"],
    ["OpenAI itself", undefined],
  ])("still asks %s for the usage breakdown", async (_name, baseUrl) => {
    mockCreate.mockResolvedValueOnce(reply());
    await build(baseUrl).chat({ message: "hi", userId: "u" });
    expect(mockCreate.mock.calls[0][0].stream_options).toEqual({ include_usage: true });
  });

  it.each([
    [
      "on a last chunk of its own",
      [
        { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } },
      ],
    ],
    [
      "on the chunk that ends the answer",
      [
        { choices: [{ delta: { content: "ok" }, finish_reason: null }] },
        {
          choices: [{ delta: { content: "" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        },
      ],
    ],
  ])("reads the usage Mistral reports unasked, %s", async (_where, chunks) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mockCreate.mockResolvedValueOnce(makeStream(chunks));
    const engine = build("https://api.mistral.ai/v1");
    (engine as unknown as { config: Config }).config.logLevel = "debug";
    const result = await engine.chat({ message: "hi", userId: "u" });
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes("turn ok"));
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty("stream_options");
    expect(result.response).toBe("ok");
    expect(line).toContain("prompt=12 completion=3");
    log.mockRestore();
  });
});
