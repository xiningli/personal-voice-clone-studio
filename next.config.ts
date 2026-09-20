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
  /* config options here */
};

export default nextConfig;
