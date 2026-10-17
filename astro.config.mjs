// @ts-check
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  // Override with SITE_URL in your Vercel project settings once the domain is final.
  site: process.env.SITE_URL || 'https://x-web.vercel.app',
  // Static by default: every docs page is prerendered HTML.
  // The /api/* routes opt out with `export const prerender = false`
  // and are deployed as Vercel serverless functions.
  output: 'static',
  adapter: vercel(),
  integrations: [sitemap()],
  server: {
    // Allow the sandbox/preview host to reach the dev server.
    // This only affects `astro dev` and `astro preview` — never the production build.
    allowedHosts: true,
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
