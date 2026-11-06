import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@reservation/db", "@reservation/shared"],
  experimental: { useTypeScriptCli: false },
};

export default nextConfig;
