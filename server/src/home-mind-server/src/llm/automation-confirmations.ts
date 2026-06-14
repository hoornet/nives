/**
 * Server-enforced confirmation gate for automation changes (create/update/delete).
 *
 * Constraints learned the hard way:
 *  - The conversation store persists only final user/assistant TEXT, never tool
 *    calls/results — so a confirmation token returned in a tool result cannot
 *    survive to the next turn (the model can't echo it back). [killed v2.1.9]
 *  - The model reformats automation args wildly between calls (action as array vs
 *    object, service vs service_data, notify.x vs x+domain, alias case…), so
 *    fingerprinting the full payload almost never matches across turns → endless
 *    re-preview loop. [killed v2.1.10]
 *
 * So: the confirmation signal is simply "the same tool was previewed for this
 * conversation in an EARLIER turn" (i.e. the user has since replied). We do NOT
 * compare the reformatted payload. For destructive update/delete we additionally
 * scope by entity_id (a stable string the model doesn't reformat) so confirming
 * one automation can't accidentally act on a different one. The per-turn nonce
 * still blocks confirming in the same turn a preview was shown.
 */

interface PendingPreview {
  toolName: string;
  /** "" for create (no sub-identity); the entity_id for update/delete. */
  identityKey: string;
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

/** Stable identity for a change: create has none; update/delete are keyed by entity_id. */
function identityKey(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "update_automation" || toolName === "delete_automation") {
    return String(input.entity_id ?? "").trim();
  }
  return "";
}

/**
 * True if this same change was previewed for this conversation in an EARLIER turn
 * (so the user has since replied) — and consume that preview. Payload formatting
 * is intentionally NOT compared; update/delete are matched by entity_id.
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
    entry.turnId !== turnId && // a later turn → a real user reply happened
    entry.identityKey === identityKey(toolName, input)
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
    identityKey: identityKey(toolName, input),
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
