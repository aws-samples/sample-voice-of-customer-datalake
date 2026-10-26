import { defineConfig } from 'vitest/config'
import { changelogPlugin } from './changelogPlugin'
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
    // Reuse single jsdom environment across all tests
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
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
      '@': path.resolve(__dirname, './src'),
      '@test': path.resolve(__dirname, './src/test'),
    },
  },
})
