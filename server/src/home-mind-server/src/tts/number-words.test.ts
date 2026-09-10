import { describe, it, expect } from "vitest";
import { sloveneNumberWords, spellNumbersForSpeech } from "./number-words.js";

describe("sloveneNumberWords", () => {
  it("gets the ones-before-tens order right", () => {
    // This is the whole reason the function exists: asked to do this, the model wrote 87
    // as "oseminosemdeset", which is 88. One syllable, a different reading.
    expect(sloveneNumberWords(87)).toBe("sedeminosemdeset");
    expect(sloveneNumberWords(86)).toBe("šestinosemdeset");
    expect(sloveneNumberWords(68)).toBe("oseminšestdeset");
    expect(sloveneNumberWords(21)).toBe("enaindvajset");
  });

  it("handles teens, which follow a different pattern", () => {
    expect(sloveneNumberWords(12)).toBe("dvanajst");
    expect(sloveneNumberWords(19)).toBe("devetnajst");
    expect(sloveneNumberWords(10)).toBe("deset");
  });

  it("builds hundreds and thousands", () => {
    expect(sloveneNumberWords(156)).toBe("sto šestinpetdeset");
    expect(sloveneNumberWords(320)).toBe("tristo dvajset");
    expect(sloveneNumberWords(940)).toBe("devetsto štirideset");
    expect(sloveneNumberWords(1013)).toBe("tisoč trinajst");
    expect(sloveneNumberWords(2700)).toBe("dva tisoč sedemsto");
    expect(sloveneNumberWords(100)).toBe("sto");
  });

  it("refuses what it cannot do rather than guessing", () => {
    expect(sloveneNumberWords(1_000_000)).toBeNull();
    expect(sloveneNumberWords(-5)).toBeNull();
    expect(sloveneNumberWords(8.6)).toBeNull();
  });
});

describe("spellNumbersForSpeech", () => {
  it("spells out the case that started this", () => {
    // "156 enot" was spoken "sto šestinpetdesetih enot".
    expect(spellNumbersForSpeech("VOC je 156 enot.", "sl")).toBe("VOC je sto šestinpetdeset enot.");
    expect(spellNumbersForSpeech("12 mikrogramov", "sl")).toBe("dvanajst mikrogramov");
  });

  it("leaves decimals alone", () => {
    // The voice already reads these correctly, and "osem celih šest" is clumsy.
    expect(spellNumbersForSpeech("8,6 mikrograma", "sl")).toBe("8,6 mikrograma");
    expect(spellNumbersForSpeech("12,7 kilovatnih ur", "sl")).toBe("12,7 kilovatnih ur");
  });

  it("leaves °C and % alone, because the voice inflects those itself", () => {
    expect(spellNumbersForSpeech("19 °C in 60 %", "sl")).toBe("19 °C in 60 %");
  });

  it("does not touch digits that are part of a name", () => {
    expect(spellNumbersForSpeech("PM10 in CO2", "sl")).toBe("PM10 in CO2");
    expect(spellNumbersForSpeech("PM2,5 je visok", "sl")).toBe("PM2,5 je visok");
  });

  it("leaves 1 and 2 as digits, the only numerals with a gender", () => {
    // "en volt" but "ena ura" — the noun decides, and digits do not carry it.
    expect(spellNumbersForSpeech("1 enota in 2 enoti", "sl")).toBe("1 enota in 2 enoti");
  });

  it("says minus out loud", () => {
    expect(spellNumbersForSpeech("Signal je -67 decibelov.", "sl")).toBe(
      "Signal je minus sedeminšestdeset decibelov."
    );
  });

  it("does nothing outside Slovene", () => {
    // Every rule here is Slovene grammar; applying it elsewhere would be wrong.
    expect(spellNumbersForSpeech("156 units", "en")).toBe("156 units");
    expect(spellNumbersForSpeech("156 enot", undefined)).toBe("156 enot");
  });

  it("accepts a full locale tag", () => {
    expect(spellNumbersForSpeech("156 enot", "sl-SI")).toBe("sto šestinpetdeset enot");
  });
});
