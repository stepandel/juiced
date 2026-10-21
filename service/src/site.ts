import type { Metadata } from 'next';

export const site = {
  name: 'Juiced',
  url: 'https://juiced.codes',
  github: 'https://github.com/stepandel/juiced',
  title: 'Juiced — Claude Code, always on.',
  description:
    'Juiced runs Claude Code in a private cloud workspace that you drive from your terminal. Close your laptop. Claude keeps working.',
};

export function pageMetadata(
  title: string,
  description: string,
  path: string,
): Metadata {
  const fullTitle = title === site.title ? title : `${title} | ${site.name}`;
  const url = new URL(path, site.url).href;
  const images = [
    {
      url: `${site.url}/opengraph-image`,
      width: 1200,
      height: 630,
      alt: site.title,
    },
  ];
  return {
    title: fullTitle,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: 'website',
      locale: 'en_US',
      siteName: site.name,
      title: fullTitle,
      description,
      url,
      images,
    },
    twitter: {
      card: 'summary_large_image',
      title: fullTitle,
      description,
      images,
    },
  };
}
