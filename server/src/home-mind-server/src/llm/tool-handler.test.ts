import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleToolCall, extractAndStoreFacts, filterExtractedFacts, normalizeTimestamp, type ToolContext } from "./tool-handler.js";
import { clearConfirmation } from "./automation-confirmations.js";
import type { HomeAssistantClient } from "../ha/client.js";
import { notExposedMessage } from "../ha/exposure.js";
import type { IMemoryStore } from "../memory/interface.js";
import type { IFactExtractor } from "./interface.js";
import type { ExtractedFact } from "../memory/types.js";

describe("handleToolCall", () => {
  let ha: HomeAssistantClient;

  beforeEach(() => {
    ha = {
      getState: vi.fn().mockResolvedValue({ state: "on" }),
      getEntities: vi.fn().mockResolvedValue([{ entity_id: "light.kitchen" }]),
      searchEntities: vi.fn().mockResolvedValue([{ entity_id: "light.bed" }]),
      callService: vi.fn().mockResolvedValue({ success: true }),
      getHistory: vi.fn().mockResolvedValue([{ state: "22" }]),
      createAutomation: vi.fn().mockResolvedValue({
        id: "1700000000000",
        alias: "Nives: Kitchen lights at 20:00",
        entity_id: "automation.kitchen_lights_at_20_00",
      }),
      listAutomations: vi.fn().mockResolvedValue([
        {
          entity_id: "automation.living_room_light_off_at_23_00",
          state: "on",
          attributes: {
            id: "1700000000000",
            friendly_name: "Nives: Living room light off at 23:00",
          },
        },
      ]),
      deleteAutomation: vi.fn().mockResolvedValue(undefined),
      updateAutomation: vi.fn().mockResolvedValue({
        id: "1700000000000",
        alias: "Nives: Living room light off at 22:00",
        entity_id: "automation.living_room_light_off_at_23_00",
      }),
      listServices: vi.fn().mockResolvedValue({
        notify: ["mobile_app_johns_iphone", "persistent_notification"],
      }),
      requireExposedAutomation: vi.fn().mockResolvedValue(undefined),
      getAutomationConfig: vi.fn().mockResolvedValue({ id: "1700000000000" }),
    } as unknown as HomeAssistantClient;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches get_state to ha.getState", async () => {
    const result = await handleToolCall(ha, "get_state", {
      entity_id: "light.kitchen",
    });

    expect(ha.getState).toHaveBeenCalledWith("light.kitchen");
    expect(result).toEqual({ state: "on" });
  });

  it("dispatches get_entities to ha.getEntities", async () => {
    const result = await handleToolCall(ha, "get_entities", {
      domain: "light",
    });

    expect(ha.getEntities).toHaveBeenCalledWith("light");
    expect(result).toEqual([{ entity_id: "light.kitchen" }]);
  });

  it("dispatches get_entities without domain", async () => {
    await handleToolCall(ha, "get_entities", {});

    expect(ha.getEntities).toHaveBeenCalledWith(undefined);
  });

  it("dispatches search_entities to ha.searchEntities", async () => {
    const result = await handleToolCall(ha, "search_entities", {
      query: "bedroom",
    });

    expect(ha.searchEntities).toHaveBeenCalledWith("bedroom");
    expect(result).toEqual([{ entity_id: "light.bed" }]);
  });

  it("dispatches call_service to ha.callService", async () => {
    const result = await handleToolCall(ha, "call_service", {
      domain: "light",
      service: "turn_on",
      entity_id: "light.kitchen",
      data: { brightness: 255 },
    });

    expect(ha.callService).toHaveBeenCalledWith("light", "turn_on", "light.kitchen", {
      brightness: 255,
    });
    expect(result).toEqual({ success: true });
  });

  it("dispatches get_history to ha.getHistory", async () => {
    const result = await handleToolCall(ha, "get_history", {
      entity_id: "sensor.temp",
      start_time: "2026-01-01T00:00:00Z",
      end_time: "2026-01-02T00:00:00Z",
    });

    expect(ha.getHistory).toHaveBeenCalledWith(
      "sensor.temp",
      "2026-01-01T00:00:00Z",
      "2026-01-02T00:00:00Z"
    );
    // A short history is summarized as raw points, keyed by entity so the model
    // is not told the id on every row.
    expect(result).toEqual({
      entity_id: "sensor.temp",
      kind: "raw",
      points: [{ state: "22", last_changed: undefined }],
    });
  });

  it("dispatches create_automation to ha.createAutomation with a Nives: prefix", async () => {
    const result = await handleToolCall(ha, "create_automation", {
      alias: "Kitchen lights at 20:00",
      trigger: { platform: "time", at: "20:00:00" },
      action: { service: "light.turn_on", target: { entity_id: "light.kitchen" } },
    });

    expect(ha.createAutomation).toHaveBeenCalledWith({
      alias: "Nives: Kitchen lights at 20:00",
      trigger: { platform: "time", at: "20:00:00" },
      condition: undefined,
      action: { service: "light.turn_on", target: { entity_id: "light.kitchen" } },
      mode: undefined,
    });
    expect(result).toMatchObject({
      success: true,
      entity_id: "automation.kitchen_lights_at_20_00",
      alias: "Nives: Kitchen lights at 20:00",
    });
  });

  it("does not double-prefix an alias that already starts with Nives:", async () => {
    await handleToolCall(ha, "create_automation", {
      alias: "Nives: Porch at sunset",
      trigger: { platform: "sun", event: "sunset" },
      action: { service: "light.turn_on", target: { entity_id: "light.porch" } },
    });

    const call = (ha.createAutomation as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.alias).toBe("Nives: Porch at sunset");
  });

  it("returns an error when create_automation is missing a trigger", async () => {
    const result = await handleToolCall(ha, "create_automation", {
      alias: "No trigger",
      action: { service: "light.turn_on" },
    });

    expect(ha.createAutomation).not.toHaveBeenCalled();
    expect(result).toEqual({ error: "create_automation requires a 'trigger'." });
  });

  it("returns an error when create_automation is missing an action", async () => {
    const result = await handleToolCall(ha, "create_automation", {
      alias: "No action",
      trigger: { platform: "time", at: "20:00:00" },
    });

    expect(ha.createAutomation).not.toHaveBeenCalled();
    expect(result).toEqual({ error: "create_automation requires an 'action'." });
  });

  it("wraps createAutomation failures in an error object", async () => {
    (ha.createAutomation as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("config editor not enabled")
    );

    const result = await handleToolCall(ha, "create_automation", {
      alias: "Boom",
      trigger: { platform: "time", at: "20:00:00" },
      action: { service: "light.turn_on" },
    });

    expect(result).toEqual({ error: "config editor not enabled" });
  });

  it("dispatches list_automations and returns a slim list", async () => {
    const result = await handleToolCall(ha, "list_automations", {});

    expect(ha.listAutomations).toHaveBeenCalled();
    expect(result).toEqual([
      {
        entity_id: "automation.living_room_light_off_at_23_00",
        name: "Nives: Living room light off at 23:00",
        state: "on",
        id: "1700000000000",
      },
    ]);
  });

  it("dispatches delete_automation: resolves entity_id to config id and deletes", async () => {
    const result = await handleToolCall(ha, "delete_automation", {
      entity_id: "automation.living_room_light_off_at_23_00",
    });

    expect(ha.deleteAutomation).toHaveBeenCalledWith("1700000000000");
    expect(result).toMatchObject({
      success: true,
      entity_id: "automation.living_room_light_off_at_23_00",
      name: "Nives: Living room light off at 23:00",
    });
  });

  it("delete_automation requires an entity_id", async () => {
    const result = await handleToolCall(ha, "delete_automation", {});

    expect(ha.deleteAutomation).not.toHaveBeenCalled();
    expect(result).toEqual({ error: "delete_automation requires an 'entity_id'." });
  });

  it("delete_automation errors when the automation is not found", async () => {
    const result = await handleToolCall(ha, "delete_automation", {
      entity_id: "automation.nonexistent",
    });

    expect(ha.deleteAutomation).not.toHaveBeenCalled();
    expect(result).toEqual({
      error: 'No automation found with entity_id "automation.nonexistent".',
    });
  });

  it("dispatches update_automation: resolves entity_id, passes only provided fields with Nives: prefix", async () => {
    const result = await handleToolCall(ha, "update_automation", {
      entity_id: "automation.living_room_light_off_at_23_00",
      alias: "Living room light off at 22:00",
      trigger: { platform: "time", at: "22:00:00" },
    });

    expect(ha.updateAutomation).toHaveBeenCalledWith("1700000000000", {
      alias: "Nives: Living room light off at 22:00",
      trigger: { platform: "time", at: "22:00:00" },
    });
    expect(result).toMatchObject({
      success: true,
      entity_id: "automation.living_room_light_off_at_23_00",
    });
  });

  it("checks an update's new sections against the automation's stored config", async () => {
    await handleToolCall(ha, "update_automation", {
      entity_id: "automation.living_room_light_off_at_23_00",
      trigger: { platform: "time", at: "22:00:00" },
    });

    expect(ha.getAutomationConfig).toHaveBeenCalledWith("1700000000000");
    expect(ha.requireExposedAutomation).toHaveBeenCalledWith(
      { trigger: { platform: "time", at: "22:00:00" }, condition: undefined, action: undefined },
      { id: "1700000000000" }
    );
  });

  it("does not read the stored config for a rename, which names no entity", async () => {
    await handleToolCall(ha, "update_automation", {
      entity_id: "automation.living_room_light_off_at_23_00",
      alias: "Living room light off at 22:00",
    });

    expect(ha.requireExposedAutomation).not.toHaveBeenCalled();
    expect(ha.getAutomationConfig).not.toHaveBeenCalled();
    expect(ha.updateAutomation).toHaveBeenCalled();
  });

  it("refuses an update that reaches past the exposure list, without writing it", async () => {
    vi.mocked(ha.requireExposedAutomation).mockRejectedValueOnce(
      new Error(notExposedMessage("lock.front_door"))
    );
    const result = await handleToolCall(ha, "update_automation", {
      entity_id: "automation.living_room_light_off_at_23_00",
      action: { service: "lock.unlock", target: { entity_id: "lock.front_door" } },
    });

    expect(result).toEqual({ error: notExposedMessage("lock.front_door") });
    expect(ha.updateAutomation).not.toHaveBeenCalled();
  });

  it("update_automation requires an entity_id", async () => {
    const result = await handleToolCall(ha, "update_automation", {
      alias: "Whatever",
    });

    expect(ha.updateAutomation).not.toHaveBeenCalled();
    expect(result).toEqual({ error: "update_automation requires an 'entity_id'." });
  });

  it("update_automation errors when the automation is not found", async () => {
    const result = await handleToolCall(ha, "update_automation", {
      entity_id: "automation.nope",
    });

    expect(ha.updateAutomation).not.toHaveBeenCalled();
    expect(result).toEqual({
      error: 'No automation found with entity_id "automation.nope".',
    });
  });

  it("dispatches list_services to ha.listServices", async () => {
    const result = await handleToolCall(ha, "list_services", { domain: "notify" });

    expect(ha.listServices).toHaveBeenCalledWith("notify");
    expect(result).toEqual({
      notify: ["mobile_app_johns_iphone", "persistent_notification"],
    });
  });

  it("returns error for unknown tool", async () => {
    const result = await handleToolCall(ha, "nonexistent_tool", {});

    expect(result).toEqual({ error: "Unknown tool: nonexistent_tool" });
  });

  it("wraps exceptions in error object", async () => {
    (ha.getState as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Connection refused")
    );

    const result = await handleToolCall(ha, "get_state", {
      entity_id: "light.kitchen",
    });

    expect(result).toEqual({ error: "Connection refused" });
  });

  it("wraps non-Error exceptions in error object", async () => {
    (ha.getState as ReturnType<typeof vi.fn>).mockRejectedValue("string error");

    const result = await handleToolCall(ha, "get_state", {
      entity_id: "light.kitchen",
    });

    expect(result).toEqual({ error: "string error" });
  });

  it("hands the model the reason an unexposed entity was refused", async () => {
    // The client refuses before the request goes out; this is the contract that
    // the refusal reaches the model as words instead of failing the turn.
    (ha.getState as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error(notExposedMessage("light.kitchen_table_1"))
    );

    const result = await handleToolCall(ha, "get_state", {
      entity_id: "light.kitchen_table_1",
    });

    expect(result).toEqual({ error: expect.stringContaining("not available to you") });
    expect(result).toEqual({ error: expect.stringContaining("Do not retry") });
  });

  it("hands a refused call_service back to the model the same way", async () => {
    (ha.callService as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error(notExposedMessage("lock.front_door"))
    );

    const result = await handleToolCall(ha, "call_service", {
      domain: "lock",
      service: "unlock",
      entity_id: "lock.front_door",
    });

    expect(result).toEqual({ error: notExposedMessage("lock.front_door") });
  });
});

