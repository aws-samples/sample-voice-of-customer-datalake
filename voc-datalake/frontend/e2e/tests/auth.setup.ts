/**
 * Signs both e2e users in through the real Cognito login page and saves each
 * session (localStorage `voc-auth`) for the other specs. Evidence for the
 * login step itself is recorded like any other step.
 */
import fs from 'node:fs'
import { test as setup } from '@playwright/test'
import { AUTH_DIR, ROLES, storageStatePath } from '../lib/env'
import { StepRecorder } from '../lib/recorder'
import { loginThroughUi } from '../lib/session'

for (const role of ROLES) {
  setup(`login ${role}`, async ({ page }) => {
    fs.mkdirSync(AUTH_DIR, { recursive: true })
    const recorder = new StepRecorder(page, role, 'dark', 'login')
    try {
      await loginThroughUi(page, role)
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined)
      await page.context().storageState({ path: storageStatePath(role) })
      fs.chmodSync(storageStatePath(role), 0o600)
      await recorder.finish({ ok: true, audit: false })
    } catch (error) {
      await recorder.finish({ ok: false, error: String(error).slice(0, 500), audit: false })
      throw error
    }
  })
}
