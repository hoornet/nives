/**
 * The forced final answer, for models that refuse `tool_choice: "none"`.
 *
 * When the tool loop reaches its cap, the last request asks for words instead
 * of more tool calls by sending `tool_choice: "none"`. Some models accept only
 * `"auto"`: in the 2026-11 model scout, Meta's Muse Ember answered that request
 * with a 400 on both of its providers, so a long tool loop ended in an error
 * instead of a reply. Like reasoning-effort.ts, we keep no list of models: the
 * endpoint tells us on first use and the answer is remembered for the rest of
 * the process. The refusal comes before anything streams, so nothing has
 * reached the caller yet.
 *
 * Without `tool_choice` the model is free to ask for a tool again, so the
 * fallback also appends one plain instruction to answer now. Any tool call on
 * that last turn is not run (the loop has already stopped); the text is used.
 */

export type ForcedAnswerParam = { tool_choice?: "none"; nudge?: boolean };

/** Appended to the conversation when `tool_choice` cannot do the job. */
export const FINAL_ANSWER_NUDGE =
  "Stop calling tools now. Answer the request in words, using only what you have found so far.";

/** `${endpoint} ${model}` pairs that refused `tool_choice: "none"`. */
const rejectsToolChoiceNone = new Set<string>();

/**
 * True when a 400 or 422 names `tool_choice`. Kept narrow on purpose: any
 * other 400 (bad model name, malformed tool schema) must surface unchanged.
 * Seen live (2026-11-12, Muse Ember): Meta answered `only "auto" is supported
 * for tool_choice` with param "tool_choice"; Google Vertex answered
 * `tool_choice none is not supported` without naming the param field.
 */
export function isToolChoiceUnsupported(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const err = error as { status?: number; param?: string; message?: string };
  if (err.status !== 400 && err.status !== 422) return false;
  if (err.param === "tool_choice") return true;
  return typeof err.message === "string" && /tool[_ ]?choice/i.test(err.message);
}

/**
 * Run `send` for one model turn. Not forced: no parameter. Forced: try
 * `tool_choice: "none"`, and on a refusal (or once this model on this endpoint
 * has refused before) send the nudge instead. The endpoint is part of the key
 * because the same model name can be served by endpoints with different rules.
 */
export async function withForcedAnswer<T>(
  model: string,
  force: boolean,
  send: (param: ForcedAnswerParam) => Promise<T>,
  endpoint = ""
): Promise<T> {
  if (!force) return send({});
  const key = `${endpoint} ${model}`;
  if (rejectsToolChoiceNone.has(key)) return send({ nudge: true });

  try {
    return await send({ tool_choice: "none" });
  } catch (error) {
    if (!isToolChoiceUnsupported(error)) throw error;
    rejectsToolChoiceNone.add(key);
    console.info(
      `[llm] ${model} rejects tool_choice "none"; forcing the final answer with an instruction instead.`
    );
    return send({ nudge: true });
  }
}

/** Test seam — the learned set is process-global by design. */
export function resetForcedAnswerCache(): void {
  rejectsToolChoiceNone.clear();
}
