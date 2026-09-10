import { describe, it, expect } from "vitest";
import { spokenVoicePointer, buildSystemPromptText } from "./prompts.js";

// Measured before this existed (2026-09-08, the served model, 4 samples per arm):
// the default persona already writes feminine Slovene unprompted, because
// "Nives" is a feminine name. The defect is disagreement — a male voice under
// that persona still produced "Ugasnila sem", a woman's grammar in a man's
// voice. With the pointer, all four samples flipped, and a HAL 9000 persona
// under a female voice flipped the other way just as reliably.

describe("spokenVoicePointer", () => {
  it("says nothing when no voice is configured", () => {
    // Text-only setups must not pay for this, and the default persona is
    // already correct without help.
    expect(spokenVoicePointer(undefined)).toBe("");
  });

  it("names the right forms for a male voice", () => {
    const p = spokenVoicePointer("male");
    expect(p).toContain('"Ugasnil sem"');
    expect(p).toMatch(/NEVER "Ugasnila sem"/);
  });

  it("names the right forms for a female voice", () => {
    const p = spokenVoicePointer("female");
    expect(p).toContain('"Ugasnila sem"');
    expect(p).toMatch(/NEVER "Ugasnil sem"/);
  });

  it("covers the language family, not just Slovene", () => {
    // Every one of these inflects the first person for the speaker's gender,
    // so a Slovene-only instruction would leave those users with the same bug.
    const p = spokenVoicePointer("female");
    for (const lang of ["Croatian", "Czech", "Polish", "Russian", "Hebrew", "Arabic"]) {
      expect(p).toContain(lang);
    }
  });

  it("constrains itself to the assistant's own speech", () => {
    // Without this the model starts gendering the user too.
    expect(spokenVoicePointer("male")).toMatch(/first-person statements only/);
  });
});

describe("spokenVoicePointer writing rules", () => {
  // Every rule here is a form Jure heard fail on the Slovene voice on 2026-09-09.
  // The wrong forms are unintelligible, not merely clumsy, so each keeps its own test.
  const p = spokenVoicePointer("female");

  it("states the mechanism, so it reaches units nobody tested", () => {
    // The rule used to be a list of the units this house happens to have, which could
    // only ever cover what we had heard. Naming the cause is what makes it generalise:
    // a wide check over twelve unfamiliar payloads got dBm, µS/cm, W/m², lx, hPa and
    // Mbps right without any of them being mentioned here.
    expect(p).toMatch(/CANNOT\s+inflect/);
    expect(p).toMatch(/for ANY unit, including ones not listed here/);
  });

  it("keeps °C and % as symbols, the only two the voice inflects itself", () => {
    // Verified by ear across 1, 2, 3 and 5, where Slovene needs stopinja / stopinji /
    // stopinje / stopinj. Everything else the voice locks to one form and gets wrong.
    expect(p).toMatch(/ONLY two exceptions are °C and %/);
    expect(p).toContain('"19 °C"');
    expect(p).toContain('"60 %"');
    expect(p).toMatch(/NEVER close the symbol up against the number/);
    expect(p).toMatch(/devetnajstih stopinj ce/);
  });

  it("requires every other unit to be written out", () => {
    expect(p).toContain("mikrograma na kubični meter");
    expect(p).toContain("µg/m³");
    expect(p).toContain("kilovatnih ur");
  });

  it("writes initialisms as spaced letter names", () => {
    // "CO2" was spoken "kod ve"; "VOC" ran together into a non-word.
    expect(p).toContain("Ve o ce");
    expect(p).toContain("Ce o dva");
  });

  it("forbids ending a sentence with a digit", () => {
    // A numeral before a full stop is an ordinal in Slovene: "VOC 156." = "156th".
    expect(p).toMatch(/NEVER end a sentence with a digit/);
    expect(p).toContain("sto šestinpetdeseti");
  });

  it("keeps numbers as digits, because spelling them out corrupts the value", () => {
    // Measured, not assumed: asked to write numerals as words, the model rendered 87 as
    // "oseminosemdeset", which is 88. Slovene puts the ones first, so one syllable changes
    // the reading. Words fix the grammatical ending, but a sensor value spoken wrongly is
    // a different class of failure from a clumsy one — see the number normaliser for how
    // the ending gets fixed without asking the model to count.
    expect(p).toMatch(/NEVER spell a number out in words/);
    expect(p).toMatch(/87 into 88/);
  });

  it("keeps numerals away from prepositions", () => {
    // "na 163 enot" was spoken "na sto triinšestdesetih enot" — the voice inflects the
    // number for a case the sentence never asked for. Restructuring fixed it; spelling the
    // number out fixed it too, but digits keep the VALUE right, and a confidently spoken
    // wrong number is worse than a wrong ending.
    expect(p).toMatch(/NEVER put a numeral straight after a preposition/);
    expect(p).toContain("triinšestdesetih");
    expect(p).toContain("zdaj je 163 enot");
  });

  it("asks for whole sentences rather than labelled fragments", () => {
    expect(p).toMatch(/Write whole sentences/);
  });

  it("says nothing at all when no voice is configured", () => {
    // A text-only setup must not pay for any of this.
    expect(spokenVoicePointer(undefined)).toBe("");
  });
});

describe("the pointer in an assembled prompt", () => {
  it("is absent unless a voice is configured", () => {
    const text = buildSystemPromptText([], false, undefined, undefined, undefined, "sl");
    expect(text).not.toMatch(/Ugasnil/);
  });

  it("follows a custom persona, so the voice wins over the persona's gender", () => {
    const hal = "You are HAL 9000, the calm and precise computer.";
    const text = buildSystemPromptText([], true, hal, undefined, undefined, "sl", "female");
    expect(text).toContain(hal);
    expect(text.indexOf("Ugasnila sem")).toBeGreaterThan(text.indexOf(hal));
  });

  it("applies to written replies too, not only spoken ones", () => {
    // The reply is written first and spoken second; gendering only the voice
    // path would leave the Assist transcript disagreeing with the audio.
    const text = buildSystemPromptText([], false, undefined, undefined, undefined, "sl", "male");
    expect(text).toContain('"Ugasnil sem"');
  });
});
