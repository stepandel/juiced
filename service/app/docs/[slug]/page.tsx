import { notFound } from 'next/navigation';
import { PublicPage } from '../../site-components';
import { guides } from '../../../src/guides';
import { pageMetadata } from '../../../src/site';

export const dynamicParams = false;
export function generateStaticParams() {
  return guides.map(({ slug }) => ({ slug }));
}

type Props = { params: Promise<{ slug: string }> };
export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  const guide = guides.find((entry) => entry.slug === slug);
  if (!guide) notFound();
  return pageMetadata(guide.title, guide.description, `/docs/${slug}`);
}

export default async function Guide({ params }: Props) {
  const { slug } = await params;
  const index = guides.findIndex((entry) => entry.slug === slug);
  if (index < 0) notFound();
  const guide = guides[index]!;
  const previous = guides[index - 1];
  const next = guides[index + 1];
  return (
    <PublicPage
      title={guide.title}
      intro={guide.description}
      aside={
        <nav className="docs-nav" aria-label="Documentation">
          <p className="number mono">Guides</p>
          <a href="/docs">Overview</a>
          {guides.map((entry) => (
            <a
              key={entry.slug}
              href={`/docs/${entry.slug}`}
              aria-current={entry.slug === slug ? 'page' : undefined}
            >
              {entry.label}
            </a>
          ))}
        </nav>
      }
    >
      {guide.body}
      <nav className="pager" aria-label="More guides">
        {previous ? (
          <a href={`/docs/${previous.slug}`} className="guide-card">
            <span className="mono">← previous</span>
            <h3>{previous.title}</h3>
          </a>
        ) : (
          <a href="/docs" className="guide-card">
            <span className="mono">← overview</span>
            <h3>All documentation</h3>
          </a>
        )}
        {next && (
          <a href={`/docs/${next.slug}`} className="guide-card forward">
            <span className="mono">next →</span>
            <h3>{next.title}</h3>
          </a>
        )}
      </nav>
    </PublicPage>
  );
}
