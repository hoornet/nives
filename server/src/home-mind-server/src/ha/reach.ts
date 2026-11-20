/**
 * What a service call or an automation names, collected so both can be held to
 * the Assist exposure list (`AssistExposure`).
 *
 * `entity_id` is not the only way to name an entity. A scene takes a map keyed by
 * entity id, a group takes lists, an area or device selects entities nobody named,
 * and an automation can name them in a trigger, a condition, a template or a time
 * (`at: sensor.phone_next_alarm`). An automation is the widest door of all: it runs
 * later, unattended, with Home Assistant's own authority, so naming an unexposed
 * lock in one drives that lock just as surely as calling the service would.
 * The same goes for what an automation calls (see `serviceRefusal`) and for what
 * its templates read, since they run with that authority too.
 */

import { checkTemplate } from "./template-check.js";
import {
  CODE_DOMAINS,
  SCRIPT_LIFECYCLE,
  isVoiceEngine,
  mediaRefusal,
  notifyRefusal,
  serviceRefusal,
} from "./service-policy.js";

/**
 * Data keys that carry entity ids besides `entity_id`: `scene.create` and
 * `scene.apply` take `entities` as a map keyed by entity id, `scene.create` takes
 * `snapshot_entities`, `group.set` takes `entities`, `add_entities` and
 * `remove_entities` as lists, `tts.speak` names its speaker in
 * `media_player_entity_id` (its `entity_id` is the voice engine), and
 * `media_player.join` takes the speakers to group in `group_members`.
 */
export const ENTITY_LIST_KEYS = [
  "entities",
  "snapshot_entities",
  "add_entities",
  "remove_entities",
  "media_player_entity_id",
  "group_members",
] as const;

/** Targets that select entities indirectly, which the exposure list cannot vet. */
export const INDIRECT_TARGETS = ["area_id", "device_id", "floor_id", "label_id"] as const;

const ENTITY_SHAPE = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const DOTTED = /[a-z0-9_]+(?:\.[a-z0-9_]+)+/g;

/** Whether a string is a Jinja template, which only Home Assistant can resolve. */
export function isTemplate(text: string): boolean {
  return text.includes("{{") || text.includes("{%");
}

/**
 * The entity IDs an `entity_id` value names; HA accepts one, a list, or "a, b".
 * A template is kept whole: split on its commas, the pieces would no longer read
 * as a template and would be checked as if they were entity ids.
 */
export function entityIdsIn(value: unknown): string[] {
  const ids = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return ids
    .filter((t): t is string => typeof t === "string")
    .flatMap((t) => (isTemplate(t) ? [t] : t.split(",")))
    .map((t) => t.trim())
    .filter((t) => t !== "");
}

/**
 * The entity ids in one of `ENTITY_LIST_KEYS`: the keys of a scene's entity map,
 * or a list. Only strings shaped like an entity id count, since other
 * integrations use the same key names for other things. They are lower-cased
 * first, as Home Assistant's `cv.entity_id` does: `Light.Hall` fails the shape
 * test as written but reaches `light.hall` all the same. A template is
 * returned as it is, so the caller refuses it rather than skipping it.
 */
export function listedEntities(value: unknown): string[] {
  const ids =
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value)
      : entityIdsIn(value);
  return ids
    .map((id) => (isTemplate(id) ? id : id.toLowerCase()))
    .filter((id) => isTemplate(id) || ENTITY_SHAPE.test(id));
}

/** Everything an automation section names, by how it names it. */
export interface Reach {
  /** Entity ids named in `entity_id` or one of `ENTITY_LIST_KEYS`. */
  named: Set<string>;
  /** Area, device, floor and label selectors, as `area_id=["kitchen"]`. */
  indirect: Set<string>;
  /** Templated entity ids, which cannot be checked without rendering them. */
  templated: Set<string>;
  /**
   * Entity-shaped words found in every other string: templates, `at`, `above`,
   * `action: script.x`. Most are not entities at all (`trigger.to_state`,
   * `light.turn_on`), so the caller checks only the ones that exist.
   */
  mentioned: Set<string>;
  /**
   * What the assistant may not write, each as the message that tells the model
   * why (see `checkActionStep` and `readsStateDynamically`).
   */
  refused: Set<string>;
}

export function emptyReach(): Reach {
  return {
    named: new Set(),
    indirect: new Set(),
    templated: new Set(),
    mentioned: new Set(),
    refused: new Set(),
  };
}

const SERVICE_REF = /^([a-z0-9_]+)\.([a-z0-9_]+)$/;

