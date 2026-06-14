/**
 * Server-enforced confirmation gate for automation changes (create/update/delete).
 *
 * Constraint that shapes this design: the conversation store only persists final
 * user/assistant TEXT, never tool calls/results. So a confirmation token returned
 * in a tool result cannot survive to the next turn — the model can't echo it back.
 *
 * Instead we track the previewed change server-side, keyed by conversation, and
 * commit when the model calls the SAME tool with the SAME (normalized) arguments
 * in a LATER turn — which is exactly what happens after the user replies "yes".
 * No token to carry. A different payload re-previews (handles "actually make it
 * 1pm"); the per-turn nonce blocks committing in the same turn it was previewed.
 */

interface PendingPreview {
  toolName: string;
  fingerprint: string;
  turnId: string;
  createdAt: number;
}

const TTL_MS = 15 * 60 * 1000; // 15 minutes
const pending = new Map<string, PendingPreview>();

function pruneExpired(now: number): void {
  for (const [key, entry] of pending) {
    if (now - entry.createdAt > TTL_MS) pending.delete(key);
  }
}

/** Deterministic JSON with sorted object keys, so key order never affects equality. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Normalize an alias for comparison: drop the "Nives: " prefix, trim, lowercase. */
function aliasKey(alias: unknown): string {
  return String(alias ?? "")
    .replace(/^nives:\s*/i, "")
    .trim()
    .toLowerCase();
}

/** A stable fingerprint of the meaningful change a tool call would make. */
function fingerprint(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "create_automation":
      return stableStringify({
        alias: aliasKey(input.alias),
        trigger: input.trigger ?? null,
        condition: input.condition ?? null,
        action: input.action ?? null,
        mode: input.mode ?? null,
      });
    case "update_automation": {
      const fields: Record<string, unknown> = { entity_id: input.entity_id };
      for (const key of ["alias", "trigger", "condition", "action", "mode"]) {
        if (input[key] !== undefined) {
          fields[key] = key === "alias" ? aliasKey(input[key]) : input[key];
        }
      }
      return stableStringify(fields);
    }
    case "delete_automation":
      return stableStringify({ entity_id: input.entity_id });
    default:
      return stableStringify(input);
  }
}

/**
 * Return true if this exact change was previewed for this conversation in an
 * EARLIER turn (i.e. the user has since replied) — and consume that preview.
 * Returns false (without consuming) otherwise.
 */
export function isConfirmed(
  conversationId: string,
  toolName: string,
  input: Record<string, unknown>,
  turnId: string
): boolean {
  const entry = pending.get(conversationId);
  if (!entry) return false;
  if (Date.now() - entry.createdAt > TTL_MS) {
    pending.delete(conversationId);
    return false;
  }
  if (
    entry.toolName === toolName &&
    entry.turnId !== turnId && // must be a later turn → a real user reply happened
    entry.fingerprint === fingerprint(toolName, input)
  ) {
    pending.delete(conversationId);
    return true;
  }
  return false;
}

/** Record that a change was previewed (awaiting the user's confirmation). */
export function recordPreview(
  conversationId: string,
  toolName: string,
  input: Record<string, unknown>,
  turnId: string
): void {
  const now = Date.now();
  pruneExpired(now);
  pending.set(conversationId, {
    toolName,
    fingerprint: fingerprint(toolName, input),
    turnId,
    createdAt: now,
  });
}

/** Drop a conversation's pending preview (e.g. the user changed their mind). */
export function clearConfirmation(conversationId: string): void {
  pending.delete(conversationId);
}

/** Build a compact, human-readable preview of a pending automation change. */
export function describePending(
  toolName: string,
  input: Record<string, unknown>
): Record<string, unknown> {
  switch (toolName) {
    case "create_automation":
      return {
        action: "create automation",
        alias: input.alias,
        trigger: input.trigger,
        condition: input.condition,
        do: input.action,
        mode: input.mode,
      };
    case "update_automation": {
      const changes: Record<string, unknown> = {};
      for (const key of ["alias", "trigger", "condition", "action", "mode"]) {
        if (input[key] !== undefined) changes[key] = input[key];
      }
      return { action: "update automation", entity_id: input.entity_id, changes };
    }
    case "delete_automation":
      return { action: "delete automation", entity_id: input.entity_id };
    default:
      return { action: toolName, input };
  }
}
