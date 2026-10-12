import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  withReasoningEffort,
  isReasoningEffortUnsupported,
  resetReasoningEffortCache,
} from "./reasoning-effort.js";

const rejection = Object.assign(
  new Error("400 Unrecognized request argument supplied: reasoning_effort"),
  { status: 400 }
);

describe("withReasoningEffort", () => {
  beforeEach(() => {
    resetReasoningEffortCache();
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends nothing when no effort is configured", async () => {
    const send = vi.fn().mockResolvedValue("ok");

    await withReasoningEffort("m", undefined, send);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({});
  });

  it("sends the configured effort to a model that accepts it", async () => {
    const send = vi.fn().mockResolvedValue("ok");

    expect(await withReasoningEffort("m", "low", send)).toBe("ok");

    expect(send.mock.calls).toEqual([[{ reasoning_effort: "low" }]]);
  });

  it("retries without the parameter once a model rejects it, and remembers", async () => {
    const send = vi.fn().mockRejectedValueOnce(rejection).mockResolvedValue("ok");

    expect(await withReasoningEffort("plain-model", "low", send)).toBe("ok");
    expect(send.mock.calls).toEqual([[{ reasoning_effort: "low" }], [{}]]);

    // Later calls skip the probe entirely.
    await withReasoningEffort("plain-model", "low", send);
    expect(send.mock.calls[2]).toEqual([{}]);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("remembers a rejection per endpoint and model, not per model name alone", async () => {
    const strict = vi.fn().mockRejectedValueOnce(rejection).mockResolvedValue("ok");
    await withReasoningEffort("m", "low", strict, "https://a.example/v1");

    const other = vi.fn().mockResolvedValue("ok");
    await withReasoningEffort("m", "low", other, "https://b.example/v1");
    expect(other).toHaveBeenCalledWith({ reasoning_effort: "low" });

    const sibling = vi.fn().mockResolvedValue("ok");
    await withReasoningEffort("other-model", "low", sibling, "https://a.example/v1");
    expect(sibling).toHaveBeenCalledWith({ reasoning_effort: "low" });
  });

  it("retries without the parameter after a 422 that names it", async () => {
    const mistral = Object.assign(
      new Error('422 {"detail":[{"type":"enum","loc":["body","reasoning_effort"],"input":"low"}]}'),
      { status: 422 }
    );
    const send = vi.fn().mockRejectedValueOnce(mistral).mockResolvedValue("ok");

    expect(await withReasoningEffort("mistral-small-latest", "low", send)).toBe("ok");
    expect(send.mock.calls).toEqual([[{ reasoning_effort: "low" }], [{}]]);
  });

  it("does not swallow an unrelated 400", async () => {
    const unrelated = Object.assign(new Error("400 Invalid schema for function"), { status: 400 });
    const send = vi.fn().mockRejectedValue(unrelated);

    await expect(withReasoningEffort("m", "low", send)).rejects.toBe(unrelated);
    expect(send).toHaveBeenCalledTimes(1);

    // And nothing was learned from it.
    const next = vi.fn().mockResolvedValue("ok");
    await withReasoningEffort("m", "low", next);
    expect(next).toHaveBeenCalledWith({ reasoning_effort: "low" });
  });

  it("does not swallow other failures that mention the parameter", async () => {
    const serverError = Object.assign(new Error("reasoning_effort upstream timeout"), { status: 500 });
    const send = vi.fn().mockRejectedValue(serverError);

    await expect(withReasoningEffort("m", "low", send)).rejects.toBe(serverError);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("isReasoningEffortUnsupported", () => {
  it("recognises the structured param field", () => {
    expect(
      isReasoningEffortUnsupported({ status: 400, param: "reasoning_effort", message: "nope" })
    ).toBe(true);
  });

  it("recognises the parameter named in the message only", () => {
    expect(isReasoningEffortUnsupported(rejection)).toBe(true);
    expect(
      isReasoningEffortUnsupported({ status: 400, message: "Unknown field: reasoning.effort" })
    ).toBe(true);
  });

  // Mistral validates with 422. The SDK folds the response body into the
  // message, so the field shows up as it does in `detail[].loc`.
  it("recognises a 422 that names the parameter", () => {
    const mistral = {
      status: 422,
      message:
        '422 {"detail":[{"type":"enum","loc":["body","reasoning_effort"],' +
        '"msg":"Input should be \'high\' or \'none\'","input":"low"}]}',
    };
    expect(isReasoningEffortUnsupported(mistral)).toBe(true);
    expect(isReasoningEffortUnsupported({ status: 422, param: "reasoning_effort" })).toBe(true);
  });

  it("leaves a 422 about anything else alone", () => {
    const unrelated = {
      status: 422,
      message:
        '422 {"detail":[{"type":"extra_forbidden","loc":["body","stream_options"],' +
        '"msg":"Extra inputs are not permitted"}]}',
    };
    expect(isReasoningEffortUnsupported(unrelated)).toBe(false);
  });

  it("ignores everything else", () => {
    expect(isReasoningEffortUnsupported({ status: 400, message: "model not found" })).toBe(false);
    expect(isReasoningEffortUnsupported({ status: 401, param: "reasoning_effort" })).toBe(false);
    expect(isReasoningEffortUnsupported(null)).toBe(false);
    expect(isReasoningEffortUnsupported("reasoning_effort")).toBe(false);
  });
});
