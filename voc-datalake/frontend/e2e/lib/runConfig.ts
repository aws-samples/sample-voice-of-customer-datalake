/**
 * The Playwright settings both runners share (playwright.config.ts and
 * playwright.design.config.ts): serial, one worker, no retries, Chromium
 * headless, evidence under OUT_DIR. Each runner adds its timeouts and projects.
 */
import path from 'node:path'
import type { PlaywrightTestConfig } from '@playwright/test'
import { OUT_DIR } from './env'

export function sharedConfig(options: { timeout: number; use: PlaywrightTestConfig['use'] }): PlaywrightTestConfig {
  return {
    testDir: './tests',
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: options.timeout,
    expect: { timeout: 15_000 },
    outputDir: path.join(OUT_DIR, 'artifacts'),
    reporter: [['list'], ['json', { outputFile: path.join(OUT_DIR, 'playwright-results.json') }]],
    use: { browserName: 'chromium', headless: true, navigationTimeout: 45_000, ...options.use },
  }
}
