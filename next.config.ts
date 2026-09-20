import path from "path";
import type { NextConfig } from "next";

// Dev-only: hosts allowed to load /_next resources besides localhost. Without this the
// page renders but never hydrates (every panel sits at "checking backend...").
// Add your own hostnames/IPs via STUDIO_DEV_ORIGINS in .env.local (git-ignored),
// comma-separated, e.g. STUDIO_DEV_ORIGINS=myhost.local,192.168.1.10
const extraOrigins = (process.env.STUDIO_DEV_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost", ...extraOrigins],
  // This app is a standalone project, not a monorepo, but its two sibling apps
  // (personal-site, personal-digital-human) each carry their own lockfile one level up
  // under ~/digital-human. Turbopack's workspace-root inference walks up looking for the
  // highest ancestor lockfile and picked that shared parent, so `node_modules` resolution
  // (e.g. tailwindcss) failed against a directory that has none. Pinning the root here to
  // this project's own directory removes the ambiguity.
  turbopack: { root: __dirname },
  outputFileTracingRoot: path.join(__dirname),
  /* config options here */
};

export default nextConfig;
