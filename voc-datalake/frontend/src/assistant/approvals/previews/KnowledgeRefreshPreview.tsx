/**
 * @fileoverview The knowledge refresh card (`propose_knowledge_refresh`): what Approve does, read with the signed-in
 * person's own session. With the Understand flow saved: the action, the repository connection, the commit (the
 * model's, or the default branch's head, whose full id the administrator enters here: this deployment cannot read a
 * branch yet), the language, the flow and its budget, and the estimate of the minutes and the cost, called one. With
 * none saved: that Approve saves it from its template and starts nothing. Approve is held until the card has what it
 * needs (the flows read, a full commit id), and what it shows is what the executor does (shown.ts).
 *
 * @module assistant/approvals/previews/KnowledgeRefreshPreview
 */
import { useContext, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  DRAFT_MINUTES, FULL_COMMIT, SECONDS_PER_SHARD, STANDARD_SESSION, refreshEstimate,
} from '@stream/assistant/tools/knowledge-refresh-rules'
import { EnumSelectField } from '../../../components/LabeledField/EnumSelectField'
import { LabeledField } from '../../../components/LabeledField/LabeledField'
import { isEngineeringAvailable } from '../../../runtimeConfig'
import { RUN_LANGUAGES } from '../../../pages/Agents/startRunRules'
import { ApprovalHoldContext, ShownContext, recordKnowledgeRefresh } from '../shown'
import type { KnowledgeRefreshShown } from '../shown'
import { findUnderstandFlow, understandFlowKey } from '../understandFlow'
import { CardNote, FieldTable } from './FieldDiff'
import { Code, Muted } from './ScraperValues'
import { fieldRow } from './format'
import type { RunLanguage } from '../../../pages/Agents/startRunRules'
import type { ProposeKnowledgeRefreshArgs } from '../knowledgeSchemas'
import type { UnderstandFlow } from '../understandFlow'

const K = 'preview.knowledgeRefresh'

const isFullCommit = (value: string): boolean => FULL_COMMIT.test(value.trim())

/** What Approve does for the flow found (undefined: not read yet), on the card's commit and language. */
function approveDoes(found: UnderstandFlow | null | undefined, commit: string, language: RunLanguage): KnowledgeRefreshShown | undefined {
  if (found === undefined) return undefined
  if (found === null) return { mode: 'create' }
  return { mode: 'start', workflowId: found.workflowId, revision: found.revision, commit: commit.trim().toLowerCase(), language }
}

function Problem({ text }: Readonly<{ text: string }>) {
  return <p role="alert" className="rounded-md border border-warn/30 bg-warn-subtle p-2 text-[12px] text-text">{text}</p>
}

function CommitField({ value, onChange }: Readonly<{ value: string; onChange: (value: string) => void }>) {
  const { t } = useTranslation(['assistantTools', 'agents'])
  const invalid = value.trim() !== '' && !isFullCommit(value)
  return (
    <LabeledField label={t('agents:startRun.fields.commit')} hint={invalid ? t('agents:startRun.invalid.commit') : t(`${K}.commitHint`)}
      hintTone={invalid ? 'danger' : 'muted'}>
      {(id) => (
        <input id={id} className="input w-full font-mono" value={value} autoComplete="off" spellCheck={false}
          aria-invalid={invalid} aria-describedby={`${id}-hint`} onChange={(event) => onChange(event.target.value)} />
      )}
    </LabeledField>
  )
}

function StartBody({ args, flow, commit, language, onCommit, onLanguage }: Readonly<{
  args: ProposeKnowledgeRefreshArgs; flow: UnderstandFlow; commit: string; language: RunLanguage
  onCommit: (value: string) => void; onLanguage: (value: RunLanguage) => void
}>) {
  const { t, i18n } = useTranslation(['assistantTools', 'agents'])
  const money = (amount: number) => new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD' }).format(amount)
  const estimate = refreshEstimate(flow.shardCap, flow.agentSteps)
  const rows = [
    fieldRow('action', t(`${K}.actionLabel`), t(`${K}.action`)),
    fieldRow('repository', t(`${K}.repository`), <Code text={args.connection} />),
    fieldRow('commit', t(`${K}.commit`), args.commit === undefined
      ? <Muted text={t(`${K}.head`)} /> : <Code text={args.commit.toLowerCase()} />),
    fieldRow('flow', t(`${K}.flow`), t(`${K}.flowName`, { name: flow.name, revision: flow.revision })),
    fieldRow('estimate', t(`${K}.estimateLabel`), t(`${K}.estimate`, {
      minutes: estimate.minutes, cost: money(estimate.sessionUsd),
    })),
  ]
  return (
    <div className="space-y-2">
      <FieldTable rows={rows} label={t(`${K}.label`)} />
      {args.commit === undefined && <CommitField value={commit} onChange={onCommit} />}
      <EnumSelectField<RunLanguage> label={t('agents:startRun.fields.language')} hint={t('agents:startRun.hints.language')}
        choices={RUN_LANGUAGES} value={language} display={(choice) => t(`agents:startRun.languages.${choice}`)}
        onChange={onLanguage} />
      <p className="text-[12px] text-muted">{t(`${K}.estimateBasis`, {
        shards: flow.shardCap, seconds: SECONDS_PER_SHARD, draft: DRAFT_MINUTES, rate: money(estimate.sessionUsdPerHour),
        sessions: estimate.sessions,
        vcpus: STANDARD_SESSION.vcpus, gb: STANDARD_SESSION.gb,
      })}</p>
      <p className="text-[12px] text-muted">{flow.monthlyBudgetUsd === null
        ? t('agents:startRun.noBudget') : t('agents:startRun.budget', { amount: money(flow.monthlyBudgetUsd) })}</p>
      <CardNote text={t(`${K}.asYou`)} />
    </div>
  )
}

export function KnowledgeRefreshPreview({ args }: Readonly<{ args: ProposeKnowledgeRefreshArgs }>) {
  const { t } = useTranslation('assistantTools')
  const shown = useContext(ShownContext)
  const hold = useContext(ApprovalHoldContext)
  const available = isEngineeringAvailable()
  const flow = useQuery({ queryKey: understandFlowKey, queryFn: findUnderstandFlow, enabled: available, retry: false })
  const [commit, setCommit] = useState(args.commit?.toLowerCase() ?? '')
  const [language, setLanguage] = useState<RunLanguage>(args.language ?? 'python')
  const found = available && flow.isSuccess ? flow.data : undefined
  const commitReady = isFullCommit(commit)

  // What Approve does, recorded as the card shows it (the executor does exactly this, or nothing).
  useEffect(() => {
    const what = approveDoes(found, commit, language)
    if (shown !== null) recordKnowledgeRefresh(shown, what)
    hold(what === undefined || (what.mode === 'start' && !commitReady))
  }, [shown, hold, found, commit, commitReady, language])

  if (!available) return <Problem text={t(`${K}.moduleOff`)} />
  if (flow.isError) return <Problem text={t(`${K}.readFailed`)} />
  if (found === undefined) return <p role="status" className="text-[12px] text-muted">{t(`${K}.looking`)}</p>
  if (found === null) {
    return (
      <div className="space-y-2">
        <Problem text={t(`${K}.notSaved`, { connection: args.connection })} />
        <CardNote text={t(`${K}.createNote`)} />
      </div>
    )
  }
  return <StartBody args={args} flow={found} commit={commit} language={language} onCommit={setCommit} onLanguage={setLanguage} />
}
