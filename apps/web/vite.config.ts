import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const API = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3000';
const WS = process.env.VITE_WS_TARGET ?? 'ws://127.0.0.1:3001';
/**
 * `LAN=1 npm run dev:web` opens the dev server to phones on the local network. The backend only
 * trusts PUBLIC_ORIGIN (localhost) and sets Secure cookies, which a phone drops over plain http on
 * a LAN IP; so in this mode the proxy presents requests as coming from localhost and strips Secure.
 * Dev only: never use it on an untrusted network.
 */
const LAN = process.env.LAN === '1';
const LOCAL_ORIGIN = 'http://localhost:5173';

type OutReq = { setHeader(k: string, v: string): void; getHeader(k: string): unknown };
type ProxyLike = {
  on(ev: 'proxyReq' | 'proxyReqWs', fn: (req: OutReq) => void): void;
  on(ev: 'proxyRes', fn: (res: { headers: Record<string, string | string[] | undefined> }) => void): void;
};
const lanProxy = (proxy: ProxyLike) => {
  if (!LAN) return;
  // `__Host-` cookies require Secure, so the phone gets them as `lan-…` and the API sees the real name.
  const asLocal = (req: OutReq) => {
    req.setHeader('origin', LOCAL_ORIGIN);
    const cookie = req.getHeader('cookie');
    if (typeof cookie === 'string') req.setHeader('cookie', cookie.replace(/(^|;\s*)lan-/g, '$1__Host-'));
  };
  proxy.on('proxyReq', asLocal);
  proxy.on('proxyReqWs', asLocal);
  proxy.on('proxyRes', (res) => {
    const c = res.headers['set-cookie'];
    if (Array.isArray(c)) res.headers['set-cookie'] = c.map((v) => v.replace(/^__Host-/, 'lan-').replace(/;\s*Secure/gi, ''));
  });
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Bundle the shared package from source in every mode, so the build never picks up a stale dist/.
  resolve: {
    alias: { '@traderoom/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)) },
  },
  server: {
    host: LAN ? '0.0.0.0' : 'localhost',
    port: 5173,
    strictPort: true,
    // Same-origin in dev, like Caddy in prod. Origin is forwarded untouched so the WS gateway's check still applies.
    proxy: {
      '/api': { target: API, configure: lanProxy },
      '/ws': { target: WS, ws: true, configure: lanProxy },
    },
  },
  build: { target: 'es2022', sourcemap: true },
});
