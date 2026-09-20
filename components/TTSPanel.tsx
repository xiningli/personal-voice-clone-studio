"use client";

import { useState, useEffect } from "react";
import type { VoiceProfile, GeneratedAudio, VoiceStylePreset, TTSMode } from "@/lib/types";
import ModelSwitch from "./ModelSwitch";
import AudioPlayer from "./AudioPlayer";

interface TTSPanelProps {
  script?: string;
  onAudioGenerated?: (audioFiles: GeneratedAudio[]) => void;
}

interface Health {
  reachable: boolean;
  model?: string;
  ready?: boolean;
  loading?: boolean;
  device?: string;
  endpoint?: string;
}

const MODES: { value: TTSMode; label: string }[] = [
  { value: "auto", label: "auto" },
  { value: "zero_shot", label: "zero_shot" },
  { value: "instruct", label: "instruct" },
  { value: "instruct_ref", label: "instruct_ref" },
  { value: "cross_lingual", label: "cross_lingual" },
];

function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/** Default voice: the profile whose emotion matches the preset, else the neutral one, else the first usable. */
function autoProfileFor(presetId: string, list: VoiceProfile[], presetList: VoiceStylePreset[]): string {
  const usable = list.filter((p) => p.promptAudioPath);
  const preset = presetList.find((p) => p.id === presetId);
  const wantLang = preset?.language === "zh" ? "zh" : "en";
  const byEmotion = preset?.emotion ? usable.find((p) => p.emotion === preset.emotion && p.language === wantLang) : undefined;
  const neutral = usable.find((p) => p.emotion === "neutral" && p.language === wantLang) ?? usable.find((p) => p.emotion === "neutral");
  return (byEmotion ?? neutral ?? usable[0])?.id ?? "";
}

