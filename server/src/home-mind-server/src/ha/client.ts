import type { Config } from "../config.js";
import { AssistExposure, notExposedMessage } from "./exposure.js";
import {
  ENTITY_LIST_KEYS,
  INDIRECT_TARGETS,
  collectReach,
  emptyReach,
  entityIdsIn,
  listedEntities,
  reachKeys,
} from "./reach.js";

export interface EntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

/**
 * One recorder row. Everything but `state` and `last_changed` is optional
 * because we ask for `minimal_response`, under which HA returns those two alone
 * for every entry other than the first and last.
 */
export interface HistoryEntry {
  entity_id?: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_changed: string;
  last_updated?: string;
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

/** Input for creating an automation. trigger/condition/action may be a single object or an array. */
export interface AutomationConfig {
  alias: string;
  trigger: unknown;
  condition?: unknown;
  action: unknown;
  mode?: string;
  description?: string;
}

/** Result of a successful automation creation. */
export interface CreatedAutomation {
  id: string;
  alias: string;
  entity_id: string;
}

type AutomationSection = "trigger" | "condition" | "action";

/** A stored automation as the assistant may read it. */
export interface AutomationSettings {
  alias: string;
  mode: string;
  trigger?: unknown[];
  condition?: unknown[];
  action?: unknown[];
  /** Path of the blueprint it is built from, which holds its sections instead. */
  blueprint?: string;
  /** Sections left out because they name something the user did not expose. */
  hidden: AutomationSection[];
}

/**
 * What HA's services catalog says about a service's response. HA rejects a
 * call with `?return_response` on a service that has none ("none"), and
 * rejects a call WITHOUT it on a service that must return one ("only").
 */
export type ServiceResponseSupport = "none" | "optional" | "only";

/** Shape HA returns when a response was requested (`?return_response`). */
export interface ServiceCallWithResponse {
  changed_states: EntityState[];
  service_response: unknown;
}

/** Lifecycle services of the script domain; any other `script.X` runs script X. */
const SCRIPT_LIFECYCLE = new Set(["turn_on", "turn_off", "toggle", "reload"]);

let lastAutomationId = 0;

/**
 * Config id for a new automation: a millisecond timestamp, like the ids HA's
 * own editor writes, but never repeated within this process. The model's tool
 * calls run in parallel, so two creates from one step can land in the same
 * millisecond; with a bare Date.now() they got the same id, HA kept only the
 * second write, and both calls still reported success.
 */
function nextAutomationId(): string {
  lastAutomationId = Math.max(Date.now(), lastAutomationId + 1);
  return lastAutomationId.toString();
}

/**
 * Lower-case and strip combining diacritics, so "Garaža" and "garaza" compare
 * equal. Letters that do not decompose (ł, ø, ß) are left as they are.
 * NFD splits an accented letter into base + combining mark; the range
 * U+0300-U+036F is exactly those marks.
 */
export function foldAccents(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export class HomeAssistantClient {
  private baseUrl: string;
  private token: string;
  private skipTlsVerify: boolean;

  // Cache settings
  private cacheTTL: number = 10000; // 10 seconds default
  private allStatesCache: CacheEntry<EntityState[]> | null = null;
  private entityCache: Map<string, CacheEntry<EntityState>> = new Map();
  // The services catalog changes only when integrations load or unload, so it
  // can live much longer than entity state. It is never invalidated by a
  // service call. Missing or failed → looked up again next time.
  private serviceResponseTTL: number = 5 * 60 * 1000;
  private serviceResponseCache: CacheEntry<Map<string, ServiceResponseSupport>> | null = null;

  /**
   * @param exposure The entities the user exposed to Assist. When given, it
   *   bounds what the tools can read and drive, the same bound Home Assistant's
   *   own agent puts on its tools. Omitted, or reporting "no opinion", it leaves
   *   the client unfiltered.
   */
  constructor(
    config: Config,
    private readonly exposure?: AssistExposure
  ) {
    this.baseUrl = config.haUrl.replace(/\/$/, "");
    this.token = config.haToken;
    this.skipTlsVerify = config.haSkipTlsVerify;
  }

  /**
   * Refuses an entity the user has not exposed, before any request is made.
   *
   * Throwing beats returning an empty result: the tool handler hands the
   * message to the model, so "not exposed" is said out loud instead of looking
   * like a device that is missing or broken.
   */
  private async requireExposed(...entityIds: string[]): Promise<void> {
    if (!this.exposure) return;
    for (const id of entityIds) {
      if (!(await this.exposure.allows(id))) throw new Error(notExposedMessage(id));
    }
  }

  /**
   * Refuses a service call that would reach past the exposure list.
   *
   * Named entities are checked one by one, including those in a nested
   * `target` and the entity maps and lists that scenes and groups take
   * (`ENTITY_LIST_KEYS`). Area, device, floor and label targets would have to
   * be resolved to know what they hit, so while the list has an opinion they
   * are refused and the model is told to name entities. A call with no target
   * touches no entity, except `script.<name>`, which runs that script.
   */
  private async requireExposedTargets(
    domain: string,
    service: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!this.exposure || (await this.exposure.list()) === null) return;
    const nested =
      payload.target && typeof payload.target === "object"
        ? (payload.target as Record<string, unknown>)
        : {};
    const indirect = INDIRECT_TARGETS.find(
      (k) => payload[k] !== undefined || nested[k] !== undefined
    );
    if (indirect) {
      throw new Error(
        `Targeting by ${indirect} is not available to you: only entities the user exposed to the ` +
          `assistant may be controlled. Call the service with the exposed entity_ids instead.`
      );
    }
    const ids = [
      ...entityIdsIn(payload.entity_id),
      ...entityIdsIn(nested.entity_id),
      ...ENTITY_LIST_KEYS.flatMap((k) => listedEntities(payload[k])),
    ];
    if (ids.includes("all")) {
      throw new Error(
        `entity_id "all" is not available to you: it reaches entities the user has not exposed. ` +
          `Call the service with the exposed entity_ids instead.`
      );
    }
    if (domain === "script" && !SCRIPT_LIFECYCLE.has(service)) ids.push(`script.${service}`);
    await this.requireExposed(...ids);
  }

  /**
   * Refuses an automation that would reach past the exposure list.
   *
   * The same bound as a service call, over everything the triggers, conditions
   * and actions name (see `collectReach`): named entities must be exposed;
   * area, device, floor and label selectors and templated entity ids cannot be
   * vetted, so they are refused while the list has an opinion; and an
   * entity-shaped word anywhere else (a template, `at:`, `action: script.x`)
   * is checked when an entity by that id exists.
   *
   * @param current The stored config of the automation being updated. What a
   *   section already named is left alone when that section is rewritten: the
   *   user wrote it, not the assistant, and refusing it would stop the
   *   assistant from renaming or retiming automations the user made by hand.
   *   Only reach that is new to the section is checked, so an entity the
   *   automation merely watched cannot be moved into an action that drives it.
   *   A section the assistant is not allowed to read cannot be replaced without
   *   keeping what it names: the assistant would be writing over what it never saw.
   */
  async requireExposedAutomation(
    sections: Partial<Pick<AutomationConfig, AutomationSection>>,
    current?: Record<string, unknown>
  ): Promise<void> {
    if (!this.exposure || (await this.exposure.list()) === null) return;
    const pairs: [AutomationSection, unknown, unknown][] = [
      ["trigger", sections.trigger, current?.trigger ?? current?.triggers],
      ["condition", sections.condition, current?.condition ?? current?.conditions],
      ["action", sections.action, current?.action ?? current?.actions],
    ];
    const reach = emptyReach();
    for (const [section, next, before] of pairs) {
      if (next === undefined) continue;
      const known = reachKeys(collectReach(before));
      const found = collectReach(next);
      const kept = reachKeys(found);
      if ([...known].some((item) => !kept.has(item)) && (await this.isHiddenSection(before))) {
        throw new Error(
          `The ${section} of this automation names devices the user has not exposed to the ` +
            `assistant, so you can't see it, and replacing it would lose them. Nothing was ` +
            `changed. The user can edit it in Home Assistant, or expose those devices and ask again.`
        );
      }
      for (const kind of ["named", "indirect", "templated", "mentioned"] as const) {
        for (const item of found[kind]) if (!known.has(item)) reach[kind].add(item);
      }
    }

    const [indirect] = reach.indirect;
    if (indirect) {
      const key = indirect.slice(0, indirect.indexOf("="));
      throw new Error(
        `Selecting by ${key} is not available to you in an automation: only entities the user ` +
          `exposed to the assistant may be used. Name the exposed entity_ids instead ` +
          `(a state trigger rather than a device trigger).`
      );
    }
    const [templated] = reach.templated;
    if (templated) {
      throw new Error(
        `The templated entity_id ${JSON.stringify(templated)} is not available to you: it cannot ` +
          `be checked against what the user exposed. Name the exposed entity_ids instead.`
      );
    }
    if (reach.named.has("all")) {
      throw new Error(
        `entity_id "all" is not available to you: it reaches entities the user has not exposed. ` +
          `Name the exposed entity_ids instead.`
      );
    }
    await this.requireExposed(...reach.named);
    if (reach.mentioned.size > 0) {
      const existing = new Set((await this.getAllStatesCached()).map((s) => s.entity_id));
      await this.requireExposed(...[...reach.mentioned].filter((id) => existing.has(id)));
    }
  }

  /**
   * Check if cache entry is still valid
   */
  private isCacheValid<T>(entry: CacheEntry<T> | null | undefined): entry is CacheEntry<T> {
    if (!entry) return false;
    return Date.now() - entry.timestamp < this.cacheTTL;
  }

  /**
   * Invalidate all caches (call after service calls)
   */
  private invalidateCache(): void {
    this.allStatesCache = null;
    this.entityCache.clear();
  }

  private async fetch<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    const fetchOptions: RequestInit = {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    };

    // Handle self-signed certificates
    if (this.skipTlsVerify && url.startsWith("https://")) {
      const { Agent } = await import("undici");
      (fetchOptions as any).dispatcher = new Agent({
        connect: { rejectUnauthorized: false },
      });
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HA API error ${response.status}: ${text}`);
    }

    return response.json() as Promise<T>;
  }

  private async fetchText(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<string> {
    const url = `${this.baseUrl}${endpoint}`;

    const fetchOptions: RequestInit = {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    };

    if (this.skipTlsVerify && url.startsWith("https://")) {
      const { Agent } = await import("undici");
      (fetchOptions as any).dispatcher = new Agent({
        connect: { rejectUnauthorized: false },
      });
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HA API error ${response.status}: ${text}`);
    }

