/**
 * @fileoverview Agents → Skills → **Propose a version** (gap M, D6-2; §6.3 Propose mode): an administrator writes a
 * version of their own on the one the scope runs, in a sheet, then reviews it before it is sent. It is a PROPOSAL
 * (`POST …/skills/<role>/versions`): it never applies itself, and is accepted or rejected like any other.
 *
 * - **Write**: a one-line summary (required), the instructions on the canvas (the SKILL.md body: the version's
 *   properties stay a read-only front-matter, split off and joined back byte for byte), the examples as a list, and an
 *   optional reason. Checked first (documents/skillDocument.ts `proposalIssues`: the bounds, no `## Examples`
 *   heading, something changed).
 * - **Review your change**: the instructions as a rendered block diff over the version it is written on (Source: the
 *   line diff), the examples added and removed. That shows what a rich edit re-serialised before anything is sent.
 * - A 409 means the scope runs another version now: **Read it again** reads it, keeps the draft, and the review then
 *   compares it with the version in use ("Written on v4; v6 is in use now"), so nothing is proposed over a change
 *   unseen.
 *
 * Closing with a draft asks first.
 *
 * @module pages/Agents/SkillProposeSheet
 */
import { useRef, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import DocumentDiff from '../../components/Document/diff/DocumentDiff'
import MarkdownEdit from '../../components/Document/edit/MarkdownEdit'
import PropertiesPanel from '../../components/Document/text/PropertiesPanel'
import { markdownPolicy } from '../../components/Document/read/markdownPolicy'
import { READING_TEXT_CLASS } from '../../components/Document/readingColumn'
import { splitFrontMatter } from '../../components/Document/text/frontMatter'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import SideSheet from '../../components/SideSheet/SideSheet'
import { engineeringSkillsApi, engineeringSkillsKeys } from '../../api/engineeringSkillsApi'
import { engineeringSkillActionsApi } from '../../api/engineeringSkillActionsApi'
import { serverReason } from '../../lib/errors'
import { useConfigStore } from '../../store/configStore'
import { SkillChanges } from './SkillChanges'
import { SkillExamplesField } from './SkillExamplesField'
import { exampleChanges, isStaleBase, proposalIssues, proposeBody, SKILL_LIMITS, skillMarkdown } from './documents/skillDocument'
import { useSkillHead } from './useSkillInUse'
import type { RefObject } from 'react'
import type { CanvasEditorHandle } from '../../components/Document/edit/editor/CanvasEditor'
import type { EditedExample } from './SkillExamplesField'
import type { ProposalIssue, SkillProposal } from './documents/skillDocument'
import type { SkillDiff, SkillRole, SkillVersionDetail } from '../../api/engineeringSkillsApi'

interface SheetProps {
  readonly connection: string
  readonly role: SkillRole
  readonly onClose: () => void
  /** The version the proposal became (its review opens). */
  readonly onProposed: (version: number) => void
}

/** The draft as the form holds it: a proposal whose examples carry their list keys. */
type Draft = SkillProposal & { readonly examples: readonly EditedExample[] }

const NO_DIFF: SkillDiff = {
  instructions: [], examples: [], tools_added: [], tools_removed: [], tools_reordered: false, model: null, harness: null, first: false,
}

function useTitle(role: SkillRole) {
  const { t } = useTranslation('agents')
  return t('skills.propose.title', { role: t(`skills.role.${role}`) })
}

function Issues({ issues }: Readonly<{ issues: readonly ProposalIssue[] }>) {
  const { t } = useTranslation('agents')
  if (issues.length === 0) return null
  return (
    <ul role="alert" className="list-disc space-y-1 rounded-lg border border-danger/30 bg-danger-subtle p-3 ps-6 text-sm text-text">
      {issues.map((issue) => <li key={issue}>{t(`skills.propose.issues.${issue}`, { max: SKILL_LIMITS.maxExamples })}</li>)}
    </ul>
  )
}

/** The write step: summary, the instructions on the canvas, the examples, a reason. */
function WriteStep({ base, draft, onDraft, handleRef, nextKey }: Readonly<{
  base: SkillVersionDetail; draft: Draft; onDraft: (next: Partial<Draft>) => void
  handleRef: RefObject<CanvasEditorHandle | null>; nextKey: () => number
}>) {
  const { t } = useTranslation('agents')
  const frontMatter = splitFrontMatter(skillMarkdown(base.record)).frontMatter
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <label htmlFor="skill-propose-summary" className="block text-[12px] font-semibold text-muted">{t('skills.propose.summary')}</label>
        <input id="skill-propose-summary" className="input w-full" maxLength={SKILL_LIMITS.maxSummaryChars} value={draft.summary}
          onChange={(event) => onDraft({ summary: event.target.value })} />
      </div>
      {frontMatter === null ? null : <PropertiesPanel frontMatter={frontMatter} />}
      <div className="space-y-1">
        <p className="text-[12px] font-semibold text-muted">{t('skills.propose.instructions')}</p>
        <MarkdownEdit markdown={draft.instructions} editable ariaLabel={t('skills.propose.instructions')} handleRef={handleRef}
          onChange={(instructions) => onDraft({ instructions })} className={`${READING_TEXT_CLASS} rounded-md border border-border p-3`} />
      </div>
      <SkillExamplesField examples={draft.examples} onChange={(next) => onDraft({ examples: next })} nextKey={nextKey} />
      <div className="space-y-1">
        <label htmlFor="skill-propose-reason" className="block text-[12px] font-semibold text-muted">{t('skills.propose.reason')}</label>
        <textarea id="skill-propose-reason" className="input w-full" rows={2} maxLength={SKILL_LIMITS.maxReasonChars}
          value={draft.reason} onChange={(event) => onDraft({ reason: event.target.value })} />
      </div>
    </div>
  )
}

