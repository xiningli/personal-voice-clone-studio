import type { Config } from "tailwindcss";

// v3 config (downgraded from v4's CSS-based @theme, see app/globals.css). content is v3's
// opt-in file scan list; `motion`/`.venv`/`node_modules` are never listed so the scanner
// never touches the vendored Python pipeline or the exported voice bundles.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)"],
        mono: ["var(--font-geist-mono)"],
      },
    },
  },
  plugins: [],
};

export default config;
