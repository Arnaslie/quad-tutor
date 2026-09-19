import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root. Without this, Turbopack walks up and finds a stray
  // package-lock.json outside the repository, then warns on every build.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
