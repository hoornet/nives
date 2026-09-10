import { describe, it, expect, vi } from "vitest";
import { OpenAITtsService } from "./tts-service.js";

// The audio format has to be asked for by name. OpenAI's own API defaults to
// MP3, but an OpenAI-compatible endpoint need not — the one behind the add-on's
// cloud voice defaults to raw PCM. Left unset, /api/tts serves PCM bytes as
// audio/mpeg and every caller, the HA text-to-speech entity included, plays
// noise. Nothing else in the stack can detect that, so it is pinned here.

describe("OpenAITtsService", () => {
  function serviceWithSpy() {
    const create = vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }));
    const svc = new OpenAITtsService("k", "some/model", "some-voice", "https://example.invalid/v1");
    (svc as unknown as { client: { audio: { speech: { create: typeof create } } } }).client = {
      audio: { speech: { create } },
    };
    return { svc, create };
  }

  it("always asks for mp3", async () => {
    const { svc, create } = serviceWithSpy();
    await svc.synthesize("Dober dan.");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ response_format: "mp3" })
    );
  });

  it("passes the configured model and voice through unchanged", async () => {
    const { svc, create } = serviceWithSpy();
    await svc.synthesize("Dober dan.");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "some/model", voice: "some-voice", input: "Dober dan." })
    );
  });

  it("spells whole numbers out on the way to the voice", async () => {
    // The reply the user sees keeps its digits; only what the voice receives changes.
    const create = vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }));
    const svc = new OpenAITtsService("k", "m", "v", "https://example.invalid/v1", "sl");
    (svc as unknown as { client: { audio: { speech: { create: typeof create } } } }).client = {
      audio: { speech: { create } },
    };
    await svc.synthesize("VOC je 156 enot, PM2,5 pa 8,6 mikrograma.");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ input: "VOC je sto šestinpetdeset enot, PM2,5 pa 8,6 mikrograma." })
    );
  });

  it("leaves the text alone when the voice is not Slovene", async () => {
    const create = vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }));
    const svc = new OpenAITtsService("k", "m", "v", "https://example.invalid/v1", "en");
    (svc as unknown as { client: { audio: { speech: { create: typeof create } } } }).client = {
      audio: { speech: { create } },
    };
    await svc.synthesize("156 units");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ input: "156 units" }));
  });

  it("returns the audio as a Buffer", async () => {
    const { svc } = serviceWithSpy();
    expect(Buffer.isBuffer(await svc.synthesize("Dober dan."))).toBe(true);
  });
});
