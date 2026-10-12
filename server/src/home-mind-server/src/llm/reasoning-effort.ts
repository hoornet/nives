/**
 * `reasoning_effort`, sent only to models that accept it.
 *
 * One add-on setting has to serve whatever model the user points it at, and
 * models without a reasoning mode (and many local servers) answer the
 * parameter with a 400. Like the output-token cap in token-cap.ts, we do not
 * keep a list of model names: the endpoint tells us on first use, and the
 * answer is remembered for the rest of the process. The probe is a 400 on the
 * initial request, so nothing is billed and, for a streamed call, nothing has
 * reached the caller yet.
 */

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

export type ReasoningParam = { reasoning_effort?: ReasoningEffort };

/** `${endpoint} ${model}` pairs known, from their own 400, to reject the parameter. */
const rejectsReasoningEffort = new Set<string>();

/**
 * True when a 400 names `reasoning_effort`. Kept narrow on purpose: any other
 * 400 (bad model name, malformed tool schema) must surface unchanged.
 *
 * Mistral validates with a 422 instead and accepts only `high` and `none`, so
 * `minimal`, `low` and `medium` come back as a 422 whose body names the field
 * (`"loc":["body","reasoning_effort"]`). That counts as the same answer.
 */
export function isReasoningEffortUnsupported(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const err = error as { status?: number; param?: string; message?: string };
  if (err.status !== 400 && err.status !== 422) return false;
  if (err.param === "reasoning_effort") return true;
  return typeof err.message === "string" && /reasoning[_. ]?effort/i.test(err.message);
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
