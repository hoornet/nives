import type { EntityState } from "./client.js";

/**
 * The entities exposed to Assist, read once per TTL and shared.
 *
 * Home Assistant's own conversation agent decides what an assistant may see and
 * touch from exactly one list: `async_should_expose` filters every state before
 * the prompt or the live-context tool is built, so an entity the user has not
 * exposed does not exist for that assistant at all.
 *
 * Nives already built its room map from that list, but the tools went straight
 * to `/api/states`, so the model could still read and drive entities the user
 * had deliberately kept out of Assist. This object is the one reading both
 * sides now share: the topology scanner uses it for the layout, and
 * `HomeAssistantClient` uses it to bound the tools.
 *
 * `null` means "no opinion", which is not the same as "expose nothing". An old
 * Home Assistant, a token without websocket access, a network error, and a user
 * who has exposed nothing all end up as `null`, and `null` filters nothing. A
 * failed websocket call that left the assistant unable to see a single device
 * would be far worse than the gap it is meant to close.
 */
/**
 * Domains the assistant may use whether or not they are exposed.
 *
 * A voice engine (`tts.*`) is not a device in the house: it turns text into
 * sound and can only be heard through a speaker, and the speaker is checked
 * (`media_player_entity_id`, see `ENTITY_LIST_KEYS`). Home Assistant does not
 * expose engines by default, so without this an announcement, including one
 * in Nives's own voice, would need the user to expose a voice engine to
 * Assist, which nobody thinks of as hiding or sharing a device.
 */
const ALWAYS_ALLOWED_DOMAINS = ["tts"];

function alwaysAllowed(entityId: string): boolean {
  return ALWAYS_ALLOWED_DOMAINS.some((d) => entityId.startsWith(`${d}.`));
}

export class AssistExposure {
  private entities: Set<string> | null = null;
  /** When the cached answer (a list, or "no opinion") stops being good. */
  private expiresAt = 0;
  private inFlight: Promise<Set<string> | null> | null = null;
  /** When the last read finished, good or not; paces the re-read before a refusal. */
  private readAt = 0;

  /**
   * @param fetcher Reads the exposure list; resolves to `null` when it cannot.
   * @param ttlMs How long a good read is kept. One minute: when Nives refuses
   *   something, the user's next move is to expose it and ask again, and a
   *   list kept for the 30-minute topology scan interval refused them again
   *   for up to half an hour. A read is one small websocket request, made only
   *   when the assistant is in use (6 to 25 ms on a 588-entity house).
   * @param retryMs How soon a failed read is tried again. Short, but not on
   *   every tool call.
   * @param missRefreshMs How old the list may be before a refusal re-reads it
   *   first (see `allows`).
   */
  constructor(
    private readonly fetcher: () => Promise<Set<string> | null>,
    private readonly ttlMs = 60 * 1000,
    private readonly retryMs = 60 * 1000,
    private readonly missRefreshMs = 10 * 1000
  ) {}

  /** The exposed entity IDs, or `null` for "no opinion". */
  async list(): Promise<Set<string> | null> {
    // "No opinion" is cached as well, or every tool call in a home that exposes
    // nothing would open a websocket of its own.
    if (Date.now() < this.expiresAt) {
      return this.entities;
    }
    // One turn runs several tool calls in parallel; without this each of them
    // would open its own websocket on the first call after a restart.
    this.inFlight ??= this.refresh();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async refresh(): Promise<Set<string> | null> {
    let fetched: Set<string> | null = null;
    try {
      fetched = await this.fetcher();
      this.readAt = Date.now();
    } catch (err) {
      this.readAt = Date.now();
      console.warn(
        `[exposure] Could not refresh the exposure list: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    // A failed read (thrown, or `null`, which is how fetchExposedEntities
    // reports one) must not widen what the model can reach: the last good
    // answer stands, and the read is retried soon.
    if (fetched === null) {
      this.expiresAt = Date.now() + this.retryMs;
      return this.entities;
    }
    // An empty list cannot be told apart from a home that never opened the
    // Expose page, so it is "no opinion" rather than a house with no devices.
    this.entities = fetched.size > 0 ? fetched : null;
    this.expiresAt = Date.now() + this.ttlMs;
    return this.entities;
  }

  /** Whether the assistant may see and act on this entity. */
  async allows(entityId: string): Promise<boolean> {
    if (alwaysAllowed(entityId)) return true;
    const exposed = await this.list();
    if (exposed === null || exposed.has(entityId)) return true;
    // A refusal is re-checked against a fresh read, so "expose it and ask
    // again" works on the first try. Paced, so a turn that names several
    // unexposed entities, or a model that keeps retrying, reads the list once.
    if (Date.now() - this.readAt < this.missRefreshMs) return false;
    this.expiresAt = 0;
    const fresh = await this.list();
    return fresh === null || fresh.has(entityId);
  }

  /**
   * The subset of `states` the assistant may see, in the order given. Voice
   * engines stay in, so the assistant can find the one to announce with.
   */
  async filter(states: EntityState[]): Promise<EntityState[]> {
    const exposed = await this.list();
    if (exposed === null) return states;
    return states.filter((s) => exposed.has(s.entity_id) || alwaysAllowed(s.entity_id));
  }
}

/**
 * What the model is told when it reaches for an entity it may not use.
 *
 * Worded so it stops instead of retrying: a model that reads "not found" tries
 * spelling variants, and a house it has only seen half of offers plenty.
 */
export function notExposedMessage(entityId: string): string {
  return (
    `${entityId} is not available to you. It may exist in Home Assistant, but the user has not ` +
    `exposed it to the assistant (Settings → Voice assistants → Expose), so it is out of scope. ` +
    `Do not retry with a different spelling; tell the user it is not exposed, and that once they ` +
    `expose it, asking again will work.`
  );
}
