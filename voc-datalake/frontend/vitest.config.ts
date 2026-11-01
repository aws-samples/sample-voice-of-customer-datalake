import { defineConfig } from 'vitest/config'
import { changelogPlugin } from './changelogPlugin.ts'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react(), changelogPlugin()],
  define: {
    // Mirror vite.config.ts's build-id stamp (issue #191) — a stable value
    // in tests so assertions on versioned URLs are deterministic.
    'import.meta.env.APP_VERSION': JSON.stringify('test'),
    // Mirror the Version card's build stamps (vite.config.ts) with fixed values.
    'import.meta.env.PLATFORM_VERSION': JSON.stringify('3.4.0'),
    'import.meta.env.BUILD_COMMIT': JSON.stringify('abc1234'),
    'import.meta.env.BUILD_TIME': JSON.stringify('2026-01-02T03:04:05.000Z'),
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 10000,
    // The per-file coverage gate (docs/coverage-gate.md) reads this through scripts/validate.sh, which adds
    // `--coverage.enabled --coverage.reporter=json-summary` on the command line.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      // Every source file, so a file no test imports reports 0 % instead of disappearing from the report.
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        // Spec files and test-only data are not production code.
        'src/**/*.{test,spec}.{ts,tsx}',
        'src/**/*-fixtures.{ts,tsx}',
        'src/**/__fixtures__/**',
        'node_modules/',
        'dist/',
        'public/',
        'src/test/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/main.tsx',
        'mock-server.js',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      '@test': path.resolve(import.meta.dirname, './src/test'),
    },
  },
})
