import { LINE_BANK } from "./arena-bank";
import { loadPrompts } from "./corpus";
import { READING_SCRIPTS } from "./reading-scripts";
import type { VoiceStylePreset } from "./types";

/**
 * A sentence whose content fits a style preset, so a listener can judge whether the
 * instruction produced the intended delivery on words that call for it. English presets
 * draw from the emotion banks (content/prompts/emotions) and the arena line bank; Chinese
 * presets draw from the Chinese reading scripts.
 */
export async function sampleForPreset(preset: VoiceStylePreset | null): Promise<{ text: string; source: string }> {
  const pick = <T,>(items: T[]): T => items[Math.floor(Math.random() * items.length)];
  if (preset?.language === "zh") {
    const emotion = emotionFor(preset) ?? "neutral";
    const pool = READING_SCRIPTS.zh.filter((s) => s.emotion === emotion);
    const s = pick(pool.length ? pool : READING_SCRIPTS.zh);
    return { text: s.text, source: `zh script · ${s.emotion}` };
  }
  const emotion = emotionFor(preset);
  if (emotion && emotion !== "neutral") {
    const bank = await loadPrompts(emotion);
    if (bank.length) return { text: pick(bank).text, source: `emotion bank · ${emotion}` };
  }
  const category = categoryFor(preset);
  const cat = LINE_BANK.find((c) => c.id === category) ?? pick(LINE_BANK);
  return { text: pick(cat.lines), source: `line bank · ${cat.id}` };
}

/** Emotion bank that matches the preset's wording, if any. */
export function emotionFor(preset: VoiceStylePreset | null): string | null {
  if (!preset) return null;
  // Digital-human presets describe a situation (greeting, thinking aloud, answering), so
  // their sentences come from the situational line bank, not from an emotion bank.
  if (preset.contentType === "digital-human") return null;
  const key = `${preset.id} ${preset.instruct}`.toLowerCase();
  const table: [RegExp, string][] = [
    [/happy|开心|cheer|bright/, "happy"],
    [/sad|低落|subdued|伤感/, "sad"],
    [/surpris|惊讶/, "surprised"],
    [/whisper|耳语|轻声|tender|温柔|soft/, "tender"],
    [/calm|沉稳|unhurried|slow/, "calm"],
    [/excit|兴奋|thrill/, "excited"],
    [/serious|严肃|precise|严谨|steadily/, "serious"],
    [/curious|好奇|question|quiz|提问/, "curious"],
    [/warm|温暖|welcom|friendly|亲切/, "warm"],
  ];
  for (const [re, emotion] of table) if (re.test(key)) return emotion;
  return null;
}

/** Arena line-bank category for presets that are about a situation rather than a mood. */
function categoryFor(preset: VoiceStylePreset | null): string {
  if (!preset) return "lecture";
  const key = `${preset.id} ${preset.contentType}`.toLowerCase();
  if (/thinking/.test(key)) return "thinking";
  if (/greeting|introduction/.test(key)) return "greeting";
  if (/answer|explanation|code/.test(key)) return "explanation";
  if (/quiz|question/.test(key)) return "question";
  if (/summary/.test(key)) return "summary";
  if (/casual|encourag/.test(key)) return "encouragement";
  return "lecture";
}
