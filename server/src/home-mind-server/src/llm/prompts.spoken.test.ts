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

  it("demands a space between the number and the unit symbol", () => {
    // "60%" was spoken "šest nič" — the two digits, separately.
    expect(p).toContain('"60 %"');
    expect(p).toMatch(/NEVER close the symbol up against the number/);
  });

  it("demands the degree symbol over a bare letter", () => {
    // "19 stopinj C" was spoken "devetnajstih stopinj ce": the letter read aloud, and
    // the number pushed into the wrong case as well.
    expect(p).toContain('"19 °C"');
    expect(p).toMatch(/devetnajstih stopinj ce/);
  });

  it("requires units with no readable symbol to be written out", () => {
    // "µg/m³" was spoken "g m" — micro and cubic silently dropped.
    expect(p).toContain("mikrograma na kubični meter");
    expect(p).toContain("µg/m³");
  });

  it("forbids ending a sentence with a digit", () => {
    // A numeral before a full stop is an ordinal in Slovene: "VOC 156." = "156th".
    expect(p).toMatch(/NEVER end a sentence with a digit/);
    expect(p).toContain("sto šestinpetdeseti");
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
