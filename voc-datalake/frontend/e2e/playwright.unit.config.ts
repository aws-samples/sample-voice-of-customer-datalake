/**
 * Offline checks of the suite's own helpers (`unit/*.spec.ts`): no deployment,
 * no login, no credentials. The ledger writes to a throwaway E2E_OUT.
 *   npx playwright test -c playwright.unit.config.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineConfig } from '@playwright/test'

process.env['E2E_API'] ??= 'https://api.unit.example/v1'
const OUT = process.env['E2E_OUT'] ??= fs.mkdtempSync(path.join(os.tmpdir(), 'voc-e2e-unit-'))
process.env['E2E_RUN_ID'] ??= 'unit-1'

export default defineConfig({
  testDir: './unit',
  timeout: 30_000,
  reporter: 'line',
  // Playwright's own run state goes with the throwaway output, not into the repo.
  outputDir: path.join(OUT, 'test-results'),
})
