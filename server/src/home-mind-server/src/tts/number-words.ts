/**
 * Spell whole numbers out, in Slovene, on the way to the voice only.
 *
 * The voice inflects a bare numeral for a case the sentence never asked for: "156 enot"
 * comes out as "sto šestinpetdesetih enot". Numbers written as words are read correctly,
 * but asking the model to write them is not safe — Slovene puts the ones before the tens,
 * so one syllable turns 87 into 88, and it did exactly that when we tried. Converting is
 * arithmetic, so it belongs in code that can be tested rather than in a prompt.
 *
 * This runs on the spoken path only. The reply shown in Home Assistant keeps its digits.
 */

const ONES = ["nič", "ena", "dva", "tri", "štiri", "pet", "šest", "sedem", "osem", "devet"];
const TEENS = [
  "deset", "enajst", "dvanajst", "trinajst", "štirinajst",
  "petnajst", "šestnajst", "sedemnajst", "osemnajst", "devetnajst",
];
const TENS = [
  "", "", "dvajset", "trideset", "štirideset",
  "petdeset", "šestdeset", "sedemdeset", "osemdeset", "devetdeset",
];
const HUNDREDS = [
  "", "sto", "dvesto", "tristo", "štiristo",
  "petsto", "šeststo", "sedemsto", "osemsto", "devetsto",
];

/** 0-999 as Slovene words. */
function underThousand(n: number): string {
  if (n < 10) return ONES[n];
  if (n < 20) return TEENS[n - 10];
  if (n < 100) {
    const [t, o] = [Math.floor(n / 10), n % 10];
    // The ones come first and fuse to the tens: 87 is sedem-in-osemdeset.
    return o === 0 ? TENS[t] : `${ONES[o]}in${TENS[t]}`;
  }
  const [h, rest] = [Math.floor(n / 100), n % 100];
  return rest === 0 ? HUNDREDS[h] : `${HUNDREDS[h]} ${underThousand(rest)}`;
}

/** Whole numbers up to 999 999 as Slovene words. Larger values are left to the caller. */
export function sloveneNumberWords(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n > 999_999) return null;
  if (n < 1000) return underThousand(n);
  const [th, rest] = [Math.floor(n / 1000), n % 1000];
  // "tisoč" alone for one thousand, otherwise counted: dva tisoč, tri tisoč.
  const thousands = th === 1 ? "tisoč" : `${underThousand(th)} tisoč`;
  return rest === 0 ? thousands : `${thousands} ${underThousand(rest)}`;
}

/**
 * Replace whole numbers with words, leaving alone everything that already works.
 *
 * Skipped, each for a measured reason:
 *  - decimals ("8,6 mikrograma") — the voice reads these correctly as they are
 *  - a number before °C or % — this voice inflects those two units itself, verified by ear
 *    across 1, 2, 3 and 5, and spelling the number out would take that away
 *  - a number glued to letters ("PM10", "CO2") — part of a name, not a reading
 *  - 1 and 2 — the only Slovene numerals that change with the gender of what they count
 *    ("en volt" but "ena ura"), which cannot be known from the digits alone
 */
export function spellNumbersForSpeech(text: string, language?: string): string {
  if (!language || language.toLowerCase().split(/[-_]/)[0] !== "sl") return text;

  return text.replace(
    // Not preceded by a letter or digit (that is a name like PM10), not the half of a
    // decimal that follows the comma, not itself the start of a decimal, and not sitting
    // in front of °C or %.
    /(?<![\p{L}\p{N}])(?<=^|[^\d][.,]|[^.,])(-?)(\d+)(?![\d.,]*\d)(?!\s*[°%])/gu,
    (match: string, minus: string, digits: string) => {
      const n = Number(digits);
      if (n <= 2) return match;
      const words = sloveneNumberWords(n);
      if (words === null) return match;
      return `${minus ? "minus " : ""}${words}`;
    }
  );
}
