import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';

const config: NextConfig = {
  outputFileTracingRoot: fileURLToPath(new URL('..', import.meta.url)),
  async redirects() {
    return [
      {
        // Machine callers (cron, queues, Stripe, the CLI) do not follow redirects.
        source: '/:path((?!(?:api|v1|webhooks)(?:/|$)).*)',
        has: [{ type: 'host' as const, value: 'juiced-eight.vercel.app' }],
        destination: 'https://juiced.codes/:path',
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
          },
        ],
      },
      ...[
        // Account pages set this header in src/pages.ts.
        'api',
        'v1',
        'webhooks',
        'health',
        'ready',
      ].map((path) => ({
        source: `/${path}/:path*`,
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      })),
    ];
  },
};
export default config;
