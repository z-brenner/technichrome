import { defineConfig } from 'vite';

// The RAW decoder (libraw-wasm) is a pthreads build and needs SharedArrayBuffer, which browsers only
// enable on cross-origin-isolated pages. public/_headers sets the same headers on Cloudflare Pages.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  build: { target: 'es2022', sourcemap: true },
  optimizeDeps: { exclude: ['libraw-wasm'] },
  worker: { format: 'es' },
});
