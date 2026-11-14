import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run dev:https` (or DEV_HTTPS=true) serves the dev client over HTTPS with a
// self-signed certificate. Browsers only allow microphone / camera on https:// or
// http://localhost, so use this to test voice from another device on your network.
export default defineConfig(({ mode }) => {
  const https = mode === 'https' || /^(1|true|yes)$/i.test(process.env.DEV_HTTPS || '');
  const apiTarget = process.env.API_URL || 'http://localhost:3001';
  return {
    plugins: [react(), ...(https ? [basicSsl()] : [])],
    server: {
      port: 5173,
      host: true, // listen on your LAN too, so other devices can connect
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
        '/uploads': { target: apiTarget, changeOrigin: true },
        '/emojis': { target: apiTarget, changeOrigin: true },
        '/gateway': { target: apiTarget.replace(/^http/, 'ws'), ws: true },
      },
      fs: { allow: ['..'] },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 1500,
    },
  };
});
