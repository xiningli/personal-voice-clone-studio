"use client";

import { useCallback, useEffect, useState } from "react";
import type { ModelEntry } from "@/lib/types";

/** Short display name for a model id: last path segment for local checkpoints, repo name for HF ids. */
export function shortModelName(id: string | undefined | null): string {
  if (!id) return "unknown";
  const parts = id.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? id;
}

/**
 * Dropdown that hot-swaps the backend model (GET /api/models, POST /api/models/select).
 * Fine-tuned checkpoints are marked with ★. `onSwitched` fires after a successful switch so
 * the host can refresh its health chip.
 */
export default function ModelSwitch({
  onSwitched,
  className = "",
  refreshKey = 0,
}: {
  onSwitched?: (modelId: string) => void;
  className?: string;
  refreshKey?: number;
}) {
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/models", { cache: "no-store" });
      if (r.ok) setModels((await r.json()) as ModelEntry[]);
    } catch {
      /* the host's health chip still shows the backend state */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  async function switchModel(id: string) {
    if (!id || switching) return;
    setSwitching(true);
    setError("");
    try {
      const r = await fetch("/api/models/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || "Model switch failed");
      await load();
      onSwitched?.(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Model switch failed");
    } finally {
      setSwitching(false);
    }
  }

  if (models.length === 0) return null;
  return (
    <label className={`flex items-center gap-2 text-xs text-gray-600 ${className}`}>
      Model
      <select
        value={models.find((m) => m.active)?.id ?? ""}
        onChange={(e) => switchModel(e.target.value)}
        disabled={switching}
        className="px-2 py-1 border border-gray-300 rounded-md text-xs bg-white max-w-64"
      >
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.kind === "finetuned" ? `★ ${m.name} (your fine-tune)` : `${m.name} (base)`}
          </option>
        ))}
      </select>
      {switching && <span className="text-gray-400">loading…</span>}
      {error && <span className="text-red-600">{error}</span>}
    </label>
  );
}
