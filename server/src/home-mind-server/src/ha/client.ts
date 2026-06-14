import type { Config } from "../config.js";

export interface EntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

export interface HistoryEntry {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
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

export class HomeAssistantClient {
  private baseUrl: string;
  private token: string;
  private skipTlsVerify: boolean;

  // Cache settings
  private cacheTTL: number = 10000; // 10 seconds default
  private allStatesCache: CacheEntry<EntityState[]> | null = null;
  private entityCache: Map<string, CacheEntry<EntityState>> = new Map();

  constructor(config: Config) {
    this.baseUrl = config.haUrl.replace(/\/$/, "");
    this.token = config.haToken;
    this.skipTlsVerify = config.haSkipTlsVerify;
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
    const states = await this.getAllStatesCached();

    if (domain) {
      return states.filter((s) => s.entity_id.startsWith(`${domain}.`));
    }

    return states;
  }

  /**
   * Search entities by name or ID substring (cached)
   */
  async searchEntities(query: string): Promise<EntityState[]> {
    const states = await this.getAllStatesCached();
    const lowerQuery = query.toLowerCase();

    return states.filter((s) => {
      const name = (s.attributes.friendly_name as string) || "";
      return (
        s.entity_id.toLowerCase().includes(lowerQuery) ||
        name.toLowerCase().includes(lowerQuery)
      );
    });
  }

  /**
   * Call a Home Assistant service (invalidates cache)
   */
  async callService(
    domain: string,
    service: string,
    entityId?: string,
    data?: Record<string, unknown>
  ): Promise<EntityState[]> {
    const payload: Record<string, unknown> = { ...data };
    if (entityId) {
      payload.entity_id = entityId;
    }

    const result = await this.fetch<EntityState[]>(`/api/services/${domain}/${service}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    // Invalidate cache after service call since states may have changed
    this.invalidateCache();

    return result;
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
    const start = startTime || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    // URL-encode every interpolated value. The `+` in `+HH:MM` tz offsets is
    // otherwise decoded as a space in query strings by aiohttp (HA's HTTP
    // layer), producing "Invalid end_time" 400s for any LLM that includes
    // an explicit timezone offset in its history args.
    let endpoint = `/api/history/period/${encodeURIComponent(start)}?filter_entity_id=${encodeURIComponent(entityId)}`;

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

  /** Best-effort prediction of the entity_id HA derives from an alias (slugify). */
  private slugify(alias: string): string {
    return alias
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  /**
   * Create (or overwrite) a Home Assistant automation via the config API, then
   * reload automations so it registers immediately. Returns the authoritative
   * entity_id (read back from HA, since the alias→slug derivation can differ on
   * collisions). Throws a friendly error if the HA `config` integration is absent.
   */
  async createAutomation(config: AutomationConfig): Promise<CreatedAutomation> {
    const id = Date.now().toString();
    const body = {
      id,
      alias: config.alias,
      description: config.description ?? "",
      mode: config.mode ?? "single",
      trigger: this.toArray(config.trigger),
      condition: this.toArray(config.condition),
      action: this.toArray(config.action),
    };

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

  /** List all automation entities (config-id lives in attributes.id). */
  async listAutomations(): Promise<EntityState[]> {
    return this.getEntities("automation");
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
    const merged = {
      id,
      alias: changes.alias ?? (current.alias as string),
      description: changes.description ?? (current.description as string) ?? "",
      mode: changes.mode ?? (current.mode as string) ?? "single",
      trigger:
        changes.trigger !== undefined
          ? this.toArray(changes.trigger)
          : this.toArray(current.trigger),
      condition:
        changes.condition !== undefined
          ? this.toArray(changes.condition)
          : this.toArray(current.condition),
      action:
        changes.action !== undefined
          ? this.toArray(changes.action)
          : this.toArray(current.action),
    };

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
