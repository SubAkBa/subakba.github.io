import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: process.env.SITE_URL ?? 'https://subakba.github.io',
  output: 'static',
  integrations: [sitemap({ filter: (page) => !/\/404(?:\/|\.html)?$/.test(page) })],
  markdown: {
    shikiConfig: {
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
    },
  },
});
