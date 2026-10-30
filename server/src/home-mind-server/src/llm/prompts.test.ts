import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt, buildSystemPromptText } from "./prompts.js";

type TextBlock = Anthropic.TextBlockParam;

describe("buildSystemPrompt (Anthropic)", () => {
  it("returns 2 blocks with default identity when no custom prompt", () => {
    const blocks = buildSystemPrompt(["fact1"]) as TextBlock[];

    expect(blocks).toHaveLength(2);
    // Static block: default identity + instructions, cached
    expect(blocks[0]).toMatchObject({
      type: "text",
      cache_control: { type: "ephemeral" },
    });
    expect(blocks[0].text).toContain("You are Nives, a helpful smart home assistant");
    expect(blocks[0].text).toContain("## WHEN TO USE TOOLS");
    // Dynamic block has no cache_control
    expect(blocks[1]).toMatchObject({ type: "text" });
    expect(blocks[1]).not.toHaveProperty("cache_control");
    expect(blocks[1].text).toContain("fact1");
  });

  it("replaces default identity with custom prompt", () => {
    const blocks = buildSystemPrompt(["fact1"], false, "You are Ava.") as TextBlock[];

    expect(blocks).toHaveLength(2);
    // Custom prompt is the identity, followed by instructions
    expect(blocks[0].text).toMatch(/^You are Ava\./);
    expect(blocks[0].text).toContain("## WHEN TO USE TOOLS");
    expect(blocks[0].text).not.toContain("You are Nives, a helpful smart home assistant");
    expect(blocks[0]).toHaveProperty("cache_control", { type: "ephemeral" });
    // Dynamic block
    expect(blocks[1].text).toContain("fact1");
  });

  it("uses voice instructions when isVoice is true", () => {
    const blocks = buildSystemPrompt([], true) as TextBlock[];

    expect(blocks[0].text).toContain("You are Nives, a helpful smart home voice assistant");
    expect(blocks[0].text).toContain("Keep responses under 2-3 sentences");
  });

  it("uses voice instructions with custom prompt", () => {
    const blocks = buildSystemPrompt([], true, "You are Ava.") as TextBlock[];

    expect(blocks[0].text).toMatch(/^You are Ava\./);
    expect(blocks[0].text).toContain("Keep responses under 2-3 sentences");
    expect(blocks[0].text).not.toContain("You are Nives, a helpful smart home voice assistant");
  });

  it("shows 'No memories yet.' when facts are empty", () => {
    const blocks = buildSystemPrompt([]) as TextBlock[];

    const dynamicBlock = blocks[blocks.length - 1];
    expect(dynamicBlock.text).toContain("No memories yet.");
  });
});

describe("buildSystemPromptText (OpenAI)", () => {
  it("returns text with default identity when no custom prompt", () => {
    const text = buildSystemPromptText(["my fact"]);

    expect(text).toContain("You are Nives, a helpful smart home assistant");
    expect(text).toContain("## WHEN TO USE TOOLS");
    expect(text).toContain("my fact");
  });

  it("replaces default identity with custom prompt", () => {
    const text = buildSystemPromptText(["my fact"], false, "You are Ava, sarcastic and sharp.");

    expect(text).toMatch(/^You are Ava, sarcastic and sharp\./);
    expect(text).not.toContain("You are Nives, a helpful smart home assistant");
    expect(text).toContain("## WHEN TO USE TOOLS");
    expect(text).toContain("my fact");

    // Custom prompt should appear before instructions and dynamic context
    const customIdx = text.indexOf("You are Ava");
    const toolsIdx = text.indexOf("## WHEN TO USE TOOLS");
    const contextIdx = text.indexOf("## Current Context:");

    expect(customIdx).toBeLessThan(toolsIdx);
    expect(toolsIdx).toBeLessThan(contextIdx);
  });

  it("uses voice identity and instructions when isVoice is true", () => {
    const text = buildSystemPromptText([], true);

    expect(text).toContain("You are Nives, a helpful smart home voice assistant");
    expect(text).toContain("Keep responses under 2-3 sentences");
  });

  it("shows 'No memories yet.' when facts are empty", () => {
    const text = buildSystemPromptText([]);

    expect(text).toContain("No memories yet.");
  });
});

