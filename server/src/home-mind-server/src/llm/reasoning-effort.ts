/**
 * `reasoning_effort`, sent only to models that accept it.
 *
 * One add-on setting has to serve whatever model the user points it at, and
 * models without a reasoning mode (and many local servers) answer the
 * parameter with a 400 or a 422. Like the output-token cap in token-cap.ts, we
 * do not keep a list of model names: the endpoint tells us on first use, and
 * the answer is remembered for the rest of the process. The probe is refused
 * on the initial request, so nothing is billed and, for a streamed call,
 * nothing has reached the caller yet.
 */

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

export type ReasoningParam = { reasoning_effort?: ReasoningEffort };

/**
 * `${endpoint} ${model}` pairs that get no `reasoning_effort`: they refused it
 * themselves, or it is withheld from them (see `isWithheldFromMistral`).
 */
const rejectsReasoningEffort = new Set<string>();

/**
 * True when a 400 names `reasoning_effort`. Kept narrow on purpose: any other
 * 400 (bad model name, malformed tool schema) must surface unchanged.
 *
 * Mistral's spec validates with a 422 and accepts only `high` and `none`, so
 * `minimal`, `low` and `medium` would come back as a 422 whose body names the
 * field (`"loc":["body","reasoning_effort"]`). That counts as the same answer.
 * Seen live (2026-10-13): the Ministral models refuse every value, `none`
 * included, with a 400 "reasoning_effort is not enabled for this model",
 * which the 400 branch below already remembers.
 */
export function isReasoningEffortUnsupported(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const err = error as { status?: number; param?: string; message?: string };
  if (err.status !== 400 && err.status !== 422) return false;
  if (err.param === "reasoning_effort") return true;
  return typeof err.message === "string" && /reasoning[_. ]?effort/i.test(err.message);
}

/**
 * Mistral answers `high` by putting its reasoning into the reply itself: the
 * content arrives as a list of thinking and text chunks where every other
 * endpoint sends a string. Neither the chat engine nor the fact extractor
 * reads that shape yet, so the reply came out as "[object Object]" and no
 * facts were extracted. `high` and `none` are the only values Mistral
 * documents, and `none` answers in plain text, so it is the one value sent
 * there. Same host test as `isMistral()` in openai-client.ts.
 */
function isWithheldFromMistral(endpoint: string, effort: ReasoningEffort): boolean {
  return effort !== "none" && /api\.mistral\.ai/i.test(endpoint);
}

/**
 * Run `send` with `reasoning_effort` when one is configured and this model on
 * this endpoint has not already refused it. The same model name can be served
 * by two endpoints with different support, so the endpoint is part of the key.
 */
export async function withReasoningEffort<T>(
  model: string,
  effort: ReasoningEffort | undefined,
  send: (param: ReasoningParam) => Promise<T>,
  endpoint = ""
): Promise<T> {
  const key = `${endpoint} ${model}`;
  if (!effort || rejectsReasoningEffort.has(key)) return send({});

  if (isWithheldFromMistral(endpoint, effort)) {
    rejectsReasoningEffort.add(key);
    console.info(
      `[llm] Thinking Effort "${effort}" is not sent to Mistral, where only "none" is supported for now.`
    );
    return send({});
  }

  try {
    return await send({ reasoning_effort: effort });
  } catch (error) {
    if (!isReasoningEffortUnsupported(error)) throw error;
    rejectsReasoningEffort.add(key);
    console.info(
      `[llm] ${model} rejects reasoning_effort; sending requests without it from now on.`
    );
    return send({});
  }
}

/** Test seam — the learned set is process-global by design. */
export function resetReasoningEffortCache(): void {
  rejectsReasoningEffort.clear();
}
