import { defineConfig } from 'vite';

// The RAW decoder (libraw-wasm) is a pthreads build and needs SharedArrayBuffer, which browsers only
// enable on cross-origin-isolated pages. vercel.json sets the same headers in production.
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
