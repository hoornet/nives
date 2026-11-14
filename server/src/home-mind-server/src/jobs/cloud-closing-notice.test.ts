import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CLOUD_CLOSING_NOTIFICATION_ID,
  RETIRED_NOTIFICATION_IDS,
  cloudClosingMessage,
  postCloudClosingNotice,
  scheduleCloudClosingNotice,
} from "./cloud-closing-notice.js";

function fakeHa() {
  return { callService: vi.fn().mockResolvedValue(undefined) };
}

const created = (ha: ReturnType<typeof fakeHa>) =>
  ha.callService.mock.calls.filter((c) => c[1] === "create");
const dismissed = (ha: ReturnType<typeof fakeHa>) =>
  ha.callService.mock.calls.filter((c) => c[1] === "dismiss").map((c) => c[3].notification_id);

describe("cloudClosingMessage", () => {
  it("speaks of the future before the closing date and the past after it", () => {
    const before = cloudClosingMessage(new Date("2026-11-20T12:00:00Z"));
    expect(before.title).toBe("Nives Cloud is closing");
    expect(before.message).toContain("closes on 1 December 2026");

    const after = cloudClosingMessage(new Date("2026-12-01T00:00:00Z"));
    expect(after.title).toBe("Nives Cloud has closed");
    expect(after.message).toContain("no longer work");
  });

  it("explains the switch and never points at the closed shop", () => {
    const { message } = cloudClosingMessage(new Date("2026-11-20T12:00:00Z"));
    expect(message).toContain("set LLM Mode to `byok`");
    expect(message).not.toMatch(/nives\.house|top up/i);
  });
});

describe("postCloudClosingNotice", () => {
  it("posts the notice in Cloud mode and clears the balance notifications", async () => {
    const ha = fakeHa();

    expect(await postCloudClosingNotice(ha, "cloud")).toBe(true);

    expect(dismissed(ha)).toEqual(RETIRED_NOTIFICATION_IDS);
    expect(created(ha)).toHaveLength(1);
    expect(created(ha)[0][3].notification_id).toBe(CLOUD_CLOSING_NOTIFICATION_ID);
  });

  it("posts nothing on your own key, and clears a notice left from Cloud mode", async () => {
    const ha = fakeHa();

    expect(await postCloudClosingNotice(ha, "byok")).toBe(false);

    expect(created(ha)).toHaveLength(0);
    expect(dismissed(ha)).toEqual([...RETIRED_NOTIFICATION_IDS, CLOUD_CLOSING_NOTIFICATION_ID]);
  });

  it("does not fail when there was nothing to dismiss", async () => {
    const ha = fakeHa();
    ha.callService.mockImplementation(async (_d: string, service: string) => {
      if (service === "dismiss") throw new Error("not found");
    });

    expect(await postCloudClosingNotice(ha, "cloud")).toBe(true);
    expect(created(ha)).toHaveLength(1);
  });
});

describe("scheduleCloudClosingNotice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("waits for Home Assistant to settle, then retries until the notice lands", async () => {
    const ha = fakeHa();
    let failures = 2;
    ha.callService.mockImplementation(async (_d: string, service: string) => {
      if (service === "create" && failures-- > 0) throw new Error("HA not ready");
    });

    scheduleCloudClosingNotice(ha, "cloud", { delayMs: 1000, retryMs: 5000, attempts: 6 });
    expect(ha.callService).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000); // first try fails
    await vi.advanceTimersByTimeAsync(5000); // second try fails
    await vi.advanceTimersByTimeAsync(5000); // third try lands
    await vi.advanceTimersByTimeAsync(60_000); // and nothing more after that

    expect(created(ha)).toHaveLength(3);
  });

  it("can be cancelled before it runs", async () => {
    const ha = fakeHa();

    const cancel = scheduleCloudClosingNotice(ha, "cloud", { delayMs: 1000 });
    cancel();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(ha.callService).not.toHaveBeenCalled();
  });
});
