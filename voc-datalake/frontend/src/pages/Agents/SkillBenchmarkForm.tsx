/**
 * @fileoverview Agents → Skills → Record benchmark (a proposed version with none): the pass rates before and after in
 * percent, the cases, whether the gate passed and its reasons, and the failure's case, prefilled with the case a
 * coach's version expects to gain on (the server takes no other for it). Recorded once: the version is measured for
 * good. Checked here first (skillActionRules.ts readBenchmark), then by the server.
 *
 * @module pages/Agents/SkillBenchmarkForm
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { readBenchmark } from './skillActionRules'
import { useSkillAction } from './useSkillAction'
import { ActionFailureLine, Field, ReasonField } from './SkillActionParts'
import type { BenchmarkFields, BenchmarkProblem } from './skillActionRules'
import type { ActionTarget } from './SkillActionParts'

export function SkillBenchmarkForm({ target, onClose }: Readonly<{ target: ActionTarget; onClose: () => void }>) {
  const { t } = useTranslation('agents')
  const { connection, role, detail } = target
  const [fields, setFields] = useState<BenchmarkFields>({
    before: '', after: '', cases: detail.expected_case, passed: false, reasons: '', failureCase: detail.expected_case,
    runRef: '',
  })
  const [problem, setProblem] = useState<BenchmarkProblem | null>(null)
  const [reason, setReason] = useState('')
  const action = useSkillAction(connection, role, detail.version, onClose)
  const set = (name: keyof BenchmarkFields) => (value: string | boolean) => setFields((was) => ({ ...was, [name]: value }))
  const submit = () => {
    const read = readBenchmark(fields)
    setProblem(read.ok ? null : read.problem)
    if (read.ok) action.run({ body: { action: 'benchmark', expected_status: detail.status, ...read.benchmark }, reason })
  }
  return (
    <ConfirmModal isOpen title={t('skills.actions.benchmark.title', { version: detail.version })}
      message={t('skills.actions.benchmark.message')} confirmLabel={t('skills.actions.benchmark.confirm')} variant="info"
      isLoading={action.pending} confirmDisabled={action.failure?.kind === 'changed'} onConfirm={submit} onCancel={onClose}>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Field label={t('skills.actions.benchmark.before')}>{(id) => (
          <input id={id} className="input w-full" inputMode="decimal" value={fields.before} onChange={(e) => set('before')(e.target.value)} />)}</Field>
        <Field label={t('skills.actions.benchmark.after')}>{(id) => (
          <input id={id} className="input w-full" inputMode="decimal" value={fields.after} onChange={(e) => set('after')(e.target.value)} />)}</Field>
      </div>
      <div className="mt-3 space-y-3">
        <Field label={t('skills.actions.benchmark.cases')}>{(id) => (
          <textarea id={id} className="input w-full" rows={2} value={fields.cases} onChange={(e) => set('cases')(e.target.value)} />)}</Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={fields.passed} onChange={(e) => set('passed')(e.target.checked)} />
          {t('skills.actions.benchmark.passed')}
        </label>
        <Field label={t('skills.actions.benchmark.reasons')}>{(id) => (
          <textarea id={id} className="input w-full" rows={3} value={fields.reasons} onChange={(e) => set('reasons')(e.target.value)} />)}</Field>
        <Field label={t('skills.actions.benchmark.failureCase')}>{(id) => (
          <input id={id} className="input w-full" value={fields.failureCase} onChange={(e) => set('failureCase')(e.target.value)} />)}</Field>
        <Field label={t('skills.actions.benchmark.runRef')}>{(id) => (
          <input id={id} className="input w-full" maxLength={300} value={fields.runRef} onChange={(e) => set('runRef')(e.target.value)} />)}</Field>
        <ReasonField value={reason} onChange={setReason} />
      </div>
      {problem !== null && <p role="alert" className="mt-3 text-sm text-danger">{t(`skills.actions.benchmark.invalid.${problem}`)}</p>}
      <ActionFailureLine failure={action.failure} />
    </ConfirmModal>
  )
}