/** The review step: what the draft changes from the version in use now. */
function ReviewStep({ base, draft, writtenOn }: Readonly<{ base: SkillVersionDetail; draft: SkillProposal; writtenOn: number }>) {
  const { t } = useTranslation('agents')
  const examples = exampleChanges(base.record.examples, draft.examples)
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{t('skills.propose.reviewHint', { version: base.version })}</p>
      {writtenOn !== base.version && (
        <p role="note" className="rounded-lg border border-warn/30 bg-warn-subtle p-3 text-sm text-text">
          {t('skills.propose.outOfDate', { base: writtenOn, current: base.version })}
        </p>
      )}
      <section aria-label={t('skills.propose.instructions')} className="space-y-2">
        <h3 className="text-sm font-semibold text-text-strong">{t('skills.propose.instructions')}</h3>
        <DocumentDiff before={base.record.instructions} after={draft.instructions} policy={markdownPolicy.model}
          identicalText={t('skills.document.identical')} beforeLabel={`v${String(base.version)}`} afterLabel={t('skills.propose.yours')} />
      </section>
      <SkillChanges diff={{ ...NO_DIFF, examples }} />
    </div>
  )
}

/** Why the proposal was not sent: another version is in use now (read it again), or the server's own words. */
function SendFailure({ error, onReadAgain, reading }: Readonly<{ error: Error | null; onReadAgain: () => void; reading: boolean }>) {
  const { t } = useTranslation('agents')
  if (error === null) return null
  if (isStaleBase(error)) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-warn/30 bg-warn-subtle p-3 text-sm text-text">
        <p className="mr-auto min-w-0">{t('skills.propose.stale')}</p>
        <button type="button" className="btn btn-secondary btn-sm" disabled={reading} onClick={onReadAgain}>
          {reading && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}{t('skills.propose.readAgain')}
        </button>
      </div>
    )
  }
  const reason = serverReason(error)
  return (
    <p role="alert" className="text-sm text-danger">
      {reason === null ? t('skills.propose.failed') : t('skills.propose.refused', { message: reason })}
    </p>
  )
}