describe("interface-language tie-breaker line", () => {
  it("appears in the dynamic block when a language is passed", async () => {
    const { buildSystemPromptText } = await import("./prompts.js");
    const prompt = buildSystemPromptText([], false, undefined, undefined, undefined, "sl");
    expect(prompt).toContain("Interface language: sl");
    expect(prompt).toContain("ONLY when the user's own words");
  });

  it("is absent when no language is passed", async () => {
    const { buildSystemPromptText } = await import("./prompts.js");
    expect(buildSystemPromptText([])).not.toContain("Interface language");
  });
});

describe("FORGETTING MEMORIES section", () => {
  it("is present in the regular prompt with the confirm-first flow", () => {
    const text = buildSystemPromptText(["User's name is Alex"]);
    expect(text).toContain("## FORGETTING MEMORIES (CONFIRM FIRST)");
    expect(text).toContain("forget_memory");
    expect(text).toMatch(/never paraphrased and never translated|never paraphrase or translate/);
    // The reminder trap must be named explicitly.
    expect(text).toMatch(/Don't forget to X|DON'T forget X/);
  });

  it("is present in the voice prompt", () => {
    const text = buildSystemPromptText([], true);
    expect(text).toContain("## FORGETTING MEMORIES (CONFIRM FIRST)");
    expect(text).toContain("forget_memory");
  });

  it("is present in both Anthropic prompt variants", () => {
    const regular = buildSystemPrompt([]) as { text: string }[];
    const voice = buildSystemPrompt([], true) as { text: string }[];
    expect(regular.map((b) => b.text).join("\n")).toContain("## FORGETTING MEMORIES (CONFIRM FIRST)");
    expect(voice.map((b) => b.text).join("\n")).toContain("## FORGETTING MEMORIES (CONFIRM FIRST)");
  });

  it("lists forgetting in the capabilities section", () => {
    const text = buildSystemPromptText([]);
    expect(text).toContain("Forget a remembered fact when asked");
  });
});

describe("assistant identity", () => {
  // nives#54: the name was never stated, so a model asked "what is your name?"
  // inferred it from the "Nives: " automation prefix — and a custom persona had
  // to out-shout that convention instead of replacing a stated name.
  it("names Nives explicitly in both default variants", () => {
    expect(buildSystemPromptText([])).toMatch(/^You are Nives, a helpful smart home assistant/);
    expect(buildSystemPromptText([], true)).toMatch(/^You are Nives, a helpful smart home voice assistant/);
  });

  it("a custom prompt replaces the name entirely — no stated Nives identity survives", () => {
    const text = buildSystemPromptText([], false, "You are HAL 9000, calm and precise.");
    expect(text).toMatch(/^You are HAL 9000, calm and precise\./);
    expect(text).not.toContain("You are Nives");
  });

  it("tells the model the automation prefix is a label, not its name", () => {
    for (const voice of [false, true]) {
      const text = buildSystemPromptText([], voice);
      expect(text).toMatch(/(never|not) your name/i);
    }
  });

  it("keeps the naming clarification when a custom persona is set", () => {
    // This is the case that matters: the clarification lives in the shared
    // instructions, so it must survive the identity line being replaced.
    const text = buildSystemPromptText([], false, "You are HAL 9000.");
    expect(text).toMatch(/(never|not) your name/i);
    expect(text).toContain("HAL 9000");
  });
});

describe("identity-change requests point at the config field, not forget_memory", () => {
  // nives#54: two users in a row tried to rename the assistant by talking to
  // it. forget_memory correctly found nothing (its name is in the prompt, not
  // in memory), but the assistant had no idea where its name comes from, so it
  // couldn't redirect them and the thread ran for days. Since 2.4.23 there is
  // exactly ONE place to point at — the add-on's Configuration tab — so the
  // guidance must name that tab, and must NOT resurrect the removed
  // integration field ("Custom system prompt" under Devices & services).
  it("tells the regular prompt where the persona is actually set", () => {
    const text = buildSystemPromptText([]);
    expect(text).toMatch(/NOT MEMORIES/i);
    expect(text).toContain("Custom Prompt");
    expect(text).toMatch(/Configuration tab/);
    expect(text).not.toContain("Custom system prompt");
    expect(text).not.toMatch(/Devices & services/);
  });

  it("tells the voice prompt the same thing", () => {
    const text = buildSystemPromptText([], true);
    expect(text).toMatch(/NOT MEMORIES/i);
    expect(text).toContain("Custom Prompt");
    expect(text).not.toContain("Custom system prompt");
  });

  it("survives a custom persona being set", () => {
    // The guidance lives in the shared instructions, so someone already running
    // a custom persona can still be told how to change it again.
    const text = buildSystemPromptText([], false, "You are HAL 9000.");
    expect(text).toContain("Custom Prompt");
  });
});

