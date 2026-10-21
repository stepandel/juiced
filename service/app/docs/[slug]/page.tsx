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
  const guide = guides.find((entry) => entry.slug === slug);
  if (!guide) notFound();
  return (
    <PublicPage title={guide.title} intro={guide.description}>
      {guide.body}
      <nav className="guide-links" aria-label="Documentation guides">
        <a href="/docs">All guides</a>
        {guides
          .filter((entry) => entry.slug !== slug)
          .map((entry) => (
            <a key={entry.slug} href={`/docs/${entry.slug}`}>
              {entry.title}
            </a>
          ))}
      </nav>
    </PublicPage>
  );
}
