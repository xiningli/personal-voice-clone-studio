import { backendHealth, TTS_ENDPOINT } from "@/lib/tts-client";

export const dynamic = "force-dynamic";

export async function GET() {
  const health = await backendHealth();
  return Response.json({ endpoint: TTS_ENDPOINT, reachable: health !== null, ...(health ?? {}) });
}
