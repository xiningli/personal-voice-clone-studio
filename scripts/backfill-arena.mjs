// One-off: give older arena rounds a category (by matching the line bank) and a model id.
// Usage: node scripts/backfill-arena.mjs [--model FunAudioLLM/CosyVoice2-0.5B]
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL(".", import.meta.url).pathname, "..");
const roundsFile = path.join(root, "data", "arena-rounds.json");
const bankSrc = fs.readFileSync(path.join(root, "lib", "arena-bank.ts"), "utf8");
const argModel = process.argv.indexOf("--model");
const defaultModel = argModel > -1 ? process.argv[argModel + 1] : "FunAudioLLM/CosyVoice2-0.5B";

// Pull { id, lines[] } out of lib/arena-bank.ts without a TS toolchain.
const bank = [];
for (const m of bankSrc.matchAll(/id:\s*"([a-z-]+)",\s*label:\s*"[^"]+",\s*lines:\s*\[([\s\S]*?)\]/g)) {
  const lines = [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1].replace(/\\"/g, '"'));
  bank.push({ id: m[1], lines });
}
const byLine = new Map();
for (const c of bank) for (const l of c.lines) byLine.set(l.trim(), c.id);

const rounds = JSON.parse(fs.readFileSync(roundsFile, "utf8"));
let changed = 0;
for (const r of rounds) {
  const before = JSON.stringify([r.category, r.model]);
  if (!r.category) r.category = byLine.get(r.text.trim()) ?? "manual";
  if (!r.model) r.model = defaultModel;
  if (JSON.stringify([r.category, r.model]) !== before) changed++;
}
fs.writeFileSync(roundsFile, JSON.stringify(rounds, null, 2));
console.log(`bank categories: ${bank.map((c) => c.id).join(", ")}`);
console.log(`updated ${changed} of ${rounds.length} rounds`);
for (const r of rounds) console.log(`${r.createdAt}  ${r.category.padEnd(9)} ${r.model}  ${r.text.slice(0, 50)}`);
