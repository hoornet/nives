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
 */

/**
 * Data keys that carry entity ids besides `entity_id`: `scene.create` and
 * `scene.apply` take `entities` as a map keyed by entity id, `scene.create` takes
 * `snapshot_entities`, and `group.set` takes `entities`, `add_entities` and
 * `remove_entities` as lists.
 */
export const ENTITY_LIST_KEYS = ["entities", "snapshot_entities", "add_entities", "remove_entities"] as const;

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
}

export function emptyReach(): Reach {
  return { named: new Set(), indirect: new Set(), templated: new Set(), mentioned: new Set() };
}

/**
 * Adds every adjacent pair in each dotted word: `states.sensor.cellar.state`
 * yields `sensor.cellar` among its pairs, and `states('lock.front')` yields
 * `lock.front`. The text is lower-cased first, because Home Assistant
 * lower-cases an entity id wherever it looks one up. Zones are left out: they
 * define places, not devices, and a zone trigger's person or tracker is named
 * in its `entity_id`, which is checked.
 */
function addMentions(text: string, into: Set<string>): void {
  for (const word of text.toLowerCase().match(DOTTED) ?? []) {
    const parts = word.split(".");
    for (let i = 0; i + 1 < parts.length; i++) {
      if (parts[i] !== "zone") into.add(`${parts[i]}.${parts[i + 1]}`);
    }
  }
}

/** Walks an automation's triggers, conditions or actions and collects what they name. */
export function collectReach(node: unknown, reach: Reach = emptyReach()): Reach {
  if (Array.isArray(node)) {
    for (const item of node) collectReach(item, reach);
    return reach;
  }
  if (typeof node === "string") {
    addMentions(node, reach.mentioned);
    return reach;
  }
  if (!node || typeof node !== "object") return reach;

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
        collectReach(Object.values(value), reach);
      }
    } else if ((INDIRECT_TARGETS as readonly string[]).includes(key)) {
      reach.indirect.add(`${key}=${JSON.stringify(value)}`);
    } else {
      collectReach(value, reach);
    }
  }
  return reach;
}

/** Every string a reach holds, whatever its kind; used to tell new reach from old. */
export function reachKeys(reach: Reach): Set<string> {
  return new Set([...reach.named, ...reach.indirect, ...reach.templated, ...reach.mentioned]);
}
