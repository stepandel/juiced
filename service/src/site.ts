import type { Metadata } from 'next';

export const site = {
  name: 'Juiced',
  url: 'https://juiced.codes',
  github: 'https://github.com/stepandel/juiced',
  title: 'Juiced — Claude Code, with more juice.',
  description:
    'Juiced runs Claude Code in a private cloud workspace that you drive from your terminal. Close your laptop. Claude keeps working.',
};

// The root layout's title templates add the site name to plain titles.
export const titleTemplate = { default: site.title, template: `%s | ${site.name}` };

export function pageMetadata(
  title: string | { absolute: string },
  description: string,
  path: string,
): Metadata {
  const url = new URL(path, site.url).href;
  // A page's openGraph replaces the root one, including the file-based image.
  const images = [
    {
      url: `${site.url}/opengraph-image`,
      width: 1200,
      height: 630,
      alt: site.title,
    },
  ];
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: 'website',
      locale: 'en_US',
      siteName: site.name,
      title,
      description,
      url,
      images,
    },
    twitter: { card: 'summary_large_image', title, description, images },
  };
}
