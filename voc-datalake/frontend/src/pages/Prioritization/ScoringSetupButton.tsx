/**
 * @fileoverview The header button that opens the scoring setup: "Scoring setup" (the
 * editor) for admins, "How scoring works" (read-only) for everyone else. The server's
 * `require_admin` is what refuses a non-admin save; this only decides what is offered.
 * @module pages/Prioritization/ScoringSetupButton
 */
import { lazy, Suspense, useState } from 'react'
import { Info, SlidersHorizontal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useIsAdmin } from '../../store/authStore'
import type { ReactElement } from 'react'

// Loaded on first open: most visits never open the setup.
const ScoringSetupDialog = lazy(() => import('./ScoringSetupDialog'))
const ScoringSetupView = lazy(() => import('./ScoringSetupView'))

export function ScoringSetupButton({ onSaved }: {
  /** After an admin's save landed — the page re-reads the board with the new setup. */
  readonly onSaved: () => void
}): ReactElement {
  const { t } = useTranslation('prioritization')
  const isAdmin = useIsAdmin()
  const [open, setOpen] = useState(false)
  const label = isAdmin ? t('setup.open') : t('setup.viewOpen')
  const Icon = isAdmin ? SlidersHorizontal : Info
  const close = () => setOpen(false)
  return (
    <>
      <button type="button" className="btn btn-secondary" onClick={() => setOpen(true)}>
        <Icon size={16} aria-hidden="true" />
        {/* Visible on phones too: a tooltip never shows on touch. */}
        <span>{label}</span>
      </button>
      {open ? (
        <Suspense fallback={null}>
          {isAdmin ? <ScoringSetupDialog onClose={close} onSaved={onSaved} /> : <ScoringSetupView onClose={close} />}
        </Suspense>
      ) : null}
    </>
  )
}
