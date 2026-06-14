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

  it("confirms a create in a LATER turn after a recorded preview", () => {
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

  it("confirms a create even when the payload was reformatted (payload not compared)", () => {
    // Preview with action as an array; confirm with a wildly different shape.
    recordPreview(conv, "create_automation", { alias: "X", trigger: [{ platform: "time", at: "12:00:00" }], action: [{ service: "notify.foo" }] }, "turn-1");
    const reformatted = {
      alias: "Nives: X",
      action: { service: "foo", domain: "notify", service_data: { message: "hi" } },
      trigger: { at: "12:00:00", platform: "time" },
    };
    expect(isConfirmed(conv, "create_automation", reformatted, "turn-2")).toBe(true);
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

  it("scopes delete/update by entity_id — a different target does NOT confirm", () => {
    recordPreview(conv, "delete_automation", { entity_id: "automation.x" }, "turn-1");
    expect(isConfirmed(conv, "delete_automation", { entity_id: "automation.y" }, "turn-2")).toBe(false);
    expect(isConfirmed(conv, "delete_automation", { entity_id: "automation.x" }, "turn-2")).toBe(true);
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
