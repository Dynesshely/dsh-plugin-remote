import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// The bundle is served by the DSH Host plugin from `/`, possibly under a proxy prefix, so every
// asset reference has to stay relative.
export default defineConfig({
  base: './',
  plugins: [vue(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    assetsDir: 'assets',
    sourcemap: false,
    // highlight.js is bundled whole (all registered languages, for auto-detection and every fence
    // language), so the single chunk is deliberately larger than Vite's default warning threshold.
    // Assets are served with an immutable one-year cache, so this is paid once per deploy.
    chunkSizeWarningLimit: 1500,
  },
})