describe("handleToolCall confirmation gate", () => {
  let ha: HomeAssistantClient;
  const CONV = "conv-gate";
  const ctx = (turnId: string) => ({ conversationId: CONV, turnId });
  const createInput = () => ({
    alias: "Kitchen lights at 20:00",
    trigger: { platform: "time", at: "20:00:00" },
    action: { service: "light.turn_on", target: { entity_id: "light.kitchen" } },
  });

  beforeEach(() => {
    clearConfirmation(CONV);
    ha = {
      createAutomation: vi.fn().mockResolvedValue({
        id: "1",
        alias: "Nives: Kitchen lights at 20:00",
        entity_id: "automation.kitchen_lights_at_20_00",
      }),
      listAutomations: vi.fn().mockResolvedValue([
        { entity_id: "automation.x", state: "on", attributes: { id: "9", friendly_name: "Nives: X" } },
      ]),
      deleteAutomation: vi.fn().mockResolvedValue(undefined),
      requireExposedAutomation: vi.fn().mockResolvedValue(undefined),
    } as unknown as HomeAssistantClient;
  });

  afterEach(() => vi.clearAllMocks());

  it("first create call returns confirmation_required and does NOT create", async () => {
    const result = (await handleToolCall(ha, "create_automation", createInput(), ctx("turn-A"))) as {
      confirmation_required?: boolean;
    };
    expect(ha.createAutomation).not.toHaveBeenCalled();
    expect(result.confirmation_required).toBe(true);
  });

  it("re-calling the same args in the SAME turn still does not create", async () => {
    await handleToolCall(ha, "create_automation", createInput(), ctx("turn-A"));
    const second = (await handleToolCall(ha, "create_automation", createInput(), ctx("turn-A"))) as {
      confirmation_required?: boolean;
    };
    expect(ha.createAutomation).not.toHaveBeenCalled();
    expect(second.confirmation_required).toBe(true);
  });

  it("creates when the same args are re-called in a LATER turn", async () => {
    await handleToolCall(ha, "create_automation", createInput(), ctx("turn-A"));
    const second = (await handleToolCall(ha, "create_automation", createInput(), ctx("turn-B"))) as {
      success?: boolean;
    };
    expect(ha.createAutomation).toHaveBeenCalledTimes(1);
    expect(second.success).toBe(true);
  });

  it("replays the live 2026-09-04 loop: reworded aliases and a rejected payload, one yes each", async () => {
    // Preview under one alias.
    await handleToolCall(ha, "create_automation", createInput(), ctx("turn-A"));
    // "yes" → the model renames it. Must apply, not re-preview.
    const renamed = { ...createInput(), alias: "Reminder: kitchen lights at 20:00" };
    const second = (await handleToolCall(ha, "create_automation", renamed, ctx("turn-B"))) as {
      success?: boolean;
    };
    expect(second.success).toBe(true);
    expect(ha.createAutomation).toHaveBeenCalledTimes(1);
  });

  it("keeps the confirmation when Home Assistant rejects the confirmed payload, so the fixed retry applies", async () => {
    await handleToolCall(ha, "create_automation", createInput(), ctx("turn-A"));
    vi.mocked(ha.createAutomation).mockRejectedValueOnce(
      new Error("HA API error 400: Message malformed: Expected HH:MM, HH:MM:SS at 'at[0]'")
    );
    const bad = { ...createInput(), trigger: { platform: "time", at: "2026-09-05 20:00:00" } };
    const failed = (await handleToolCall(ha, "create_automation", bad, ctx("turn-B"))) as {
      error?: string;
      message?: string;
      confirmation_required?: boolean;
    };
    expect(failed.error).toMatch(/malformed/);
    expect(failed.message).toMatch(/still stands/);
    expect(failed.confirmation_required).toBeUndefined();

    // The corrected retry in the SAME turn goes straight through.
    const retry = (await handleToolCall(ha, "create_automation", createInput(), ctx("turn-B"))) as {
      success?: boolean;
      confirmation_required?: boolean;
    };
    expect(retry.confirmation_required).toBeUndefined();
    expect(retry.success).toBe(true);
    expect(ha.createAutomation).toHaveBeenCalledTimes(2);
  });

  it("refuses an out-of-reach create at the preview, and leaves no confirmation behind", async () => {
    // The user must never be asked to approve a payload that is then refused,
    // and a refusal must not count as a yes: the corrected payload is previewed.
    vi.mocked(ha.requireExposedAutomation).mockRejectedValueOnce(
      new Error(notExposedMessage("lock.front_door"))
    );
    const unlock = {
      ...createInput(),
      action: { service: "lock.unlock", target: { entity_id: "lock.front_door" } },
    };
    const refused = (await handleToolCall(ha, "create_automation", unlock, ctx("turn-A"))) as {
      error?: string;
      message?: string;
      confirmation_required?: boolean;
    };
    expect(refused.error).toBe(notExposedMessage("lock.front_door"));
    expect(refused.message).toBeUndefined();
    expect(refused.confirmation_required).toBeUndefined();

    const fixed = (await handleToolCall(ha, "create_automation", createInput(), ctx("turn-B"))) as {
      confirmation_required?: boolean;
    };
    expect(fixed.confirmation_required).toBe(true);
    expect(ha.createAutomation).not.toHaveBeenCalled();
  });

  it("commits a REFORMATTED create on a later-turn re-call (payload shape is not compared)", async () => {
    await handleToolCall(ha, "create_automation", createInput(), ctx("turn-A"));
    // Same intent, different shape than the preview → must still commit (this is the v2.1.11 fix).
    const second = (await handleToolCall(
      ha,
      "create_automation",
      {
        alias: "Nives: Kitchen lights at 20:00",
        trigger: { at: "20:00:00", platform: "time" },
        action: { service: "light.turn_on", target: { entity_id: "light.kitchen" } },
      },
      ctx("turn-B")
    )) as { success?: boolean };
    expect(ha.createAutomation).toHaveBeenCalledTimes(1);
    expect(second.success).toBe(true);
  });

  it("without conversation context, creates directly (legacy path)", async () => {
    const result = (await handleToolCall(ha, "create_automation", createInput())) as {
      success?: boolean;
    };
    expect(ha.createAutomation).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it("delete requires confirmation first, then deletes on a later-turn re-call", async () => {
    const first = (await handleToolCall(ha, "delete_automation", { entity_id: "automation.x" }, ctx("turn-A"))) as {
      confirmation_required?: boolean;
    };
    expect(ha.deleteAutomation).not.toHaveBeenCalled();
    expect(first.confirmation_required).toBe(true);

    const second = (await handleToolCall(ha, "delete_automation", { entity_id: "automation.x" }, ctx("turn-B"))) as {
      success?: boolean;
    };
    expect(ha.deleteAutomation).toHaveBeenCalledWith("9");
    expect(second.success).toBe(true);
  });
});

describe("filterExtractedFacts", () => {
  it("keeps valid facts", () => {
    const facts: ExtractedFact[] = [
      { content: "User prefers 22°C for the bedroom", category: "preference", confidence: 0.9 },
    ];
    const { kept, skipped } = filterExtractedFacts(facts);
    expect(kept).toHaveLength(1);
    expect(skipped).toHaveLength(0);
  });

  it("skips facts shorter than 10 characters", () => {
    const facts: ExtractedFact[] = [
      { content: "Too short", category: "preference", confidence: 0.9 },
    ];
    const { kept, skipped } = filterExtractedFacts(facts);
    expect(kept).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toContain("too short");
  });

  it("skips facts with transient state patterns", () => {
    const transientFacts: ExtractedFact[] = [
      { content: "Kitchen light is currently displaying red color", category: "device" },
      { content: "Sensor is showing 22 degrees right now in the bedroom", category: "baseline" },
      { content: "The light was just turned on by the assistant", category: "device" },
      { content: "Temperature is now set to 25 degrees", category: "device" },
    ];
    const { kept, skipped } = filterExtractedFacts(transientFacts);
    expect(kept).toHaveLength(0);
    expect(skipped).toHaveLength(4);
    for (const s of skipped) {
      expect(s.reason).toContain("transient");
    }
  });

  it("skips facts with confidence below 0.2", () => {
    const facts: ExtractedFact[] = [
      { content: "User might prefer warm lighting", category: "preference", confidence: 0.1 },
    ];
    const { kept, skipped } = filterExtractedFacts(facts);
    expect(kept).toHaveLength(0);
    expect(skipped[0].reason).toContain("low confidence");
  });

  it("keeps facts without confidence field (defaults to acceptable)", () => {
    const facts: ExtractedFact[] = [
      { content: "User prefers lights dim in the evening", category: "preference" },
    ];
    const { kept } = filterExtractedFacts(facts);
    expect(kept).toHaveLength(1);
  });

  it("skips device spec/capability dump facts", () => {
    const facts: ExtractedFact[] = [
      { content: "light.led_strip_colors_kitchen supports RGBW and color_temp modes", category: "device", confidence: 0.9 },
      { content: "light.kitchen supports 170 effects including rainbow and fire", category: "device", confidence: 0.8 },
      { content: "The entity has supported_color modes of rgbw and xy", category: "device", confidence: 0.85 },
      { content: "Device supports brightness and on_off color modes", category: "device", confidence: 0.9 },
      { content: "The light has a firmware version 2.1.3 installed", category: "device", confidence: 0.7 },
      { content: "Light strip supports rgb color mode natively", category: "device", confidence: 0.8 },
    ];
    const { kept, skipped } = filterExtractedFacts(facts);
    expect(kept).toHaveLength(0);
    expect(skipped).toHaveLength(6);
    for (const s of skipped) {
      expect(s.reason).toContain("device spec");
    }
  });

  it("skips command echo facts (restating what assistant did)", () => {
    const facts: ExtractedFact[] = [
      { content: "Kitchen light was set to red color by the assistant", category: "device", confidence: 0.8 },
      { content: "Bedroom brightness was changed to 50 percent", category: "device", confidence: 0.7 },
      { content: "Living room light was turned off at night", category: "device", confidence: 0.8 },
      { content: "Temperature has been set to 22 degrees in the bedroom", category: "baseline", confidence: 0.8 },
      { content: "The light color has been changed to blue", category: "device", confidence: 0.7 },
    ];
    const { kept, skipped } = filterExtractedFacts(facts);
    expect(kept).toHaveLength(0);
    expect(skipped).toHaveLength(5);
    for (const s of skipped) {
      expect(s.reason).toContain("command echo");
    }
  });

  it("does not false-positive on legitimate facts containing similar words", () => {
    const facts: ExtractedFact[] = [
      { content: "User's name is Jure and he supports open source projects", category: "identity", confidence: 0.9 },
      { content: "User prefers warm white color temperature for evenings", category: "preference", confidence: 0.85 },
      { content: "User calls the kitchen LED strip Big Bertha", category: "device", confidence: 0.9 },
    ];
    const { kept, skipped } = filterExtractedFacts(facts);
    expect(kept).toHaveLength(3);
    expect(skipped).toHaveLength(0);
  });

  it("applies all filters and returns mixed results", () => {
    const facts: ExtractedFact[] = [
      { content: "User's name is Jure", category: "identity", confidence: 1.0 },
      { content: "short", category: "preference", confidence: 0.9 },
      { content: "Light is currently red in the kitchen", category: "device", confidence: 0.8 },
      { content: "Maybe the user likes blue lights", category: "preference", confidence: 0.1 },
    ];
    const { kept, skipped } = filterExtractedFacts(facts);
    expect(kept).toHaveLength(1);
    expect(kept[0].content).toBe("User's name is Jure");
    expect(skipped).toHaveLength(3);
  });
});

describe("extractAndStoreFacts", () => {
  let memory: IMemoryStore;
  let extractor: IFactExtractor;

  beforeEach(() => {
    memory = {
      getFacts: vi.fn().mockResolvedValue([
        { id: "old-1", content: "old fact", category: "preference" },
      ]),
      addFact: vi.fn().mockResolvedValue("new-id"),
      addFacts: vi.fn().mockResolvedValue(["new-id"]),
      deleteFact: vi.fn().mockResolvedValue(true),
    } as unknown as IMemoryStore;

    extractor = {
      extract: vi.fn().mockResolvedValue([
        {
          content: "User prefers 22°C for bedroom",
          category: "preference",
          confidence: 0.9,
          replaces: ["old-1"],
        },
      ]),
    } as unknown as IFactExtractor;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls getFacts, extract, deleteFact for replaced, addFacts for new", async () => {
    const count = await extractAndStoreFacts(
      memory,
      extractor,
      "user-1",
      "I prefer 22",
      "Got it!"
    );

    expect(memory.getFacts).toHaveBeenCalledWith("user-1");
    expect(extractor.extract).toHaveBeenCalledWith("I prefer 22", "Got it!", [
      { id: "old-1", content: "old fact", category: "preference" },
    ]);
    expect(memory.deleteFact).toHaveBeenCalledWith("user-1", "old-1");
    expect(memory.addFacts).toHaveBeenCalledWith("user-1", [
      { content: "User prefers 22°C for bedroom", category: "preference", confidence: 0.9 },
    ]);
    expect(count).toBe(1);
  });

  it("stores multiple facts via batch and returns correct count", async () => {
    (extractor.extract as ReturnType<typeof vi.fn>).mockResolvedValue([
      { content: "Fact A is a long enough preference", category: "preference", confidence: 0.8, replaces: [] },
      { content: "Fact B is identity information", category: "identity", confidence: 0.9, replaces: [] },
      { content: "Fact C is baseline sensor data", category: "baseline", confidence: 0.7, replaces: [] },
    ]);
    (memory.addFacts as ReturnType<typeof vi.fn>).mockResolvedValue(["id-1", "id-2", "id-3"]);

    const count = await extractAndStoreFacts(
      memory,
      extractor,
      "user-1",
      "msg",
      "resp"
    );

    expect(count).toBe(3);
    expect(memory.addFacts).toHaveBeenCalledTimes(1);
  });

  it("returns 0 when extraction yields no facts", async () => {
    (extractor.extract as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const count = await extractAndStoreFacts(
      memory,
      extractor,
      "user-1",
      "msg",
      "resp"
    );

    expect(count).toBe(0);
    expect(memory.addFacts).not.toHaveBeenCalled();
    expect(memory.deleteFact).not.toHaveBeenCalled();
  });

  it("does not call deleteFact when replaces is empty", async () => {
    (extractor.extract as ReturnType<typeof vi.fn>).mockResolvedValue([
      { content: "New fact about user preference", category: "preference", confidence: 0.8, replaces: [] },
    ]);

    await extractAndStoreFacts(memory, extractor, "user-1", "msg", "resp");

    expect(memory.deleteFact).not.toHaveBeenCalled();
  });

  it("does not call deleteFact when replaces is undefined", async () => {
    (extractor.extract as ReturnType<typeof vi.fn>).mockResolvedValue([
      { content: "New fact about user preference", category: "preference", confidence: 0.8 },
    ]);

    await extractAndStoreFacts(memory, extractor, "user-1", "msg", "resp");

    expect(memory.deleteFact).not.toHaveBeenCalled();
  });

  it("filters out garbage facts before storing", async () => {
    (extractor.extract as ReturnType<typeof vi.fn>).mockResolvedValue([
      { content: "User prefers 22°C for bedroom", category: "preference", confidence: 0.9, replaces: [] },
      { content: "Light is currently red in the kitchen", category: "device", confidence: 0.8, replaces: [] },
      { content: "too short", category: "preference", confidence: 0.9, replaces: [] },
    ]);
    (memory.addFacts as ReturnType<typeof vi.fn>).mockResolvedValue(["id-1"]);

    const count = await extractAndStoreFacts(
      memory,
      extractor,
      "user-1",
      "msg",
      "resp"
    );

    expect(count).toBe(1);
    expect(memory.addFacts).toHaveBeenCalledWith("user-1", [
      { content: "User prefers 22°C for bedroom", category: "preference", confidence: 0.9 },
    ]);
  });
});

describe("normalizeTimestamp", () => {
  it("passes through timestamps with Z suffix unchanged", () => {
    expect(normalizeTimestamp("2026-01-15T20:00:00Z")).toBe("2026-01-15T20:00:00Z");
    expect(normalizeTimestamp("2026-01-15T20:00:00.000Z")).toBe("2026-01-15T20:00:00.000Z");
  });

  it("passes through timestamps with +HH:MM offset unchanged", () => {
    expect(normalizeTimestamp("2026-01-15T20:00:00+01:00")).toBe("2026-01-15T20:00:00+01:00");
    expect(normalizeTimestamp("2026-01-15T20:00:00-05:00")).toBe("2026-01-15T20:00:00-05:00");
  });

  it("passes through timestamps with +HHMM offset unchanged", () => {
    expect(normalizeTimestamp("2026-01-15T20:00:00+0100")).toBe("2026-01-15T20:00:00+0100");
  });

  it("appends Z to bare timestamps", () => {
    expect(normalizeTimestamp("2026-01-15T20:00:00")).toBe("2026-01-15T20:00:00Z");
    expect(normalizeTimestamp("2026-01-15T20:00:00.000")).toBe("2026-01-15T20:00:00.000Z");
  });

  it("returns undefined for undefined input", () => {
    expect(normalizeTimestamp(undefined)).toBeUndefined();
  });
});

describe("handleToolCall get_history normalization", () => {
  let ha: HomeAssistantClient;

  beforeEach(() => {
    ha = {
      getState: vi.fn().mockResolvedValue({ state: "on" }),
      getEntities: vi.fn().mockResolvedValue([]),
      searchEntities: vi.fn().mockResolvedValue([]),
      callService: vi.fn().mockResolvedValue({ success: true }),
      getHistory: vi.fn().mockResolvedValue([{ state: "22" }]),
    } as unknown as HomeAssistantClient;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes bare start_time and end_time by appending Z", async () => {
    await handleToolCall(ha, "get_history", {
      entity_id: "sensor.temp",
      start_time: "2026-01-15T20:00:00",
      end_time: "2026-01-15T21:00:00",
    });

    expect(ha.getHistory).toHaveBeenCalledWith(
      "sensor.temp",
      "2026-01-15T20:00:00Z",
      "2026-01-15T21:00:00Z"
    );
  });

  it("passes through timestamps that already have timezone info", async () => {
    await handleToolCall(ha, "get_history", {
      entity_id: "sensor.temp",
      start_time: "2026-01-15T20:00:00+01:00",
      end_time: "2026-01-15T21:00:00Z",
    });

    expect(ha.getHistory).toHaveBeenCalledWith(
      "sensor.temp",
      "2026-01-15T20:00:00+01:00",
      "2026-01-15T21:00:00Z"
    );
  });

  it("passes undefined timestamps through without normalization", async () => {
    await handleToolCall(ha, "get_history", {
      entity_id: "sensor.temp",
    });

    expect(ha.getHistory).toHaveBeenCalledWith(
      "sensor.temp",
      undefined,
      undefined
    );
  });
});

describe("handleToolCall forget_memory", () => {
  const CONV = "conv-forget-handler";
  const ha = {} as unknown as HomeAssistantClient;
  let memory: IMemoryStore;

  const fact = (id: string, content: string) => ({
    id,
    userId: "user-1",
    content,
    category: "identity" as const,
    confidence: 1,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    lastUsed: new Date("2026-01-01T00:00:00Z"),
    useCount: 0,
  });
  const CANARY = "User's test canary word is bumblebee";

  const ctx = (turnId: string): ToolContext => ({
    conversationId: CONV,
    turnId,
    userId: "user-1",
    memory,
  });

  beforeEach(() => {
    clearConfirmation(CONV);
    memory = {
      getFacts: vi.fn().mockResolvedValue([fact("f-1", CANARY)]),
      deleteFact: vi.fn().mockResolvedValue(true),
    } as unknown as IMemoryStore;
  });

  afterEach(() => vi.clearAllMocks());

  it("errors without memory/userId in context and deletes nothing", async () => {
    const result = (await handleToolCall(ha, "forget_memory", { query: CANARY }, { conversationId: CONV, turnId: "t1" })) as { error?: string };
    expect(result.error).toBeDefined();
    expect(memory.deleteFact).not.toHaveBeenCalled();
  });

  it("errors on an empty query", async () => {
    const result = (await handleToolCall(ha, "forget_memory", { query: "  " }, ctx("t1"))) as { error?: string };
    expect(result.error).toContain("query");
    expect(memory.deleteFact).not.toHaveBeenCalled();
  });

  it("returns no_match without deleting, and leaks no confirmation slot", async () => {
    const miss = (await handleToolCall(ha, "forget_memory", { query: "the weather in Ljubljana" }, ctx("t1"))) as { no_match?: boolean };
    expect(miss.no_match).toBe(true);
    expect(memory.deleteFact).not.toHaveBeenCalled();

    // A later-turn call that DOES resolve must still be a preview, not a commit.
    const later = (await handleToolCall(ha, "forget_memory", { query: CANARY }, ctx("t2"))) as { confirmation_required?: boolean };
    expect(later.confirmation_required).toBe(true);
    expect(memory.deleteFact).not.toHaveBeenCalled();
  });

  it("returns disambiguation candidates without deleting or arming the gate", async () => {
    memory.getFacts = vi.fn().mockResolvedValue([
      fact("f-bed", "User prefers the bedroom at 20 degrees"),
      fact("f-bath", "User prefers the bathroom at 20 degrees"),
    ]);
    const result = (await handleToolCall(ha, "forget_memory", { query: "user prefers at 20 degrees" }, ctx("t1"))) as {
      needs_disambiguation?: boolean;
      candidates?: string[];
    };
    expect(result.needs_disambiguation).toBe(true);
    expect(result.candidates).toHaveLength(2);
    expect(memory.deleteFact).not.toHaveBeenCalled();

    // Picking one candidate in a later turn must PREVIEW, not commit.
    const pick = (await handleToolCall(ha, "forget_memory", { query: "User prefers the bedroom at 20 degrees" }, ctx("t2"))) as { confirmation_required?: boolean };
    expect(pick.confirmation_required).toBe(true);
    expect(memory.deleteFact).not.toHaveBeenCalled();
  });

  it("first matching call previews with the exact content and flags it for extraction filtering", async () => {
    const context = ctx("t1");
    const result = (await handleToolCall(ha, "forget_memory", { query: CANARY }, context)) as {
      confirmation_required?: boolean;
      memory_to_forget?: string;
    };
    expect(result.confirmation_required).toBe(true);
    expect(result.memory_to_forget).toBe(CANARY);
    expect(context.forgetTargets).toContain(CANARY);
    expect(memory.deleteFact).not.toHaveBeenCalled();
  });

  it("re-calling in the SAME turn still previews", async () => {
    await handleToolCall(ha, "forget_memory", { query: CANARY }, ctx("t1"));
    const second = (await handleToolCall(ha, "forget_memory", { query: CANARY }, ctx("t1"))) as { confirmation_required?: boolean };
    expect(second.confirmation_required).toBe(true);
    expect(memory.deleteFact).not.toHaveBeenCalled();
  });

  it("commits on a later-turn re-call with the same query", async () => {
    await handleToolCall(ha, "forget_memory", { query: CANARY }, ctx("t1"));
    const second = (await handleToolCall(ha, "forget_memory", { query: CANARY }, ctx("t2"))) as {
      success?: boolean;
      forgotten?: string;
    };
    expect(memory.deleteFact).toHaveBeenCalledWith("user-1", "f-1");
    expect(second.success).toBe(true);
    expect(second.forgotten).toBe(CANARY);
  });

  it("commits on a later-turn REWORDED query that resolves to the same fact", async () => {
    await handleToolCall(ha, "forget_memory", { query: "my test canary word is bumblebee" }, ctx("t1"));
    const second = (await handleToolCall(ha, "forget_memory", { query: "users test canary word is bumblebee" }, ctx("t2"))) as { success?: boolean };
    expect(memory.deleteFact).toHaveBeenCalledWith("user-1", "f-1");
    expect(second.success).toBe(true);
  });

  it("re-previews instead of deleting when the confirm turn resolves to a DIFFERENT fact", async () => {
    memory.getFacts = vi.fn().mockResolvedValue([
      fact("f-1", CANARY),
      fact("f-2", "User's name is Alex"),
    ]);
    await handleToolCall(ha, "forget_memory", { query: CANARY }, ctx("t1"));
    const second = (await handleToolCall(ha, "forget_memory", { query: "User's name is Alex" }, ctx("t2"))) as { confirmation_required?: boolean };
    expect(second.confirmation_required).toBe(true);
    expect(memory.deleteFact).not.toHaveBeenCalled();
  });

  it("deletes every id of a duplicate-content group", async () => {
    memory.getFacts = vi.fn().mockResolvedValue([fact("f-1", CANARY), fact("f-2", CANARY)]);
    await handleToolCall(ha, "forget_memory", { query: CANARY }, ctx("t1"));
    await handleToolCall(ha, "forget_memory", { query: CANARY }, ctx("t2"));
    expect(memory.deleteFact).toHaveBeenCalledWith("user-1", "f-1");
    expect(memory.deleteFact).toHaveBeenCalledWith("user-1", "f-2");
  });

  it("reports failure when deletion fails, then a next-turn retry commits without a fresh confirm", async () => {
    memory.deleteFact = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    await handleToolCall(ha, "forget_memory", { query: CANARY }, ctx("t1"));
    const failed = (await handleToolCall(ha, "forget_memory", { query: CANARY }, ctx("t2"))) as { error?: string };
    expect(failed.error).toBeDefined();

    const retry = (await handleToolCall(ha, "forget_memory", { query: CANARY }, ctx("t3"))) as { success?: boolean };
    expect(retry.success).toBe(true);
  });

  it("flags candidates and near-misses for extraction filtering too", async () => {
    // Near-miss: the suggestion is forget-flavored, so it must not be re-learned.
    const missCtx = ctx("t1");
    await handleToolCall(ha, "forget_memory", { query: "my test canary word thing" }, missCtx);
    expect(missCtx.forgetTargets).toContain(CANARY);

    memory.getFacts = vi.fn().mockResolvedValue([
      fact("f-bed", "User prefers the bedroom at 20 degrees"),
      fact("f-bath", "User prefers the bathroom at 20 degrees"),
    ]);
    const ambCtx = ctx("t2");
    await handleToolCall(ha, "forget_memory", { query: "user prefers at 20 degrees" }, ambCtx);
    expect(ambCtx.forgetTargets).toEqual(
      expect.arrayContaining([
        "User prefers the bedroom at 20 degrees",
        "User prefers the bathroom at 20 degrees",
      ])
    );
  });

  it("flags the committed memory so extraction cannot re-learn it", async () => {
    await handleToolCall(ha, "forget_memory", { query: CANARY }, ctx("t1"));
    const commitCtx = ctx("t2");
    await handleToolCall(ha, "forget_memory", { query: CANARY }, commitCtx);
    expect(commitCtx.forgetTargets).toContain(CANARY);
  });

  it("REFUSES when there is no conversation continuity — it cannot be confirmed, so it must not delete", async () => {
    // This asserted the opposite until 2.4.18. The AI Task entity posts with no
    // conversationId by design (ai_task.py), and gets the full tool set, so the
    // fall-through meant one generate_data run — including the camera-image
    // path — could erase a memory on the first call with nobody asked.
    const result = (await handleToolCall(ha, "forget_memory", { query: CANARY }, { userId: "user-1", memory })) as {
      error?: string;
      success?: boolean;
    };
    expect(memory.deleteFact).not.toHaveBeenCalled();
    expect(result.success).toBeUndefined();
    expect(result.error).toMatch(/conversation/i);
  });

  it("REFUSES the exact ai_task request shape (userId + customPrompt, no conversationId)", async () => {
    const aiTaskCtx = { userId: "user-1", memory }; // no conversationId, no turnId
    const result = (await handleToolCall(ha, "forget_memory", { query: CANARY }, aiTaskCtx)) as { error?: string };
    expect(result.error).toBeDefined();
    expect(memory.deleteFact).not.toHaveBeenCalled();
  });

  it("still refuses when only turnId is missing", async () => {
    const result = (await handleToolCall(ha, "forget_memory", { query: CANARY }, {
      conversationId: CONV, userId: "user-1", memory,
    })) as { error?: string };
    expect(result.error).toBeDefined();
    expect(memory.deleteFact).not.toHaveBeenCalled();
  });

  it("coexists with a pending automation preview without cross-firing", async () => {
    const gateHa = {
      createAutomation: vi.fn().mockResolvedValue({ id: "1", alias: "Nives: X", entity_id: "automation.x" }),
      requireExposedAutomation: vi.fn().mockResolvedValue(undefined),
    } as unknown as HomeAssistantClient;
    const auto = { alias: "X", trigger: { platform: "time", at: "12:00" }, action: { service: "notify.foo" } };

    await handleToolCall(gateHa, "create_automation", auto, ctx("t1"));
    await handleToolCall(gateHa, "forget_memory", { query: CANARY }, ctx("t1"));

    // Confirming the forget must not create the automation.
    const forget = (await handleToolCall(gateHa, "forget_memory", { query: CANARY }, ctx("t2"))) as { success?: boolean };
    expect(forget.success).toBe(true);
    expect(gateHa.createAutomation).not.toHaveBeenCalled();

    // The automation preview is still pending and confirmable on its own.
    const create = (await handleToolCall(gateHa, "create_automation", auto, ctx("t3"))) as { success?: boolean };
    expect(create.success).toBe(true);
    expect(gateHa.createAutomation).toHaveBeenCalledTimes(1);
  });
});

describe("extractAndStoreFacts forget filtering", () => {
  let memory: IMemoryStore;
  let extractor: IFactExtractor;

  const extracted = (facts: ExtractedFact[]) =>
    ({ extract: vi.fn().mockResolvedValue(facts) }) as unknown as IFactExtractor;

  beforeEach(() => {
    memory = {
      getFacts: vi.fn().mockResolvedValue([]),
      addFacts: vi.fn().mockResolvedValue(["new-1"]),
      deleteFact: vi.fn().mockResolvedValue(true),
    } as unknown as IMemoryStore;
  });

  afterEach(() => vi.clearAllMocks());

  it("stores everything when no forget happened in the turn", async () => {
    extractor = extracted([
      { content: "User's name is HAL 9000", category: "identity", confidence: 1 },
    ]);
    const n = await extractAndStoreFacts(memory, extractor, "user-1", "call me HAL 9000", "Got it");
    expect(n).toBe(1);
    expect(memory.addFacts).toHaveBeenCalledWith("user-1", [
      expect.objectContaining({ content: "User's name is HAL 9000" }),
    ]);
  });

  it("drops a fact that re-learns the memory just forgotten, keeps the replacement", async () => {
    // The exact issue #54 shape: forget the old identity, set a new one, same breath.
    extractor = extracted([
      { content: "User's name is Jure", category: "identity", confidence: 1 },
      { content: "User's name is HAL 9000", category: "identity", confidence: 1 },
    ]);
    const n = await extractAndStoreFacts(
      memory,
      extractor,
      "user-1",
      "forget that my name is Jure, my name is now HAL 9000",
      "Forgotten. I'll call you HAL 9000.",
      ["User's name is Jure"]
    );
    expect(n).toBe(1);
    const stored = (memory.addFacts as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toBe("User's name is HAL 9000");
  });

  it("drops a REWORDED re-learn of the forgotten memory", async () => {
    extractor = extracted([
      { content: "The user's name is Jure", category: "identity", confidence: 1 },
    ]);
    const n = await extractAndStoreFacts(
      memory,
      extractor,
      "user-1",
      "forget my name",
      "Forgotten.",
      ["User's name is Jure"]
    );
    expect(n).toBe(0);
    expect(memory.addFacts).not.toHaveBeenCalled();
  });

  it("keeps an unrelated fact even when a forget happened in the same turn", async () => {
    extractor = extracted([
      { content: "User prefers the bedroom at 20 degrees", category: "preference", confidence: 1 },
    ]);
    const n = await extractAndStoreFacts(
      memory,
      extractor,
      "user-1",
      "forget my canary word; also I like the bedroom at 20",
      "Done.",
      ["User's test canary word is bumblebee"]
    );
    expect(n).toBe(1);
  });
});

describe("handleToolCall forget_memory — previewed memory vanishes before confirm", () => {
  // Live on real HA: the async extractor's `replaces` path deletes the old fact
  // between preview and "yes", so the confirm call must NOT re-resolve onto the
  // replacement and offer to forget the name the user just set.
  const CONV = "conv-forget-race";
  const ha = {} as unknown as HomeAssistantClient;
  let memory: IMemoryStore;

  const fact = (id: string, content: string) => ({
    id, userId: "user-1", content,
    category: "identity" as const, confidence: 1,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    lastUsed: new Date("2026-01-01T00:00:00Z"),
    useCount: 0,
  });
  const ctx = (turnId: string): ToolContext => ({
    conversationId: CONV, turnId, userId: "user-1", memory,
  });

  beforeEach(() => {
    clearConfirmation(CONV);
    memory = {
      getFacts: vi.fn().mockResolvedValue([fact("f-old", "User's name is Jure")]),
      deleteFact: vi.fn().mockResolvedValue(true),
    } as unknown as IMemoryStore;
  });

  afterEach(() => vi.clearAllMocks());

  it("reports already_gone instead of targeting the replacement fact", async () => {
    const preview = (await handleToolCall(ha, "forget_memory", { query: "User's name is Jure" }, ctx("t1"))) as {
      confirmation_required?: boolean;
    };
    expect(preview.confirmation_required).toBe(true);

    // Extractor replaced the fact in between: old gone, new name stored.
    memory.getFacts = vi.fn().mockResolvedValue([fact("f-new", "User's name is HAL 9000")]);

    const confirm = (await handleToolCall(ha, "forget_memory", { query: "User's name is Jure" }, ctx("t2"))) as {
      already_gone?: boolean;
      confirmation_required?: boolean;
      memory_to_forget?: string;
    };
    expect(confirm.already_gone).toBe(true);
    expect(confirm.confirmation_required).toBeUndefined();
    expect(confirm.memory_to_forget).toBeUndefined();
    expect(memory.deleteFact).not.toHaveBeenCalled();
  });

  it("does not hijack an unrelated forget while another preview is stale", async () => {
    await handleToolCall(ha, "forget_memory", { query: "User's name is Jure" }, ctx("t1"));
    memory.getFacts = vi.fn().mockResolvedValue([
      fact("f-canary", "User's test canary word is bumblebee"),
    ]);
    // A different memory entirely → normal preview flow, not already_gone.
    const other = (await handleToolCall(
      ha, "forget_memory", { query: "User's test canary word is bumblebee" }, ctx("t2")
    )) as { already_gone?: boolean; confirmation_required?: boolean };
    expect(other.already_gone).toBeUndefined();
    expect(other.confirmation_required).toBe(true);
  });

  it("still commits normally when the previewed memory is still there", async () => {
    await handleToolCall(ha, "forget_memory", { query: "User's name is Jure" }, ctx("t1"));
    const confirm = (await handleToolCall(ha, "forget_memory", { query: "User's name is Jure" }, ctx("t2"))) as {
      success?: boolean;
    };
    expect(confirm.success).toBe(true);
    expect(memory.deleteFact).toHaveBeenCalledWith("user-1", "f-old");
  });
});

describe("extractAndStoreFacts — one-word value swap survives (live 2.4.16 regression)", () => {
  it("keeps the new canary word while dropping a restatement of the old one", async () => {
    const memory = {
      getFacts: vi.fn().mockResolvedValue([]),
      addFacts: vi.fn().mockResolvedValue(["new-1"]),
      deleteFact: vi.fn().mockResolvedValue(true),
    } as unknown as IMemoryStore;
    const extractor = {
      extract: vi.fn().mockResolvedValue([
        { content: 'User\'s test canary word is "honeybee"', category: "preference", confidence: 1 },
        { content: "The user's canary word is bumblebee", category: "preference", confidence: 1 },
      ]),
    } as unknown as IFactExtractor;

    const n = await extractAndStoreFacts(
      memory, extractor, "user-1",
      "forget that my test canary word is bumblebee — my canary word is now honeybee",
      "Forgotten. I'll remember honeybee.",
      ['User\'s test canary word is "bumblebee"']
    );

    expect(n).toBe(1);
    const stored = (memory.addFacts as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toContain("honeybee");
  });
});
