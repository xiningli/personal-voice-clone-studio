// Markdown report builders (docs/protocol.md §4). The evaluation section lives here; the
// corpus and training sections are contributed by their own modules and spliced in by
// app/api/report/route.ts at the marked placeholders.

import type { ArenaRound, ArenaVote, BradleyTerryEntry } from "./types";
import { fitBradleyTerry, raterReliability } from "./arena-stats";

function fmt(v: number | null | undefined, digits = 2): string {
  return v === null || v === undefined ? "–" : v.toFixed(digits);
}

function esc(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function btTable(entries: BradleyTerryEntry[]): string {
  if (!entries.length) return "_No decided test trials yet._\n";
  const head =
    "| # | instruction | BT score | 95% CI | W | L | rounds | naturalness | emotion | similarity | WER | spk-sim |\n" +
    "|---|---|---:|:---:|---:|---:|---:|---:|---:|---:|---:|---:|\n";
  const rows = entries
    .map(
      (e, i) =>
        `| ${i + 1} | ${e.instruct ? esc(e.instruct) : "_(pure clone)_"} | ${fmt(e.score, 3)} | [${fmt(e.ci95[0], 2)}, ${fmt(e.ci95[1], 2)}] | ${e.wins} | ${e.losses} | ${e.rounds} | ${fmt(e.avgNaturalness)} | ${fmt(e.avgEmotion)} | ${fmt(e.avgSimilarity)} | ${fmt(e.avgWer)} | ${fmt(e.avgSpeakerSimilarity, 3)} |`
    )
    .join("\n");
  return head + rows + "\n";
}

/** §2 as Markdown: one BT table per backend model, reliability, objective-metric summary. */
export function evaluationSection(rounds: ArenaRound[], votes: ArenaVote[], bootstrap = 1000): string {
  const models = [...new Set(rounds.map((r) => r.model ?? "unknown"))].sort();
  const lines: string[] = [];
  lines.push("## Subjective evaluation\n");
  lines.push(
    `Protocol: two-alternative forced choice under blind labels, same text / prompt / seed per round; ` +
      `Bradley-Terry strengths (MLE, mean-centred log scale) with ${bootstrap}-sample bootstrap 95% CIs over decided test trials. ` +
      `Repeat and anchor trials are excluded from ranking and reported as rater reliability.\n`
  );
  lines.push(`Rounds: ${rounds.length} · votes: ${votes.length} · models: ${models.length}\n`);

  for (const model of models) {
    const mr = rounds.filter((r) => (r.model ?? "unknown") === model);
    const ids = new Set(mr.map((r) => r.id));
    const mv = votes.filter((v) => ids.has(v.roundId));
    const trials = { test: 0, repeat: 0, anchor: 0 } as Record<string, number>;
    for (const r of mr) trials[r.trial ?? "test"] = (trials[r.trial ?? "test"] ?? 0) + 1;
    lines.push(`### Model \`${model}\`\n`);
    lines.push(`${mr.length} rounds (${trials.test} test, ${trials.repeat} repeat, ${trials.anchor} anchor) · ${mv.length} votes\n`);
    lines.push(btTable(fitBradleyTerry(rounds, votes, { model, bootstrap })));
    const rel = raterReliability(rounds, votes, model);
    lines.push(
      `Rater reliability: repeat agreement ${rel.repeatAgreement === null ? "–" : `${Math.round(rel.repeatAgreement * 100)}%`} ` +
        `(${rel.repeatTrials} repeat trials); anchor accuracy ${rel.anchorAccuracy === null ? "–" : `${Math.round(rel.anchorAccuracy * 100)}%`} ` +
        `(${rel.anchorTrials} anchor trials).\n`
    );
    const wer = mr.flatMap((r) => r.candidates.map((c) => c.metrics?.wer)).filter((x): x is number => typeof x === "number");
    const ss = mr
      .flatMap((r) => r.candidates.map((c) => c.metrics?.speakerSimilarity))
      .filter((x): x is number => typeof x === "number");
    const tail = mr
      .flatMap((r) => r.candidates.map((c) => c.metrics?.reverbTailDb))
      .filter((x): x is number => typeof x === "number");
    const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
    lines.push(
      `Objective metrics over ${mr.reduce((n, r) => n + r.candidates.length, 0)} candidates: ` +
        `mean WER ${fmt(mean(wer), 3)} (n=${wer.length}), mean CAM++ speaker similarity ${fmt(mean(ss), 3)} (n=${ss.length}), ` +
        `mean reverb tail ${fmt(mean(tail), 1)} dB (n=${tail.length}).\n`
    );
  }
  return lines.join("\n");
}
