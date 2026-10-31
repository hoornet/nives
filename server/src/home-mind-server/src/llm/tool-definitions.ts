import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "get_state",
    description:
      "Get the current state of a Home Assistant entity (sensor, light, switch, etc.)",
    parameters: {
      type: "object",
      properties: {
        entity_id: {
          type: "string",
          description:
            "The entity ID to get state for (e.g., sensor.temperature, light.living_room)",
        },
      },
      required: ["entity_id"],
    },
  },
  {
    name: "get_entities",
    description:
      "List the Home Assistant entities available to you, optionally filtered by domain (light, sensor, switch, etc.). Entities the user has not exposed to the assistant are not listed and cannot be used.",
    parameters: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description:
            "Optional domain to filter by (e.g., 'light', 'sensor', 'switch')",
        },
      },
      required: [],
    },
  },
  {
    name: "search_entities",
    description:
      "Search for Home Assistant entities by name or ID substring. Returns entity IDs, states, and attributes. Use this to find the correct entity_id before calling call_service.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to match against entity IDs and names",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "call_service",
    description:
      "Call a Home Assistant service to control devices (turn on/off lights, set thermostat, etc.). " +
      "Services that return data (weather.get_forecasts, calendar.get_events, todo.get_items, ...) " +
      "work too: their result comes back in `service_response`, with no extra flag needed. " +
      "FORECASTS: weather entities do NOT carry a forecast in their attributes. For tomorrow's " +
      "weather, rain, or any forecast, call weather.get_forecasts with entity_id set to the weather " +
      "entity and data {\"type\": \"daily\"} (or \"hourly\"), then read service_response.",
    parameters: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "Service domain (e.g., 'light', 'switch', 'climate')",
        },
        service: {
          type: "string",
          description:
            "Service name (e.g., 'turn_on', 'turn_off', 'toggle'). For lights: use 'turn_on' with data to set brightness/color — there is no separate 'set_color' service.",
        },
        entity_id: {
          type: "string",
          description: "Optional entity ID to target",
        },
        data: {
          type: "object",
          description:
            "Optional service data. Common fields for light.turn_on: brightness (0-255), rgb_color ([R,G,B] each 0-255), color_temp_kelvin (2000-6500, e.g. 2700=warm white, 4000=neutral, 6500=daylight), hs_color ([hue 0-360, saturation 0-100]), rgbw_color ([R,G,B,W] each 0-255, for RGBW strips). WHITE LIGHT — check supported_color_modes first: if 'rgbw' use rgbw_color [0,0,0,255]; if only 'color_temp' use color_temp_kelvin; if 'xy'/'hs'/'rgb' (RGB-only lights) use rgb_color [255,255,255]. Do NOT invent fields like 'white' or 'color'.",
        },
      },
      required: ["domain", "service"],
    },
  },
  {
    name: "get_history",
    description:
      "Historical states for one entity, for trend analysis. ALWAYS check the " +
      "`kind` field before reading the result, which is one of exactly three shapes. " +
      'kind="raw": `points` holds every reading as {state, last_changed}. ' +
      'kind="numeric": `buckets` holds {t, n, min, max, mean} per interval, where ' +
      "`t` is the start of the interval, `bucket_minutes` is its length, and `n` is " +
      "how many readings fell in it. A short spike appears as a high `max` in one " +
      "bucket while `mean` stays near normal. " +
      'kind="state": `buckets` holds {t, n, state, changes}, where `state` is the ' +
      "value held for most of the interval and `changes` counts transitions within it. " +
      "Long ranges are ALWAYS returned as buckets and the individual readings are NOT " +
      "available for them. To examine something more closely, call again with a " +
      "narrower start_time and end_time, which yields smaller buckets or raw readings.",
    parameters: {
      type: "object",
      properties: {
        entity_id: {
          type: "string",
          description: "The entity ID to get history for",
        },
        start_time: {
          type: "string",
          description:
            "Start time in ISO 8601 format with timezone (e.g., '2026-01-15T20:00:00Z'). Use the ISO Timestamp from system context for calculations. Default: 24 hours ago.",
        },
        end_time: {
          type: "string",
          description:
            "End time in ISO 8601 format with timezone (e.g., '2026-01-15T21:00:00Z'). Use the ISO Timestamp from system context for calculations. Default: now.",
        },
      },
      required: ["entity_id"],
    },
  },
  {
    name: "create_automation",
    description:
      "Create a new Home Assistant automation (a scheduled or event-triggered routine, e.g. 'turn the porch light on at sunset every day'). Call this AS SOON AS you have the details — do NOT ask the user for permission first. The FIRST call NEVER creates anything: it returns a 'confirmation_required' preview, and relaying that preview in plain language IS how you ask. Only after the user agrees in their NEXT message do you call this again with the same arguments to actually create it. Asking in text before the first call just makes the user confirm twice. The automation is created ENABLED and its alias is automatically prefixed with 'Nives: ' so the user can find and remove it in Settings → Automations. Provide trigger and action using Home Assistant's automation schema (the same shape as automations.yaml).",
    parameters: {
      type: "object",
      properties: {
        alias: {
          type: "string",
          description:
            "Human-readable name for the automation (e.g. 'Porch light at sunset'). A 'Nives: ' prefix is added automatically — do not include it yourself.",
        },
        trigger: {
          type: "array",
          items: { type: "object" },
          description:
            "The trigger that starts the automation, as an array of HA trigger objects. Examples: time → {\"platform\":\"time\",\"at\":\"23:00:00\"}; sun → {\"platform\":\"sun\",\"event\":\"sunset\",\"offset\":\"-00:15:00\"}; state → {\"platform\":\"state\",\"entity_id\":\"binary_sensor.front_door\",\"to\":\"on\"}; numeric → {\"platform\":\"numeric_state\",\"entity_id\":\"sensor.temperature\",\"above\":25}. A time trigger's \"at\" is a time of day ONLY (HH:MM:SS), never a date; for a one-off on a particular day keep \"at\" as the time and add a template condition on the date, e.g. {\"condition\":\"template\",\"value_template\":\"{{ now().strftime('%Y-%m-%d') == '2026-09-05' }}\"}.",
        },
        condition: {
          type: "array",
          items: { type: "object" },
          description:
            "Optional condition(s) that must be true for the action to run, as an array of HA condition objects. Omit if there are no conditions.",
        },
        action: {
          type: "array",
          items: { type: "object" },
          description:
            "The action(s) to perform. Each action MUST be shaped exactly as {\"service\": \"<domain>.<name>\", \"data\": {...}} with an optional \"target\": {\"entity_id\": \"...\"}. Example (light): {\"service\":\"light.turn_off\",\"target\":{\"entity_id\":\"light.porch\"}}. Example (phone notification): {\"service\":\"notify.mobile_app_<device>\",\"data\":{\"message\":\"...\"}}. The service id MUST include its domain prefix (e.g. \"notify.mobile_app_sm_a366b\" — get it from list_services). Do NOT add a separate \"domain\" key, and do NOT use \"service_data\" (use \"data\").",
        },
        mode: {
          type: "string",
          description:
            "Optional run mode: 'single' (default), 'restart', 'queued', or 'parallel'. Omit unless the user needs specific concurrency behavior.",
        },
      },
      required: ["alias", "trigger", "action"],
    },
  },
  {
    name: "list_automations",
    description:
      "List the Home Assistant automations (entity_id, name, and on/off enabled state). Automations Nives created are named with a 'Nives: ' prefix. Use this to answer 'what automations do I have / did you make', or to find an automation's entity_id before deleting it. Names only: to see what an automation does, use get_automation.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_automation",
    description:
      "Read one automation: its name, run mode, trigger, condition and action, in the shape update_automation takes. Read-only, no confirmation needed. Use this to answer 'what does this automation do', and ALWAYS before passing a trigger, condition or action to update_automation: whatever you pass replaces that whole field, so start from what is stored and keep everything the user did not ask to change. A field listed under 'hidden' names devices the user has not exposed: you can't read or replace it. An automation built from a blueprint shows only the blueprint, and can't be changed here.",
    parameters: {
      type: "object",
      properties: {
        entity_id: {
          type: "string",
          description:
            "The automation entity_id to read (e.g. 'automation.living_room_light_off_at_23_00'). Obtain it from list_automations.",
        },
      },
      required: ["entity_id"],
    },
  },
  {
    name: "delete_automation",
    description:
      "Delete a Home Assistant automation by its entity_id (get the entity_id from list_automations first). Call this AS SOON AS you know which automation is meant — do NOT ask the user for permission first. The FIRST call NEVER deletes anything: it returns a 'confirmation_required' preview naming the automation, and relaying that IS how you ask. Only after the user agrees in their NEXT message do you call this again with the same entity_id to actually delete it. Asking in text before the first call just makes the user confirm twice. Deletion is permanent.",
    parameters: {
      type: "object",
      properties: {
        entity_id: {
          type: "string",
          description:
            "The automation entity_id to delete (e.g. 'automation.living_room_light_off_at_23_00'). Obtain it from list_automations.",
        },
      },
      required: ["entity_id"],
    },
  },
  {
    name: "update_automation",
    description:
      "Modify an existing automation — change its trigger, action, name, conditions, or mode. Get the entity_id from list_automations first. Provide ONLY the fields you want to change; everything else is kept as-is. Call this AS SOON AS you know what to change — do NOT ask the user for permission first. The FIRST call NEVER changes anything: it returns a 'confirmation_required' preview of the change, and relaying that IS how you ask. Only after the user agrees in their NEXT message do you call this again with the same arguments to apply it. Asking in text before the first call just makes the user confirm twice. (There is no in-place partial edit of a trigger/action — whatever you pass for a field fully replaces that field, so read it with get_automation first and keep what the user did not ask to change.)",
    parameters: {
      type: "object",
      properties: {
        entity_id: {
          type: "string",
          description:
            "The automation entity_id to modify (e.g. 'automation.living_room_light_off_at_23_00'). Obtain it from list_automations.",
        },
        alias: {
          type: "string",
          description:
            "Optional new name. A 'Nives: ' prefix is kept/added automatically — do not include it.",
        },
        trigger: {
          type: "array",
          items: { type: "object" },
          description:
            "Optional replacement trigger (array of HA trigger objects). Replaces the existing trigger entirely. Omit to keep the current trigger.",
        },
        condition: {
          type: "array",
          items: { type: "object" },
          description:
            "Optional replacement condition(s) (array of HA condition objects). Replaces existing conditions. Omit to keep current.",
        },
        action: {
          type: "array",
          items: { type: "object" },
          description:
            "Optional replacement action(s). Replaces the existing action entirely. Each action MUST be shaped {\"service\": \"<domain>.<name>\", \"data\": {...}} with optional \"target\": {\"entity_id\": \"...\"} — full service id with its domain (from list_services), NO separate \"domain\" key, and use \"data\" not \"service_data\". Omit to keep the current action.",
        },
        mode: {
          type: "string",
          description: "Optional new run mode: 'single', 'restart', 'queued', or 'parallel'.",
        },
      },
      required: ["entity_id"],
    },
  },
  {
    name: "list_services",
    description:
      "List the Home Assistant services (actions) that actually exist, as a map of domain → service names. Optionally filter by domain (e.g. 'notify', 'light'). ALWAYS use this to find the real service id before putting a service into an automation action — especially notify services, which are device-specific (e.g. 'notify.mobile_app_johns_iphone'). NEVER guess or invent service names like 'notify.mobile_app_your_phone'.",
    parameters: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description:
            "Optional domain to filter by (e.g. 'notify', 'light', 'script', 'climate'). Omit to list every domain.",
        },
      },
      required: [],
    },
  },
  {
    name: "forget_memory",
    description:
      "Permanently forget ONE stored memory about the user. Use when the user asks you to forget, delete, or stop remembering a specific thing ('forget that…', 'delete the memory that…', 'that's no longer true'). Set 'query' to the EXACT text of the remembered fact as it appears in 'What You Remember About This User' — copied verbatim, never paraphrased and never translated. The FIRST call NEVER deletes anything: it returns a 'confirmation_required' preview quoting the memory, and relaying that preview IS how you ask the user. Only after the user agrees in their NEXT message do you call this again with the same query to actually forget it. One specific memory per call — NEVER loop it to wipe memories the user did not name. NOT for Home Assistant automations or devices (use delete_automation for those). 'Don't forget to X' is a request to REMEMBER or remind, never a reason to call this tool. Deletion is permanent.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The exact text of the remembered fact to forget, copied verbatim from 'What You Remember About This User' (or from a candidate returned by an earlier call).",
        },
      },
      required: ["query"],
    },
  },
];

export function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: "object" as const,
      properties: t.parameters.properties,
      required: t.parameters.required,
    },
  }));
}

export function toOpenAITools(
  tools: ToolDefinition[]
): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
