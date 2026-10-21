import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { site, titleTemplate } from '../src/site';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: titleTemplate,
  description: site.description,
  openGraph: { title: titleTemplate },
  twitter: { title: titleTemplate },
  icons: { icon: '/favicon.svg' },
  verification: {
    ...(process.env.GOOGLE_SITE_VERIFICATION
      ? { google: process.env.GOOGLE_SITE_VERIFICATION }
      : {}),
    ...(process.env.BING_SITE_VERIFICATION
      ? { other: { 'msvalidate.01': process.env.BING_SITE_VERIFICATION } }
      : {}),
  },
};
export const viewport: Viewport = { themeColor: '#0b0d0b' };
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
