/**
 * Design-track runner (tests/design-*.spec.ts): every screen and overlay as
 * both roles at desktop (1440) and mobile (390) widths, in both themes, with
 * the deep audit from lib/deepAudit.ts.
 *
 * Differs from playwright.config.ts on purpose:
 * - READ ONLY, so there is no `cleanup` teardown (it creates nothing to delete).
 * - `E2E_MOCK=1` runs against the local dev mock (DEV builds treat the session
 *   as an admin without Cognito), so there is no login step and only the admin
 *   projects run.
 *
 *   E2E_SITE=… E2E_API=… npx playwright test -c playwright.design.config.ts [--project=admin-desktop]
 */
import { defineConfig, type Project } from '@playwright/test'

// Same run id rule as playwright.config.ts (`<track>-<epoch ms>` with E2E_TRACK).
const { MOCK, storageStatePath, defaultRunId } = await import('./lib/env')
process.env['E2E_RUN_ID'] ??= defaultRunId()
const { sharedConfig } = await import('./lib/runConfig')

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } } as const

const roles = MOCK ? (['admin'] as const) : (['admin', 'user'] as const)
const auditProjects: Project[] = roles.flatMap((role) =>
  (Object.keys(VIEWPORTS) as Array<keyof typeof VIEWPORTS>).map((viewport): Project => ({
    name: `${role}-${viewport}`,
    testMatch: /design-.*\.spec\.ts/,
    dependencies: MOCK ? [] : ['setup'],
    metadata: { role, viewport },
    use: {
      viewport: VIEWPORTS[viewport],
      ...(viewport === 'mobile' ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
      ...(MOCK ? {} : { storageState: storageStatePath(role) }),
    },
  })))

export default defineConfig({
  ...sharedConfig({ timeout: 300_000, use: { actionTimeout: 15_000, trace: 'off' } }),
  projects: [
    ...(MOCK ? [] : [{ name: 'setup', testMatch: /auth\.setup\.ts/ }]),
    ...auditProjects,
  ],
})
