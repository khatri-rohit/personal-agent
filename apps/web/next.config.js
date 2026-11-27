//@ts-check

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    '@agent/agent-models',
    '@agent/agent-client',
    'streamdown',
    '@streamdown/code',
    '@streamdown/mermaid',
  ],
  typescript: {
    tsconfigPath: 'tsconfig.app.json',
  },
};

module.exports = nextConfig;
