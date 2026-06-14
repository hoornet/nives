import { describe, it, expect, beforeEach, vi } from "vitest";
import { HomeAssistantClient } from "./client.js";
import type { Config } from "../config.js";

const baseConfig: Config = {
  haUrl: "http://supervisor/core",
  haToken: "test-token",
  haSkipTlsVerify: false,
} as Config;

describe("HomeAssistantClient.getHistory URL encoding", () => {
  let captured: string | undefined;

  beforeEach(() => {
    captured = undefined;
    global.fetch = vi.fn(async (input: unknown) => {
      captured = typeof input === "string" ? input : String(input);
      return new Response(JSON.stringify([[]]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  it("URL-encodes the `+` in `+HH:MM` tz offsets on start_time, end_time, and entity_id", async () => {
    const ha = new HomeAssistantClient(baseConfig);
    await ha.getHistory(
      "sensor.solaredge_current_power",
      "2026-05-11T00:00:00+02:00",
      "2026-05-11T09:46:47+02:00"
    );

    expect(captured).toBeDefined();
    // Raw `+` would be decoded as space by aiohttp on the HA side.
    expect(captured).not.toContain("+02:00");
    // Properly encoded forms.
    expect(captured).toContain("%2B02%3A00");
    expect(captured).toContain("end_time=2026-05-11T09%3A46%3A47%2B02%3A00");
  });

  it("still works for plain `Z` (UTC) timestamps", async () => {
    const ha = new HomeAssistantClient(baseConfig);
    await ha.getHistory(
      "sensor.foo",
      "2026-05-11T00:00:00Z",
      "2026-05-11T09:00:00Z"
    );

    expect(captured).toContain("end_time=2026-05-11T09%3A00%3A00Z");
  });
});

describe("HomeAssistantClient.createAutomation", () => {
  let calls: { url: string; method: string; body?: string }[];
  let postedId: string | undefined;

  beforeEach(() => {
    calls = [];
    postedId = undefined;
    global.fetch = vi.fn(async (input: unknown, init?: unknown) => {
      const url = typeof input === "string" ? input : String(input);
      const opts = (init ?? {}) as { method?: string; body?: string };
      calls.push({ url, method: opts.method ?? "GET", body: opts.body });

      const configMatch = url.match(/\/api\/config\/automation\/config\/(\d+)$/);
      if (configMatch) {
        postedId = configMatch[1];
        return new Response(JSON.stringify({ result: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Service validation: GET /api/services (exact, not the reload service call)
      if (url.endsWith("/api/services")) {
        return new Response(
          JSON.stringify([
            { domain: "light", services: { turn_on: {}, turn_off: {} } },
            { domain: "automation", services: { reload: {}, trigger: {} } },
            { domain: "notify", services: { mobile_app_johns_iphone: {}, persistent_notification: {} } },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      // Read-back: listAutomations() → getEntities("automation") → GET /api/states
      if (url.endsWith("/api/states")) {
        return new Response(
          JSON.stringify([
            {
              entity_id: "automation.kitchen_lights_at_20_00",
              state: "on",
              attributes: { id: postedId, friendly_name: "Nives: Kitchen lights at 20:00" },
              last_changed: "",
              last_updated: "",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      // automation.reload service call (and any other) → empty list
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  it("POSTs the config (normalizing objects to arrays), reloads, and reads back the entity_id", async () => {
    const ha = new HomeAssistantClient(baseConfig);
    const result = await ha.createAutomation({
      alias: "Nives: Kitchen lights at 20:00",
      trigger: { platform: "time", at: "20:00:00" },
      action: { service: "light.turn_on", target: { entity_id: "light.kitchen" } },
    });

    const post = calls.find(
      (c) => /\/api\/config\/automation\/config\/\d+$/.test(c.url) && c.method === "POST"
    );
    expect(post).toBeDefined();
    const sent = JSON.parse(post!.body!);
    expect(Array.isArray(sent.trigger)).toBe(true);
    expect(Array.isArray(sent.action)).toBe(true);
    expect(Array.isArray(sent.condition)).toBe(true); // omitted → []
    expect(sent.alias).toBe("Nives: Kitchen lights at 20:00");
    expect(sent.mode).toBe("single");

    // Reloaded so the entity registers immediately
    expect(
      calls.some((c) => c.url.endsWith("/api/services/automation/reload") && c.method === "POST")
    ).toBe(true);

    // Authoritative entity_id read back from HA
    expect(result.entity_id).toBe("automation.kitchen_lights_at_20_00");
    expect(result.id).toBe(postedId);
  });

  it("throws a friendly error when the config editor is not enabled (404)", async () => {
    global.fetch = vi.fn(
      async () => new Response("404: Not Found", { status: 404 })
    ) as unknown as typeof fetch;

    const ha = new HomeAssistantClient(baseConfig);
    await expect(
      ha.createAutomation({
        alias: "X",
        trigger: { platform: "time", at: "20:00:00" },
        action: { service: "light.turn_on" },
      })
    ).rejects.toThrow(/config editor/i);
  });

  it("rejects (without writing) an action that calls a non-existent service", async () => {
    const ha = new HomeAssistantClient(baseConfig);
    await expect(
      ha.createAutomation({
        alias: "Nives: Notification at noon",
        trigger: { platform: "time", at: "12:00:00" },
        action: { service: "notify.mobile_app_your_phone_name", data: { message: "Noon!" } },
      })
    ).rejects.toThrow(/don't exist/i);

    // Validation runs before the write — no config POST should have happened.
    expect(
      calls.some((c) => /\/api\/config\/automation\/config\//.test(c.url) && c.method === "POST")
    ).toBe(false);
  });
});

describe("HomeAssistantClient.updateAutomation", () => {
  let calls: { url: string; method: string; body?: string }[];

  beforeEach(() => {
    calls = [];
    global.fetch = vi.fn(async (input: unknown, init?: unknown) => {
      const url = typeof input === "string" ? input : String(input);
      const opts = (init ?? {}) as { method?: string; body?: string };
      const method = opts.method ?? "GET";
      calls.push({ url, method, body: opts.body });

      const configMatch = url.match(/\/api\/config\/automation\/config\/(\d+)$/);
      if (configMatch && method === "GET") {
        return new Response(
          JSON.stringify({
            id: configMatch[1],
            alias: "Nives: Living room light off at 23:00",
            mode: "single",
            trigger: [{ platform: "time", at: "23:00:00" }],
            condition: [],
            action: [{ service: "light.turn_off", target: { entity_id: "light.living_room" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (configMatch) {
        return new Response(JSON.stringify({ result: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/services")) {
        return new Response(
          JSON.stringify([
            { domain: "light", services: { turn_on: {}, turn_off: {} } },
            { domain: "automation", services: { reload: {} } },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.endsWith("/api/states")) {
        return new Response(
          JSON.stringify([
            {
              entity_id: "automation.living_room_light_off_at_23_00",
              state: "on",
              attributes: { id: "1700000000000" },
              last_changed: "",
              last_updated: "",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });

  it("reads current config, overlays only changed fields, writes back to the same id", async () => {
    const ha = new HomeAssistantClient(baseConfig);
    const result = await ha.updateAutomation("1700000000000", {
      trigger: { platform: "time", at: "22:00:00" },
    });

    const post = calls.find(
      (c) => /\/api\/config\/automation\/config\/1700000000000$/.test(c.url) && c.method === "POST"
    );
    expect(post).toBeDefined();
    const sent = JSON.parse(post!.body!);
    // Changed field replaced…
    expect(sent.trigger).toEqual([{ platform: "time", at: "22:00:00" }]);
    // …untouched fields preserved from the current config
    expect(sent.alias).toBe("Nives: Living room light off at 23:00");
    expect(sent.action).toEqual([
      { service: "light.turn_off", target: { entity_id: "light.living_room" } },
    ]);
    expect(result.id).toBe("1700000000000");
  });
});
