import { NextRequest } from "next/server";
import { promptBankStatus, loadPrompts, bankFor, targetSecondsFor, estimateSeconds, DEFAULT_SPEAKER, DEFAULT_ACCEPT_RATE } from "@/lib/corpus";
import { getProfile } from "@/lib/storage";
import { EMOTIONS } from "@/lib/reading-scripts";

export const dynamic = "force-dynamic";

/**
 * ?profileId=  → BankStatus for that profile (remaining sentences, expected speech, takes needed).
 * (no params)  → the plan for every emotion: bank size, expected speech if all accepted, target,
 *                and the sentence count needed at the default accept rate.
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const speaker = q.get("speaker") || DEFAULT_SPEAKER;
  const profileId = q.get("profileId");
  if (profileId) {
    const profile = await getProfile(profileId);
    if (!profile) return Response.json({ error: "Profile not found" }, { status: 404 });
    return Response.json(await promptBankStatus(profile, speaker));
  }
  const plan = [];
  for (const e of EMOTIONS) {
    const prompts = await loadPrompts(bankFor(e.id));
    const est = prompts.reduce((s, p) => s + (p.estSeconds ?? estimateSeconds(p.text)), 0);
    const target = targetSecondsFor(e.id);
    const avg = prompts.length ? est / prompts.length : 0;
    plan.push({
      emotion: e.id,
      bank: bankFor(e.id),
      sentences: prompts.length,
      avgSeconds: Math.round(avg * 10) / 10,
      estSpeechSeconds: Math.round(est),
      targetSeconds: target,
      sentencesNeededAtDefaultRate: avg ? Math.ceil(target / avg / DEFAULT_ACCEPT_RATE) : null,
      enough: avg ? prompts.length >= Math.ceil(target / avg / DEFAULT_ACCEPT_RATE) : false,
    });
  }
  return Response.json({ acceptRateAssumed: DEFAULT_ACCEPT_RATE, plan });
}
