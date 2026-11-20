/**
 * One memory for the household (nives#65).
 *
 * Facts are stored per user id, and until 2.7.0 the integration picked that id
 * per caller: a voice satellite (no Home Assistant user behind the request)
 * wrote to the configured id, while the dashboard and the companion app wrote
 * to each person's own Home Assistant user id. One install quietly kept two or
 * more memories that could not see each other, and nothing said so: it read
 * as memory loss rather than routing.
 *
 * The integration now uses one configured id for everyone by default. This
 * module carries the two server halves of that change:
 *
 *  - an info line the first time a request lands on an empty bucket while
 *    another bucket holds facts, so a split that remains (shared memory turned
 *    off, or an API caller choosing its own ids) takes minutes to diagnose
 *    instead of days;
 *  - a one-time, non-destructive merge that copies the facts older versions
 *    wrote into per-user buckets into the shared one.
 */

import { promises as fs } from "node:fs";
import type { IMemoryStore } from "./interface.js";
import type { Fact, IConversationStore } from "./types.js";
import { normalizeFactContent } from "./fact-resolution.js";

/** Lives next to the conversation database; see createRouter's caller. */
export const MERGE_MARKER_FILENAME = "memory-merges.json";

/**
 * How many facts the merge reads from each bucket. A prompt only ever sees 100,
 * but a copy must not silently drop the rest of a heavy bucket.
 */
export const MERGE_READ_LIMIT = 1000;

export interface MergeSource {
  userId: string;
  copied: number;
  duplicates: number;
}

export type MergeResult =
  | { merged: number; sources: MergeSource[] }
  | { merged: 0; skipped: true };

/**
 * Returns a check to run, fire and forget, at the start of every chat request.
 *
 * Each user id is looked at once per process, so the cost is a handful of
 * memory reads per id per restart. Errors are logged at debug and never reach
 * the request: this is a diagnostic, not part of answering.
 */
export function createEmptyBucketCheck(
  memory: IMemoryStore,
  conversations: IConversationStore
): (userId: string) => Promise<void> {
  const checked = new Set<string>();

  return async (userId: string) => {
    if (checked.has(userId)) return;
    checked.add(userId);
    try {
      if ((await memory.getFacts(userId)).length > 0) return;
      const holders: string[] = [];
      for (const other of conversations.getKnownUsers()) {
        if (other === userId) continue;
        const count = (await memory.getFacts(other)).length;
        if (count > 0) holders.push(`"${other}" (${count})`);
      }
      if (holders.length === 0) return;
      console.log(
        `[memory] Memory bucket "${userId}" is empty, while other buckets hold facts: ` +
          `${holders.join(", ")}. Requests from different people or devices are landing in ` +
          `different memories. To give the whole household one memory, check that "Shared memory" ` +
          `is on in the Nives integration's options (Settings > Devices & services > Nives > Configure).`
      );
    } catch (err) {
      console.debug('[memory] Empty-memory check for "%s" failed:', userId, err);
    }
  };
}

async function readMarker(markerPath: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(markerPath, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error("not a JSON object");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Unreadable is treated as "never merged": the duplicate check below
      // still keeps a repeat merge from copying anything twice.
      console.warn("[memory-merge] Could not read %s, ignoring it:", markerPath, err);
    }
    return {};
  }
}

// Two merges for the same bucket at once (an entry reloaded twice in quick
// succession, or a client retrying after its own timeout) would both see the
// facts as missing and copy them twice. The second caller waits for the first.
const inFlight = new Map<string, Promise<MergeResult>>();

/**
 * Copy every fact held by any other known user into `target`, skipping facts
 * whose normalised content `target` already has.
 *
 * Non-destructive: the source buckets are only read, so turning shared memory
 * off later restores per-user memories with nothing lost. Idempotent: when
 * `markerPath` is given (the add-on keeps conversations in SQLite, so it
 * always is), a successful merge is recorded there and every later call for
 * the same target returns `{ merged: 0, skipped: true }`. Without a marker the
 * duplicate check alone keeps a repeat call from copying anything.
 *
 * Users are the ones the conversation store has seen, which is also how the
 * cleanup job finds them; the memory store has no way to list its buckets.
 */
export function mergeMemoryInto(
  target: string,
  memory: IMemoryStore,
  conversations: IConversationStore,
  markerPath?: string
): Promise<MergeResult> {
  const running = inFlight.get(target);
  if (running) return running;
  const merge = runMerge(target, memory, conversations, markerPath).finally(() =>
    inFlight.delete(target)
  );
  inFlight.set(target, merge);
  return merge;
}

async function runMerge(
  target: string,
  memory: IMemoryStore,
  conversations: IConversationStore,
  markerPath?: string
): Promise<MergeResult> {
  const marker = markerPath ? await readMarker(markerPath) : {};
  if (Object.prototype.hasOwnProperty.call(marker, target)) {
    return { merged: 0, skipped: true };
  }

  const present = new Set(
    (await memory.getFacts(target, MERGE_READ_LIMIT)).map((fact) => normalizeFactContent(fact.content))
  );
  const plan: { userId: string; facts: Fact[]; duplicates: number }[] = [];
  for (const userId of conversations.getKnownUsers()) {
    if (userId === target) continue;
    const facts: Fact[] = [];
    let duplicates = 0;
    for (const fact of await memory.getFacts(userId, MERGE_READ_LIMIT)) {
      const key = normalizeFactContent(fact.content);
      if (!key) continue; // nothing to copy
      if (present.has(key)) {
        duplicates++;
        continue;
      }
      // Also dedupes across sources: two people who both told Nives the
      // same thing end up with it once in the shared memory.
      present.add(key);
      facts.push(fact);
    }
    plan.push({ userId, facts, duplicates });
  }

  // Say what is about to happen before anything is written, so the log of a
  // merge that fails halfway still shows what it set out to do.
  if (plan.length === 0) {
    console.log(`[memory-merge] No other buckets to merge into "${target}".`);
  }
  for (const { userId, facts, duplicates } of plan) {
    console.log(
      `[memory-merge] Would merge ${facts.length} facts from bucket "${userId}" into "${target}" ` +
        `(${duplicates} already there).`
    );
  }

  const sources: MergeSource[] = [];
  for (const { userId, facts, duplicates } of plan) {
    const ids =
      facts.length === 0
        ? []
        : await memory.addFacts(
            target,
            facts.map((fact) => ({
              content: fact.content,
              category: fact.category,
              confidence: fact.confidence,
            }))
          );
    sources.push({ userId, copied: ids.length, duplicates });
  }
  const merged = sources.reduce((sum, source) => sum + source.copied, 0);
  console.log(
    `[memory-merge] Merged ${merged} facts into "${target}" from ${sources.length} other ` +
      `buckets. The originals are unchanged.`
  );

  if (markerPath) {
    marker[target] = { mergedAt: new Date().toISOString(), merged };
    await fs.writeFile(markerPath, JSON.stringify(marker, null, 2));
  }
  return { merged, sources };
}
