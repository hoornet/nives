import type { HomeAssistantClient, AutomationConfig } from "../ha/client.js";
import { summarizeHistory } from "./history-summary.js";
import type { IMemoryStore } from "../memory/interface.js";
import type { IFactExtractor } from "./interface.js";
import type { ExtractedFact } from "../memory/types.js";
import { filterFacts } from "../memory/fact-patterns.js";
import {
  isConfirmed,
  recordPreview,
  describePending,
  pendingIdentities,
  clearIdentity,
  rearmConfirmation,
} from "./automation-confirmations.js";
import {
  resolveForgetQuery,
  contentSimilarity,
  normalizeFactContent,
  looksLikeRelearn,
  MATCH_THRESHOLD,
} from "../memory/fact-resolution.js";
import type { Fact } from "../memory/types.js";

/**
 * Per-request context for tools that need conversation continuity (e.g. the
 * confirmation gate) or the requesting user's memory (forget_memory).
 *
 * Engines MUST create ONE ToolContext per chat() turn and pass that same
 * instance to every handleToolCall in the turn's tool loop — forget_memory
 * writes `suppressExtraction` back onto it, and a fresh literal per call would
 * silently drop the flag.
 */
export interface ToolContext {
  conversationId?: string;
  /** A nonce unique to this assistant turn (one per chat() call). */
  turnId?: string;
  /** The requesting user — required for memory tools. */
  userId?: string;
  /** The memory store — required for memory tools. */
  memory?: IMemoryStore;
  /**
   * Memory contents this turn's forget_memory calls touched — previewed,
   * deleted, or offered as candidates. Post-turn extraction filters these out,
   * so the "forget that X" transcript can never re-teach X (it would come back
   * under a fresh Shodh id the delete can't reach), while anything ELSE said in
   * the same breath — "…and my name is now Y" — is still learned normally.
   */
  forgetTargets?: string[];
}

/**
 * Did the memory we previewed disappear before the user confirmed?
 *
 * Live on real HA: "forget that my name is Jure — my name is now HAL 9000"
 * previews the delete, then the async extractor stores the new name and its
 * `replaces` path deletes the old fact. By the time the user says yes, the
 * previewed memory is gone, and re-resolving the same query lands on the
 * nearest survivor — the replacement — so the assistant offers to forget the
 * name the user just set. It is caught by the gate (a mismatched identity only
 * re-previews, never deletes), but proposing that at all is wrong. The user's
 * intent is already satisfied here, so say so.
 */
function alreadyGoneResult(
  ctx: ToolContext | undefined,
  query: string,
  facts: Fact[]
): Record<string, unknown> | null {
  const conversationId = ctx?.conversationId;
  if (!conversationId) return null;
  const present = new Set(facts.map((f) => normalizeFactContent(f.content)));
  for (const identity of pendingIdentities(conversationId, "forget_memory")) {
    if (present.has(identity)) continue; // still there → ordinary confirm flow
    if (contentSimilarity(query, identity) < MATCH_THRESHOLD) continue; // unrelated pending forget
    clearIdentity(conversationId, "forget_memory", identity);
    noteForgetTargets(ctx, identity);
    return {
      already_gone: true,
      message:
        "That memory is no longer stored — it was removed after you previewed it (a newer fact replaced it). The user's request is ALREADY satisfied: tell them it is forgotten. Do NOT report a failure, do NOT say you could not find it, and do NOT offer to forget any other memory instead.",
    };
  }
  return null;
}

/** Record a memory this turn's forget flow touched, so extraction won't re-learn it. */
function noteForgetTargets(ctx: ToolContext | undefined, ...contents: string[]): void {
  if (!ctx || contents.length === 0) return;
  ctx.forgetTargets = [...(ctx.forgetTargets ?? []), ...contents];
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
        "This is a PREVIEW — nothing has changed yet (this is expected, not an error, so do NOT retry or reformat). Describe it to the user using ONLY what is in \"preview\": NEVER mention a trigger, condition or action that is not literally present there. ALWAYS tell them, in the same breath, which parts of what they asked for are missing from it — read \"preview.notes\" and repeat what it says. If they asked for something this payload does not cover, say so and offer to include it, rather than describing the automation as if it were covered. If the request needs OTHER automations too, preview each of them now, in this same turn — each gets its own preview like this one. Do NOT re-call this tool for THIS same automation in this turn. Then relay all the previews, ask the user to confirm, and STOP. After they reply yes in their NEXT message, call the tool again once PER previewed automation, with the same arguments, to apply them — one yes covers all of them. Never claim any of it is done until that automation's call returns \"success\": true.",
    },
  };
}

