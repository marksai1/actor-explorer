import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import base from './vite.config';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The published build: no server behind it, everything answered from the
 * encrypted snapshot on the device.
 *
 * This is a separate config rather than an environment variable so that
 * `npm run build:static` behaves the same in PowerShell, bash and CI without a
 * cross-env dependency.
 *
 * `BASE_PATH` is the one thing that changes per deployment. GitHub Pages serves
 * a project site from `/<repo>/`, so that has to be baked into the asset URLs;
 * a custom domain or a user site would set it to `/`.
 */
const BASE_PATH = process.env.BASE_PATH ?? '/actor-explorer/';

/**
 * GitHub Pages has no rewrite rule, so a reload on /person/123 is a 404. Every
 * static host that lacks SPA routing honours 404.html, and serving the app from
 * it turns the miss into a normal client-side route.
 */
function spaFallback(outDir: string) {
  return {
    name: 'spa-404-fallback',
    closeBundle() {
      const index = path.join(outDir, 'index.html');
      if (fs.existsSync(index)) fs.copyFileSync(index, path.join(outDir, '404.html'));
    },
  };
}

const outDir = path.resolve(here, '../dist-static');

export default defineConfig({
  ...base,
  base: BASE_PATH,
  plugins: [react(), spaFallback(outDir)],
  define: {
    'import.meta.env.VITE_STATIC': JSON.stringify('1'),
  },
  build: {
    outDir,
    emptyOutDir: true,
  },
});
