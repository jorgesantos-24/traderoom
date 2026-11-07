import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const API = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3000';
const WS = process.env.VITE_WS_TARGET ?? 'ws://127.0.0.1:3001';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Bundle the shared package from source in every mode, so the build never picks up a stale dist/.
  resolve: {
    alias: { '@traderoom/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) },
  },
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
    // Same-origin in dev, like Caddy in prod. Origin is forwarded untouched so the WS gateway's check still applies.
    proxy: {
      '/api': { target: API },
      '/ws': { target: WS, ws: true },
    },
  },
  build: { target: 'es2022', sourcemap: true },
});
