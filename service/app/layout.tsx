import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Juiced — Claude Code, always on.',
  description:
    'Juiced runs Claude Code in a private cloud workspace that you drive from your terminal. Close your laptop. Claude keeps working.',
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
