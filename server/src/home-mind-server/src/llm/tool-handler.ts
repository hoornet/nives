import type { HomeAssistantClient, HistoryEntry, AutomationConfig } from "../ha/client.js";
import type { IMemoryStore } from "../memory/interface.js";
import type { IFactExtractor } from "./interface.js";
import type { ExtractedFact } from "../memory/types.js";
import { filterFacts } from "../memory/fact-patterns.js";
import { isConfirmed, recordPreview, describePending } from "./automation-confirmations.js";

/** Per-request context for tools that need conversation continuity (e.g. the confirmation gate). */
export interface ToolContext {
  conversationId?: string;
  /** A nonce unique to this assistant turn (one per chat() call). */
  turnId?: string;
}

/**
 * Server-enforced confirmation gate for automation changes. On the first call it
 * records a preview and returns confirmation_required WITHOUT acting. It only lets
 * execution proceed when the SAME tool is called with the SAME (normalized)
 * arguments in a LATER turn — i.e. after the user has replied "yes". No token is
 * carried (tool results aren't persisted to history). When there's no conversation
 * continuity (no conversationId/turnId), it falls back to direct execution.
 */
function gateAutomationChange(
  ctx: ToolContext | undefined,
  toolName: string,
  input: Record<string, unknown>
): { proceed: boolean; response?: unknown } {
  const conversationId = ctx?.conversationId;
  const turnId = ctx?.turnId;
  if (!conversationId || !turnId) {
    return { proceed: true }; // No continuity → can't gate; behave as before.
  }

  if (isConfirmed(conversationId, toolName, input, turnId)) {
    return { proceed: true };
  }

  recordPreview(conversationId, toolName, input, turnId);
  return {
    proceed: false,
    response: {
      confirmation_required: true,
      preview: describePending(toolName, input),
      message:
        "This change has NOT been made yet. Describe the preview to the user in plain language and ask them to confirm. ONLY after they reply with a yes, call this exact tool AGAIN with the same arguments to apply it. (Do not claim it's done until a call returns success.)",
    },
  };
}

/** Max history entries to return to the LLM to avoid blowing context window */
const MAX_HISTORY_ENTRIES = 200;

/**
 * Normalize a timestamp to ensure it has timezone info.
 * If the timestamp lacks a Z suffix or ±HH:MM offset, append Z (UTC).
 */
export function normalizeTimestamp(ts: string | undefined): string | undefined {
  if (ts === undefined) return undefined;
  // Already has Z suffix or ±HH:MM / ±HHMM offset
  if (/Z$/i.test(ts) || /[+-]\d{2}:\d{2}$/.test(ts) || /[+-]\d{4}$/.test(ts)) {
    return ts;
  }
  return ts + "Z";
}

/**
 * Downsample history to avoid blowing the LLM context window.
 * Strips bulky attributes and evenly samples entries when over the limit.
 */
export function truncateHistory(
  entries: HistoryEntry[]
): { entity_id: string; state: string; last_changed: string }[] {
  // Strip attributes — they're huge (friendly_name, unit, icon, device_class, etc.)
  // and the LLM only needs state + timestamp
  const slim = entries.map((e) => ({
    entity_id: e.entity_id,
    state: e.state,
    last_changed: e.last_changed,
  }));

  if (slim.length <= MAX_HISTORY_ENTRIES) return slim;

  // Evenly sample, always keeping first and last
  const step = (slim.length - 1) / (MAX_HISTORY_ENTRIES - 1);
  const sampled: typeof slim = [];
  for (let i = 0; i < MAX_HISTORY_ENTRIES; i++) {
    sampled.push(slim[Math.round(i * step)]);
  }

  console.log(`[tool] get_history truncated ${entries.length} → ${sampled.length} entries`);
  return sampled;
}