function ProposeForm({ connection, role, base, onClose, onProposed }: Readonly<SheetProps & { base: SkillVersionDetail }>) {
  const { t } = useTranslation('agents')
  const title = useTitle(role)
  const queryClient = useQueryClient()
  // (each example's list key: the base's by their place, a new one's from this counter, read in handlers only)
  const keys = useRef(base.record.examples.length)
  const nextKey = () => { keys.current += 1; return keys.current }
  const [writtenOn] = useState(base.version)
  const [step, setStep] = useState<'write' | 'review'>('write')
  const [draft, setDraft] = useState<Draft>(() => ({
    summary: '', reason: '', instructions: base.record.instructions,
    examples: base.record.examples.map((example, index) => ({ ...example, key: index + 1 })),
  }))
  const [issues, setIssues] = useState<readonly ProposalIssue[]>([])
  const [asking, setAsking] = useState(false)
  const [reading, setReading] = useState(false)
  const handleRef = useRef<CanvasEditorHandle | null>(null)
  const send = useMutation({
    mutationFn: (proposal: SkillProposal) => engineeringSkillActionsApi.propose(connection, role, proposeBody(proposal, base.version)),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: engineeringSkillsKeys.all() })
      onProposed(result.version.version)
    },
  })
  const current = (): Draft => ({ ...draft, instructions: handleRef.current?.getMarkdown() ?? draft.instructions })
  const onDraft = (next: Partial<Draft>) => setDraft((was) => ({ ...was, ...next }))
  const review = () => {
    const proposal = current()
    const found = proposalIssues(proposal, base.record)
    setDraft(proposal)
    setIssues(found)
    if (found.length === 0) setStep('review')
  }
  const readAgain = async () => {
    setReading(true)
    try {
      await queryClient.invalidateQueries({ queryKey: engineeringSkillsKeys.all() })
      send.reset()
    } finally {
      setReading(false)
    }
  }
  const dirty = draft.summary !== '' || draft.reason !== '' || draft.instructions !== base.record.instructions
    || exampleChanges(base.record.examples, draft.examples).length > 0
  const close = () => { if (dirty && !send.isSuccess) setAsking(true); else onClose() }
  const footer = step === 'write' ? (
    <>
      <button type="button" className="btn btn-secondary btn-sm" onClick={close}>{t('skills.propose.cancel')}</button>
      <button type="button" className="btn btn-primary btn-sm" onClick={review}>{t('skills.propose.review')}</button>
    </>
  ) : (
    <>
      <button type="button" className="btn btn-secondary btn-sm" disabled={send.isPending} onClick={() => setStep('write')}>
        {t('skills.propose.back')}
      </button>
      <button type="button" className="btn btn-primary btn-sm" aria-disabled={send.isPending}
        onClick={() => { if (!send.isPending) send.mutate(draft) }}>
        {send.isPending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}{t('skills.propose.submit')}
      </button>
    </>
  )
  return (
    <SideSheet isOpen onClose={close} size="wide" title={title} footer={footer}
      description={t('skills.propose.writtenOn', { version: base.version })}>
      <Issues issues={issues} />
      {step === 'write'
        ? <WriteStep base={base} draft={draft} onDraft={onDraft} handleRef={handleRef} nextKey={nextKey} />
        : <ReviewStep base={base} draft={draft} writtenOn={writtenOn} />}
      <SendFailure error={send.error} onReadAgain={() => void readAgain()} reading={reading} />
      <ConfirmModal isOpen={asking} title={t('skills.propose.discard.title')} message={t('skills.propose.discard.message')}
        confirmLabel={t('skills.propose.discard.confirm')} cancelLabel={t('skills.propose.discard.keep')} variant="warning"
        onConfirm={() => onClose()} onCancel={() => setAsking(false)} />
    </SideSheet>
  )
}

/**
 * The sheet: the version in use read first (the base the draft is written on; a re-read after a 409 keeps the
 * draft on screen while the new one arrives), then the form.
 */
export function SkillProposeSheet({ connection, role, onClose, onProposed }: SheetProps) {
  const { t } = useTranslation('agents')
  const title = useTitle(role)
  const configured = useConfigStore((s) => s.config.apiEndpoint) !== ''
  const { inUse, known } = useSkillHead(connection, role)
  const scope = inUse?.scope ?? ''
  const number = inUse?.version ?? 0
  const base = useQuery({
    queryKey: engineeringSkillsKeys.version(scope, role, number),
    queryFn: () => engineeringSkillsApi.version(scope, role, number),
    enabled: configured && inUse !== null,
    placeholderData: keepPreviousData,
  })
  if (base.data !== undefined) {
    return <ProposeForm connection={connection} role={role} base={base.data} onClose={onClose} onProposed={onProposed} />
  }
  const none = known && inUse === null
  return (
    <SideSheet isOpen onClose={onClose} size="wide" title={title}>
      {none && <p className="text-sm text-muted">{t('skills.propose.noBase')}</p>}
      {base.isError
        ? <LoadFailed message={t('skills.versionFailed')} onRetry={() => void base.refetch()} retrying={base.isFetching} />
        : !none && <div className="skeleton h-24" role="status" aria-label={t('skills.propose.loading')} />}
    </SideSheet>
  )
}
