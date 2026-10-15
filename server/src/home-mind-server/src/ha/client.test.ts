import { describe, it, expect, beforeEach, vi } from "vitest";
import { HomeAssistantClient } from "./client.js";
import { AssistExposure } from "./exposure.js";
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

  it("coerces a malformed action (stray domain + service_data) into a valid HA shape", async () => {
    const ha = new HomeAssistantClient(baseConfig);
    await ha.createAutomation({
      alias: "Nives: Sun Adoration Notification",
      trigger: { platform: "time", at: "12:00:00" },
      action: {
        service: "mobile_app_johns_iphone",
        domain: "notify",
        service_data: { message: "It's time!" },
      },
    });

    const post = calls.find(
      (c) => /\/api\/config\/automation\/config\/\d+$/.test(c.url) && c.method === "POST"
    );
    expect(post).toBeDefined();
    const sent = JSON.parse(post!.body!);
    expect(sent.action).toEqual([
      { service: "notify.mobile_app_johns_iphone", data: { message: "It's time!" } },
    ]);
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

  // Tool calls from one model step run in parallel. Two creates in the same
  // millisecond used to share a Date.now() id, so the second write replaced
  // the first in HA while both calls reported success.
  it("gives each of several parallel creates its own config id", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1790270789751);
    try {
      const ha = new HomeAssistantClient(baseConfig);
      const results = await Promise.all([
        ha.createAutomation({
          alias: "Nives: Bedroom cooling on",
          trigger: { platform: "time", at: "20:00:00" },
          action: { service: "light.turn_on" },
        }),
        ha.createAutomation({
          alias: "Nives: Bedroom cooling off",
          trigger: { platform: "time", at: "22:00:00" },
          action: { service: "light.turn_off" },
        }),
      ]);

      const postedIds = calls
        .filter((c) => c.method === "POST")
        .map((c) => c.url.match(/\/api\/config\/automation\/config\/(\d+)$/)?.[1])
        .filter((id): id is string => id !== undefined);
      expect(postedIds).toHaveLength(2);
      expect(new Set(postedIds).size).toBe(2);
      expect(results[0].id).not.toBe(results[1].id);
    } finally {
      vi.restoreAllMocks();
    }
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
        // HA's config API returns PLURAL keys (triggers/conditions/actions) —
        // the merge must read these to preserve un-changed fields.
        return new Response(
          JSON.stringify({
            id: configMatch[1],
            alias: "Nives: Living room light off at 23:00",
            mode: "single",
            triggers: [{ platform: "time", at: "23:00:00" }],
            conditions: [],
            actions: [{ service: "light.turn_off", target: { entity_id: "light.living_room" } }],
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

describe("HomeAssistantClient.callService and ?return_response", () => {
  // HA 400s a response-only service called WITHOUT ?return_response
  // ("Service call requires responses but caller did not ask for responses")
  // and a no-response service called WITH it ("Service does not support
  // responses"). The catalog at GET /api/services says which is which, so the
  // client decides from that, never from the caller. Issue #64.
  let calls: { url: string; method: string; body?: string }[];
  let catalogStatus: number;

  const catalog = [
    {
      domain: "weather",
      services: { get_forecasts: { response: { optional: false }, fields: { type: {} } } },
    },
    { domain: "light", services: { turn_on: { response: null }, turn_off: {} } },
    { domain: "conversation", services: { process: { response: { optional: true } } } },
  ];

  beforeEach(() => {
    calls = [];
    catalogStatus = 200;
    global.fetch = vi.fn(async (input: unknown, init?: unknown) => {
      const url = typeof input === "string" ? input : String(input);
      const opts = (init ?? {}) as { method?: string; body?: string };
      calls.push({ url, method: opts.method ?? "GET", body: opts.body });
      if (url.endsWith("/api/services")) {
        return new Response(catalogStatus === 200 ? JSON.stringify(catalog) : "nope", {
          status: catalogStatus,
          headers: { "Content-Type": "application/json" },
        });
      }
      const withResponse = url.includes("?return_response");
      return new Response(
        JSON.stringify(
          withResponse
            ? { changed_states: [], service_response: { "weather.forecast_home": { forecast: [] } } }
            : [{ entity_id: "light.kitchen", state: "on", attributes: {} }]
        ),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;
  });

  const posts = () => calls.filter((c) => c.method === "POST");

  it("adds ?return_response for a response-only service and surfaces service_response", async () => {
    const client = new HomeAssistantClient(baseConfig);
    const result = await client.callService("weather", "get_forecasts", "weather.forecast_home", {
      type: "daily",
    });
    expect(posts()).toHaveLength(1);
    expect(posts()[0].url).toMatch(/\/api\/services\/weather\/get_forecasts\?return_response$/);
    expect(JSON.parse(posts()[0].body!)).toEqual({ type: "daily", entity_id: "weather.forecast_home" });
    expect(result).toEqual({
      changed_states: [],
      service_response: { "weather.forecast_home": { forecast: [] } },
    });
  });

  it("adds it for an optional-response service as well", async () => {
    const client = new HomeAssistantClient(baseConfig);
    await client.callService("conversation", "process", undefined, { text: "hi" });
    expect(posts()[0].url).toMatch(/\?return_response$/);
  });

  it("never adds it for a service without a response, even when the caller hints", async () => {
    const client = new HomeAssistantClient(baseConfig);
    const result = await client.callService("light", "turn_on", "light.kitchen", {
      brightness: 255,
      return_response: true,
    });
    expect(posts()[0].url).toMatch(/\/api\/services\/light\/turn_on$/);
    // the hint is not a service field and must not reach HA
    expect(JSON.parse(posts()[0].body!)).toEqual({ brightness: 255, entity_id: "light.kitchen" });
    expect(result).toEqual([{ entity_id: "light.kitchen", state: "on", attributes: {} }]);
  });

  it("leaves it off for a service the catalog does not know, unless hinted", async () => {
    const client = new HomeAssistantClient(baseConfig);
    await client.callService("custom", "do_thing");
    expect(posts()[0].url).toMatch(/\/api\/services\/custom\/do_thing$/);
    await client.callService("custom", "do_thing", undefined, { return_response: true });
    expect(posts()[1].url).toMatch(/\/api\/services\/custom\/do_thing\?return_response$/);
  });

  it("falls back to a plain call when the catalog cannot be fetched", async () => {
    catalogStatus = 500;
    const client = new HomeAssistantClient(baseConfig);
    const result = await client.callService("light", "turn_off", "light.kitchen");
    expect(posts()).toHaveLength(1);
    expect(posts()[0].url).toMatch(/\/api\/services\/light\/turn_off$/);
    expect(Array.isArray(result)).toBe(true);
  });

  it("fetches the catalog once and reuses it across calls", async () => {
    const client = new HomeAssistantClient(baseConfig);
    await client.callService("light", "turn_on", "light.a");
    await client.callService("light", "turn_off", "light.a");
    await client.callService("weather", "get_forecasts", "weather.forecast_home", { type: "daily" });
    expect(calls.filter((c) => c.url.endsWith("/api/services") && c.method === "GET")).toHaveLength(1);
    expect(posts()).toHaveLength(3);
  });
});

describe("HomeAssistantClient.searchEntities accent folding", () => {
  const states = [
    { entity_id: "switch.garaza_vrata", state: "off", attributes: { friendly_name: "Garaza vrata" } },
    { entity_id: "light.kuhinja_luc", state: "on", attributes: { friendly_name: "Kuhinja luč" } },
    { entity_id: "light.dnevna_soba", state: "on", attributes: { friendly_name: "Dnevna soba" } },
    { entity_id: "light.spalnica", state: "on", attributes: { friendly_name: "Spálnica" } },
    { entity_id: "sensor.cas_ura", state: "1", attributes: { friendly_name: "Čas" } },
  ];

  beforeEach(() => {
    global.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(states), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    ) as unknown as typeof fetch;
  });

  const ids = async (query: string) =>
    (await new HomeAssistantClient(baseConfig).searchEntities(query)).map((s) => s.entity_id);

  it("finds an ASCII-slugged entity from an accented query", async () => {
    expect(await ids("garaža")).toEqual(["switch.garaza_vrata"]);
  });

  it("matches an accented name from an unaccented query", async () => {
    expect(await ids("kuhinja luc")).toEqual(["light.kuhinja_luc"]);
    expect(await ids("spalnica")).toEqual(["light.spalnica"]);
  });

  it("matches an accented query against an accented name", async () => {
    expect(await ids("Spálnica")).toEqual(["light.spalnica"]);
    expect(await ids("kuhinja")).toEqual(["light.kuhinja_luc"]);
  });

  it("folds case and accents together (č, š, ž)", async () => {
    expect(await ids("ČAS")).toEqual(["sensor.cas_ura"]);
    expect(await ids("DNEVNA")).toEqual(["light.dnevna_soba"]);
    expect(await ids("sobá")).toEqual(["light.dnevna_soba"]);
  });

  it("does not turn folding into a match-everything", async () => {
    expect(await ids("terasa")).toEqual([]);
  });
});

describe("HomeAssistantClient and the Assist exposure list", () => {
  // Home Assistant's own agent filters every state through async_should_expose
  // before anything sees it, so an unexposed entity does not exist for the
  // assistant: not in the prompt, and not through a tool. Before this the room
  // map honoured the user's choices while the tools went straight to
  // /api/states and could read and drive the whole house.
  const house = [
    { entity_id: "light.kitchen_table", state: "on", attributes: { friendly_name: "Kitchen table" } },
    { entity_id: "light.kitchen_table_1", state: "off", attributes: { friendly_name: "Kitchen table 1" } },
    { entity_id: "light.kitchen_table_2", state: "off", attributes: { friendly_name: "Kitchen table 2" } },
    { entity_id: "sensor.kitchen_presence", state: "on", attributes: { friendly_name: "Kitchen presence" } },
    {
      entity_id: "automation.nives_porch_light_at_sunset",
      state: "on",
      attributes: { id: "1700000000000", friendly_name: "Nives: Porch light at sunset" },
    },
    { entity_id: "lock.front_door", state: "locked", attributes: { friendly_name: "Front door" } },
    { entity_id: "sensor.phone_next_alarm", state: "2026-10-16T06:30:00+00:00", attributes: {} },
    { entity_id: "script.garage_door", state: "off", attributes: { friendly_name: "Garage door" } },
    { entity_id: "person.resident", state: "home", attributes: { friendly_name: "Resident" } },
    { entity_id: "zone.home", state: "1", attributes: { friendly_name: "Home" } },
    { entity_id: "tts.nives_text_to_speech", state: "unknown", attributes: { friendly_name: "Nives Text-to-speech" } },
    { entity_id: "media_player.living_room_speaker", state: "idle", attributes: { friendly_name: "Living room speaker" } },
    { entity_id: "media_player.bedroom_speaker", state: "idle", attributes: { friendly_name: "Bedroom speaker" } },
  ];

  // Enough of the services catalog for automation writes to pass their own
  // check that every service they call exists.
  const services = [
    { domain: "light", services: { turn_on: {}, turn_off: {} } },
    { domain: "lock", services: { unlock: {} } },
    { domain: "scene", services: { apply: {}, create: {} } },
    { domain: "group", services: { set: {} } },
    { domain: "automation", services: { reload: {} } },
  ];

  let calls: string[];
  /** What GET /api/config/automation/config/<id> returns: the automation being updated. */
  let storedAutomation: Record<string, unknown>;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  beforeEach(() => {
    calls = [];
    storedAutomation = {};
    global.fetch = vi.fn(async (input: unknown) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push(url);
      if (url.includes("/api/config/automation/config/")) return json(storedAutomation);
      if (url.endsWith("/api/services")) return json(services);
      if (url.includes("/api/services")) return json([]);
      if (url.includes("/api/history/period")) return json([[]]);
      if (url.endsWith("/api/states")) return json(house);
      const id = url.split("/api/states/")[1];
      const state = house.find((s) => s.entity_id === id);
      return json(state ?? { message: "Entity not found." }, state ? 200 : 404);
    }) as unknown as typeof fetch;
  });

  const exposing = (...ids: string[]) => new AssistExposure(async () => new Set(ids));
  const posted = (service: string) => calls.some((u) => u.includes(`/api/services/${service}`));
  const wroteAutomation = () => calls.some((u) => u.includes("/api/config/automation/config/"));

  describe("reads", () => {
    it("search_entities returns only what the user exposed", async () => {
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      const found = await client.searchEntities("kitchen");
      expect(found.map((s) => s.entity_id)).toEqual(["light.kitchen_table"]);
    });

    it("get_entities returns only what the user exposed, plus the voice engines", async () => {
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      expect((await client.getEntities()).map((s) => s.entity_id)).toEqual([
        "light.kitchen_table",
        "tts.nives_text_to_speech",
      ]);
      expect((await client.getEntities("light")).map((s) => s.entity_id)).toEqual([
        "light.kitchen_table",
      ]);
      expect(await client.getEntities("sensor")).toEqual([]);
    });

    it("get_state refuses an entity that exists but is not exposed, without asking HA", async () => {
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      await expect(client.getState("light.kitchen_table_1")).rejects.toThrow(/not available to you/);
      expect(calls).toEqual([]);
    });

    it("get_state refuses even when the entity is already in the state cache", async () => {
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      await client.getEntities(); // fills the cache with every state, exposed or not
      await expect(client.getState("sensor.kitchen_presence")).rejects.toThrow(
        /not available to you/
      );
    });

    it("get_history refuses an unexposed entity, without asking HA", async () => {
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      await expect(client.getHistory("sensor.kitchen_presence")).rejects.toThrow(
        /not available to you/
      );
      expect(calls.some((u) => u.includes("/api/history"))).toBe(false);
    });

    it("get_history refuses a comma-joined id that would smuggle an unexposed entity", async () => {
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      await expect(
        client.getHistory("light.kitchen_table,sensor.kitchen_presence")
      ).rejects.toThrow(/not available to you/);
      expect(calls.some((u) => u.includes("/api/history"))).toBe(false);
    });

    it("lets an exposed entity through untouched", async () => {
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      expect((await client.getState("light.kitchen_table")).state).toBe("on");
      await client.getHistory("light.kitchen_table");
      expect(calls.some((u) => u.includes("/api/history"))).toBe(true);
    });
  });

  describe("call_service", () => {
    it("refuses to drive an unexposed entity, before the request leaves", async () => {
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      await expect(
        client.callService("light", "turn_on", "light.kitchen_table_1")
      ).rejects.toThrow(/light\.kitchen_table_1 is not available to you/);
      expect(posted("light/turn_on")).toBe(false);
    });

    it("drives an exposed entity", async () => {
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      await client.callService("light", "turn_on", "light.kitchen_table");
      expect(posted("light/turn_on")).toBe(true);
    });

    it("checks entity_id handed in through data, and every id in a list", async () => {
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      await expect(
        client.callService("light", "turn_on", undefined, { entity_id: "light.kitchen_table_2" })
      ).rejects.toThrow(/not available to you/);
      await expect(
        client.callService("light", "turn_on", undefined, {
          entity_id: ["light.kitchen_table", "light.kitchen_table_2"],
        })
      ).rejects.toThrow(/kitchen_table_2/);
      expect(posted("light/turn_on")).toBe(false);
    });

    it("splits a comma-separated entity_id", async () => {
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      await expect(
        client.callService("light", "turn_on", "light.kitchen_table, light.kitchen_table_2")
      ).rejects.toThrow(/kitchen_table_2/);
      await expect(
        client.callService("light", "turn_on", undefined, {
          entity_id: "light.kitchen_table,light.kitchen_table_1",
        })
      ).rejects.toThrow(/kitchen_table_1/);
      expect(posted("light/turn_on")).toBe(false);
    });

    it("checks the entity_id of a nested target", async () => {
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      await expect(
        client.callService("light", "turn_off", undefined, {
          target: { entity_id: ["light.kitchen_table", "light.kitchen_table_2"] },
        })
      ).rejects.toThrow(/kitchen_table_2/);
      expect(posted("light/turn_off")).toBe(false);
    });

    it("refuses entity_id all, named or in data, with its own message", async () => {
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      await expect(client.callService("light", "turn_off", "all")).rejects.toThrow(
        /entity_id "all" is not available/
      );
      await expect(
        client.callService("light", "turn_off", undefined, { target: { entity_id: "all" } })
      ).rejects.toThrow(/entity_id "all" is not available/);
      expect(posted("light/turn_off")).toBe(false);
    });

    it.each(["area_id", "device_id", "floor_id", "label_id"])(
      "refuses a %s target, top-level or nested, and asks for entity ids",
      async (key) => {
        const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
        await expect(
          client.callService("light", "turn_off", undefined, { [key]: "kitchen" })
        ).rejects.toThrow(new RegExp(`${key} is not available.*exposed entity_ids`));
        await expect(
          client.callService("light", "turn_off", undefined, { target: { [key]: ["kitchen"] } })
        ).rejects.toThrow(new RegExp(`${key} is not available`));
        expect(posted("light/turn_off")).toBe(false);
      }
    );

    it("passes indirect targets when the list has no opinion", async () => {
      const client = new HomeAssistantClient(baseConfig, new AssistExposure(async () => null));
      await client.callService("light", "turn_off", undefined, { area_id: "kitchen" });
      await client.callService("light", "turn_on", undefined, { target: { label_id: "evening" } });
      expect(posted("light/turn_off")).toBe(true);
      expect(posted("light/turn_on")).toBe(true);
    });

    it("passes indirect targets when the user exposed nothing", async () => {
      const client = new HomeAssistantClient(baseConfig, new AssistExposure(async () => new Set()));
      await client.callService("light", "turn_off", undefined, { area_id: "kitchen" });
      expect(posted("light/turn_off")).toBe(true);
    });

    it("needs script.<name> exposed to run it; lifecycle services check their target", async () => {
      const client = new HomeAssistantClient(
        baseConfig,
        exposing("light.kitchen_table", "script.good_night")
      );
      await expect(client.callService("script", "garage_door")).rejects.toThrow(
        /script\.garage_door is not available/
      );
      await client.callService("script", "good_night");
      await expect(
        client.callService("script", "turn_on", "script.garage_door")
      ).rejects.toThrow(/script\.garage_door is not available/);
      await client.callService("script", "turn_on", "script.good_night");
      expect(posted("script/garage_door")).toBe(false);
      expect(posted("script/good_night")).toBe(true);
      expect(posted("script/turn_on")).toBe(true);
    });

    it("checks the entity maps and lists that scenes and groups take", async () => {
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      await expect(
        client.callService("scene", "apply", undefined, {
          entities: { "light.kitchen_table": "on", "lock.front_door": "unlocked" },
        })
      ).rejects.toThrow(/lock\.front_door is not available/);
      await expect(
        client.callService("scene", "create", undefined, {
          scene_id: "before",
          snapshot_entities: ["sensor.kitchen_presence"],
        })
      ).rejects.toThrow(/sensor\.kitchen_presence is not available/);
      await expect(
        client.callService("group", "set", undefined, {
          object_id: "evening",
          add_entities: ["light.kitchen_table", "light.kitchen_table_2"],
        })
      ).rejects.toThrow(/kitchen_table_2 is not available/);
      // Home Assistant lower-cases entity ids, so a capitalised one must not slip past.
      await expect(
        client.callService("scene", "apply", undefined, { entities: { "Lock.Front_Door": "unlocked" } })
      ).rejects.toThrow(/lock\.front_door is not available/);
      expect(posted("scene/")).toBe(false);
      expect(posted("group/set")).toBe(false);

      await client.callService("scene", "apply", undefined, {
        entities: { "light.kitchen_table": { state: "on", brightness: 120 } },
      });
      expect(posted("scene/apply")).toBe(true);
    });

    it("announces with any voice engine, but only on an exposed speaker", async () => {
      const client = new HomeAssistantClient(
        baseConfig,
        exposing("light.kitchen_table", "media_player.living_room_speaker")
      );
      expect((await client.searchEntities("text-to-speech")).map((s) => s.entity_id)).toEqual([
        "tts.nives_text_to_speech",
      ]);
      await client.callService("tts", "speak", undefined, {
        entity_id: "tts.nives_text_to_speech",
        media_player_entity_id: "media_player.living_room_speaker",
        message: "Dober dan",
      });
      expect(posted("tts/speak")).toBe(true);
      calls = [];

      await expect(
        client.callService("tts", "speak", undefined, {
          entity_id: "tts.nives_text_to_speech",
          media_player_entity_id: "media_player.bedroom_speaker",
          message: "Dober dan",
        })
      ).rejects.toThrow(/media_player\.bedroom_speaker is not available/);
      await expect(
        client.callService("media_player", "join", "media_player.living_room_speaker", {
          group_members: ["media_player.bedroom_speaker"],
        })
      ).rejects.toThrow(/media_player\.bedroom_speaker is not available/);
      expect(posted("tts/speak")).toBe(false);
      expect(posted("media_player/join")).toBe(false);
    });

    it("passes a call with no target at all", async () => {
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      await client.callService("notify", "notify", undefined, { message: "hi" });
      // The balance heads-up raises and clears its own notification this way.
      await client.callService("persistent_notification", "create", undefined, {
        notification_id: "nives_balance_low",
        title: "Nives",
        message: "Balance is low",
      });
      expect(posted("notify/notify")).toBe(true);
      expect(posted("persistent_notification/create")).toBe(true);
    });
  });

  describe("automations", () => {
    const at7 = { platform: "time", at: "07:00:00" };
    const kitchenOn = { service: "light.turn_on", target: { entity_id: "light.kitchen_table" } };
    const unlock = { service: "lock.unlock", target: { entity_id: "lock.front_door" } };

    it("list_automations still sees automations the user never exposed", async () => {
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      expect((await client.listAutomations()).map((s) => s.entity_id)).toEqual([
        "automation.nives_porch_light_at_sunset",
      ]);
      // while get_entities, which the model reads directly, does not
      expect(await client.getEntities("automation")).toEqual([]);
    });

    it("the reload after a write is not refused", async () => {
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      await client.callService("automation", "reload");
      expect(posted("automation/reload")).toBe(true);
    });

    it("writes an automation that names only exposed entities", async () => {
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      await client.createAutomation({ alias: "Kitchen at 7", trigger: at7, action: kitchenOn });
      expect(wroteAutomation()).toBe(true);
    });

    it("refuses an action on an unexposed entity before anything is written", async () => {
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      await expect(
        client.createAutomation({ alias: "Unlock at 7", trigger: at7, action: [kitchenOn, unlock] })
      ).rejects.toThrow(/lock\.front_door is not available to you/);
      expect(wroteAutomation()).toBe(false);
    });

    it("refuses a trigger or condition that watches an unexposed entity", async () => {
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      await expect(
        client.requireExposedAutomation({
          trigger: { platform: "state", entity_id: "sensor.kitchen_presence", to: "on" },
          action: kitchenOn,
        })
      ).rejects.toThrow(/sensor\.kitchen_presence is not available/);
      await expect(
        client.requireExposedAutomation({
          trigger: at7,
          condition: { condition: "state", entity_id: ["lock.front_door"], state: "locked" },
          action: kitchenOn,
        })
      ).rejects.toThrow(/lock\.front_door is not available/);
    });

    it("checks a scene's entity map inside an action", async () => {
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      await expect(
        client.requireExposedAutomation({
          trigger: at7,
          action: { service: "scene.apply", data: { entities: { "lock.front_door": "unlocked" } } },
        })
      ).rejects.toThrow(/lock\.front_door is not available/);
    });

    it.each([
      ["area_id", { service: "light.turn_on", target: { area_id: "kitchen" } }],
      ["device_id", { device_id: "abc123", domain: "lock", type: "unlock" }],
      ["label_id", { service: "light.turn_off", data: { label_id: ["evening"] } }],
    ])("refuses a %s selector, which cannot be vetted", async (key, action) => {
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      await expect(client.requireExposedAutomation({ trigger: at7, action })).rejects.toThrow(
        new RegExp(`Selecting by ${key} is not available.*exposed entity_ids`)
      );
    });

    it("refuses a templated entity_id, and entity_id all", async () => {
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      await expect(
        client.requireExposedAutomation({
          trigger: at7,
          action: { service: "light.turn_off", target: { entity_id: "{{ trigger.entity_id }}" } },
        })
      ).rejects.toThrow(/templated entity_id "\{\{ trigger.entity_id \}\}" is not available/);
      await expect(
        client.requireExposedAutomation({
          trigger: at7,
          action: { service: "light.turn_off", target: { entity_id: "all" } },
        })
      ).rejects.toThrow(/entity_id "all" is not available/);
    });

    it("checks entity ids named in templates, times and script calls when they exist", async () => {
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      await expect(
        client.requireExposedAutomation({
          trigger: at7,
          condition: { condition: "template", value_template: "{{ is_state('lock.front_door', 'locked') }}" },
          action: kitchenOn,
        })
      ).rejects.toThrow(/lock\.front_door is not available/);
      await expect(
        client.requireExposedAutomation({
          trigger: at7,
          condition: { condition: "template", value_template: "{{ states.sensor.kitchen_presence.state == 'on' }}" },
          action: kitchenOn,
        })
      ).rejects.toThrow(/sensor\.kitchen_presence is not available/);
      await expect(
        client.requireExposedAutomation({
          trigger: { platform: "time", at: "sensor.phone_next_alarm" },
          action: kitchenOn,
        })
      ).rejects.toThrow(/sensor\.phone_next_alarm is not available/);
      await expect(
        client.requireExposedAutomation({ trigger: at7, action: { action: "script.garage_door" } })
      ).rejects.toThrow(/script\.garage_door is not available/);
    });

    it("checks capitalised ids the way Home Assistant reads them, lower-cased", async () => {
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      await expect(
        client.requireExposedAutomation({
          trigger: at7,
          condition: { condition: "template", value_template: "{{ is_state('Lock.Front_Door', 'locked') }}" },
          action: kitchenOn,
        })
      ).rejects.toThrow(/lock\.front_door is not available/);
      await expect(
        client.requireExposedAutomation({
          trigger: { platform: "time", at: "Sensor.Phone_Next_Alarm" },
          action: kitchenOn,
        })
      ).rejects.toThrow(/sensor\.phone_next_alarm is not available/);
      // and an exposed entity written with capitals is still the exposed entity
      await client.requireExposedAutomation({
        trigger: at7,
        action: { service: "light.turn_on", target: { entity_id: "Light.Kitchen_Table" } },
      });
    });

    it("an announcement may use any voice engine, but only an exposed speaker", async () => {
      const client = new HomeAssistantClient(
        baseConfig,
        exposing("light.kitchen_table", "media_player.living_room_speaker")
      );
      const announce = (speaker: string) => ({
        action: "tts.speak",
        target: { entity_id: "tts.nives_text_to_speech" },
        data: { media_player_entity_id: speaker, message: "Dobro jutro" },
      });
      await client.requireExposedAutomation({ trigger: at7, action: announce("media_player.living_room_speaker") });
      await expect(
        client.requireExposedAutomation({ trigger: at7, action: announce("media_player.bedroom_speaker") })
      ).rejects.toThrow(/media_player\.bedroom_speaker is not available/);
    });

    it("lets through words that only look like entities, and zones", async () => {
      const client = new HomeAssistantClient(
        baseConfig,
        exposing("light.kitchen_table", "person.resident")
      );
      await client.requireExposedAutomation({
        trigger: { platform: "zone", entity_id: "person.resident", zone: "zone.home", event: "leave" },
        condition: { condition: "template", value_template: "{{ trigger.to_state.state != 'home' }}" },
        action: { action: "light.turn_off", target: { entity_id: "light.kitchen_table" } },
      });
    });

    it("an update may keep what the user's automation already names in that section", async () => {
      // Written by hand in Home Assistant: watches a sensor the user never exposed.
      storedAutomation = {
        id: "1700000000000",
        alias: "Kitchen presence",
        triggers: [{ trigger: "state", entity_id: "sensor.kitchen_presence", to: "on" }],
        actions: [kitchenOn],
      };
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      await client.updateAutomation("1700000000000", {
        trigger: [{ platform: "state", entity_id: "sensor.kitchen_presence", to: "on", for: "00:01:00" }],
      });
      expect(wroteAutomation()).toBe(true);
    });

    it("an update cannot move a watched entity into an action that drives it", async () => {
      storedAutomation = {
        id: "1700000000000",
        alias: "Door locked",
        triggers: [{ trigger: "state", entity_id: "lock.front_door", to: "locked" }],
        actions: [kitchenOn],
      };
      const client = new HomeAssistantClient(baseConfig, exposing("light.kitchen_table"));
      await expect(
        client.updateAutomation("1700000000000", { action: [kitchenOn, unlock] })
      ).rejects.toThrow(/lock\.front_door is not available/);
      expect(calls.filter((u) => u.includes("/api/config/automation/config/"))).toHaveLength(1); // the read
    });

    it("is unbounded when the list has no opinion", async () => {
      const client = new HomeAssistantClient(baseConfig, new AssistExposure(async () => null));
      await client.createAutomation({ alias: "Unlock at 7", trigger: at7, action: unlock });
      expect(wroteAutomation()).toBe(true);
    });
  });

  describe("without an opinionated list", () => {
    it("without an exposure list the client behaves exactly as before", async () => {
      const client = new HomeAssistantClient(baseConfig);
      expect((await client.searchEntities("kitchen")).map((s) => s.entity_id)).toEqual(
        house.filter((s) => s.entity_id.includes("kitchen")).map((s) => s.entity_id)
      );
      expect(await client.getEntities()).toHaveLength(house.length);
      await client.callService("light", "turn_on", "light.kitchen_table_1");
      await client.callService("light", "turn_off", undefined, { area_id: "kitchen" });
      expect(posted("light/turn_on")).toBe(true);
      expect(posted("light/turn_off")).toBe(true);
    });

    it("a list that cannot be read means no opinion, not a house with no devices", async () => {
      const client = new HomeAssistantClient(baseConfig, new AssistExposure(async () => null));
      expect(await client.getEntities()).toHaveLength(house.length);
      expect((await client.getState("sensor.kitchen_presence")).state).toBe("on");
      await client.getHistory("sensor.kitchen_presence");
      await client.callService("light", "turn_on", "light.kitchen_table_1");
      expect(posted("light/turn_on")).toBe(true);
    });
  });
});
