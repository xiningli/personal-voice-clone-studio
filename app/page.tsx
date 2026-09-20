import Link from "next/link";

const panels = [
  {
    href: "/voices",
    title: "Voice Profiles",
    description: "One profile per emotion, recorded sentence by sentence with quality control; the corpus and the cloning prompts",
    icon: "M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z",
    color: "bg-purple-50 text-purple-600 border-purple-200",
  },
  {
    href: "/generate",
    title: "TTS Generator",
    description: "Generate audio with your cloned voice and a natural-language tone instruction",
    icon: "M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z",
    color: "bg-green-50 text-green-600 border-green-200",
  },
  {
    href: "/train",
    title: "Train",
    description: "Fine-tune CosyVoice3 on your corpus (SFT) and your preferences (DPO), then switch the backend to the new checkpoint",
    icon: "M13 10V3L4 14h7v7l9-11h-7z",
    color: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  {
    href: "/arena",
    title: "Arena",
    description: "Blind-compare prosody instructions, rate them, and export preference data for the digital human",
    icon: "M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3",
    color: "bg-rose-50 text-rose-600 border-rose-200",
  },
  {
    href: "/api-docs",
    title: "API",
    description: "How to call the studio from other programs: generate speech, switch models, read profiles and arena data",
    icon: "M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z",
    color: "bg-sky-50 text-sky-700 border-sky-200",
  },
];

export default function Home() {
  return (
    <div>
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">
          Personal Voice Clone Studio
        </h1>
        <p className="text-gray-500 mt-2">
          Clone your voice, judge it blind, and fine-tune it, powered by
          CosyVoice. Record a reference clip, write your script, describe the
          tone you want, and generate natural-sounding narration.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {panels.map((panel) => (
          <Link
            key={panel.href}
            href={panel.href}
            className={`block border rounded-xl p-6 transition-all hover:shadow-md ${panel.color}`}
          >
            <div className="flex items-start gap-4">
              <div className="p-2 rounded-lg bg-white/80">
                <svg
                  className="w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d={panel.icon}
                  />
                </svg>
              </div>
              <div>
                <h2 className="font-semibold text-gray-900">{panel.title}</h2>
                <p className="text-sm text-gray-600 mt-1">
                  {panel.description}
                </p>
              </div>
            </div>
          </Link>
        ))}
      </div>

      <div className="mt-8 p-5 bg-gray-50 rounded-xl border border-gray-200">
        <h3 className="font-semibold text-gray-800 mb-2">Quick Start</h3>
        <ol className="text-sm text-gray-600 space-y-1.5 list-decimal list-inside">
          <li>
            Start the backend with <code className="bg-gray-200 px-1 rounded">bash backend/run.sh</code>{" "}
            and wait for the sidebar dot to turn green
          </li>
          <li>
            Create a <strong>Voice Profile</strong> per emotion and read the sentences it gives you;
            every take is quality-checked before it counts, and the corpus grows with each profile
          </li>
          <li>
            In the <strong>TTS Generator</strong>, pick your voice, type an{" "}
            <strong>instruct</strong> such as &ldquo;Speak warmly and slowly&rdquo;, and generate
          </li>
          <li>
            Roll blind rounds in the <strong>Arena</strong>, pick winners, leave a note under any
            track; the leaderboard ranks instructions with confidence intervals
          </li>
          <li>
            <strong>Train</strong> once the readiness meters are green: SFT on the corpus, then DPO
            on your preferences, and switch the backend to the new checkpoint
          </li>
        </ol>
      </div>
    </div>
  );
}
