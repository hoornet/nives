import { describe, it, expect, beforeEach } from "vitest";
import {
  recordPreview,
  isConfirmed,
  clearConfirmation,
  describePending,
} from "./automation-confirmations.js";

describe("automation confirmations", () => {
  const conv = "conv-1";
  const create = (over: Record<string, unknown> = {}) => ({
    alias: "X",
    trigger: { platform: "time", at: "12:00:00" },
    action: { service: "notify.foo" },
    ...over,
  });

  beforeEach(() => clearConfirmation(conv));

  it("confirms the same payload in a LATER turn after a recorded preview", () => {
    recordPreview(conv, "create_automation", create(), "turn-1");
    expect(isConfirmed(conv, "create_automation", create(), "turn-2")).toBe(true);
  });

  it("does NOT confirm in the same turn the preview was recorded", () => {
    recordPreview(conv, "create_automation", create(), "turn-1");
    expect(isConfirmed(conv, "create_automation", create(), "turn-1")).toBe(false);
  });

  it("does NOT confirm without a prior preview", () => {
    expect(isConfirmed(conv, "create_automation", create(), "turn-2")).toBe(false);
  });

  it("does NOT confirm a DIFFERENT payload (forces a re-preview)", () => {
    recordPreview(conv, "create_automation", create(), "turn-1");
    expect(
      isConfirmed(
        conv,
        "create_automation",
        create({ trigger: { platform: "time", at: "13:00:00" } }),
        "turn-2"
      )
    ).toBe(false);
  });

  it("ignores the 'Nives: ' prefix and key order when matching", () => {
    recordPreview(
      conv,
      "create_automation",
      { alias: "Sun", action: { service: "notify.foo" }, trigger: { at: "12:00:00", platform: "time" } },
      "turn-1"
    );
    expect(
      isConfirmed(
        conv,
        "create_automation",
        { trigger: { platform: "time", at: "12:00:00" }, alias: "Nives: Sun", action: { service: "notify.foo" } },
        "turn-2"
      )
    ).toBe(true);
  });

  it("is single-use — confirming consumes the preview", () => {
    recordPreview(conv, "create_automation", create(), "turn-1");
    expect(isConfirmed(conv, "create_automation", create(), "turn-2")).toBe(true);
    expect(isConfirmed(conv, "create_automation", create(), "turn-3")).toBe(false);
  });

  it("does not confirm across different tools", () => {
    recordPreview(conv, "create_automation", create(), "turn-1");
    expect(isConfirmed(conv, "delete_automation", { entity_id: "automation.x" }, "turn-2")).toBe(false);
  });

  it("describePending summarizes create/update/delete", () => {
    expect(
      describePending("create_automation", { alias: "A", trigger: {}, action: {} })
    ).toMatchObject({ action: "create automation", alias: "A" });
    expect(describePending("update_automation", { entity_id: "automation.x", mode: "restart" })).toMatchObject({
      action: "update automation",
      entity_id: "automation.x",
      changes: { mode: "restart" },
    });
    expect(describePending("delete_automation", { entity_id: "automation.x" })).toMatchObject({
      action: "delete automation",
      entity_id: "automation.x",
    });
  });
});
