import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { changelogPlugin } from './changelogPlugin'

/**
 * Build id for cache-busting runtime-fetched locale JSONs (issue #191).
 * Derived from the git HEAD commit so identical source produces identical
 * bundles — a content-neutral redeploy keeps clients cache-warm, and
 * post-#188 no-cache headers cover same-sha freshness regardless.
 *
 * Resolution order: CI-provided sha env vars, then .git (read via fs —
 * sonarjs/no-os-command-from-path bans PATH-resolved commands, and fs is
 * faster than spawning git), then a timestamp. Handles ref indirection,
 * detached HEAD, packed refs (fresh clones pack refs, so CI would
 * otherwise always hit the fallback), and worktree/submodule `.git`
 * files (gitdir: indirection).
 *
 * Known trade-off: a dirty working tree stamps the clean HEAD sha
 * (dirty detection needs `git status`, which the lint rule above bans).
 * Deploys are expected to come from committed trees, and #188's
 * no-cache headers keep same-sha fetches revalidating regardless.
 */
function buildId(): string {
  return gitShortSha() ?? `${Date.now()}`
}

/** The short HEAD sha (what `git rev-parse --short HEAD` prints, read via fs
 * for the reason above), or null without git (a tarball). Never throws. */
function gitShortSha(): string | null {
  const ciSha = [process.env.GITHUB_SHA, process.env.CODEBUILD_RESOLVED_SOURCE_VERSION]
    .find((value) => value !== undefined && value !== '')
  if (ciSha !== undefined) return ciSha.slice(0, 7)
  try {
    const gitDir = resolveGitDir()
    if (gitDir === null) return null
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    if (!head.startsWith('ref: ')) return head.slice(0, 7) // detached HEAD
    const sha = resolveRef(gitDir, head.slice(5))
    return sha !== null ? sha.slice(0, 7) : null
  } catch {
    return null
  }
}

/** Repo root (the frontend lives at voc-datalake/frontend), where package.json carries the platform version. */
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** The platform version from the repo-root package.json, 'unknown' when unreadable. */
function platformVersion(): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed && typeof parsed.version === 'string') {
      return parsed.version
    }
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Locate the actual git directory: find-up for `.git`, following the
 * `gitdir: <path>` indirection used by worktrees and submodules. */
function resolveGitDir(): string | null {
  const found = findUp('.git')
  if (found === null) return null
  // One read decides: a directory is the git dir itself; a file holds the pointer.
  const content = readGitDirPointer(found)
  if (content === null) return found
  if (!content.startsWith('gitdir: ')) return null
  const target = content.slice(8)
  return isAbsolute(target) ? target : join(dirname(found), target)
}

/** The text of `.git` when it is a pointer FILE (worktrees, submodules); null when it is the directory. */
function readGitDirPointer(found: string): string | null {
  try {
    return readFileSync(found, 'utf8').trim()
  } catch (error: unknown) {
    // EISDIR: `.git` is the real directory, which is the common case.
    if (error instanceof Error && 'code' in error && error.code === 'EISDIR') return null
    throw error
  }
}

/** Resolve a symbolic ref to a sha: loose ref file first, then packed-refs
 * (fresh clones pack their refs — lines are `<sha> <ref>`). Linked
 * worktrees keep HEAD in their private gitdir but refs/packed-refs in the
 * COMMON dir (the `commondir` file points there), so refs resolve against
 * that base when present. */
function resolveRef(gitDir: string, ref: string): string | null {
  const refsBase = refsBaseDir(gitDir)
  const loose = join(refsBase, ref)
  if (existsSync(loose)) return readFileSync(loose, 'utf8').trim()
  const packedPath = join(refsBase, 'packed-refs')
  if (!existsSync(packedPath)) return null
  const line = readFileSync(packedPath, 'utf8')
    .split('\n')
    .find((entry) => !entry.startsWith('#') && !entry.startsWith('^') && entry.endsWith(` ${ref}`))
  return line?.split(' ')[0] ?? null
}

/** Base directory for refs: the worktree common dir when `commondir`
 * exists, otherwise the gitdir itself. */
function refsBaseDir(gitDir: string): string {
  const commonDirFile = join(gitDir, 'commondir')
  if (!existsSync(commonDirFile)) return gitDir
  const target = readFileSync(commonDirFile, 'utf8').trim()
  return isAbsolute(target) ? target : join(gitDir, target)
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
  plugins: [react(), tailwindcss(), changelogPlugin()],
  define: {
    global: 'globalThis',
    // Namespaced under import.meta.env: a bare identifier define would be
    // replaced ANYWHERE the identifier appears in source (Vite does
    // identifier-level substitution), silently corrupting unrelated code.
    'import.meta.env.APP_VERSION': JSON.stringify(buildId()),
    // The Administration > Version card (pages/Settings/buildInfo.ts); vitest.config.ts pins
    // fixed values so specs are deterministic. Stamped once per server start in dev.
    'import.meta.env.PLATFORM_VERSION': JSON.stringify(platformVersion()),
    'import.meta.env.BUILD_COMMIT': JSON.stringify(gitShortSha() ?? 'unknown'),
    'import.meta.env.BUILD_TIME': JSON.stringify(new Date().toISOString()),
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
