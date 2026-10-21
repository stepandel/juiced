import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Juiced — Claude Code, with more juice.',
  description:
    'Run Claude Code in an isolated cloud workspace. Keep your terminal, your code, and your Claude account.',
  icons: { icon: '/favicon.svg' },
};
export const viewport: Viewport = { themeColor: '#0b0d0b' };
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
