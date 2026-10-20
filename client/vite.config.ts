import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // Never ship source maps in production — keep the original source
    // out of the deployed bundle (deliberate, don't remove).
    sourcemap: false,
  },
  server: {
    // In dev, the Vite server proxies API calls to the Express server.
    proxy: { '/api': 'http://localhost:4000' },
  },
});
