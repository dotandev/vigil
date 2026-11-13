import type { NextConfig } from "next";

// Static export: the app is entirely client-side (it reads the chain directly),
// so `next build` produces an `out/` folder that any static host can serve.
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  // Set NEXT_PUBLIC_BASE_PATH=/vigil when hosting under a subpath (GitHub Pages).
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
  reactStrictMode: true,
  agentRules: false,
};

export default nextConfig;
