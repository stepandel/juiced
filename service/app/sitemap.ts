import type { MetadataRoute } from 'next';
import { guides } from '../src/guides';
import { site } from '../src/site';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    '/',
    '/docs',
    ...guides.map(({ slug }) => `/docs/${slug}`),
    '/pricing',
  ].map((path) => ({
    url: path === '/' ? site.url : new URL(path, site.url).href,
  }));
}
