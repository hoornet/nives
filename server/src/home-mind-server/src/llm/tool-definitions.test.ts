import { describe, it, expect } from "vitest";
import {
  TOOL_DEFINITIONS,
  toAnthropicTools,
  toOpenAITools,
} from "./tool-definitions.js";

describe("TOOL_DEFINITIONS", () => {
  it("has 11 tools", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(12);
  });

  it("has the expected tool names", () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual([
      "get_state",
      "get_entities",
      "search_entities",
      "call_service",
      "get_history",
      "create_automation",
      "list_automations",
      "get_automation",
      "delete_automation",
      "update_automation",
      "list_services",
      "forget_memory",
    ]);
  });

  it("each tool has name, description, and parameters", () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters.type).toBe("object");
      expect(tool.parameters.properties).toBeDefined();
      expect(Array.isArray(tool.parameters.required)).toBe(true);
    }
  });
});

describe("toAnthropicTools", () => {
  it("converts to Anthropic format with input_schema", () => {
    const result = toAnthropicTools(TOOL_DEFINITIONS);

    expect(result).toHaveLength(12);
    for (const tool of result) {
      expect(tool).toHaveProperty("name");
      expect(tool).toHaveProperty("description");
      expect(tool.input_schema).toMatchObject({
        type: "object",
      });
      expect(tool.input_schema).toHaveProperty("properties");
      expect(tool.input_schema).toHaveProperty("required");
    }
  });

  it("preserves tool properties and required fields", () => {
    const result = toAnthropicTools(TOOL_DEFINITIONS);
    const getState = result.find((t) => t.name === "get_state")!;

    expect(getState.input_schema.properties).toHaveProperty("entity_id");
    expect(getState.input_schema.required).toEqual(["entity_id"]);
  });
});

describe("toOpenAITools", () => {
  it("wraps in function type", () => {
    const result = toOpenAITools(TOOL_DEFINITIONS);

    expect(result).toHaveLength(12);
    for (const tool of result) {
      expect(tool.type).toBe("function");
      const fn = (tool as any).function;
      expect(fn).toHaveProperty("name");
      expect(fn).toHaveProperty("description");
      expect(fn.parameters).toMatchObject({
        type: "object",
      });
    }
  });

  it("preserves tool parameters structure", () => {
    const result = toOpenAITools(TOOL_DEFINITIONS);
    const callService = result.find(
      (t) => (t as any).function.name === "call_service"
    )!;
    const fn = (callService as any).function;

    expect(fn.parameters).toHaveProperty("properties");
    expect(fn.parameters).toHaveProperty("required");
    expect(fn.parameters.required).toEqual(["domain", "service"]);
  });
});

describe("gated tools describe the preview-first flow, not a pre-call question", () => {
  // Regression: these descriptions predated the server-enforced confirmation
  // gate (v2.1.9-2.1.11) and still said "ONLY call this AFTER the user has
  // explicitly confirmed". The gate makes the FIRST call the preview, so the
  // model asked in text, got a yes, called the tool, got confirmation_required,
  // and asked a SECOND time. Observed live: "delete the bedroom cooling
  // automation" took two rounds of "da" before anything happened. prompts.ts
  // described the flow correctly all along; the tool description sits closer to
  // the call site and won.
  const GATED = ["create_automation", "update_automation", "delete_automation", "forget_memory"];

  for (const name of GATED) {
    const def = () => TOOL_DEFINITIONS.find((t) => t.name === name)!;

    it(`${name} does not tell the model to ask before calling`, () => {
      expect(def().description).not.toMatch(/ONLY call this AFTER/i);
      expect(def().description).not.toMatch(/first (restate|name) .*and ask/i);
    });

    it(`${name} states that the first call previews without acting`, () => {
      const d = def().description;
      expect(d).toMatch(/FIRST call NEVER/);
      expect(d).toMatch(/confirmation_required/);
      expect(d).toMatch(/NEXT message/);
    });
  }
});

describe("automation field schemas", () => {
  // Declared as "object" these left a model holding a list no valid way to send
  // it, and Haiku 5.5 on the Anthropic API sent JSON text instead.
  for (const name of ["create_automation", "update_automation"]) {
    for (const field of ["trigger", "condition", "action"]) {
      it(`${name}.${field} is an array of objects`, () => {
        const tool = TOOL_DEFINITIONS.find((t) => t.name === name)!;
        expect(tool.parameters.properties[field]).toMatchObject({
          type: "array",
          items: { type: "object" },
        });
      });
    }
  }
});