export default function TTSPanel({ script, onAudioGenerated }: TTSPanelProps) {
  const [profiles, setProfiles] = useState<VoiceProfile[]>([]);
  const [presets, setPresets] = useState<VoiceStylePreset[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [speed, setSpeed] = useState(1.0);
  const [instruct, setInstruct] = useState("");
  const [seed, setSeed] = useState<string>("");
  const [mode, setMode] = useState<TTSMode>("auto");
  const [text, setText] = useState(script || "");
  const [sampling, setSampling] = useState(false);
  const [sampleSource, setSampleSource] = useState("");
  const [manualVoice, setManualVoice] = useState(false);

  async function refreshHealth() {
    try {
      const h = await fetch("/api/tts/health", { cache: "no-store" });
      setHealth((await h.json()) as Health);
    } catch {
      setHealth({ reachable: false });
    }
  }


  async function sampleLine() {
    setSampling(true);
    try {
      const r = await fetch(`/api/presets/sample?presetId=${encodeURIComponent(selectedPresetId)}`, { cache: "no-store" });
      const data = (await r.json()) as { text: string; source: string };
      if (data.text) {
        setText(data.text);
        setSampleSource(data.source);
      }
    } catch {
      /* keep the current text */
    } finally {
      setSampling(false);
    }
  }
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [generatedFiles, setGeneratedFiles] = useState<GeneratedAudio[]>([]);

  useEffect(() => {
    fetch("/api/tts/profiles")
      .then((r) => r.json())
      .then((data: VoiceProfile[]) => {
        const usable = data.filter((p) => p.promptAudioPath);
        setProfiles(usable);
        setSelectedProfileId((cur) => cur || autoProfileFor("", usable, []));
      })
      .catch(() => setProfiles([]));
    fetch("/api/presets")
      .then((r) => r.json())
      .then(setPresets)
      .catch(() => setPresets([]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const r = await fetch("/api/tts/health", { cache: "no-store" });
        const data = (await r.json()) as Health;
        if (!cancelled) setHealth(data);
      } catch {
        if (!cancelled) setHealth({ reachable: false });
      }
    }
    poll();
    const t = setInterval(poll, 10000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    if (script !== undefined) setText(script);
  }, [script]);

  function applyPreset(id: string) {
    setSelectedPresetId(id);
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    setInstruct(preset.instruct);
    setSpeed(preset.speed);
    if (!manualVoice) setSelectedProfileId(autoProfileFor(id, profiles, presets));
  }

  async function handleGenerate() {
    if (!text.trim() || !selectedProfileId) return;

    setGenerating(true);
    setError("");

    const parsedSeed = seed.trim() === "" ? undefined : parseInt(seed, 10);

    try {
      const res = await fetch("/api/tts/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          voiceProfileId: selectedProfileId,
          speed,
          instruct,
          seed: Number.isFinite(parsedSeed) ? parsedSeed : undefined,
          mode,
          stylePresetId: selectedPresetId || undefined,
          format: "wav",
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Generation failed");
      }

      setGeneratedFiles(data.audioFiles);
      onAudioGenerated?.(data.audioFiles);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  const backendOffline = health !== null && !health.reachable;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">TTS Generation</h2>
          <p className="text-sm text-gray-500 mt-1">
            Generate audio from your script using a cloned voice (CosyVoice)
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <HealthChip health={health} />
          <ModelSwitch onSwitched={refreshHealth} />
        </div>
      </div>

      {backendOffline && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
          The TTS backend is not reachable. Start it with{" "}
          <code className="bg-amber-100 px-1 rounded">bash backend/run.sh</code>
          {health?.endpoint && (
            <span className="text-amber-600"> (expected at {health.endpoint})</span>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Voice reference
            <button
              type="button"
              onClick={() => {
                if (manualVoice) setSelectedProfileId(autoProfileFor(selectedPresetId, profiles, presets));
                setManualVoice((m) => !m);
              }}
              className="ml-2 text-xs font-normal text-indigo-600 hover:underline"
            >
              {manualVoice ? "back to auto" : "choose manually"}
            </button>
          </label>
          {manualVoice ? (
            <select
              value={selectedProfileId}
              onChange={(e) => setSelectedProfileId(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
            >
              <option value="">Select a voice...</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.language})
                </option>
              ))}
            </select>
          ) : (
            <div className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50 text-gray-700">
              {profiles.find((p) => p.id === selectedProfileId)?.name ?? "no prepared profile yet"}
              <span className="text-xs text-gray-400 ml-2">auto: matches the preset&apos;s emotion, else neutral</span>
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Speed / 语速: {speed.toFixed(2)}x
          </label>
          <input
            type="range"
            min="0.7"
            max="1.3"
            step="0.05"
            value={speed}
            onChange={(e) => setSpeed(parseFloat(e.target.value))}
            className="w-full accent-indigo-600"
          />
          <p className="text-xs text-gray-400 mt-1">Native CosyVoice speed, no post-stretching</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Mode</label>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as TTSMode)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
          >
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-400 mt-1">
            auto = instruct if an instruction is given, otherwise zero-shot with the transcript
          </p>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Style Preset / 预设
        </label>
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => applyPreset(p.id)}
              title={p.description}
              className={`px-3 py-1.5 rounded-full text-xs border transition-colors ${
                selectedPresetId === p.id
                  ? "bg-indigo-600 text-white border-indigo-600"
                  : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
              }`}
            >
              {p.name}
            </button>
          ))}
          {presets.length === 0 && (
            <span className="text-xs text-gray-400">No presets loaded</span>
          )}
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Instruct / 语气语调
        </label>
        <input
          type="text"
          value={instruct}
          onChange={(e) => {
            setInstruct(e.target.value);
            setSelectedPresetId("");
          }}
          placeholder="e.g. 用温暖亲切的语气说 / Speak warmly and slowly"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
        />
        <p className="text-xs text-gray-400 mt-1">
          Natural-language prosody instruction for CosyVoice. Leave empty for a pure zero-shot clone.
        </p>
      </div>

      <div className="flex items-end gap-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Seed <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <input
            type="number"
            min="0"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            placeholder="random"
            className="w-40 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500"
          />
        </div>
        <button
          type="button"
          onClick={() => setSeed(String(randomSeed()))}
          className="px-3 py-2 text-sm bg-gray-100 border border-gray-300 rounded-lg hover:bg-gray-200 transition-colors"
        >
          🎲 random
        </button>
        {seed && (
          <button
            type="button"
            onClick={() => setSeed("")}
            className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700"
          >
            clear
          </button>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="block text-sm font-medium text-gray-700">Script Text / 文本</label>
          <button
            type="button"
            onClick={sampleLine}
            disabled={sampling}
            title={selectedPresetId ? "Random sentence whose content fits the selected preset" : "Random sentence from the line bank"}
            className="text-xs px-2.5 py-1 rounded-md border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
          >
            {sampling ? "…" : "🎲 Sample a line for this preset"}
          </button>
        </div>
        {sampleSource && <p className="text-xs text-gray-400 mb-1">from {sampleSource}</p>}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          placeholder="Enter or paste your teaching script..."
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-indigo-500 resize-y"
        />
      </div>

      <div className="flex items-center gap-4">
        <span className="text-xs text-gray-400">Output: WAV 24 kHz mono</span>
        <button
          onClick={handleGenerate}
          disabled={!text.trim() || !selectedProfileId || generating}
          className="px-6 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {generating ? (
            <span className="flex items-center gap-2">
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Generating...
            </span>
          ) : (
            "Generate Audio"
          )}
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {generatedFiles.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-gray-700">Generated Audio</h3>
          {generatedFiles.map((af, i) => (
            <div key={af.id} className="space-y-1">
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <AudioPlayer
                    src={af.path}
                    label={generatedFiles.length > 1 ? `Chunk ${i + 1}` : undefined}
                  />
                </div>
                <a
                  href={af.path}
                  download={af.filename}
                  className="px-3 py-2 text-sm bg-gray-100 border border-gray-300 rounded-lg hover:bg-gray-200 transition-colors flex-shrink-0"
                >
                  Download
                </a>
              </div>
              <p className="text-xs text-gray-400 font-mono px-1">
                instruct: {af.instruct ? `"${af.instruct}"` : "(none)"} · speed {af.speed?.toFixed(2)} ·
                seed {af.seed} · mode {af.mode} · {af.duration.toFixed(1)}s
                {af.elapsedSeconds !== undefined && ` · generated in ${af.elapsedSeconds.toFixed(1)}s`}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HealthChip({ health }: { health: Health | null }) {
  let color = "bg-gray-300";
  let label = "checking backend...";
  if (health) {
    if (!health.reachable) {
      color = "bg-red-500";
      label = "backend offline";
    } else if (health.ready) {
      color = "bg-green-500";
      label = health.model ? `ready · ${health.model}` : "ready";
    } else {
      color = "bg-yellow-400";
      label = health.loading ? "loading model..." : "backend up · model not loaded";
    }
  }
  return (
    <span className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-gray-200 bg-white text-xs text-gray-600 whitespace-nowrap">
      <span className={`w-2 h-2 rounded-full ${color}`} />
      {label}
    </span>
  );
}
