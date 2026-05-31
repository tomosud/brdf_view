import { defineConfig } from 'vite';

// GitHub Pages serves this repo under https://tomosud.github.io/brdf_view/.
// In dev we use '/', in production the repo subpath. Override with BASE_PATH if needed.
export default defineConfig(({ command }) => ({
  base: process.env.BASE_PATH ?? (command === 'build' ? '/brdf_view/' : '/'),
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
  server: {
    open: true,
  },
}));
