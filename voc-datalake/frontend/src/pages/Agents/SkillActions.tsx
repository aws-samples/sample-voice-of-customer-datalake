/**
 * @fileoverview Agents → Skills → a version's actions (administrators): Accept and Reject on a proposed version,
 * Roll back to this version on an earlier accepted one, and Record benchmark on a proposed version with none
 * (SkillBenchmarkForm.tsx). Each opens an approval card first: a confirmation that says exactly what changes (from
 * which version to which, the change's summary, and for a coach's version its benchmark), with an optional reason.
 * Accept stays off, with the reason shown, for a coach's version without a benchmark that passed with a gain on its
 * expected case. A 409 (it changed since the screen read it) reads everything again and says so.
 *
 * @module pages/Agents/SkillActions
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { BenchmarkLines } from './SkillHistory'
import { SkillBenchmarkForm } from './SkillBenchmarkForm'
import { baseIsInUse, inUse, offeredActions, useVersionName } from './skillActionRules'
import { useSkillAction } from './useSkillAction'
import { ActionFailureLine, ReasonField } from './SkillActionParts'
import type { ActionTarget } from './SkillActionParts'

type Card = 'accept' | 'reject' | 'rollback' | 'benchmark' | null

/** The version an accepted proposal is written on, and a flag when that is not the version in use now. */
function BaseLine({ target }: Readonly<{ target: ActionTarget }>) {
  const { t } = useTranslation('agents')
  const name = useVersionName()
  const { base } = target.detail
  const written = base === null ? t('skills.noBase') : t('skills.actions.writtenOn', { version: name(base, target.connection) })
  return (
    <>
      <p className="mt-2 text-sm">{written}</p>
      {!baseIsInUse(target) && (
        <p className="mt-1 text-sm text-warn" role="note">
          {t('skills.actions.baseNotInUse', { current: name(inUse(target), target.connection) })}
        </p>
      )}
    </>
  )
}

/** The approval card of Accept, Reject or Roll back: what changes, the summary, the benchmark, a reason. */
function ApprovalCard({ card, target, onClose }: Readonly<{ card: 'accept' | 'reject' | 'rollback'; target: ActionTarget; onClose: () => void }>) {
  const { t } = useTranslation('agents')
  const name = useVersionName()
  const { connection, role, detail, current } = target
  const [reason, setReason] = useState('')
  const action = useSkillAction(connection, role, detail.version, onClose)
  const to = name({ shared: connection === '', version: detail.version }, connection)
  const from = name(inUse(target), connection)
  const confirm = () => {
    if (card === 'accept') action.run({ body: { action: 'accept', expected_status: detail.status, expected_current: current }, reason })
    else if (card === 'reject') action.run({ body: { action: 'reject', expected_status: detail.status }, reason })
    else action.run({ body: { action: 'rollback', expected_current: current }, reason })
  }
  return (
    <ConfirmModal isOpen title={t(`skills.actions.${card}.title`, { version: detail.version })}
      message={t(`skills.actions.${card}.message`, { from, to, version: detail.version })}
      confirmLabel={t(`skills.actions.${card}.confirm`)} variant={card === 'reject' ? 'danger' : 'warning'}
      isLoading={action.pending} confirmDisabled={action.failure?.kind === 'changed'} onConfirm={confirm} onCancel={onClose}>
      <p className="mt-3 text-sm text-text-strong break-words [overflow-wrap:anywhere]">{detail.summary}</p>
      {card === 'accept' && <BaseLine target={target} />}
      {detail.proposed_by_kind === 'agent' && card === 'accept' && <div className="mt-2"><BenchmarkLines benchmark={detail.benchmark} /></div>}
      <div className="mt-3"><ReasonField value={reason} onChange={setReason} /></div>
      <ActionFailureLine failure={action.failure} />
    </ConfirmModal>
  )
}

export function SkillActions({ target }: Readonly<{ target: ActionTarget }>) {
  const { t } = useTranslation('agents')
  const heldId = useId()
  const [card, setCard] = useState<Card>(null)
  const offered = offeredActions(target.detail, target.current)
  const close = () => setCard(null)
  if (!offered.accept && !offered.rollback) return null
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('skills.actions.label')}>
      {offered.accept && (
        // (held: aria-disabled, not disabled, so the button stays focusable and its reason reaches a keyboard user)
        <button type="button" className="btn btn-primary btn-sm" aria-disabled={offered.acceptHeld !== null}
          aria-describedby={offered.acceptHeld === null ? undefined : heldId}
          onClick={() => { if (offered.acceptHeld === null) setCard('accept') }}>
          {t('skills.actions.accept.button')}
        </button>
      )}
      {offered.reject && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCard('reject')}>{t('skills.actions.reject.button')}</button>}
      {offered.benchmark && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCard('benchmark')}>{t('skills.actions.benchmark.button')}</button>}
      {offered.rollback && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCard('rollback')}>{t('skills.actions.rollback.button')}</button>}
      {offered.acceptHeld !== null && <p id={heldId} className="w-full text-[12px] text-warn">{t(`skills.actions.held.${offered.acceptHeld}`)}</p>}
      {card === 'benchmark' && <SkillBenchmarkForm target={target} onClose={close} />}
      {card !== null && card !== 'benchmark' && <ApprovalCard card={card} target={target} onClose={close} />}
    </div>
  )
}
