import type { ReactNode } from 'react';
import { site } from '../src/site';

export function LogoMark({
  color = 'currentColor',
  cutout = 'var(--bg)',
  ...props
}: {
  color?: string;
  cutout?: string;
  className?: string;
  width?: number;
  height?: number;
}) {
  return (
    <svg viewBox="0 0 26 30" fill="none" aria-hidden="true" {...props}>
      <path d="M5 10h16l-2 16H7L5 10Z" fill={color} />
      <path
        d="m14 3-2 7M5 7h16"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path d="m14 14-4 6h4l-1 4 5-7h-4l1-3Z" fill={cutout} />
    </svg>
  );
}

export function SiteHeader() {
  return (
    <header>
      <a href="/" className="brand" aria-label="Juiced home">
        <LogoMark className="mark" />
        juiced
      </a>
      <nav className="site-nav mono" aria-label="Main navigation">
        <a href="/docs">docs</a>
        <a href="/pricing">pricing</a>
        <a href={site.github}>
          github <span aria-hidden="true">↗</span>
        </a>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mono">
      <nav className="site-nav" aria-label="Footer navigation">
        <a href="/docs">docs</a>
        <a href="/pricing">pricing</a>
        <a href="/llms.txt">llms.txt</a>
      </nav>
      <a href="https://cantelop.com">
        powered by cantelop <span aria-hidden="true">↗</span>
      </a>
    </footer>
  );
}

export function PublicPage({
  title,
  intro,
  eyebrow = { label: 'Juiced documentation', href: '/docs' },
  children,
}: {
  title: string;
  intro?: string;
  eyebrow?: { label: string; href: string } | null;
  children: ReactNode;
}) {
  return (
    <div className="wrap">
      <SiteHeader />
      <main className="document">
        {eyebrow && (
          <p className="number mono">
            <a href={eyebrow.href}>{eyebrow.label}</a>
          </p>
        )}
        <h1>{title}</h1>
        {intro && <p className="lede">{intro}</p>}
        <div className="prose">{children}</div>
      </main>
      <SiteFooter />
    </div>
  );
}
