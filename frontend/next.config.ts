import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: 'export',
  // This is an independent Next.js project nested inside the tavern-study repo (which has its
  // own top-level package-lock.json for the backend). Without this, Next infers the workspace
  // root from the outer lockfile and warns on every build.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
