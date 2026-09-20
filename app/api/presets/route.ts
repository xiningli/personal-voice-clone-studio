import { getPresets } from "@/lib/storage";
import { emotionFor } from "@/lib/preset-sample";

export async function GET() {
  const presets = await getPresets();
  return Response.json(presets.map((p) => ({ ...p, emotion: emotionFor(p) })));
}