    return response.text();
  }

  /**
   * Get all states (cached)
   */
  private async getAllStatesCached(): Promise<EntityState[]> {
    if (this.isCacheValid(this.allStatesCache)) {
      return this.allStatesCache.data;
    }

    const states = await this.fetch<EntityState[]>("/api/states");
    this.allStatesCache = { data: states, timestamp: Date.now() };

    // Also populate individual entity cache
    for (const state of states) {
      this.entityCache.set(state.entity_id, { data: state, timestamp: Date.now() });
    }

    return states;
  }

  /**
   * Get state of a single entity (cached)
   */
  async getState(entityId: string): Promise<EntityState> {
    await this.requireExposed(entityId);

    // Check individual cache first
    const cached = this.entityCache.get(entityId);
    if (this.isCacheValid(cached)) {
      return cached.data;
    }

    // Check if we have a recent all-states cache
    if (this.isCacheValid(this.allStatesCache)) {
      const state = this.allStatesCache.data.find(s => s.entity_id === entityId);
      if (state) return state;
    }

    // Fetch individual entity
    const state = await this.fetch<EntityState>(`/api/states/${entityId}`);
    this.entityCache.set(entityId, { data: state, timestamp: Date.now() });
    return state;
  }

  /**
   * Get all entities, optionally filtered by domain (cached)
   */
  async getEntities(domain?: string): Promise<EntityState[]> {
    const states = await this.visibleStates();

    if (domain) {
      return states.filter((s) => s.entity_id.startsWith(`${domain}.`));
    }

    return states;
  }

  /** Every state the assistant may see: all of them when the list has no opinion. */
  private async visibleStates(): Promise<EntityState[]> {
    const states = await this.getAllStatesCached();
    return this.exposure ? this.exposure.filter(states) : states;
  }

  /**
   * Search entities by name or ID substring (cached).
   *
   * Both sides are accent-folded before comparing. An entity_id is ASCII by
   * construction, so a query in the user's own language ("garaža") could never
   * match the entity slugged from it ("garaza_vrata"), and a friendly name is
   * whatever the installer typed, sometimes accented and sometimes not.
   */
  async searchEntities(query: string): Promise<EntityState[]> {
    const states = await this.visibleStates();
    const needle = foldAccents(query);

    return states.filter((s) => {
      const name = (s.attributes.friendly_name as string) || "";
      return (
        foldAccents(s.entity_id).includes(needle) ||
        foldAccents(name).includes(needle)
      );
    });
  }

  /**
   * Call a Home Assistant service (invalidates cache).
   *
   * Services that return data (`weather.get_forecasts`, `calendar.get_events`,
   * `todo.get_items`, ...) must be called with `?return_response`, and services
   * that don't must NOT be — HA 400s either way round. Which is which is
   * declared in the services catalog, so the decision is made here from that,
   * never by the caller: the query parameter goes on when the catalog says the
   * service supports a response, and the result then carries HA's
   * `{ changed_states, service_response }` instead of the changed-states list.
   * A `return_response` key inside `data` is accepted as a hint (it is not a
   * service field, so it is stripped from the payload) and can only ADD the
   * parameter for a service the catalog doesn't know; it never forces it onto
   * a service the catalog says has no response.
   */
  async callService(
    domain: string,
    service: string,
    entityId?: string,
    data?: Record<string, unknown>
  ): Promise<EntityState[] | ServiceCallWithResponse> {
    const payload: Record<string, unknown> = { ...data };
    const hint = payload.return_response === true;
    delete payload.return_response;
    if (entityId) {
      payload.entity_id = entityId;
    }

    // Every entity this call would touch, whether named in `entityId` or handed
    // in through `data`: a model that has been told an entity is out of scope
    // will otherwise try the other door.
    await this.requireExposedTargets(domain, service, payload);

    const support = await this.getServiceResponseSupport(domain, service);
    const wantResponse =
      support === "only" || support === "optional" || (support === undefined && hint);

    const endpoint = `/api/services/${domain}/${service}${wantResponse ? "?return_response" : ""}`;
    const result = await this.fetch<EntityState[] | ServiceCallWithResponse>(endpoint, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    // Invalidate cache after service call since states may have changed
    this.invalidateCache();

    return result;
  }

  /**
   * Whether `domain.service` supports a response, per HA's services catalog:
   * `response: null` → "none", `{ optional: true }` → "optional",
   * `{ optional: false }` → "only". `undefined` when the service is not in the
   * catalog or the catalog could not be fetched — best-effort, a catalog hiccup
   * must never stop a light from turning on.
   */
  private async getServiceResponseSupport(
    domain: string,
    service: string
  ): Promise<ServiceResponseSupport | undefined> {
    const cached = this.serviceResponseCache;
    if (!cached || Date.now() - cached.timestamp >= this.serviceResponseTTL) {
      try {
        const raw = await this.fetch<
          { domain: string; services: Record<string, { response?: { optional?: boolean } | null }> }[]
        >("/api/services");
        const map = new Map<string, ServiceResponseSupport>();
        for (const entry of raw) {
          for (const [name, desc] of Object.entries(entry.services ?? {})) {
            const r = desc?.response;
            map.set(
              `${entry.domain}.${name}`,
              r == null ? "none" : r.optional ? "optional" : "only"
            );
          }
        }
        this.serviceResponseCache = { data: map, timestamp: Date.now() };
      } catch {
        return undefined;
      }
    }
    return this.serviceResponseCache!.data.get(`${domain}.${service}`);
  }

  /**
   * Render a Jinja2 template via the HA template API.
   * Returns the rendered plain-text result (HA returns text/plain, not JSON).
   */
  async renderTemplate(template: string): Promise<string> {
    return this.fetchText("/api/template", {
      method: "POST",
      body: JSON.stringify({ template }),
    });
  }

  /**
   * Get historical states for an entity (not cached - historical data)
   */
  async getHistory(
    entityId: string,
    startTime?: string,
    endTime?: string
  ): Promise<HistoryEntry[]> {
    await this.requireExposed(entityId);

    const start = startTime || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    // URL-encode every interpolated value. The `+` in `+HH:MM` tz offsets is
    // otherwise decoded as a space in query strings by aiohttp (HA's HTTP
    // layer), producing "Invalid end_time" 400s for any LLM that includes
    // an explicit timezone offset in its history args.
    // `minimal_response` drops attributes from every entry except the first and
    // last. We only ever read state + last_changed, so serializing icon,
    // friendly_name and device_class onto fifty thousand rows was work HA did
    // purely for us to discard: six of these calls took 15-23s each on a real
    // house. The first entry stays complete, which is where the unit comes from.
    let endpoint = `/api/history/period/${encodeURIComponent(start)}?filter_entity_id=${encodeURIComponent(entityId)}&minimal_response=true`;

    if (endTime) {
      endpoint += `&end_time=${encodeURIComponent(endTime)}`;
    }

    const result = await this.fetch<HistoryEntry[][]>(endpoint);
    return result[0] || [];
  }

  /** Wrap a single object (or undefined) into the array form HA's config API expects. */
  private toArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null) return [];
    return [value];
  }

  /**
   * Coerce common LLM action malformations into a valid HA action shape:
   *  - a stray `domain` key (HA 400s on it) is folded into the service id
   *    (e.g. {service:"mobile_app_x", domain:"notify"} → {service:"notify.mobile_app_x"})
   *  - `service_data` is renamed to `data` (HA's current key)
   * Recurses into control structures (choose/if/sequence/...) but not into payloads.
   */
  private cleanActionNode(node: unknown): unknown {
    if (Array.isArray(node)) return node.map((n) => this.cleanActionNode(n));
    if (!node || typeof node !== "object") return node;
    const obj = node as Record<string, unknown>;
    const isCall = typeof obj.service === "string" || typeof obj.action === "string";
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (isCall && key === "domain") continue; // dropped; folded into service below
      if (isCall && key === "service_data") {
        if (obj.data === undefined) out.data = value; // rename service_data → data
        continue;
      }
      // Leave payload values untouched; recurse into control structures.
      if (key === "data" || key === "target" || key === "metadata" || key === "variables") {
        out[key] = value;
      } else {
        out[key] = this.cleanActionNode(value);
      }
    }
    if (
      isCall &&
      typeof obj.domain === "string" &&
      typeof out.service === "string" &&
      !(out.service as string).includes(".")
    ) {
      out.service = `${obj.domain}.${out.service}`;
    }
    return out;
  }

  private normalizeActions(actions: unknown[]): unknown[] {
    return actions.map((a) => this.cleanActionNode(a));
  }

  /** Best-effort prediction of the entity_id HA derives from an alias (slugify). */
  private slugify(alias: string): string {
    return alias
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  // What an automation may name is bounded by the exposure list
  // (requireExposedAutomation), but the automations themselves are not:
  // listAutomations() reads every automation, exposed or not. Automations are
  // rarely exposed, and filtering them would leave the assistant unable to
  // find, change or delete the ones it just made.

  /**
   * Create (or overwrite) a Home Assistant automation via the config API, then
   * reload automations so it registers immediately. Returns the authoritative
   * entity_id (read back from HA, since the alias→slug derivation can differ on
   * collisions). Throws a friendly error if the HA `config` integration is absent.
   */
  async createAutomation(config: AutomationConfig): Promise<CreatedAutomation> {
    const id = nextAutomationId();
    const body = {
      id,
      alias: config.alias,
      description: config.description ?? "",
      mode: config.mode ?? "single",
      trigger: this.toArray(config.trigger),
      condition: this.toArray(config.condition),
      action: this.normalizeActions(this.toArray(config.action)),
    };

    await this.requireExposedAutomation(body);

    // Reject actions that reference non-existent services (e.g. a guessed
    // notify.mobile_app_* placeholder) before writing a broken automation.
    await this.validateActionServices(body.action);

    try {
      await this.fetch(`/api/config/automation/config/${id}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/HA API error 40[45]\b/.test(message)) {
        throw new Error(
          "Couldn't create the automation — this Home Assistant doesn't have the config editor enabled. Add `config:` (or `default_config:`) to configuration.yaml and restart HA, then try again."
        );
      }
      throw error;
    }

    // Reload so the new automation registers immediately (also invalidates the state cache).
    await this.callService("automation", "reload");

    return {
      id,
      alias: config.alias,
      entity_id: await this.resolveAutomationEntityId(id, config.alias),
    };
  }

  /**
   * List all automation entities (config-id lives in attributes.id). Reads past
   * the exposure list on purpose; see the note above createAutomation().
   */
  async listAutomations(): Promise<EntityState[]> {
    const states = await this.getAllStatesCached();
    return states.filter((s) => s.entity_id.startsWith("automation."));
  }

  /** Delete an automation by its config id, then reload. */
  async deleteAutomation(id: string): Promise<void> {
    await this.fetch(`/api/config/automation/config/${id}`, { method: "DELETE" });
    await this.callService("automation", "reload");
  }

  /** Find the entity_id HA assigned to a just-created automation (by config id), with slug fallback. */
  private async resolveAutomationEntityId(id: string, alias: string): Promise<string> {
    try {
      const automations = await this.listAutomations();
      const match = automations.find((a) => a.attributes.id === id);
      if (match) return match.entity_id;
    } catch {
      // Fall through to the predicted slug below.
    }
    return `automation.${this.slugify(alias)}`;
  }

  /** Read an automation's stored config by its config id (the value in attributes.id). */
  async getAutomationConfig(id: string): Promise<Record<string, unknown>> {
    return this.fetch<Record<string, unknown>>(`/api/config/automation/config/${id}`);
  }

  /** Whether a stored section reaches past the exposure list. */
  private async isHiddenSection(section: unknown): Promise<boolean> {
    try {
      // Reach is read the same way in all three sections, so `action` stands for any.
      await this.requireExposedAutomation({ action: section });
      return false;
    } catch {
      return true;
    }
  }

  /**
   * An automation as the assistant may read it, under the names update_automation
   * takes. The automation itself is not bounded by the exposure list (see the note
   * above createAutomation), but what it names is: a section that reaches past the
   * list is left out, so an unexposed id can't come back through its automation.
   */
  async readAutomation(id: string): Promise<AutomationSettings> {
    const config = await this.getAutomationConfig(id);
    const settings: AutomationSettings = {
      alias: config.alias as string,
      mode: (config.mode as string) ?? "single",
      hidden: [],
    };
    if (config.use_blueprint !== undefined) {
      return { ...settings, blueprint: (config.use_blueprint as { path: string }).path };
    }
    const stored: [AutomationSection, unknown][] = [
      ["trigger", config.trigger ?? config.triggers],
      ["condition", config.condition ?? config.conditions],
      ["action", config.action ?? config.actions],
    ];
    for (const [section, value] of stored) {
      if (await this.isHiddenSection(value)) settings.hidden.push(section);
      else settings[section] = this.toArray(value);
    }
    return settings;
  }

  /**
   * Update an existing automation: read its current config, overlay only the
   * provided fields, validate service references, write back to the same id,
   * and reload. Returns the (possibly changed) authoritative entity_id.
   */
  async updateAutomation(
    id: string,
    changes: Partial<AutomationConfig>
  ): Promise<CreatedAutomation> {
    const current = await this.getAutomationConfig(id);
    // Its triggers and actions live in the blueprint, and writing it back without
    // `use_blueprint` would leave an automation that does nothing.
    if (current.use_blueprint !== undefined) {
      throw new Error(
        `"${current.alias}" is built from a blueprint, so it can't be changed here. ` +
          `Nothing was changed. The user can edit it in Home Assistant.`
      );
    }
    // HA's config API returns plural keys (triggers/conditions/actions); older
    // forms / our POST body use singular. Read BOTH so an un-changed field is
    // preserved from current instead of being wiped to [] (this silently
    // destroyed actions on trigger-only updates before the fix).
    const {
      trigger: curSingularTrigger,
      triggers: curTriggers,
      condition: curSingularCondition,
      conditions: curConditions,
      action: curSingularAction,
      actions: curActions,
      ...rest // A write replaces the whole entry: keep `variables`, `max` and the like.
    } = current;
    const curTrigger = curSingularTrigger ?? curTriggers;
    const curCondition = curSingularCondition ?? curConditions;
    const curAction = curSingularAction ?? curActions;
    const merged = {
      ...rest,
      id,
      alias: changes.alias ?? (current.alias as string),
      description: changes.description ?? (current.description as string) ?? "",
      mode: changes.mode ?? (current.mode as string) ?? "single",
      trigger:
        changes.trigger !== undefined
          ? this.toArray(changes.trigger)
          : this.toArray(curTrigger),
      condition:
        changes.condition !== undefined
          ? this.toArray(changes.condition)
          : this.toArray(curCondition),
      action: this.normalizeActions(
        changes.action !== undefined
          ? this.toArray(changes.action)
          : this.toArray(curAction)
      ),
    };

    await this.requireExposedAutomation(changes, current);
    await this.validateActionServices(merged.action);

    await this.fetch(`/api/config/automation/config/${id}`, {
      method: "POST",
      body: JSON.stringify(merged),
    });
    await this.callService("automation", "reload");

    return {
      id,
      alias: merged.alias,
      entity_id: await this.resolveAutomationEntityId(id, merged.alias),
    };
  }

  /**
   * List available Home Assistant services (actions), as a map of
   * domain -> service names. Optionally filter to a single domain.
   * Use to discover real service ids (e.g. notify.mobile_app_<device>).
   */
  async listServices(domain?: string): Promise<Record<string, string[]>> {
    const raw = await this.fetch<{ domain: string; services: Record<string, unknown> }[]>(
      "/api/services"
    );
    const map: Record<string, string[]> = {};
    for (const entry of raw) {
      if (domain && entry.domain !== domain) continue;
      map[entry.domain] = Object.keys(entry.services ?? {});
    }
    return map;
  }

  /** Build the set of all known "domain.service" ids. */
  private async getKnownServiceIds(): Promise<Set<string>> {
    const raw = await this.fetch<{ domain: string; services: Record<string, unknown> }[]>(
      "/api/services"
    );
    const set = new Set<string>();
    for (const entry of raw) {
      for (const name of Object.keys(entry.services ?? {})) {
        set.add(`${entry.domain}.${name}`);
      }
    }
    return set;
  }

  /**
   * Throw a descriptive error if an automation action references a service that
   * doesn't exist (e.g. a guessed notify.mobile_app_* placeholder). Best-effort:
   * if the service list can't be fetched, validation is skipped (never blocks on
   * an API hiccup). Templated service names ("{{ ... }}") are skipped.
   */
  private async validateActionServices(action: unknown): Promise<void> {
    const refs = new Set<string>();
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(collect);
        return;
      }
      if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          if (
            (key === "service" || key === "action") &&
            typeof value === "string" &&
            /^[a-z_]+\.[a-z0-9_]+$/.test(value) &&
            !value.includes("{{")
          ) {
            refs.add(value);
          } else {
            collect(value);
          }
        }
      }
    };
    collect(action);
    if (refs.size === 0) return;

    let known: Set<string>;
    try {
      known = await this.getKnownServiceIds();
    } catch {
      return; // Can't fetch services → don't block on our own validation failing.
    }

    const unknown = [...refs].filter((ref) => !known.has(ref));
    if (unknown.length === 0) return;

    const hints = unknown.map((ref) => {
      const dom = ref.split(".")[0];
      const sameDomain = [...known].filter((k) => k.startsWith(`${dom}.`)).slice(0, 12);
      return sameDomain.length
        ? `"${ref}" doesn't exist — available ${dom} services: ${sameDomain.join(", ")}`
        : `"${ref}" doesn't exist and there are no services in the "${dom}" domain`;
    });

    throw new Error(
      `The automation action references services that don't exist in this Home Assistant. ${hints.join("; ")}. Use a real service id (call list_services to discover them) — never invent or use placeholder names.`
    );
  }
}
