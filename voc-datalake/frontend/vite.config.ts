import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defineConfig } from 'vite'

/**
 * Build id for cache-busting runtime-fetched locale JSONs (issue #191).
 * Derived from the git HEAD commit so identical source produces identical
 * bundles — a content-neutral redeploy keeps clients cache-warm, and
 * post-#188 no-cache headers cover same-sha freshness regardless.
 * Read straight from .git (no child process: sonarjs/no-os-command-from-path
 * bans PATH-resolved commands, and fs is faster anyway). Falls back to a
 * timestamp when .git is absent (CI tarballs) or the ref is packed.
 */
function buildId(): string {
  try {
    const gitDir = findUp('.git')
    if (gitDir === null) return `${Date.now()}`
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    if (!head.startsWith('ref: ')) return head.slice(0, 7) // detached HEAD
    const refPath = join(gitDir, head.slice(5))
    if (!existsSync(refPath)) return `${Date.now()}` // packed ref — punt
    return readFileSync(refPath, 'utf8').trim().slice(0, 7)
  } catch {
    return `${Date.now()}`
  }
}

/** Walk up from cwd looking for a directory entry (monorepo: .git lives two levels up). */
function findUp(name: string): string | null {
  const step = (dir: string, depth: number): string | null => {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir || depth >= 6) return null
    return step(parent, depth + 1)
  }
  return step(process.cwd(), 0)
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
