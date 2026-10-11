import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ site }) => {
  if (!site) throw new Error('Astro site URL is required to generate robots.txt');

  return new Response(`User-agent: *\nAllow: /\nSitemap: ${new URL('/sitemap-index.xml', site)}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
