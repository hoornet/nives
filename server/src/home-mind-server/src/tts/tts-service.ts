/**
 * Text-to-speech service.
 * Currently only the OpenAI TTS API is supported.
 * When TTS_PROVIDER is not set (or "none"), the service is disabled
 * and the /api/tts endpoint returns 501.
 */

import OpenAI from "openai";
import type { Config } from "../config.js";
import { spellNumbersForSpeech } from "./number-words.js";
import { spellInitialismsForSpeech } from "./initialisms.js";

/**
 * Everything that changes between the reply the user reads and the text the voice is given.
 * Initialisms first, so the digits they carry ("PM10") are already free-standing when the
 * number speller looks at them. Nothing here touches what Home Assistant displays.
 */
export function prepareTextForSpeech(text: string, language?: string): string {
  return spellNumbersForSpeech(spellInitialismsForSpeech(text, language), language);
}

/**
 * What a given voice model needs on the way in. Two things differ between the voices we ship:
 *
 * - The Azure neural voices (microsoft/mai-voice-2, Petra/Rok) inflect a bare Slovene numeral for a
 *   case the sentence never asked for and run the letters of "CO2" into a non-word, so the text is
 *   spelled out for them by prepareTextForSpeech. ElevenLabs reads "156 enot", "CO2" and "PM2,5"
 *   correctly as written (verified by ear and by STT round trip, speech-eval 2026-10-11), and the
 *   letter names only make it worse, so it gets the written reply untouched.
 * - ElevenLabs guesses the language from the text and, on a short Slovene sentence, sometimes guesses a
 *   neighbour, which comes out as wrong word stress. Pinning the language fixes that; it travels as
 *   `provider.options.elevenlabs.language_code`, the nesting OpenRouter forwards (a top-level
 *   `language_code` is silently dropped). Only ElevenLabs takes the field.
 */
export function voiceProfile(model: string): { spellForSpeech: boolean; forceLanguage: boolean } {
  const elevenLabs = model.startsWith("elevenlabs/");
  return { spellForSpeech: !elevenLabs, forceLanguage: elevenLabs };
}

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
    const lang = language ?? this.language;
    const profile = voiceProfile(this.model);
    // What the caller displays keeps its digits and its "PM2,5"; only what the voice receives
    // changes, and only for voices that need it (see voiceProfile).
    const spoken = profile.spellForSpeech ? prepareTextForSpeech(text, lang) : text;
    const extra =
      profile.forceLanguage && lang
        ? { provider: { options: { elevenlabs: { language_code: lang } } } }
        : {};
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
      // The SDK serialises the params object as the request body, so a field it does not know
      // about reaches the endpoint as-is. The cast is only to get past its parameter type.
      ...(extra as Record<string, never>),
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
