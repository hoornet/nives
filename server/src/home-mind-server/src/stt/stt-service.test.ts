import { describe, it, expect, vi } from "vitest";
import OpenAI from "openai";
import { OpenAISttService, STT_MAX_TOTAL_WAIT_MS, STT_RETRY_DELAYS_MS, wavDurationSeconds } from "./stt-service.js";

/** A 16 kHz mono 16-bit WAV holding `seconds` of silence. */
function wav(seconds: number): Buffer {
  const rate = 16000;
  const dataSize = Math.round(seconds * rate * 2);
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

const rateLimited = () =>
  OpenAI.APIError.generate(429, { message: "Provider returned 429" }, undefined, new Headers());

function service(create: ReturnType<typeof vi.fn>, logText = true) {
  const lines: string[] = [];
  const sleeps: number[] = [];
  const stt = new OpenAISttService("key", "microsoft/mai-transcribe-2", undefined, {
    logText,
    client: { audio: { transcriptions: { create } } } as never,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (line) => lines.push(line),
  });
  return { stt, lines, sleeps };
}

describe("OpenAISttService", () => {
  it("retries a rate-limited transcription and succeeds, logging each attempt", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(rateLimited())
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValueOnce({ text: "Prižgi luči v kuhinji." });
    const { stt, lines, sleeps } = service(create);

    const text = await stt.transcribe(wav(2.5), "audio/wav", "speech.wav", "sl");

    expect(text).toBe("Prižgi luči v kuhinji.");
    expect(create).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([STT_RETRY_DELAYS_MS[0], STT_RETRY_DELAYS_MS[1]]);
    expect(lines.filter((l) => l.includes("retrying"))).toHaveLength(2);
    const summary = lines.at(-1)!;
    expect(summary).toContain("2.5 s of audio");
    expect(summary).toContain("language=sl");
    expect(summary).toContain("3 attempts");
    expect(summary).toContain('"Prižgi luči v kuhinji."');
  });

  it("gives up after the last retry and logs why", async () => {
    const create = vi.fn().mockRejectedValue(rateLimited());
    const { stt, lines } = service(create);

    await expect(stt.transcribe(wav(1), "audio/wav", "speech.wav", "sl")).rejects.toThrow(/429/);
    expect(create).toHaveBeenCalledTimes(STT_RETRY_DELAYS_MS.length + 1);
    expect(lines.at(-1)).toMatch(/FAILED after 4 attempt\(s\).*429/);
  });

  it("does not retry errors that another attempt cannot fix", async () => {
    const create = vi
      .fn()
      .mockRejectedValue(OpenAI.APIError.generate(401, { message: "bad key" }, undefined, new Headers()));
    const { stt, sleeps } = service(create);

    await expect(stt.transcribe(wav(1), "audio/wav", "speech.wav")).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("says plainly when the transcript came back empty", async () => {
    const create = vi.fn().mockResolvedValue({ text: "" });
    const { stt, lines } = service(create);

    expect(await stt.transcribe(wav(1.2), "audio/wav", "speech.wav", "sl")).toBe("");
    expect(lines.at(-1)).toContain("NOTHING (empty transcript)");
  });

  it("waits as long as the provider asks, within the cap", async () => {
    const hinted = OpenAI.APIError.generate(
      429,
      { message: "slow down" },
      undefined,
      new Headers({ "retry-after": "3" })
    );
    const create = vi.fn().mockRejectedValueOnce(hinted).mockResolvedValueOnce({ text: "ok" });
    const { stt, sleeps } = service(create);

    await stt.transcribe(wav(1), "audio/wav", "speech.wav");
    expect(sleeps).toEqual([3000]);
  });

  it("stops retrying once the total wait would exceed its budget", async () => {
    const hinted = () =>
      OpenAI.APIError.generate(429, { message: "busy" }, undefined, new Headers({ "retry-after-ms": "7000" }));
    const create = vi.fn().mockImplementation(async () => {
      throw hinted();
    });
    const { stt, sleeps, lines } = service(create);

    await expect(stt.transcribe(wav(1), "audio/wav", "speech.wav")).rejects.toThrow();
    // 7 s fits, a second 7 s would make 14 s > 12 s.
    expect(sleeps).toEqual([7000]);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(STT_MAX_TOTAL_WAIT_MS);
    expect(create).toHaveBeenCalledTimes(2);
    expect(lines.at(-1)).toMatch(/FAILED after 2 attempt/);
  });

  it("retries server errors and dropped connections", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(OpenAI.APIError.generate(503, { message: "unavailable" }, undefined, new Headers()))
      .mockRejectedValueOnce(new OpenAI.APIConnectionError({ message: "socket hang up" }))
      .mockResolvedValueOnce({ text: "ok" });
    const { stt } = service(create);

    expect(await stt.transcribe(wav(1), "audio/wav", "speech.wav")).toBe("ok");
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("treats a whitespace-only transcript as nothing heard", async () => {
    const create = vi.fn().mockResolvedValue({ text: "  \n " });
    const { stt, lines } = service(create);

    expect(await stt.transcribe(wav(1), "audio/wav", "speech.wav")).toBe("");
    expect(lines.at(-1)).toContain("NOTHING (empty transcript)");
  });

  it("logs only the length of the text when not at debug level", async () => {
    const create = vi.fn().mockResolvedValue({ text: "Koliko je ura?" });
    const { stt, lines } = service(create, false);

    await stt.transcribe(wav(1), "audio/wav", "speech.wav", "sl");
    expect(lines.at(-1)).toContain("14 chars");
    expect(lines.at(-1)).not.toContain("Koliko");
  });
});

describe("wavDurationSeconds", () => {
  it("reads the duration from a PCM WAV header", () => {
    expect(wavDurationSeconds(wav(3))).toBeCloseTo(3, 5);
  });

  it("finds the format chunk even when another chunk comes first", () => {
    const plain = wav(2);
    const list = Buffer.alloc(8 + 10);
    list.write("LIST", 0, "ascii");
    list.writeUInt32LE(10, 4);
    const reordered = Buffer.concat([plain.subarray(0, 12), list, plain.subarray(12)]);
    expect(wavDurationSeconds(reordered)).toBeCloseTo(2, 5);
  });

  it("returns undefined for anything that is not a WAV", () => {
    expect(wavDurationSeconds(Buffer.from("not audio at all, just some bytes here to pass 44"))).toBeUndefined();
  });
});