/** Keys that hold a service call's payload; each must be a plain object. */
const PAYLOAD_KEYS = ["target", "data", "service_data", "data_template"] as const;

/**
 * Trigger platforms an automation written by the assistant may use: ones that
 * fire on the house's own entities, the clock, the sun, zones, calendars, tags
 * and spoken sentences. Others can be fired from outside or carry whatever a
 * bus, broker or integration sends, exposed or not.
 */
const ALLOWED_TRIGGERS: ReadonlySet<string> = new Set([
  "state",
  "numeric_state",
  "time",
  "time_pattern",
  "sun",
  "zone",
  "homeassistant",
  "template",
  "calendar",
  "tag",
  "conversation",
]);

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Whether an action step names what it acts on: an entity other than a voice
 * engine, or an area-like target. A voice engine is allowed everywhere, so
 * counting it would let any service through as "targeted".
 */
function actionIsTargeted(step: Record<string, unknown>, domain: string, service: string): boolean {
  if (domain === "script" && !SCRIPT_LIFECYCLE.has(service)) {
    return true; // script.<name> runs that script, which the exposure check vets by name.
  }
  const holders = [step, ...PAYLOAD_KEYS.map((k) => step[k])].filter(plainObject);
  const realEntity = (id: string) => !isVoiceEngine(id.toLowerCase());
  return holders.some(
    (h) =>
      entityIdsIn(h.entity_id).some(realEntity) ||
      ENTITY_LIST_KEYS.some((k) => listedEntities(h[k]).some(realEntity)) ||
      INDIRECT_TARGETS.some((k) => h[k] !== undefined)
  );
}

/**
 * Adds to `refused` whatever in one step of an automation the assistant may
 * not write: a service outside the allowlist or one that names nothing, the
 * older `service_template` / `data_template` keys, a payload given as a
 * template string (which Home Assistant renders, so its targets cannot be
 * read here), an `event:` action (which fires the user's own automations), a
 * trigger outside `ALLOWED_TRIGGERS`, a device trigger, condition or action
 * (which acts through an integration rather than an entity), a security code,
 * and media the assistant may not play.
 */
function checkActionStep(step: Record<string, unknown>, reach: Reach): void {
  const refuse = (message: string) => reach.refused.add(message);
  for (const key of ["service_template", "data_template"]) {
    if (key in step) {
      refuse(
        `The older "${key}" key is not available to you in an automation: name the action with ` +
          `"action" and give its fields in "data" and its entities in "target".`
      );
    }
  }
  if (step.device_id !== undefined && typeof step.type === "string") {
    refuse(
      `Device triggers, conditions and actions are not available to you in an automation. Use ` +
        `the exposed entities instead (a state trigger, a state condition, a service call).`
    );
  }
  // `event` also names what a zone, sun, calendar or homeassistant trigger
  // waits for; only a step that is not a trigger fires one.
  const isTrigger = typeof step.trigger === "string" || typeof step.platform === "string";
  if (typeof step.event === "string" && !isTrigger) {
    refuse(
      `Firing an event (${step.event}) is not available to you in an automation: it can set off ` +
        `the user's other automations.`
    );
  }
  for (const key of ["trigger", "platform"]) {
    const platform = step[key];
    if (typeof platform === "string" && !ALLOWED_TRIGGERS.has(platform.trim().toLowerCase())) {
      refuse(
        `A ${platform.trim()} trigger is not available to you in an automation. Use a state, ` +
          `numeric_state, time, sun, zone or calendar trigger on exposed devices instead.`
      );
    }
  }
  for (const key of ["service", "action"]) {
    const value = step[key];
    if (typeof value !== "string") continue;
    const name = value.trim();
    if (isTemplate(name)) {
      refuse(
        `This automation calls a templated action (${name.slice(0, 80)}), which cannot be ` +
          `checked. Name the action directly, such as light.turn_on.`
      );
      continue;
    }
    const match = SERVICE_REF.exec(name.toLowerCase());
    if (!match) continue;
    const [, domain, service] = match;
    // Only a service call's payload keys are payloads; elsewhere `data` may be
    // a variable like any other.
    for (const payloadKey of PAYLOAD_KEYS) {
      if (payloadKey in step && !plainObject(step[payloadKey])) {
        refuse(
          `The "${payloadKey}" of an action must be written out as fields, not as a template or ` +
            `text, so what it acts on can be checked. Name the exposed entity_ids in "target".`
        );
      }
    }
    const payload = plainObject(step.data) ? step.data : plainObject(step.service_data) ? step.service_data : {};
    const why =
      serviceRefusal(domain, service, actionIsTargeted(step, domain, service)) ??
      (domain === "notify" ? notifyRefusal(service, payload, step.target) : null) ??
      mediaRefusal(payload, service === "browse_media" || service === "search_media") ??
      (CODE_DOMAINS.has(domain) && payload.code !== undefined
        ? `A security code is not available to you in an automation. The user can add the code ` +
          `in Home Assistant, or arm and disarm it themselves.`
        : null);
    if (why) refuse(`In this automation, ${why}`);
  }
}

