/**
 * Speech-to-text service.
 * Currently only the OpenAI-compatible transcriptions API is supported.
 * When STT_PROVIDER is not set (or "none"), the service is disabled
 * and the /api/stt endpoint returns 501.
 */

import OpenAI from "openai";
import type { Config } from "../config.js";

export interface ISttService {
  transcribe(audioBuffer: Buffer, mimeType: string, filename: string, language?: string): Promise<string>;
}

/**
 * Waits before each retry of a transcription the provider turned away.
 *
 * The SDK's own retries were not enough: it tries twice more within about a
 * second and a half, and on 2026-09-19 a spoken request failed with
 * "Provider returned 429" after exactly that. A busy provider needs longer than
 * that to clear, and the Home Assistant side waits 45 s for us, so a few
 * seconds spent retrying costs far less than a failed request the user has to
 * repeat. We retry the same model on purpose: for Slovene the alternatives
 * transcribe too poorly to be worth falling back to.
 */
export const STT_RETRY_DELAYS_MS = [1000, 2500, 5000] as const;

/** Never wait longer than this on a provider's retry-after hint. */
const MAX_RETRY_AFTER_MS = 8000;

/** Errors worth another attempt: rate limits, server-side failures, network trouble. */
function isRetryable(error: unknown): boolean {
  if (error instanceof OpenAI.APIConnectionError) return true; // includes timeouts
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    return status === 408 || status === 429 || (typeof status === "number" && status >= 500);
  }
  return false;
}

function describeError(error: unknown): string {
  if (error instanceof OpenAI.APIError) {
    return `${error.status ?? "no status"} ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** The provider's own retry hint, if it gave one we are willing to wait for. */
function retryAfterMs(error: unknown): number | undefined {
  if (!(error instanceof OpenAI.APIError) || !error.headers) return undefined;
  const headers = error.headers as Headers;
  const ms = Number(headers.get?.("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return Math.min(ms, MAX_RETRY_AFTER_MS);
  const seconds = Number(headers.get?.("retry-after"));
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  return undefined;
}

/** Seconds of audio in a PCM WAV, read from its header; undefined for anything else. */
export function wavDurationSeconds(buffer: Buffer): number | undefined {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return undefined;
  }
  const byteRate = buffer.readUInt32LE(28);
  if (!byteRate) return undefined;
  // Walk the chunks to the data chunk rather than assuming a 44-byte header.
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "data") return Math.min(size, buffer.length - offset - 8) / byteRate;
    offset += 8 + size + (size % 2);
  }
  return undefined;
}

type TranscriptionsClient = Pick<OpenAI, "audio">;

export interface SttServiceOptions {
  /** Log the recognised text itself, not only its length. */
  logText?: boolean;
  /** Injected in tests. */
  client?: TranscriptionsClient;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export class OpenAISttService implements ISttService {
  private client: TranscriptionsClient;
  private model: string;
  private logText: boolean;
  private sleep: (ms: number) => Promise<void>;
  private log: (line: string) => void;

  constructor(apiKey: string, model: string, baseUrl?: string, options: SttServiceOptions = {}) {
    // maxRetries 0: retries happen in transcribe(), where each one is logged
    // and the waits are long enough to outlast a busy provider.
    this.client =
      options.client ??
      new OpenAI({
        apiKey,
        maxRetries: 0,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
      });
    this.model = model;
    this.logText = options.logText ?? false;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = options.log ?? ((line) => console.log(line));
  }

  async transcribe(audioBuffer: Buffer, mimeType: string, filename: string, language?: string): Promise<string> {
    const started = Date.now();
    const seconds = wavDurationSeconds(audioBuffer);
    const audio =
      `${seconds !== undefined ? `${seconds.toFixed(1)} s of audio` : "audio"} ` +
      `(${mimeType || "unknown type"}, ${Math.round(audioBuffer.length / 1024)} KB), ` +
      `language=${language ?? "auto"}, model=${this.model}`;

    for (let attempt = 1; ; attempt++) {
      try {
        const file = new File([audioBuffer], filename, { type: mimeType });
        const result = await this.client.audio.transcriptions.create({
          file,
          model: this.model,
          ...(language ? { language } : {}),
        });
        const text = result.text ?? "";
        const took = ((Date.now() - started) / 1000).toFixed(1);
        const tries = attempt > 1 ? `, ${attempt} attempts` : "";
        const heard = text.trim()
          ? this.logText
            ? `"${text}"`
            : `${text.length} chars`
          : "NOTHING (empty transcript)";
        this.log(`[stt] ${audio} → ${took} s${tries}: ${heard}`);
        return text;
      } catch (error) {
        const delay = STT_RETRY_DELAYS_MS[attempt - 1];
        if (delay === undefined || !isRetryable(error)) {
          const took = ((Date.now() - started) / 1000).toFixed(1);
          this.log(`[stt] FAILED after ${attempt} attempt(s), ${took} s: ${describeError(error)} — ${audio}`);
          throw error;
        }
        const wait = retryAfterMs(error) ?? delay;
        this.log(`[stt] attempt ${attempt} failed (${describeError(error)}); retrying in ${(wait / 1000).toFixed(1)} s`);
        await this.sleep(wait);
      }
    }
  }
}

export function createSttService(config: Config): ISttService | null {
  if (config.sttProvider === "none") return null;

  // Resolve API key: dedicated STT key takes precedence, then fall back to openaiApiKey
  const apiKey = config.sttApiKey ?? config.openaiApiKey;
  if (!apiKey) return null;

  return new OpenAISttService(apiKey, config.sttModel, config.sttBaseUrl ?? config.openaiBaseUrl, {
    logText: config.logLevel === "debug",
  });
}