describe("cache-friendly ordering (#66)", () => {
  // Prompt caching is a prefix match: anything after the first per-request
  // byte is uncacheable. The home layout and device cheat sheet change on
  // rescan (~30 min), not per request, so they must sit BEFORE the
  // timestamps and retrieved facts, not after.
  const LAYOUT = "## Home Layout:\n- Ground floor: kitchen";
  const DEVICES = "## Device Capabilities:\n- light.kitchen: rgbw";

  it("puts the home description in its own cached block, ahead of the volatile one", () => {
    const blocks = buildSystemPrompt(
      ["fact1"], false, undefined, DEVICES, LAYOUT
    ) as TextBlock[];

    expect(blocks).toHaveLength(3);
    // Home description: cached, no per-request content
    expect(blocks[1]).toMatchObject({ cache_control: { type: "ephemeral" } });
    expect(blocks[1].text).toContain("Home Layout");
    expect(blocks[1].text).toContain("Device Capabilities");
    expect(blocks[1].text).not.toContain("Date/Time");
    // Volatile block: timestamps + facts, NOT cached
    expect(blocks[2]).not.toHaveProperty("cache_control");
    expect(blocks[2].text).toContain("Date/Time");
    expect(blocks[2].text).toContain("fact1");
    expect(blocks[2].text).not.toContain("Home Layout");
  });

  it("emits no empty home block when there is no layout or cheat sheet", () => {
    const blocks = buildSystemPrompt(["fact1"]) as TextBlock[];
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.text.length > 0)).toBe(true);
  });

  it("keeps the plain-text prompt volatile-last for automatic prefix caching", () => {
    const text = buildSystemPromptText(
      ["fact1"], false, undefined, DEVICES, LAYOUT
    );
    const timestamp = text.indexOf("Date/Time");
    expect(timestamp).toBeGreaterThan(text.indexOf("Home Layout"));
    expect(timestamp).toBeGreaterThan(text.indexOf("Device Capabilities"));
    // Facts are retrieved per message — they stay in the volatile tail too.
    expect(text.indexOf("fact1")).toBeGreaterThan(text.indexOf("Device Capabilities"));
  });

  it("keeps every section present after the reorder", () => {
    const text = buildSystemPromptText(
      ["fact1"], false, undefined, DEVICES, LAYOUT, "en"
    );
    for (const marker of [
      "You are Nives",
      "Home Layout",
      "Device Capabilities",
      "## Current Context:",
      "Interface language",
      "fact1",
    ]) {
      expect(text).toContain(marker);
    }
  });
});

describe("misheard-name tolerance (voice)", () => {
  it("is present in the voice prompt", () => {
    const text = buildSystemPromptText([], true);
    expect(text).toContain("YOUR NAME, MISHEARD");
    expect(text).toContain('"News"');
    expect(text).toContain("NEVER correct the user");
  });

  it("is absent from the regular (typed) prompt", () => {
    const text = buildSystemPromptText([], false);
    expect(text).not.toContain("YOUR NAME, MISHEARD");
  });

  it("survives a custom persona (instructions are not replaced)", () => {
    const text = buildSystemPromptText([], true, "You are HAL 9000.");
    expect(text).toContain("YOUR NAME, MISHEARD");
  });
});

describe("follow-up rule", () => {
  // History keeps reply text only, so without this the model reads its own
  // answer as unchecked and takes it back.
  it.each([false, true])("says earlier tool calls are not shown (voice: %s)", (isVoice) => {
    expect(buildSystemPromptText([], isVoice)).toContain("not the tool calls behind them");
  });
});
