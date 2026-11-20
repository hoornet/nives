import type { EntityState } from "./client.js";
import { isVoiceEngine } from "./service-policy.js";

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
 * The list is the boundary, so it fails closed. A user who has exposed nothing
 * gets an assistant that can reach nothing (and a notification saying why, see
 * `jobs/nothing-exposed-notice.ts`), not one that can reach everything. A list
 * that has never been read, because Home Assistant was still starting or the
 * websocket failed, is `null`, which also allows nothing; it is retried soon,
 * and a read that fails later keeps the last good list.
 */
/**
 * Voice engines (`tts.*`) may be used whether or not they are exposed.
 *
 * A voice engine is not a device in the house: it turns text into sound and
 * can only be heard through a speaker, and the speaker is checked
 * (`media_player_entity_id`, see `ENTITY_LIST_KEYS`). Home Assistant does not
 * expose engines by default, so without this an announcement, including one
 * in Nives's own voice, would need the user to expose a voice engine to
 * Assist, which nobody thinks of as hiding or sharing a device. The test is on
 * a whole, well-formed id, since the id may end up in a request path.
 */
const alwaysAllowed = isVoiceEngine;

export class AssistExposure {
  private entities: Set<string> | null = null;
  /** When the cached answer (a list, or a failed first read) stops being good. */
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

  /** The exposed entity IDs, or `null` while the list has never been read. */
  async list(): Promise<Set<string> | null> {
    // A failed read is cached for `retryMs` as well, or every tool call while
    // Home Assistant is unreachable would open a websocket of its own.
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
    // An empty list is the user's answer too: nothing is exposed, so nothing
    // may be reached.
    this.entities = fetched;
    this.expiresAt = Date.now() + this.ttlMs;
    return this.entities;
  }

  /** Whether the assistant may see and act on this entity. */
  async allows(entityId: string): Promise<boolean> {
    if (alwaysAllowed(entityId)) return true;
    const exposed = await this.list();
    if (exposed?.has(entityId)) return true;
    // A refusal is re-checked against a fresh read, so "expose it and ask
    // again" works on the first try. Paced, so a turn that names several
    // unexposed entities, or a model that keeps retrying, reads the list once.
    if (Date.now() - this.readAt < this.missRefreshMs) return false;
    this.expiresAt = 0;
    const fresh = await this.list();
    return fresh?.has(entityId) ?? false;
  }

  /**
   * The subset of `states` the assistant may see, in the order given. Voice
   * engines stay in, so the assistant can find the one to announce with.
   */
  async filter(states: EntityState[]): Promise<EntityState[]> {
    const exposed = await this.list();
    return states.filter((s) => exposed?.has(s.entity_id) || alwaysAllowed(s.entity_id));
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

/** What the model is told when the user has exposed nothing at all. */
export function nothingExposedMessage(): string {
  return (
    `The user has not exposed any devices to the assistant (Settings → Voice assistants → ` +
    `Expose), so you can't act on anything. Tell them to expose what they want you to use; it ` +
    `works as soon as they do.`
  );
}

/**
 * What the model is told when the exposure list could not be read yet, so it
 * does not tell the user a device is unexposed when nobody knows.
 */
export function exposureUnavailableMessage(): string {
  return (
    `Home Assistant has not told the assistant yet which devices are exposed to it, so none can ` +
    `be used right now. This usually clears within a minute of Home Assistant starting. Tell the ` +
    `user to try again shortly, and to check the Nives add-on log if it keeps happening.`
  );
}
