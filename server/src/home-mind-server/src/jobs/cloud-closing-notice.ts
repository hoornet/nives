import type { HomeAssistantClient } from "../ha/client.js";

/**
 * Nives Cloud closes on 1 December 2026 (decided 2026-11-14). An install still
 * set to Cloud mode gets one Home Assistant notification at startup explaining
 * how to switch to its own key, so nobody finds out from a failing assistant.
 *
 * This replaces the balance watch: with top-ups closed, its "top up" advice
 * had nowhere left to send people. Its notifications, and the integration's
 * old out-of-credit notice that also pointed at the Cloud site, are dismissed
 * here too, in every mode, so none of them lingers after the update.
 */

export const CLOUD_CLOSING_NOTIFICATION_ID = "nives_cloud_closing";
/**
 * Notification ids whose text sent people to the Cloud site: the balance
 * watch's two (removed in 2.10.0) and the integration's out-of-credit notice,
 * which now posts under `nives_out_of_credit` instead.
 */
export const RETIRED_NOTIFICATION_IDS = ["nives_low_balance", "nives_balance_paused", "nives_usage_limit"];

export const CLOUD_CLOSING_DATE = new Date("2026-12-01T00:00:00Z");

export function cloudClosingMessage(now: Date = new Date()): { title: string; message: string } {
  const closed = now >= CLOUD_CLOSING_DATE;
  return {
    title: closed ? "Nives Cloud has closed" : "Nives Cloud is closing",
    message:
      (closed
        ? "Nives Cloud closed on 1 December 2026, so its keys no longer work. "
        : "Nives Cloud closes on 1 December 2026, and its keys stop working that day. ") +
      "Nives itself keeps running on your own API key, with your memories and settings untouched:\n\n" +
      "1. Get a key, for example from [OpenRouter](https://openrouter.ai) or [Anthropic](https://console.anthropic.com).\n" +
      "2. In the Nives add-on's Configuration, set LLM Mode to `byok`.\n" +
      "3. Under Bring Your Own Key, choose the provider and paste the key. " +
      "With OpenRouter, leaving Model empty uses Claude Haiku 5.5.\n" +
      "4. Save and restart the add-on.\n\n" +
      "Voice and transcription need Provider set to OpenRouter.",
  };
}

type Notifier = Pick<HomeAssistantClient, "callService">;

/**
 * Home Assistant treats dismissing an id it does not have as a no-op, so an
 * error here means Home Assistant could not be reached or refused the call.
 * Let it through: the scheduler retries, and an old notice is not left behind.
 */
async function dismiss(ha: Notifier, id: string): Promise<void> {
  await ha.callService("persistent_notification", "dismiss", undefined, { notification_id: id });
}

/**
 * Clear the retired notifications and, in Cloud mode, post the closing notice
 * (or clear it once the user has switched). Throws when any call to Home
 * Assistant fails, so the caller can retry.
 */
export async function postCloudClosingNotice(
  ha: Notifier,
  llmMode: "cloud" | "byok",
  now: Date = new Date()
): Promise<boolean> {
  for (const id of RETIRED_NOTIFICATION_IDS) await dismiss(ha, id);
  if (llmMode !== "cloud") {
    await dismiss(ha, CLOUD_CLOSING_NOTIFICATION_ID);
    return false;
  }
  await ha.callService("persistent_notification", "create", undefined, {
    notification_id: CLOUD_CLOSING_NOTIFICATION_ID,
    ...cloudClosingMessage(now),
  });
  console.log("[cloud] Cloud mode: posted the Nives Cloud closing notice");
  return true;
}

/**
 * Post the notice once Home Assistant has had a minute to settle, retrying a
 * few times if it is not reachable yet. Returns a function that cancels it.
 */
export function scheduleCloudClosingNotice(
  ha: Notifier,
  llmMode: "cloud" | "byok",
  { delayMs = 60_000, retryMs = 300_000, attempts = 6 } = {}
): () => void {
  let timer: NodeJS.Timeout | null = null;
  let left = attempts;
  const run = () => {
    left--;
    postCloudClosingNotice(ha, llmMode).catch((err) => {
      console.warn(`[cloud] Could not post the Nives Cloud closing notice: ${String(err)}`);
      if (left > 0) timer = setTimeout(run, retryMs);
    });
  };
  timer = setTimeout(run, delayMs);
  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
