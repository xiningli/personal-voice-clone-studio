import { LINE_BANK } from "@/lib/arena-bank";

export async function GET() {
  return Response.json(LINE_BANK.map((c) => ({ id: c.id, label: c.label, lines: c.lines.length })));
}
