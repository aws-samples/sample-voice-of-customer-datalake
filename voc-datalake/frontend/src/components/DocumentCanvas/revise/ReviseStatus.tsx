/**
 * @fileoverview A failed "Revise from comments" pass (the toolbar's AI rewrite, DocumentToolbar), above the canvas: its
 * reason as an alert. Why a pass cannot start is the button's tooltip (reviseChanges `reviseBlockedReason`); its
 * running state is the toolbar's polite status.
 *
 * @module components/DocumentCanvas/revise/ReviseStatus
 */
import { useTranslation } from 'react-i18next'
import type { RevisePass } from './useRevisePass'

/** A pass that failed: the server's reason (no threads yet, a stale version), else a generic one. */
export function ReviseFailure({ pass }: Readonly<{ pass: RevisePass }>) {
  const { t } = useTranslation('projectDetail')
  if (pass.kind !== 'failed') return null
  return <p role="alert" className="mb-3 text-xs text-danger">{pass.message ?? t('canvas.revise.failed')}</p>
}
