/**
 * @fileoverview "Use as design system": ask the API for the saved design system
 * merged with a reference's extracted design, load it into the editor's draft
 * and remember what it changes for the banner. Nothing is saved here — the
 * admin reviews and presses Save (the existing PUT), or Discards.
 *
 * Unsaved edits are never replaced silently: with a dirty draft the admin is
 * asked first.
 *
 * @module pages/Company/useApplyReference
 */
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { designSystemApi } from '../../api/designSystemApi'
import type { DesignReference, DesignSystemBody } from '../../api/designSystemApi'
import { serverReason } from '../../lib/errors'
import { summarizeDraft, urlHost } from './designDraftSummary'
import type { AppliedReference } from './ApplyBanner'
import type { ApplyControls } from './DesignReferences'

/** How the banner names a reference: its title, else the link's host. */
function referenceLabel(reference: DesignReference): string {
  return reference.title.trim() || urlHost(reference.url ?? '') || reference.kind
}

export function useApplyReference({ saved, dirty, load }: Readonly<{
  /** The saved design system — what the summary compares against (and what the API merged into). */
  saved: DesignSystemBody | undefined
  dirty: boolean
  /** Replace the editor's draft. */
  load: (value: DesignSystemBody) => void
}>) {
  const { t } = useTranslation('settings')
  const [applied, setApplied] = useState<AppliedReference | null>(null)
  const [confirming, setConfirming] = useState<DesignReference | null>(null)
  const apply = useMutation({
    mutationFn: (reference: DesignReference) => designSystemApi.applyReference(reference.id),
    onSuccess: (draft, reference) => {
      const next = { tokens: draft.tokens, guidelines: draft.guidelines, components: draft.components }
      load(next)
      setApplied({ source: referenceLabel(reference), summary: summarizeDraft(saved ?? next, next) })
    },
    onSettled: () => setConfirming(null),
  })
  const request = (reference: DesignReference) => {
    if (dirty) setConfirming(reference)
    else apply.mutate(reference)
  }
  const controls: ApplyControls = {
    applyingId: apply.isPending ? apply.variables.id : null,
    applyErrorFor: (id) => (apply.isError && apply.variables.id === id
      ? serverReason(apply.error) ?? t('designSystem.applied.failed')
      : null),
    onApply: request,
  }
  const dialog = (
    <ConfirmModal
      isOpen={confirming !== null}
      title={t('designSystem.applied.replaceTitle')}
      message={t('designSystem.applied.replaceMessage', { title: confirming ? referenceLabel(confirming) : '' })}
      confirmLabel={t('designSystem.preview.apply')}
      variant="warning"
      isLoading={apply.isPending}
      onConfirm={() => { if (confirming) apply.mutate(confirming) }}
      onCancel={() => setConfirming(null)}
    />
  )
  return { controls, applied, clear: () => setApplied(null), dialog }
}
