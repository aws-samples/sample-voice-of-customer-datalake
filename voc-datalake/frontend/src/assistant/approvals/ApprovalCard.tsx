/**
 * AG-UI human-in-the-loop approval card for one pending write-tool interrupt.
 *
 * The model proposed a write; nothing has happened yet. The card shows what
 * would happen (title, the server's one-line message, a preview of the args),
 * gates Approve on: a registered tool, args that pass its schema, an unexpired
 * interrupt, admin rights for admin-only tools and — for destructive tools — an
 * explicit confirmation. Approve runs the write through the existing REST
 * client with the user's own token; the outcome (`executed` / `failed` /
 * `declined`) goes to `onResolve` exactly once, and the card collapses to a
 * compact resolved line. Decline always works, except while a write is in
 * flight; an expired card offers only Dismiss (declined, reason "expired").
 *
 * Contract: default export + `ApprovalCardProps` (`../types`).
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { useIsAdmin } from '../../store/authStore'
import { ActionBar } from './ActionBar'
import { CardHeader, ResolvedState } from './CardParts'
import { ArgsPreview } from './previews/ValueView'
import { getWriteTool } from './registry'
import { useApprovalFlow } from './useApprovalFlow'
import { useExpiry } from './useExpiry'
import { ShownContext, createShownRecord } from './shown'
import type { ShownRecord } from './shown'
import { checkArgs, isApprovable, isDestructive } from './approvalGate'
import type { ArgsCheck } from './approvalGate'
import type { Expiry } from './useExpiry'
import type { PageContext } from '../contract'
import type { ApprovalCardProps, WriteToolDefinition, WriteToolExecutionContext } from '../types'

function ArgsProblems({ known, problems }: Readonly<{ known: boolean; problems: string[] }>) {
  const { t } = useTranslation('assistantTools')
  return (
    <div role="alert" className="rounded-md border border-danger/30 bg-danger-subtle p-2 text-[12px] text-danger">
      <p className="font-medium">{known ? t('card.invalidArgs') : t('card.unknownTool')}</p>
      {problems.length > 0 && (
        <ul className="list-disc pl-4 mt-1">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
      )}
    </div>
  )
}

function PreviewSection({ definition, check, page }: Readonly<{
  definition: WriteToolDefinition | undefined
  check: ArgsCheck
  page: PageContext
}>) {
  if (definition === undefined || !check.ok) {
    return <ArgsProblems known={definition !== undefined} problems={check.ok ? [] : check.problems} />
  }
  const { Preview } = definition
  return Preview === undefined ? <ArgsPreview args={check.args} /> : <Preview args={check.args} page={page} />
}

function DestructiveConfirm({ checked, disabled, onChange }: Readonly<{
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}>) {
  const { t } = useTranslation('assistantTools')
  const id = useId()
  return (
    <div className="rounded-md border border-danger/30 bg-danger-subtle p-2 text-[13px] text-danger">
      <p>{t('card.destructiveWarning')}</p>
      <label htmlFor={id} className="mt-1 flex items-center gap-2 font-medium">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded-sm accent-danger"
        />
        {t('card.destructiveConfirm')}
      </label>
    </div>
  )
}

function InterruptMessage({ message }: Readonly<{ message?: string }>) {
  if (message === undefined || message === '') return null
  return <p className="text-sm text-text break-words">{message}</p>
}

interface PendingBodyProps {
  props: Readonly<ApprovalCardProps>
  shown: ShownRecord
  titleId: string
  title: string
  definition: WriteToolDefinition | undefined
  check: ArgsCheck
  expiry: Expiry
  flow: ReturnType<typeof useApprovalFlow>
  phase: 'pending' | 'declining' | 'executing'
  actionsRef: RefObject<HTMLDivElement | null>
}

function PendingBody({ props, shown, titleId, title, definition, check, expiry, flow, phase, actionsRef }: Readonly<PendingBodyProps>) {
  const { t } = useTranslation('assistantTools')
  const queryClient = useQueryClient()
  const isAdmin = useIsAdmin()
  const [confirmed, setConfirmed] = useState(false)
  const { interrupt, page, disabled = false } = props
  const destructive = isDestructive(interrupt, definition)
  const adminBlocked = definition?.adminOnly === true && !isAdmin
  const canApprove = isApprovable({ definition, check, expiry, adminBlocked, destructive, confirmed, disabled, phase })
  const showConfirm = destructive && check.ok && !expiry.expired && phase !== 'declining'

  const handleApprove = () => {
    if (canApprove && definition !== undefined && check.ok) {
      // `shown` carries what this card displayed (job window/language, brand base) to the executor.
      const ctx: WriteToolExecutionContext = { queryClient, page, shown }
      void flow.approve(definition, check.args, ctx)
    }
  }

  return (
    <>
      <CardHeader titleId={titleId} title={title} destructive={destructive} projectId={interrupt.metadata?.projectId} expiry={expiry} />
      <InterruptMessage message={interrupt.message} />
      <div className="max-h-96 overflow-auto">
        <PreviewSection definition={definition} check={check} page={page} />
      </div>
      {adminBlocked && <p className="text-[12px] text-warn">{t('card.adminOnly')}</p>}
      {showConfirm && <DestructiveConfirm checked={confirmed} disabled={phase === 'executing' || disabled} onChange={setConfirmed} />}
      <div ref={actionsRef} data-testid="approval-actions">
        <ActionBar
          phase={phase}
          expired={expiry.expired}
          canApprove={canApprove}
          destructive={destructive}
          disabled={disabled}
          onApprove={handleApprove}
          onStartDecline={flow.startDecline}
          onCancelDecline={flow.cancelDecline}
          onDecline={flow.decline}
        />
      </div>
    </>
  )
}

export default function ApprovalCard(props: Readonly<ApprovalCardProps>) {
  const { interrupt, toolCall, onResolve } = props
  const { t } = useTranslation('assistantTools')
  const expiry = useExpiry(interrupt.expiresAt)
  const titleId = useId()
  const sectionRef = useRef<HTMLElement>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  const flow = useApprovalFlow({ interruptId: interrupt.id, toolCallId: toolCall.id, onResolve })
  // Captured once, at first render: the values the previews show are the ones executed.
  const [shown] = useState(createShownRecord)
  const { state } = flow

  const definition = getWriteTool(toolCall.name)
  const check = checkArgs(definition, toolCall.args)
  const title = definition?.title(toolCall.args, t) ?? t('card.unknownToolTitle', { name: toolCall.name })
  const destructive = isDestructive(interrupt, definition)

  // Bring the card to keyboard and screen-reader users when it appears, and keep
  // focus on it when the resolved state replaces the focused buttons. Focus does
  // not scroll (the panel's auto-scroll targets the message list's end, above the
  // cards), so in the 600px bubble Approve/Decline could sit below the fold:
  // scroll just enough to show the action row. This effect runs after the message
  // list's (an earlier sibling), so it has the last word on mount.
  useEffect(() => {
    sectionRef.current?.focus({ preventScroll: true })
    actionsRef.current?.scrollIntoView({ block: 'nearest' })
  }, [])
  useEffect(() => {
    const active = document.activeElement
    if (state.phase === 'resolved' && (active === null || active === document.body)) {
      sectionRef.current?.focus({ preventScroll: true })
    }
  }, [state.phase])

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      aria-labelledby={titleId}
      aria-busy={state.phase === 'executing'}
      data-testid="approval-card"
      data-interrupt-id={interrupt.id}
      data-state={state.phase}
      className={clsx(
        'rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        state.phase !== 'resolved' && 'card overflow-hidden p-3 space-y-3 animate-scale-in',
        state.phase !== 'resolved' && (destructive ? 'border-danger/30' : 'border-warn/30'),
      )}
    >
      {state.phase === 'resolved' ? (
        <>
          <h3 id={titleId} className="sr-only">{title}</h3>
          <ResolvedState title={title} outcome={state.outcome} />
        </>
      ) : (
        <ShownContext.Provider value={shown}>
          <PendingBody
            props={props}
            shown={shown}
            titleId={titleId}
            title={title}
            definition={definition}
            check={check}
            expiry={expiry}
            flow={flow}
            phase={state.phase}
            actionsRef={actionsRef}
          />
        </ShownContext.Provider>
      )}
    </section>
  )
}