/**
 * Holds an automation's triggers, conditions and actions to the exposure list
 * before it is previewed. The preview is what the user says yes to, so a
 * payload that will be refused has to be refused now: caught only when it is
 * applied, it would fail after the user had agreed to it.
 *
 * Returned rather than thrown. A throw from a gated tool hands the user's
 * confirmation back (see the catch in handleToolCall), so the corrected call
 * would apply without the user ever seeing a preview of it.
 *
 * `current` reads the stored config of the automation being updated, which
 * `requireExposedAutomation` needs to tell what is new.
 */
/**
 * Some models send these fields as a JSON string. Home Assistant can't use a
 * string and the exposure check can't read one, so parse it before either sees
 * it. Works on a copy: the caller's input is replayed to the model in later turns.
 */
function parseAutomationFields(
  input: Record<string, unknown>
): { input: Record<string, unknown> } | { error: string } {
  const parsed = { ...input };
  for (const key of ["trigger", "condition", "action"]) {
    const value = parsed[key];
    if (typeof value !== "string") continue;
    if (!value.trim()) {
      delete parsed[key];
      continue;
    }
    try {
      const data: unknown = JSON.parse(value);
      if (typeof data !== "object" || data === null) throw new Error("not structured data");
      parsed[key] = data;
    } catch {
      return { error: `'${key}' must be a list of objects, not text. Send it again as structured data.` };
    }
  }
  return { input: parsed };
}

