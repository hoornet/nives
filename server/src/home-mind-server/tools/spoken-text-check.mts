/**
 * Does the spoken-reply rule hold for units this house does not have?
 *
 * The rule used to be a list of the units Jure's sensors happen to emit, which could only
 * ever cover what we had tested. It is now a principle ("the voice cannot inflect, so write
 * units and initialisms as words"), and the point of a principle is the long tail. This
 * drives the real prompt over a wide set of sensor payloads and fails on any symbol or bare
 * initialism that survives into the reply.
 *
 * Text-level only, so it needs no ears and no audio: a voice reading ordinary words is
 * predictable, which is exactly why the rule turns everything into words.
 *
 * Run: npx tsx tools/spoken-text-check.mts   (needs ~/.config/nives/openrouter-eval.key)
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { buildSystemPromptText } from "../src/llm/prompts.js";

const key = readFileSync(`${homedir()}/.config/nives/openrouter-eval.key`, "utf8").trim();
const MODEL = "openai/gpt-5.6-luna";

// Units and initialisms across the HA sensor space. Most of these Jure does not own.
const CASES: { q: string; data: Record<string, unknown> }[] = [
  { q: "Kakšna je kakovost zraka?", data: { voc: 156, co2_ppm: 780, pm25: 8.6, pm25_unit: "µg/m³", pm10: 12 } },
  { q: "Koliko elektrike smo porabili?", data: { today_kwh: 12.7, now_w: 450, peak_kw: 3.2, month_mwh: 0.41 } },
  { q: "Kakšno je vreme zunaj?", data: { temp_c: 19, pressure_hpa: 1013, wind_ms: 4.2, rain_mm: 3.5, uv_index: 6 } },
  { q: "Kako svetlo je v dnevni sobi?", data: { lux: 320, color_temp_k: 2700 } },
  { q: "Kako glasno je?", data: { noise_db: 42.5 } },
  { q: "Kakšno je stanje baterij?", data: { sensor_battery_pct: 87, voltage_v: 3.1, current_ma: 220 } },
  { q: "Koliko vode smo porabili?", data: { today_l: 145, month_m3: 4.2 } },
  { q: "Kakšen je signal senzorja?", data: { rssi_dbm: -67, lqi: 120 } },
  { q: "Kakšna je kakovost vode?", data: { ph: 7.2, conductivity_us_cm: 340 } },
  { q: "Koliko sonca smo dobili?", data: { irradiance_w_m2: 780, produced_kwh: 18.3 } },
  { q: "Kakšna je hitrost interneta?", data: { down_mbps: 940, up_mbps: 210, ping_ms: 12 } },
  { q: "Kakšen je tlak v ogrevanju?", data: { pressure_bar: 1.4, flow_lmin: 12, temp_c: 55 } },
];

// A symbol or bare initialism that reached the reply is a failure: the voice cannot inflect it.
// °C and % are the two exceptions — this voice inflects them correctly by itself, verified by
// ear across 1, 2, 3 and 5, where Slovene needs four different endings. They must still carry
// a space, because "60%" closed up is spoken "šest nič".
const VIOLATIONS: [RegExp, string][] = [
  [/\d(°|%)/, "symbol closed up against the number"],
  [/\d\s*°(?!C)/, "degree symbol without C"],
  [/µg|μg|\bmg\/|\bg\/m/, "µg/m³ or similar"],
  [/\b\d[\d,.]*\s*(kWh|MWh|kW|W|Wh|V|mA|A|Hz|dB|dBm|hPa|mbar|bar|lx|ppm|ppb|mm|cm|km\/h|m\/s|m³|m2|W\/m²|l\/min|L|ml|µS)\b/, "unit abbreviation"],
  [/\b(VOC|CO2|CO₂|PM2[.,]5|PM10|RSSI|LQI|UV|pH|LED|Mbps|ms)\b/, "bare initialism"],
];

async function reply(system: string, q: string, data: unknown) {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 220, messages: [
      { role: "system", content: system },
      { role: "user", content: q },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function",
          function: { name: "get_sensors", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: JSON.stringify(data) },
    ] }),
  });
  const j = await r.json();
  return (j.choices?.[0]?.message?.content ?? `ERROR ${JSON.stringify(j).slice(0, 120)}`)
    .replace(/\s+/g, " ").trim();
}

const system = buildSystemPromptText([], true, undefined, undefined, undefined, "sl", "female");
const results = await Promise.all(CASES.map((c) => reply(system, c.q, c.data)));

let failed = 0;
results.forEach((out, i) => {
  const hits = VIOLATIONS.filter(([re]) => re.test(out)).map(([, n]) => n);
  if (hits.length) failed++;
  console.log(`${hits.length ? "FAIL" : "ok  "}  ${CASES[i].q}`);
  if (hits.length) console.log(`      ${hits.join("; ")}`);
  console.log(`      ${out.slice(0, 190)}`);
});
console.log(`\n${CASES.length - failed}/${CASES.length} clean`);
process.exit(failed ? 1 : 0);
