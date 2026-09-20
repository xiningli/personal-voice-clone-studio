"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";

const navItems = [
  { href: "/", label: "Dashboard", icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1" },
  { href: "/voices", label: "Voice Profiles", icon: "M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" },
  { href: "/generate", label: "TTS Generator", icon: "M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2z" },
  { href: "/train", label: "Train", icon: "M13 10V3L4 14h7v7l9-11h-7z" },
  { href: "/arena", label: "Arena", icon: "M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" },
  { href: "/export", label: "Export", icon: "M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" },
  { href: "/api-docs", label: "API", icon: "M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" },
];

interface Health {
  reachable: boolean;
  model?: string;
  ready?: boolean;
  loading?: boolean;
}

export default function Sidebar() {
  const pathname = usePathname();
  const [health, setHealth] = useState<Health | null>(null);

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

  let dot = "bg-gray-500";
  let status = "checking backend...";
  if (health) {
    if (!health.reachable) {
      dot = "bg-red-500";
      status = "backend offline · bash backend/run.sh";
    } else if (health.ready) {
      dot = "bg-green-500";
      status = health.model ? `ready · ${health.model}` : "ready";
    } else {
      dot = "bg-yellow-400";
      status = health.loading ? "loading model..." : "backend up · model idle";
    }
  }

  return (
    <aside className="w-64 bg-gray-900 text-gray-100 flex flex-col min-h-screen">
      <div className="p-5 border-b border-gray-700">
        <h1 className="text-lg font-bold tracking-tight">Personal Voice Clone Studio</h1>
        <p className="text-xs text-gray-400 mt-1">Personal TTS Workspace · CosyVoice</p>
      </div>
      <nav className="flex-1 p-3 space-y-1">
        {navItems.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                active
                  ? "bg-indigo-600 text-white"
                  : "text-gray-300 hover:bg-gray-800 hover:text-white"
              }`}
            >
              <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={item.icon} />
              </svg>
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="p-4 border-t border-gray-700 text-xs text-gray-400 flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
        <span className="truncate" title={status}>
          {status}
        </span>
      </div>
    </aside>
  );
}
