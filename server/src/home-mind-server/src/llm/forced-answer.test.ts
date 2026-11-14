import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  withForcedAnswer,
  isToolChoiceUnsupported,
  resetForcedAnswerCache,
} from "./forced-answer.js";

// The two refusals seen live in the 2026-11 scout (Meta and Google Vertex).
const metaRefusal = Object.assign(
  new Error('400 only "auto" is supported for `tool_choice`'),
  { status: 400, param: "tool_choice" }
);
const vertexRefusal = Object.assign(
  new Error("400 tool_choice `none` is not supported. Only `auto` is supported"),
  { status: 400 }
);

describe("withForcedAnswer", () => {
  beforeEach(() => {
    resetForcedAnswerCache();
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends nothing extra on an ordinary turn", async () => {
    const send = vi.fn().mockResolvedValue("ok");

    await withForcedAnswer("m", false, send);

    expect(send.mock.calls).toEqual([[{}]]);
  });

  it("forces the answer with tool_choice none where it is accepted", async () => {
    const send = vi.fn().mockResolvedValue("ok");

    expect(await withForcedAnswer("m", true, send)).toBe("ok");

    expect(send.mock.calls).toEqual([[{ tool_choice: "none" }]]);
  });

  it("falls back to the nudge when tool_choice is refused, and remembers", async () => {
    const send = vi.fn().mockRejectedValueOnce(metaRefusal).mockResolvedValue("ok");

    expect(await withForcedAnswer("muse", true, send)).toBe("ok");
    expect(send.mock.calls).toEqual([[{ tool_choice: "none" }], [{ nudge: true }]]);

    // The next forced turn skips the probe.
    await withForcedAnswer("muse", true, send);
    expect(send.mock.calls[2]).toEqual([{ nudge: true }]);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("remembers a refusal per endpoint and model", async () => {
    const strict = vi.fn().mockRejectedValueOnce(vertexRefusal).mockResolvedValue("ok");
    await withForcedAnswer("m", true, strict, "https://a.example/v1");

    const other = vi.fn().mockResolvedValue("ok");
    await withForcedAnswer("m", true, other, "https://b.example/v1");
    expect(other.mock.calls).toEqual([[{ tool_choice: "none" }]]);
  });

  it("lets any other error through untouched", async () => {
    const other = Object.assign(new Error("400 model not found"), { status: 400 });
    const send = vi.fn().mockRejectedValue(other);

    await expect(withForcedAnswer("m", true, send)).rejects.toBe(other);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("isToolChoiceUnsupported", () => {
  it("recognises both live refusals", () => {
    expect(isToolChoiceUnsupported(metaRefusal)).toBe(true);
    expect(isToolChoiceUnsupported(vertexRefusal)).toBe(true);
  });

  it("ignores other statuses and unrelated 400s", () => {
    expect(isToolChoiceUnsupported(Object.assign(new Error("tool_choice"), { status: 500 }))).toBe(false);
    expect(isToolChoiceUnsupported(Object.assign(new Error("bad tools schema"), { status: 400 }))).toBe(false);
    expect(isToolChoiceUnsupported(null)).toBe(false);
  });
});
