"use client";

import { useSyncExternalStore } from "react";
import { APP_SECTIONS, BACKEND, BACKEND_SECTION, RECIPE_JS, RECIPE_PYTHON, RECIPE_STEPS, type Endpoint, type Section } from "@/lib/api-docs";

const METHOD_COLOR: Record<Endpoint["method"], string> = {
  GET: "bg-emerald-50 text-emerald-700 border-emerald-200",
  POST: "bg-indigo-50 text-indigo-700 border-indigo-200",
  PUT: "bg-amber-50 text-amber-700 border-amber-200",
  DELETE: "bg-rose-50 text-rose-700 border-rose-200",
};

function fill(text: string, origin: string): string {
  return text.replaceAll("{ORIGIN}", origin).replaceAll("{BACKEND}", BACKEND);
}

function Code({ children }: { children: string }) {
  return (
    <pre className="bg-gray-900 text-gray-100 text-xs rounded-lg p-3 overflow-x-auto whitespace-pre leading-relaxed">
      <code>{children}</code>
    </pre>
  );
}

function EndpointCard({ e, origin }: { e: Endpoint; origin: string }) {
  return (
    <div className="border border-gray-200 rounded-xl bg-white p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`px-2 py-0.5 rounded-md text-xs font-semibold border ${METHOD_COLOR[e.method]}`}>{e.method}</span>
        <code className="text-sm font-mono text-gray-900">{e.path}</code>
      </div>
      <p className="text-sm text-gray-700">{e.summary}</p>
      {e.request && (
        <div>
          <p className="text-xs font-medium text-gray-500 mb-1">Request</p>
          <code className="block text-xs bg-gray-50 border border-gray-200 rounded-md px-2 py-1.5 whitespace-pre-wrap text-gray-800">{e.request}</code>
        </div>
      )}
      <div>
        <p className="text-xs font-medium text-gray-500 mb-1">Response</p>
        <code className="block text-xs bg-gray-50 border border-gray-200 rounded-md px-2 py-1.5 whitespace-pre-wrap text-gray-800">{e.response}</code>
      </div>
      <div>
        <p className="text-xs font-medium text-gray-500 mb-1">Example</p>
        <Code>{fill(e.curl, origin)}</Code>
      </div>
      {e.notes && <p className="text-xs text-gray-500">{e.notes}</p>}
    </div>
  );
}

function SectionBlock({ s, origin }: { s: Section; origin: string }) {
  return (
    <section id={s.id} className="space-y-3 scroll-mt-6">
      <h3 className="text-lg font-semibold text-gray-900">{s.title}</h3>
      {s.intro && <p className="text-sm text-gray-600">{fill(s.intro, origin)}</p>}
      <div className="grid gap-3">
        {s.endpoints.map((e) => (
          <EndpointCard key={`${e.method} ${e.path}`} e={e} origin={origin} />
        ))}
      </div>
    </section>
  );
}

export default function ApiDocsPage() {
  // The page's own origin, read only in the browser; the server render shows a placeholder.
  const origin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => "https://<host>:3010"
  );

  const toc = [...APP_SECTIONS, BACKEND_SECTION, { id: "recipe", title: "Recipe: speak a line from another program" } as Section];

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">API</h2>
        <p className="text-sm text-gray-500 mt-1">How to call Personal Voice Clone Studio from other programs.</p>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-3 text-sm text-gray-700">
        <p>
          There are two servers. <strong>The app</strong> at <code className="font-mono text-gray-900">{origin}</code> is what other programs
          should call: every route under <code className="font-mono">/api/*</code> below, JSON in and out, files served under{" "}
          <code className="font-mono">/audio/*</code>. <strong>The internal CosyVoice backend</strong> at{" "}
          <code className="font-mono text-gray-900">{BACKEND}</code> is bound to this machine only; the app routes call it for you.
        </p>
        <p>
          The app serves HTTPS with a self-signed certificate, so pass <code className="font-mono">-k</code> to curl (or disable certificate
          verification in your client) when calling from a script. No authentication is required on either server; keep them on a trusted
          network.
        </p>
        <p>
          <strong>Which model answers.</strong> The backend holds one model at a time. <code className="font-mono">GET /api/tts/health</code> and the{" "}
          <code className="font-mono">x-model</code> header on backend responses say which; every file from <code className="font-mono">/api/tts/generate</code>{" "}
          also records the <code className="font-mono">mode</code> and <code className="font-mono">seed</code> that produced it, and every arena round records its model.
        </p>
        <nav className="flex flex-wrap gap-2 pt-1">
          {toc.map((s) => (
            <a key={s.id} href={`#${s.id}`} className="text-xs px-2.5 py-1 rounded-full border border-gray-300 hover:bg-gray-50 text-gray-700">
              {s.title}
            </a>
          ))}
        </nav>
      </div>

      {APP_SECTIONS.map((s) => (
        <SectionBlock key={s.id} s={s} origin={origin} />
      ))}

      <SectionBlock s={BACKEND_SECTION} origin={origin} />

      <section id="recipe" className="space-y-4 scroll-mt-6">
        <h3 className="text-lg font-semibold text-gray-900">Recipe: speak a line in the owner&apos;s voice from another program</h3>
        <div className="grid gap-3">
          {RECIPE_STEPS.map((step) => (
            <div key={step.title} className="border border-gray-200 rounded-xl bg-white p-4 space-y-2">
              <p className="text-sm font-medium text-gray-900">{step.title}</p>
              <p className="text-sm text-gray-600">{step.body}</p>
              <Code>{fill(step.curl, origin)}</Code>
            </div>
          ))}
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="border border-gray-200 rounded-xl bg-white p-4 space-y-2">
            <p className="text-sm font-medium text-gray-900">Python (requests)</p>
            <Code>{fill(RECIPE_PYTHON, origin)}</Code>
          </div>
          <div className="border border-gray-200 rounded-xl bg-white p-4 space-y-2">
            <p className="text-sm font-medium text-gray-900">JavaScript (fetch)</p>
            <Code>{fill(RECIPE_JS, origin)}</Code>
          </div>
        </div>
      </section>
    </div>
  );
}
