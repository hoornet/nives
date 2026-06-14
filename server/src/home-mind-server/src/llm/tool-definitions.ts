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
      "List all Home Assistant entities, optionally filtered by domain (light, sensor, switch, etc.)",
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
      "Call a Home Assistant service to control devices (turn on/off lights, set thermostat, etc.)",
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
      "Get historical states for an entity over time (for trend analysis)",
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
      "Create a new Home Assistant automation (a scheduled or event-triggered routine, e.g. 'turn the porch light on at sunset every day'). ONLY call this AFTER the user has explicitly confirmed they want it created — first restate the trigger and action in plain language and ask. The automation is created ENABLED and its alias is automatically prefixed with 'Nives: ' so the user can find and remove it in Settings → Automations. Provide trigger and action using Home Assistant's automation schema (the same shape as automations.yaml).",
    parameters: {
      type: "object",
      properties: {
        alias: {
          type: "string",
          description:
            "Human-readable name for the automation (e.g. 'Porch light at sunset'). A 'Nives: ' prefix is added automatically — do not include it yourself.",
        },
        trigger: {
          type: "object",
          description:
            "The trigger that starts the automation, as an HA trigger object or array of objects. Examples: time → {\"platform\":\"time\",\"at\":\"23:00:00\"}; sun → {\"platform\":\"sun\",\"event\":\"sunset\",\"offset\":\"-00:15:00\"}; state → {\"platform\":\"state\",\"entity_id\":\"binary_sensor.front_door\",\"to\":\"on\"}; numeric → {\"platform\":\"numeric_state\",\"entity_id\":\"sensor.temperature\",\"above\":25}.",
        },
        condition: {
          type: "object",
          description:
            "Optional condition(s) that must be true for the action to run, as an HA condition object or array. Omit if there are no conditions.",
        },
        action: {
          type: "object",
          description:
            "The action(s) to perform, as an HA action object or array. Example: {\"service\":\"light.turn_off\",\"target\":{\"entity_id\":\"light.porch\"}}. Use search_entities first to confirm the correct entity_id.",
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
      "List the Home Assistant automations (entity_id, name, and on/off enabled state). Automations Nives created are named with a 'Nives: ' prefix. Use this to answer 'what automations do I have / did you make', or to find an automation's entity_id before deleting it.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "delete_automation",
    description:
      "Delete a Home Assistant automation by its entity_id (get the entity_id from list_automations first). ONLY call this AFTER the user has explicitly confirmed the deletion — first name the automation you're about to remove and ask. Deletion is permanent.",
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
