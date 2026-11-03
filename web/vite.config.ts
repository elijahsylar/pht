/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';

// The Content-Security-Policy for the built page. One string, used by the
// plugin below and asserted by the deploy script and the UI check.
//
// img-src allows data: because 98.css draws its checkboxes, title-bar buttons
// and scrollbars with data: SVGs. No frame-ancestors here: browsers ignore it in
// a <meta> tag (and say so in the console); nginx sends X-Frame-Options DENY.
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// Injected at build time only. Vite's dev server injects CSS as inline <style>
// tags, which this policy (correctly) blocks, so `npm run dev` runs without it
// and every check of the policy runs against a build (`vite preview`).
function cspMeta(): Plugin {
  return {
    name: 'pht-csp-meta',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: () => [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
          injectTo: 'head-prepend',
        },
      ],
    },
  };
}

// Local only: the dev server and `vite preview` forward /api to pht-api's
// `npm run dev:fake` on port 4100, so the page is same-origin exactly as behind
// nginx and the client needs no base URL. 127.0.0.1 rather than "localhost":
// dev:fake binds IPv4 loopback only, and Node may resolve localhost to ::1.
// PHT_API_PORT is for the UI check, which runs its own dev:fake on another port.
const api = `http://127.0.0.1:${process.env.PHT_API_PORT ?? 4100}`;

export default defineConfig({
  plugins: [cspMeta()],
  build: {
    // The preload polyfill is an extra script the page does not need.
    modulePreload: { polyfill: false },
    sourcemap: false,
    // Never turn an asset into a data: URI: the policy only allows those as images.
    assetsInlineLimit: 0,
  },
  server: { host: '127.0.0.1', proxy: { '/api': api } },
  preview: { host: '127.0.0.1', proxy: { '/api': api } },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
  },
});
