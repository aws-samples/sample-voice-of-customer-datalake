/**
 * `AppConfigCard`'s admin gate on Run and Delete.
 *
 * The gate shipped untested: reverting Run to `disabled={isRunning}` and dropping
 * `disabled={!isAdmin}` from Delete left all 146 tests under `src/pages/Scrapers`
 * passing. `PluginConfigModal.test.tsx` covers the equivalent gate in the modal, but
 * nothing rendered this card with `isAdmin={false}` — the prop threads
 * `Scrapers` → `AppConfigList` → `AppConfigCard` and was untested at every hop.
 *
 * This is the MORE reachable of the two surfaces: the card is on the Scrapers page
 * itself, always visible, while the modal is behind a click. The server refuses
 * either way (`POST /sources/{source}/run` and
 * `DELETE /integrations/{source}/apps/{id}` are admin-gated), so nothing was
 * exposed; what was unprotected is the gate itself against a future refactor.
 *
 * Each non-admin case asserts the CALLBACK was not invoked, not merely that the
 * button carries `disabled` — matching the convention in `PluginConfigModal.test.tsx`
 * of asserting the request is not issued. `disabled` on a styled button is easy to
 * render and easy to bypass; the mutation not happening is the observable.
 *
 * Buttons are located by their lucide `svg` class rather than by `title`, because
 * `title` is part of what these assertions are about: Run and Delete carry the same
 * admin-only value, so selecting on it would find the wrong button and could pass
 * with one of the two gates removed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { expectAdminGatedButton, expectEnabledButtonFires } from './scrapers-fixtures'
import { AppConfigCard } from './AppConfigComponents'
import type { PluginManifest } from '../../plugins/types'

const plugin: PluginManifest = {
  id: 'app_reviews_ios',
  name: 'iOS App Reviews',
  icon: 'iOS',
  description: 'Collect reviews from the App Store',
  config: [],
  enabled: true,
  hasIngestor: true,
  hasWebhook: false,
  hasS3Trigger: false,
}

const app = {
  id: 'a1',
  app_name: 'Zara',
  app_id: '547951480',
  frequency_minutes: '1440',
  max_reviews_per_run: '500',
}

const onEdit = vi.fn()
const onDelete = vi.fn()
const onRun = vi.fn()

function renderCard(isAdmin: boolean) {
  return render(
    <AppConfigCard
      app={app}
      plugin={plugin}
      isAdmin={isAdmin}
      onEdit={onEdit}
      onDelete={onDelete}
      onRun={onRun}
      isRunning={false}
    />
  )
}

describe('AppConfigCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('when the user is not an admin', () => {
    it('does not trigger a run', async () => {
      renderCard(false)

      await expectAdminGatedButton('lucide-play', onRun)
    })

    it('does not delete the app config', async () => {
      renderCard(false)

      await expectAdminGatedButton('lucide-trash2', onDelete)
    })
  })

  describe('when the user is an admin', () => {
    /**
     * Positive controls. Without these, disabling every button unconditionally
     * would satisfy both cases above while making the card useless for the
     * administrators it exists for.
     */
    it('triggers a run', async () => {
      renderCard(true)

      await expectEnabledButtonFires('lucide-play', onRun, 'Run now')
    })

    it('deletes the app config', async () => {
      renderCard(true)

      await expectEnabledButtonFires('lucide-trash2', onDelete, 'Delete')
    })
  })

  describe('regardless of admin status', () => {
    /**
     * The gate's boundary. Edit opens `PluginConfigModal`, whose `AppEditorForm`
     * Save carries the gate for `POST /integrations/{source}/apps` — asserted in
     * `PluginConfigModal.test.tsx`, not taken on trust, because the same claim
     * about `ScraperEditor`'s Save turned out to be false. Disabling Edit would
     * stop a non-admin READING a config the API already serves them
     * (`GET /integrations/{source}/apps` is deliberately open). Pinning it makes
     * that a decision rather than an omission, and stops a future "disable
     * everything for non-admins" from passing the cases above.
     */
    it.each([true, false])('opens the editor (isAdmin=%s)', async (isAdmin) => {
      renderCard(isAdmin)

      await expectEnabledButtonFires('lucide-settings', onEdit)
    })

    it.each([true, false])('renders the app details (isAdmin=%s)', (isAdmin) => {
      renderCard(isAdmin)

      expect(screen.getByText('Zara')).toBeInTheDocument()
      expect(screen.getByText('iOS')).toBeInTheDocument()
      expect(screen.getByText('500')).toBeInTheDocument()
    })
  })
})
