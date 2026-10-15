import { describe, it, expect, vi, afterEach } from "vitest";
import { AssistExposure, notExposedMessage } from "./exposure.js";

const set = (...ids: string[]) => new Set(ids);

describe("AssistExposure", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows an exposed entity and refuses one that merely exists", async () => {
    const exposure = new AssistExposure(async () => set("light.kitchen"));

    expect(await exposure.allows("light.kitchen")).toBe(true);
    expect(await exposure.allows("light.kitchen_1")).toBe(false);
  });

  it("has no opinion when the list cannot be read", async () => {
    const exposure = new AssistExposure(async () => null);

    // A websocket failure must not blind the assistant to the whole house.
    expect(await exposure.allows("light.anything")).toBe(true);
    expect(await exposure.list()).toBeNull();
  });

  it("has no opinion when the read throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const exposure = new AssistExposure(async () => {
      throw new Error("websocket down");
    });

    expect(await exposure.allows("light.anything")).toBe(true);
    expect(await exposure.list()).toBeNull();
  });

  it("has no opinion when the user exposed nothing", async () => {
    const exposure = new AssistExposure(async () => set());

    expect(await exposure.allows("light.anything")).toBe(true);
    expect(await exposure.list()).toBeNull();
  });

  it("caches for the TTL, then refreshes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let current = set("light.a");
    const fetcher = vi.fn(async () => current);
    const exposure = new AssistExposure(fetcher, 1000);

    expect(await exposure.allows("light.a")).toBe(true);
    expect(await exposure.allows("light.b")).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);

    current = set("light.a", "light.b");
    expect(await exposure.allows("light.b")).toBe(false); // still cached

    vi.setSystemTime(Date.now() + 1001);
    expect(await exposure.allows("light.b")).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("defaults the TTL to the 30-minute topology scan interval", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetcher = vi.fn(async () => set("light.a"));
    const exposure = new AssistExposure(fetcher);

    await exposure.list();
    vi.setSystemTime(Date.now() + 29 * 60 * 1000);
    await exposure.list();
    expect(fetcher).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 2 * 60 * 1000);
    await exposure.list();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent reads into one fetch", async () => {
    const fetcher = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return set("light.a");
    });
    const exposure = new AssistExposure(fetcher);

    const [a, b, list] = await Promise.all([
      exposure.allows("light.a"),
      exposure.allows("light.b"),
      exposure.list(),
    ]);

    expect([a, b]).toEqual([true, false]);
    expect(list).toEqual(set("light.a"));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps the last good list when a refresh throws", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail = false;
    const exposure = new AssistExposure(async () => {
      if (fail) throw new Error("websocket down");
      return set("light.a");
    }, 1000);

    expect(await exposure.allows("light.b")).toBe(false);

    fail = true;
    vi.setSystemTime(Date.now() + 1001);
    // Falling back to "no opinion" here would hand the model the whole house
    // the moment the websocket hiccups; the known-good answer is better.
    expect(await exposure.allows("light.b")).toBe(false);
    expect(await exposure.allows("light.a")).toBe(true);
  });

  it("keeps the last good list when a refresh resolves to null", async () => {
    // fetchExposedEntities never throws: a websocket error resolves to null.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let answer: Set<string> | null = set("light.a");
    const exposure = new AssistExposure(async () => answer, 1000);

    expect(await exposure.allows("light.b")).toBe(false);

    answer = null;
    vi.setSystemTime(Date.now() + 1001);
    expect(await exposure.allows("light.b")).toBe(false);
  });

  it("caches no opinion instead of re-reading on every call", async () => {
    const fetcher = vi.fn(async () => set());
    const exposure = new AssistExposure(fetcher);

    await exposure.allows("light.a");
    await exposure.allows("light.b");
    await exposure.list();

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries a failed read after the retry delay, not on every call", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let answer: Set<string> | null = null;
    const fetcher = vi.fn(async () => answer);
    const exposure = new AssistExposure(fetcher, 60_000, 1000);

    expect(await exposure.allows("light.b")).toBe(true);
    expect(await exposure.allows("light.b")).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);

    answer = set("light.a");
    vi.setSystemTime(Date.now() + 1001);
    expect(await exposure.allows("light.b")).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("defaults the retry delay to one minute", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetcher = vi.fn(async () => null);
    const exposure = new AssistExposure(fetcher);

    await exposure.list();
    vi.setSystemTime(Date.now() + 59 * 1000);
    await exposure.list();
    expect(fetcher).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 2 * 1000);
    await exposure.list();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("filters a list of states, preserving order", async () => {
    const exposure = new AssistExposure(async () => set("light.a", "light.c"));
    const states = ["light.a", "light.b", "light.c"].map((entity_id) => ({
      entity_id,
      state: "on",
      attributes: {},
      last_changed: "",
      last_updated: "",
    }));

    expect((await exposure.filter(states)).map((s) => s.entity_id)).toEqual([
      "light.a",
      "light.c",
    ]);
  });

  it("always allows a voice engine, and keeps it when filtering", async () => {
    // Home Assistant exposes no tts entity by default; an engine only speaks
    // through a speaker, and the speaker is what gets checked.
    const exposure = new AssistExposure(async () => set("light.a"));
    expect(await exposure.allows("tts.nives_text_to_speech")).toBe(true);
    expect(await exposure.allows("media_player.bedroom")).toBe(false);
    const states = ["tts.nives_text_to_speech", "media_player.bedroom", "light.a"].map((entity_id) => ({
      entity_id,
      state: "on",
      attributes: {},
      last_changed: "",
      last_updated: "",
    }));
    expect((await exposure.filter(states)).map((s) => s.entity_id)).toEqual([
      "tts.nives_text_to_speech",
      "light.a",
    ]);
  });
});

describe("notExposedMessage", () => {
  it("names the entity and tells the model not to retry other spellings", () => {
    const message = notExposedMessage("light.kitchen_table_1");

    expect(message).toContain("light.kitchen_table_1 is not available to you");
    expect(message).toContain("Do not retry with a different spelling");
  });
});