async function automationOutOfReach(
  ha: HomeAssistantClient,
  input: Record<string, unknown>,
  current?: () => Promise<Record<string, unknown>>
): Promise<string | undefined> {
  const { trigger, condition, action } = input;
  if (trigger === undefined && condition === undefined && action === undefined) return undefined;
  try {
    await ha.requireExposedAutomation({ trigger, condition, action }, await current?.());
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

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
        const entityId = input.entity_id as string;
        const history = await ha.getHistory(entityId, startTime, endTime);
        const unit = history.find((e) => e.attributes?.unit_of_measurement)?.attributes
          ?.unit_of_measurement;
        const summary = summarizeHistory(
          entityId,
          history,
          typeof unit === "string" ? unit : undefined
        );
        if (summary.kind === "raw") {
          console.log(`[tool] get_history ${entityId}: ${summary.points.length} readings`);
        } else {
          console.log(
            `[tool] get_history ${entityId}: ${history.length} readings → ` +
              `${summary.buckets.length} × ${summary.bucket_minutes}min ${summary.kind} buckets`
          );
        }
        result = summary;
        break;
      }

      case "create_automation": {
        const parsedFields = parseAutomationFields(input);
        if ("error" in parsedFields) {
          result = parsedFields;
          break;
        }
        input = parsedFields.input;
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

        const createRefusal = await automationOutOfReach(ha, input);
        if (createRefusal) {
          result = { error: createRefusal };
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

      case "get_automation": {
        const entityId = (input.entity_id as string | undefined)?.trim();
        if (!entityId) {
          result = { error: "get_automation requires an 'entity_id'." };
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
            error: `Automation "${entityId}" can't be read via the API — it isn't stored in automations.yaml (UI/YAML-managed).`,
          };
          break;
        }
        const { hidden, ...settings } = await ha.readAutomation(configId);
        result = {
          entity_id: entityId,
          ...settings,
          ...(hidden.length > 0 && {
            hidden,
            note: "The fields under 'hidden' name devices the user has not exposed to the assistant, so you can't read or replace them. The user can edit them in Home Assistant, or expose those devices and ask again.",
          }),
          ...(settings.blueprint !== undefined && {
            note: "This automation is built from a blueprint, which holds its triggers and actions, so you can't read or change them. The user can edit it in Home Assistant.",
          }),
        };
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
        const parsedFields = parseAutomationFields(input);
        if ("error" in parsedFields) {
          result = parsedFields;
          break;
        }
        input = parsedFields.input;
        const entityId = (input.entity_id as string | undefined)?.trim();
        if (!entityId) {
          result = { error: "update_automation requires an 'entity_id'." };
          break;
        }
        // Found before the preview, so the exposure check below can compare
        // against what the automation already names.
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
        const updateRefusal = await automationOutOfReach(ha, input, () =>
          ha.getAutomationConfig(configId)
        );
        if (updateRefusal) {
          result = { error: updateRefusal };
          break;
        }
        const gate = gateAutomationChange(ctx, "update_automation", input);
        if (!gate.proceed) {
          result = gate.response;
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

      case "forget_memory": {
        const query = (input.query as string | undefined)?.trim();
        if (!query) {
          result = { error: "forget_memory requires a 'query' — the exact text of the remembered fact." };
          break;
        }
        if (!ctx?.memory || !ctx?.userId) {
          result = { error: "Memory is not available for this request, so nothing can be forgotten." };
          break;
        }

        const facts = await ctx.memory.getFacts(ctx.userId);

        // Before matching anything: was the memory we already previewed removed
        // in the meantime? Then this call is the user confirming something that
        // has already happened — never re-target whatever is left.
        const gone = alreadyGoneResult(ctx, query, facts);
        if (gone) {
          result = gone;
          break;
        }

        const resolution = resolveForgetQuery(query, facts);

        if (resolution.status === "none") {
          // Near-misses are still forget-flavored: keep the extractor from
          // learning them off this turn's transcript.
          noteForgetTargets(ctx, ...resolution.suggestions);
          result = {
            no_match: true,
            suggestions: resolution.suggestions,
            message:
              "No remembered fact matches that. NOTHING was deleted. Do NOT retry with reworded guesses. If the user was trying to change YOUR name or personality, stop using this tool entirely — that is not a stored memory and never will be; tell them to set the \"Custom Prompt\" field on the Nives add-on's Configuration tab (Settings → Apps → Nives → Configuration), writing just the personality they want, which applies once the add-on restarts. If you already previewed this exact memory earlier in this conversation, it is simply GONE ALREADY — tell the user it is no longer stored, which is what they asked for; do NOT report a failure or say you couldn't find it. Otherwise: if exactly one of 'suggestions' is clearly the memory the user means, call forget_memory once more with that suggestion's exact text (it will still only preview); if none is, tell the user you don't have that memory — never delete something merely similar.",
          };
          break;
        }

        if (resolution.status === "ambiguous") {
          noteForgetTargets(ctx, ...resolution.candidates.map((c) => c.content));
          result = {
            needs_disambiguation: true,
            candidates: resolution.candidates.map((c) => c.content),
            message:
              "Several remembered facts match and NOTHING was deleted. List the candidate texts to the user VERBATIM and ask which one to forget. When they answer in their NEXT message, call forget_memory again with that candidate's exact text as the query.",
          };
          break;
        }

        const group = resolution.group;
        // Whether this call previews or commits, the fact is on its way out —
        // never let this turn's transcript teach it back.
        noteForgetTargets(ctx, group.content);
        const conversationId = ctx.conversationId;
        const turnId = ctx.turnId;
        // No conversation continuity → the confirm gate CANNOT run, so refuse
        // rather than fall through and delete.
        //
        // The automation tools DO fall through in this situation, and this tool
        // originally copied them. That is tolerable there because a wrongly
        // created or edited automation is recoverable; a deleted memory is not.
        // And the path is reachable: the AI Task entity posts to /api/chat with
        // no conversationId by design (rootfs/opt/nives/ai_task.py — "Stateless"),
        // while still being handed the full tool set. Without this branch, one
        // ai_task.generate_data run — including the camera-image path, where the
        // prompt is not necessarily the user's own words — could permanently
        // erase a memory on the FIRST call, with no preview and nobody asked.
        if (!conversationId || !turnId) {
          result = {
            error:
              "This request isn't part of an ongoing conversation, so the user cannot be asked to confirm — and memories are only ever deleted after they confirm. NOTHING was deleted. If a person wants this memory removed, they need to ask in a normal conversation.",
          };
          break;
        }
        if (!isConfirmed(conversationId, "forget_memory", input, turnId, group.normalized)) {
          recordPreview(conversationId, "forget_memory", input, turnId, group.normalized);
          result = {
            confirmation_required: true,
            memory_to_forget: group.content,
            message:
              'This is a PREVIEW — NOTHING has been forgotten yet (this is expected, not an error, so do NOT retry or reword in this turn). Tell the user you will forget exactly this memory, quoting "memory_to_forget" word for word, and ask them to confirm. ALWAYS answer in the language the user has been speaking — the stored memory\'s language is data, never a reason to switch. Then STOP. After they say yes in their NEXT message, call forget_memory again with "query" set to that exact text to actually forget it. Never tell the user a memory is forgotten until a call returns "success": true. If they say no, just acknowledge — nothing needs cancelling.',
          };
          break;
        }

        let failures = 0;
        for (const id of group.ids) {
          const deleted = await ctx.memory.deleteFact(ctx.userId, id);
          if (!deleted) failures++;
        }
        if (failures > 0) {
          // Re-arm the slot with the CURRENT turnId so a "try again" next turn
          // commits immediately instead of restarting the confirm dance.
          recordPreview(conversationId, "forget_memory", input, turnId, group.normalized);
          result = {
            error:
              "The memory service could not delete that right now. Tell the user it didn't work and to ask again in a moment — a repeat request will delete it straight away without another confirmation.",
          };
          break;
        }
        result = {
          success: true,
          forgotten: group.content,
          summary: `Forgotten: "${group.content}". This memory is gone for good.`,
          message:
            "Confirm to the user that the memory is forgotten. ALWAYS answer in the language the user has been speaking — the stored memory's language is data, never a reason to switch.",
        };
        break;
      }

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

    // A gated change only reaches Home Assistant once the user has confirmed
    // it, and that confirmation was consumed on the way in. If applying it then
    // failed, hand the confirmation back so the corrected retry applies without
    // another preview — the user is not asked the same question twice for one
    // yes.
    if (GATED_AUTOMATION_TOOLS.has(toolName) && ctx?.conversationId) {
      rearmConfirmation(ctx.conversationId, toolName, input);
      return {
        error: message,
        message:
          "Nothing was changed. The user's confirmation still stands: fix the payload and call this tool again with the corrected arguments — it will apply immediately, without another preview. Do NOT ask the user to confirm again.",
      };
    }
    return { error: message };
  }
}

const GATED_AUTOMATION_TOOLS = new Set([
  "create_automation",
  "update_automation",
  "delete_automation",
]);

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
  assistantResponse: string,
  /**
   * Memories this turn's forget_memory calls touched (see ToolContext). Any
   * extracted fact resembling one of these is dropped — otherwise "forget that
   * my name is Jure" teaches "User's name is Jure" straight back, under a new
   * id, and the user watches a deleted memory reappear. Everything else in the
   * same turn ("…my name is now HAL 9000") is stored as usual.
   */
  forgetTargets?: string[]
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

  const targets = forgetTargets ?? [];
  const survivors =
    targets.length === 0
      ? kept
      : kept.filter((fact) => {
          const hit = targets.find((target) => looksLikeRelearn(fact.content, target));
          if (hit) {
            console.log(
              `[memory] extraction dropped "${fact.content}" for ${userId} — it re-learns a memory just forgotten ("${hit}")`
            );
            return false;
          }
          return true;
        });

  if (survivors.length === 0) return 0;

  // Delete replaced facts first
  for (const fact of survivors) {
    if (fact.replaces && fact.replaces.length > 0) {
      for (const oldFactId of fact.replaces) {
        const deleted = await memory.deleteFact(userId, oldFactId);
        if (deleted) {
          console.log(`Replaced old fact ${oldFactId} for ${userId}`);
        }
      }
    }
  }

  // Batch store all surviving facts
  const ids = await memory.addFacts(
    userId,
    survivors.map((f) => ({ content: f.content, category: f.category, confidence: f.confidence }))
  );

  for (const fact of survivors) {
    console.log(`Stored new fact for ${userId}: ${fact.content}`);
  }

  return ids.length;
}
