import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react()],
  build: {
    outDir: path.resolve(here, '../dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // The client shares server/scoring.ts, which lives outside the Vite root.
    fs: { allow: [path.resolve(here, '..')] },
    // Listen on the LAN too, so the dev build is reachable from a phone.
    host: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.PORT ?? 8787}`,
        changeOrigin: true,
      },
    },
  },
});
