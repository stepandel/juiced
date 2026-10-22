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

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
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
        <a href="/account">console</a>
        <a href={site.github} className="github">
          <GitHubMark />
          github
        </a>
        <a href="/docs/getting-started" className="button">
          get started
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
        <a href={site.github}>github</a>
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
  eyebrow = { label: 'Documentation', href: '/docs' },
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
          <p className="label">
            <span className="hash">//</span>
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
