import { NextRequest } from "next/server";
import { nextPrompts, profilePrompts, DEFAULT_SPEAKER } from "@/lib/corpus";
import { getProfile } from "@/lib/storage";

export const dynamic = "force-dynamic";

/**
 * ?profileId=&n=  → the profile's emotion reading script(s) first, then unrecorded ARCTIC
 *                   sentences for that emotion (English profiles only; Chinese get scripts only).
 * ?emotion=&n=    → unrecorded ARCTIC sentences for an emotion (no profile).
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const speaker = q.get("speaker") || DEFAULT_SPEAKER;
  const n = Math.min(50, Math.max(1, parseInt(q.get("n") || "10", 10) || 10));
  const profileId = q.get("profileId");
  try {
    if (profileId) {
      const profile = await getProfile(profileId);
      if (!profile) return Response.json({ error: "Profile not found" }, { status: 404 });
      return Response.json(await profilePrompts(profile, n, speaker));
    }
    return Response.json(await nextPrompts(speaker, n, q.get("emotion") || "neutral"));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "failed" }, { status: 400 });
  }
}
