import { describe, it, expect, beforeEach } from "vitest";
import {
  issueConfirmation,
  consumeConfirmation,
  clearConfirmation,
  describePending,
} from "./automation-confirmations.js";

describe("automation confirmations", () => {
  const conv = "conv-1";
  beforeEach(() => clearConfirmation(conv));

  it("consumes a valid token from a LATER turn", () => {
    const token = issueConfirmation(conv, "create_automation", { alias: "X" }, "turn-1");
    const res = consumeConfirmation(conv, token, "create_automation", "turn-2");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.input).toEqual({ alias: "X" });
  });

  it("rejects confirming in the SAME turn it was issued", () => {
    const token = issueConfirmation(conv, "create_automation", { alias: "X" }, "turn-1");
    expect(consumeConfirmation(conv, token, "create_automation", "turn-1").ok).toBe(false);
  });

  it("rejects an unknown / mismatched token", () => {
    issueConfirmation(conv, "create_automation", { alias: "X" }, "turn-1");
    expect(consumeConfirmation(conv, "not-the-token", "create_automation", "turn-2").ok).toBe(false);
  });

  it("rejects when the tool name differs", () => {
    const token = issueConfirmation(conv, "create_automation", { alias: "X" }, "turn-1");
    expect(consumeConfirmation(conv, token, "delete_automation", "turn-2").ok).toBe(false);
  });

  it("is single-use — a token can't be consumed twice", () => {
    const token = issueConfirmation(conv, "create_automation", { alias: "X" }, "turn-1");
    expect(consumeConfirmation(conv, token, "create_automation", "turn-2").ok).toBe(true);
    expect(consumeConfirmation(conv, token, "create_automation", "turn-3").ok).toBe(false);
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
