/**
 * @fileoverview The Set up dialog's fix for a failing way of working (7.50.02; docs ux-agents-redesign S5): an agent
 * not enabled yet runs as the person setting it up, whose stored way of working its pushes follow (readiness `dial`:
 * nothing saved, or Human-driven, pushes nothing).
 *
 * **Set mine to AI-driven** opens an inline confirm (a labelled group that takes focus) naming both effects: the
 * automations the person enables may push to `voc-agent/*` branches and open pull requests, and AI may write their
 * PR/FAQs and PRDs. Only **Set to AI-driven** there saves, the caller's OWN way of working (`PUT /users/me/ai-mode`,
 * aiModeApi.ts `saveMine`: never another person's); **Cancel** saves nothing. Then the dialog's readiness and the
 * caller's way of working are read again.
 *
 * @module pages/Agents/DialFix
 */
import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { aiModeApi } from '../../api/aiModeApi'
import { myAiModeKey } from '../../api/queryKeys'
import { WAY_OF_WORKING_CHECK, engineeringReadinessKeys } from '../../api/engineeringReadinessApi'
import { serverReason } from '../../lib/errors'
import type { ReadinessCheck, ReadinessSubject } from '../../api/engineeringReadinessApi'

/** Whether `checks` hold a failing way of working (the one this fix sets). */
const dialFails = (checks: readonly ReadinessCheck[] | undefined): boolean =>
  checks?.some((check) => check.id === WAY_OF_WORKING_CHECK && check.status === 'fail') ?? false

/** The inline confirm: what AI-driven changes, its one saving button and Cancel; it takes focus when it opens. */
function DialConfirm({ busy, onConfirm, onCancel }: Readonly<{ busy: boolean; onConfirm: () => void; onCancel: () => void }>) {
  const { t } = useTranslation('agents')
  const textId = useId()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.focus() }, [])
  return (
    <div ref={ref} role="group" aria-labelledby={textId} tabIndex={-1} className="space-y-2 focus-ring rounded-md">
      <p id={textId} className="text-[12px] text-text">{t('readiness.dialConfirm')}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" aria-disabled={busy} onClick={() => { if (!busy) onConfirm() }}>
          {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} {t('readiness.dialConfirmAction')}
        </button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </div>
  )
}

/** The fix, shown while the readiness of `subject` (the dialog's selection) has a failing way of working. */
export function DialFix({ subject, checks }: Readonly<{ subject: ReadinessSubject; checks: readonly ReadinessCheck[] | undefined }>) {
  const { t } = useTranslation('agents')
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const save = useMutation({
    mutationFn: () => aiModeApi.saveMine('ai_driven'),
    onSuccess: () => {
      setConfirming(false)
      // (the agent's own entry starts every preview's key: the dialog's selection is read again with it)
      const agentKey = 'automation' in subject ? engineeringReadinessKeys.of({ automation: subject.automation }) : engineeringReadinessKeys.of(subject)
      void queryClient.invalidateQueries({ queryKey: agentKey })
      void queryClient.invalidateQueries({ queryKey: myAiModeKey() })
    },
  })
  if (!dialFails(checks)) return null
  return (
    <div className="space-y-2 rounded-md border border-border p-2" data-testid="dial-fix">
      {confirming
        ? <DialConfirm busy={save.isPending} onConfirm={() => { save.mutate() }} onCancel={() => { setConfirming(false) }} />
        : (
            <button type="button" className="btn btn-secondary" onClick={() => { save.reset(); setConfirming(true) }}>
              {t('readiness.setDialMine')}
            </button>
          )}
      {save.isSuccess && <p role="status" className="text-[12px] text-ok">{t('readiness.dialSaved')}</p>}
      {save.isError && <p role="alert" className="text-[12px] text-danger">{serverReason(save.error) ?? t('readiness.dialFailed')}</p>}
    </div>
  )
}
