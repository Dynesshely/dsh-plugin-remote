import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

/**
 * Keep the stylesheet out of the first paint's critical path.
 *
 * Vite emits a render-blocking `<link rel="stylesheet">`, which on a slow link delays the first paint
 * until the whole sheet has arrived — long after the inline splash in the document could have been
 * visible. Loading it as a preload and promoting it on arrival lets the shell paint immediately; the
 * `noscript` copy keeps the page correct with scripting disabled. The page's CSP allows inline handlers,
 * so no extra file is needed for the two words of JavaScript this costs.
 * @returns the Vite plugin.
 */
function nonBlockingStylesheet () {
  return {
    name: 'rc-non-blocking-stylesheet',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler (html) {
        return html.replace(
          /<link rel="stylesheet"([^>]*)href="([^"]+)"([^>]*)>/gu,
          (_match, before, href, after) => `<link rel="preload" as="style"${before}href="${href}"${after} onload="this.rel='stylesheet'">`
            + `<noscript><link rel="stylesheet"${before}href="${href}"${after}></noscript>`,
        )
      },
    },
  }
}

// The bundle is served by the DSH Host plugin from `/`, possibly under a proxy prefix, so every
// asset reference has to stay relative.
export default defineConfig({
  base: './',
  plugins: [vue(), tailwindcss(), nonBlockingStylesheet()],
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
