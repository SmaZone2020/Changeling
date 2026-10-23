import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root: a stray lockfile above this folder would otherwise
  // widen Turbopack's scan and slow startup down.
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
