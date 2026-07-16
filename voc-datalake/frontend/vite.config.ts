import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'

/**
 * Build id for cache-busting runtime-fetched locale JSONs (issue #191).
 * Derived from the git commit (plus a -dirty marker for uncommitted trees)
 * so identical source produces identical bundles — a content-neutral
 * redeploy keeps clients cache-warm. Post-#188 fetches revalidate via
 * no-cache headers regardless, so a same-sha deploy loses nothing.
 * Falls back to a timestamp where git isn't available (CI tarballs).
 */
function buildId(): string {
  try {
    const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim() !== ''
    return dirty ? `${sha}-dirty` : sha
  } catch {
    return `${Date.now()}`
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    global: 'globalThis',
    // Namespaced under import.meta.env: a bare identifier define would be
    // replaced ANYWHERE the identifier appears in source (Vite does
    // identifier-level substitution), silently corrupting unrelated code.
    'import.meta.env.APP_VERSION': JSON.stringify(buildId()),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-recharts': ['recharts'],
          'vendor-icons': ['lucide-react'],
          'vendor-query': ['@tanstack/react-query'],
          'vendor-i18n': ['i18next', 'react-i18next', 'i18next-browser-languagedetector', 'i18next-http-backend'],
          'vendor-markdown': ['react-markdown', 'remark-gfm'],
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