export async function handleToolCall(
  ha: HomeAssistantClient,
  toolName: string,
  input: Record<string, unknown>,
  ctx?: ToolContext
): Promise<unknown> {
  const start = Date.now();
  console.log(`[tool] ${toolName} called with: ${JSON.stringify(input)}`);

  try {
    let result: unknown;

    switch (toolName) {
      case "get_state":
        result = await ha.getState(input.entity_id as string);
        break;

      case "get_entities":
        result = await ha.getEntities(input.domain as string | undefined);
        break;

      case "search_entities":
        result = await ha.searchEntities(input.query as string);
        break;

      case "call_service":
        result = await ha.callService(
          input.domain as string,
          input.service as string,
          input.entity_id as string | undefined,
          input.data as Record<string, unknown> | undefined
        );
        break;

      case "get_history": {
        const startTime = normalizeTimestamp(input.start_time as string | undefined);
        const endTime = normalizeTimestamp(input.end_time as string | undefined);
        const history = await ha.getHistory(
          input.entity_id as string,
          startTime,
          endTime
        );
        result = truncateHistory(history);
        break;
      }

      case "create_automation": {
        const alias = (input.alias as string | undefined)?.trim();
        if (!alias) {
          result = { error: "create_automation requires an 'alias'." };
          break;
        }
        if (input.trigger === undefined || input.trigger === null) {
          result = { error: "create_automation requires a 'trigger'." };
          break;
        }
        if (input.action === undefined || input.action === null) {
          result = { error: "create_automation requires an 'action'." };
          break;
        }

        const gate = gateAutomationChange(ctx, "create_automation", input);
        if (!gate.proceed) {
          result = gate.response;
          break;
        }

        // Enforce the "Nives: " alias prefix idempotently (don't double-prefix).
        const prefixedAlias = /^nives:\s*/i.test(alias) ? alias : `Nives: ${alias}`;
        const created = await ha.createAutomation({
          alias: prefixedAlias,
          trigger: input.trigger,
          condition: input.condition,
          action: input.action,
          mode: input.mode as string | undefined,
        });
        result = {
          success: true,
          id: created.id,
          entity_id: created.entity_id,
          alias: created.alias,
          summary: `Created automation "${created.alias}" (${created.entity_id}). It is enabled now.`,
        };
        break;
      }

      case "list_automations": {
        const automations = await ha.listAutomations();
        result = automations.map((a) => ({
          entity_id: a.entity_id,
          name: (a.attributes.friendly_name as string) ?? a.entity_id,
          state: a.state, // "on" = enabled, "off" = disabled
          id: a.attributes.id as string | undefined,
        }));
        break;
      }

      case "delete_automation": {
        const entityId = (input.entity_id as string | undefined)?.trim();
        if (!entityId) {
          result = { error: "delete_automation requires an 'entity_id'." };
          break;
        }
        const gate = gateAutomationChange(ctx, "delete_automation", input);
        if (!gate.proceed) {
          result = gate.response;
          break;
        }
        const automations = await ha.listAutomations();
        const target = automations.find((a) => a.entity_id === entityId);
        if (!target) {
          result = { error: `No automation found with entity_id "${entityId}".` };
          break;
        }
        const configId = target.attributes.id as string | undefined;
        if (!configId) {
          result = {
            error: `Automation "${entityId}" can't be deleted via the API — it isn't stored in automations.yaml (UI/YAML-managed).`,
          };
          break;
        }
        const name = (target.attributes.friendly_name as string) ?? entityId;
        await ha.deleteAutomation(configId);
        result = {
          success: true,
          entity_id: entityId,
          name,
          summary: `Deleted automation "${name}".`,
        };
        break;
      }

      case "update_automation": {
        const entityId = (input.entity_id as string | undefined)?.trim();
        if (!entityId) {
          result = { error: "update_automation requires an 'entity_id'." };
          break;
        }
        const gate = gateAutomationChange(ctx, "update_automation", input);
        if (!gate.proceed) {
          result = gate.response;
          break;
        }
        const automations = await ha.listAutomations();
        const target = automations.find((a) => a.entity_id === entityId);
        if (!target) {
          result = { error: `No automation found with entity_id "${entityId}".` };
          break;
        }
        const configId = target.attributes.id as string | undefined;
        if (!configId) {
          result = {
            error: `Automation "${entityId}" can't be edited via the API — it isn't stored in automations.yaml (UI/YAML-managed).`,
          };
          break;
        }
        // Overlay only the fields the caller actually provided.
        const changes: Partial<AutomationConfig> = {};
        if (input.alias !== undefined) {
          const a = (input.alias as string).trim();
          changes.alias = /^nives:\s*/i.test(a) ? a : `Nives: ${a}`;
        }
        if (input.trigger !== undefined) changes.trigger = input.trigger;
        if (input.condition !== undefined) changes.condition = input.condition;
        if (input.action !== undefined) changes.action = input.action;
        if (input.mode !== undefined) changes.mode = input.mode as string;
        const updated = await ha.updateAutomation(configId, changes);
        result = {
          success: true,
          id: updated.id,
          entity_id: updated.entity_id,
          alias: updated.alias,
          summary: `Updated automation "${updated.alias}" (${updated.entity_id}).`,
        };
        break;
      }

      case "list_services":
        result = await ha.listServices(input.domain as string | undefined);
        break;

      default:
        result = { error: `Unknown tool: ${toolName}` };
    }

    const elapsed = Date.now() - start;
    console.log(`[tool] ${toolName} completed in ${elapsed}ms`);
    return result;
  } catch (error) {
    const elapsed = Date.now() - start;
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[tool] ${toolName} failed in ${elapsed}ms: ${message}`);
    return { error: message };
  }
}

/**
 * Filter out garbage facts that the LLM extracted despite prompt instructions.
 * Delegates to shared pattern matching in fact-patterns.ts.
 */
export function filterExtractedFacts(facts: ExtractedFact[]): { kept: ExtractedFact[]; skipped: { fact: ExtractedFact; reason: string }[] } {
  return filterFacts(facts);
}

export async function extractAndStoreFacts(
  memory: IMemoryStore,
  extractor: IFactExtractor,
  userId: string,
  userMessage: string,
  assistantResponse: string
): Promise<number> {
  const existingFacts = await memory.getFacts(userId);

  const extractedFacts = await extractor.extract(
    userMessage,
    assistantResponse,
    existingFacts
  );

  // Filter out garbage
  const { kept, skipped } = filterExtractedFacts(extractedFacts);

  for (const { fact, reason } of skipped) {
    console.debug(`[filter] Skipped fact for ${userId}: "${fact.content}" — ${reason}`);
  }

  if (kept.length === 0) return 0;

  // Delete replaced facts first
  for (const fact of kept) {
    if (fact.replaces && fact.replaces.length > 0) {
      for (const oldFactId of fact.replaces) {
        const deleted = await memory.deleteFact(userId, oldFactId);
        if (deleted) {
          console.log(`Replaced old fact ${oldFactId} for ${userId}`);
        }
      }
    }
  }

  // Batch store all kept facts
  const ids = await memory.addFacts(
    userId,
    kept.map((f) => ({ content: f.content, category: f.category, confidence: f.confidence }))
  );

  for (const fact of kept) {
    console.log(`Stored new fact for ${userId}: ${fact.content}`);
  }

  return ids.length;
}
