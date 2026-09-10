/**
 * Text-to-speech service.
 * Currently only the OpenAI TTS API is supported.
 * When TTS_PROVIDER is not set (or "none"), the service is disabled
 * and the /api/tts endpoint returns 501.
 */

import OpenAI from "openai";
import type { Config } from "../config.js";
import { spellNumbersForSpeech } from "./number-words.js";

export interface ITtsService {
  synthesize(text: string, language?: string): Promise<Buffer>;
}

export class OpenAITtsService implements ITtsService {
  private client: OpenAI;
  private model: string;
  private voice: string;

  private language?: string;

  constructor(apiKey: string, model: string, voice: string, baseUrl?: string, language?: string) {
    this.client = new OpenAI({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });
    this.model = model;
    this.voice = voice;
    this.language = language;
  }

  async synthesize(text: string, language?: string): Promise<Buffer> {
    // OpenAI TTS detects language automatically from input text — no explicit language param needed.
    // Numbers are the exception: the voice inflects a bare numeral for a case the sentence
    // never asked for ("156 enot" spoken "sto šestinpetdesetih enot"), so whole numbers are
    // spelled out here, on the way to the voice only. What the caller displays keeps its digits.
    const spoken = spellNumbersForSpeech(text, language ?? this.language);
    const response = await this.client.audio.speech.create({
      model: this.model,
      // Cast because the SDK's type lists only OpenAI's own voices, while the
      // voice name is whatever the configured endpoint accepts.
      voice: this.voice as "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer",
      input: spoken,
      // Must be explicit. OpenAI defaults to MP3, but an OpenAI-compatible
      // endpoint need not: at least one defaults to raw PCM, which /api/tts
      // would then serve as audio/mpeg and every caller would play as noise.
      response_format: "mp3",
    });
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
}

export function createTtsService(config: Config): ITtsService | null {
  if (config.ttsProvider === "none") return null;

  const apiKey = config.ttsApiKey ?? config.openaiApiKey;
  if (!apiKey) return null;

  return new OpenAITtsService(
    apiKey,
    config.ttsModel,
    config.ttsVoice,
    config.ttsBaseUrl ?? config.openaiBaseUrl,
    config.ttsLanguage
  );
}
