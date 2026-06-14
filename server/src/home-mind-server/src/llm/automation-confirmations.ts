import { randomUUID } from "node:crypto";

/**
 * Server-enforced confirmation gate for automation changes (create/update/delete).
 *
 * The model's first call to a gated tool issues a token and stores the pending
 * payload WITHOUT making any change. The change is only applied on a second call
 * that supplies the matching token — AND that comes in a later assistant turn
 * (different `turnId`), which forces a real user reply in between. This makes
 * "ask before changing" a hard requirement, not just a prompt instruction.
 */

interface PendingConfirmation {
  token: string;
  toolName: string;
  input: Record<string, unknown>;
  turnId: string;
  createdAt: number;
}

const TTL_MS = 15 * 60 * 1000; // 15 minutes
const pending = new Map<string, PendingConfirmation>();

function pruneExpired(now: number): void {
  for (const [key, entry] of pending) {
    if (now - entry.createdAt > TTL_MS) pending.delete(key);
  }
}

/**
 * Store a pending change for a conversation and return a fresh confirm token.
 * Overwrites any prior pending confirmation for the same conversation.
 */
export function issueConfirmation(
  conversationId: string,
  toolName: string,
  input: Record<string, unknown>,
  turnId: string
): string {
  const now = Date.now();
  pruneExpired(now);
  const token = randomUUID();
  pending.set(conversationId, { token, toolName, input, turnId, createdAt: now });
  return token;
}

export type ConsumeResult =
  | { ok: true; toolName: string; input: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * Validate and consume a confirm token. Fails (without consuming, except on
 * expiry) when there is no match, the tool differs, it has expired, or it is
 * being confirmed in the same turn it was issued (no real user reply yet).
 */
export function consumeConfirmation(
  conversationId: string,
  token: string,
  toolName: string,
  turnId: string
): ConsumeResult {
  const entry = pending.get(conversationId);
  if (!entry || entry.token !== token) {
    return {
      ok: false,
      reason:
        "No matching pending confirmation. Call the tool again WITHOUT confirm_token to get a fresh preview, show it to the user, and only confirm after they reply.",
    };
  }
  if (entry.toolName !== toolName) {
    return {
      ok: false,
      reason: "That confirmation was for a different action. Start over without confirm_token.",
    };
  }
  if (Date.now() - entry.createdAt > TTL_MS) {
    pending.delete(conversationId);
    return {
      ok: false,
      reason: "The confirmation expired. Restate the change, ask the user again, then retry.",
    };
  }
  if (entry.turnId === turnId) {
    // Same assistant turn → the user has not actually replied yet.
    return {
      ok: false,
      reason:
        "Present the preview to the user and wait for their reply BEFORE confirming — do not confirm in the same turn.",
    };
  }
  pending.delete(conversationId);
  return { ok: true, toolName: entry.toolName, input: entry.input };
}

/** Drop a conversation's pending confirmation (e.g. the user changed their mind). */
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