/**
 * Template forms that read one entity by its literal id. The id is then
 * collected as a mention and held to the exposure list like any other.
 */
/**
 * Adds every adjacent pair in each dotted word: `states.sensor.cellar.state`
 * yields `sensor.cellar` among its pairs, and `states('lock.front')` yields
 * `lock.front`. The text is lower-cased first, because Home Assistant
 * lower-cases an entity id wherever it looks one up. Zones and the sun are left
 * out: they are places and the sky, not devices, and a zone trigger's person or
 * tracker is named in its `entity_id`, which is checked.
 */
function addMentions(text: string, into: Set<string>): void {
  // An id in a url may be percent-encoded, and Home Assistant decodes it.
  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    // Not valid percent-encoding: the text as written is all there is.
  }
  for (const source of decoded === text ? [text] : [text, decoded]) {
    for (const word of source.toLowerCase().match(DOTTED) ?? []) {
      const parts = word.split(".");
      for (let i = 0; i + 1 < parts.length; i++) {
        if (parts[i] !== "zone" && parts[i] !== "sun") into.add(`${parts[i]}.${parts[i + 1]}`);
      }
    }
  }
}

/**
 * Keys whose values are a call's fields or variables, not steps: what they
 * name and what their templates read is collected, but they are not checked
 * as triggers, conditions or actions.
 */
const DATA_KEYS: ReadonlySet<string> = new Set([
  "data",
  "target",
  "service_data",
  "data_template",
  "variables",
  "event_data",
]);

/**
 * Walks an automation's triggers, conditions or actions and collects what they name.
 *
 * @param asData The node is a call's fields or variables rather than a step.
 */
export function collectReach(node: unknown, reach: Reach = emptyReach(), asData = false): Reach {
  if (Array.isArray(node)) {
    for (const item of node) collectReach(item, reach, asData);
    return reach;
  }
  if (typeof node === "string") {
    addMentions(node, reach.mentioned);
    const template = isTemplate(node) ? checkTemplate(node) : undefined;
    // What the template reads, as the parser saw it: held to the exposure
    // list like any other mention, whatever the spacing.
    for (const id of template?.ids ?? []) {
      const domain = id.slice(0, id.indexOf("."));
      if (domain !== "zone" && domain !== "sun") reach.mentioned.add(id);
    }
    if (template && !template.safe) {
      reach.refused.add(
        `A template in this automation (${node.trim().slice(0, 80)}) uses something you may not ` +
          `use in an automation. Templates may read a device only by its id, as in ` +
          `states('sensor.kitchen_temperature') or state_attr('sensor.x', 'unit_of_measurement'), ` +
          `plus what the trigger carries, the time, numbers and text, with simple filters such ` +
          `as float, round and default, comparisons and "a if b else c". No {% %} statements.`
      );
    }
    return reach;
  }
  if (!node || typeof node !== "object") return reach;

  if (!asData) checkActionStep(node as Record<string, unknown>, reach);
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "entity_id") {
      for (const id of entityIdsIn(value)) {
        if (isTemplate(id)) reach.templated.add(id);
        else reach.named.add(id.toLowerCase());
      }
    } else if ((ENTITY_LIST_KEYS as readonly string[]).includes(key)) {
      for (const id of listedEntities(value)) {
        (isTemplate(id) ? reach.templated : reach.named).add(id);
      }
      // A scene's entity map holds states and attributes, which can be templates.
      if (value && typeof value === "object" && !Array.isArray(value)) {
        collectReach(Object.values(value), reach, true);
      }
    } else if ((INDIRECT_TARGETS as readonly string[]).includes(key)) {
      reach.indirect.add(`${key}=${JSON.stringify(value)}`);
    } else {
      collectReach(value, reach, asData || DATA_KEYS.has(key));
    }
  }
  return reach;
}

/** Every string a reach holds, whatever its kind; used to tell new reach from old. */
export function reachKeys(reach: Reach): Set<string> {
  return new Set([
    ...reach.named,
    ...reach.indirect,
    ...reach.templated,
    ...reach.mentioned,
    ...reach.refused,
  ]);
}
