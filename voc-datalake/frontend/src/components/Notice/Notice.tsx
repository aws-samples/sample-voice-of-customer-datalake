/**
 * @fileoverview Notice: one icon, a short message and at most one action, in two shapes.
 *
 * - `empty`: a centred card that stands in for a list or a set of cards with nothing in it
 *   ("No projects yet", "No feedback matches these filters"): an icon tile, a heading, a hint
 *   and the action that fills it.
 * - `banner`: a one-line strip above or inside content that says something about it
 *   ("This form is disabled", "The last run needs a decision", a failed read), toned `warn`
 *   or `danger`, with the action that resolves it.
 *
 * The page keeps its own copy and its own `role`: `status` for a polite update, `alert` for a
 * failure, `note` for standing advice, none for a plain empty list.
 *
 * @module components/Notice
 */
import clsx from 'clsx'
import { Link } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

type NoticeActionBase = Readonly<{
  label: string
  icon?: LucideIcon
  /** `primary` when the action is the one thing to do here; defaults to `secondary`. */
  emphasis?: 'primary' | 'secondary'
}>

type NoticeButtonAction = NoticeActionBase & Readonly<{
  onClick: () => void
  disabled?: boolean
  /** The action's work is in flight: its icon spins and the button waits. */
  busy?: boolean
}>

type NoticeLinkAction = NoticeActionBase & Readonly<{ to: string }>

type NoticeAction = NoticeButtonAction | NoticeLinkAction

type NoticeCommon = Readonly<{
  icon: LucideIcon
  text: ReactNode
  action?: NoticeAction
  role?: 'status' | 'alert' | 'note'
  className?: string
}>

type EmptyNoticeProps = NoticeCommon & Readonly<{ variant: 'empty'; title: ReactNode }>
type BannerNoticeProps = NoticeCommon & Readonly<{ variant: 'banner'; tone: 'warn' | 'danger' }>

export type NoticeProps = EmptyNoticeProps | BannerNoticeProps

function isLinkAction(action: NoticeAction): action is NoticeLinkAction {
  return 'to' in action
}

function ActionControl({ action, small }: Readonly<{ action: NoticeAction; small: boolean }>) {
  const busy = !isLinkAction(action) && action.busy === true
  const className = clsx('btn', action.emphasis === 'primary' ? 'btn-primary' : 'btn-secondary',
    small && 'btn-sm self-start sm:self-auto', 'justify-center')
  const Icon = action.icon
  const content = (
    <>
      {Icon && <Icon size={small ? 14 : 16} aria-hidden="true" className={busy ? 'animate-spin' : undefined} />}
      {action.label}
    </>
  )
  if (isLinkAction(action)) return <Link to={action.to} className={className}>{content}</Link>
  return (
    <button type="button" onClick={() => action.onClick()} disabled={busy || action.disabled === true}
      className={className}>
      {content}
    </button>
  )
}

function EmptyNotice({ icon: Icon, title, text, action, role, className }: EmptyNoticeProps) {
  return (
    <div role={role} className={clsx('card py-12 text-center', className)}>
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-accent-subtle">
        <Icon size={20} className="text-accent-text" aria-hidden="true" />
      </div>
      <h2 className="mb-1 text-base font-semibold tracking-tight text-text-strong">{title}</h2>
      <p className={clsx('px-4 text-sm text-muted', action && 'mb-4')}>{text}</p>
      {action && <ActionControl action={action} small={false} />}
    </div>
  )
}

/** A warning keeps body text and colours only its icon; a failure is danger throughout (icon inherits). */
const BANNER_TONES: Readonly<Record<BannerNoticeProps['tone'], Readonly<{ box: string; icon?: string }>>> = {
  warn: { box: 'border-warn/30 bg-warn-subtle text-text', icon: 'text-warn' },
  danger: { box: 'border-danger/30 bg-danger-subtle text-danger' },
}

function BannerNotice({ icon: Icon, text, action, role, className, tone }: BannerNoticeProps) {
  const tones = BANNER_TONES[tone]
  return (
    <div role={role} className={clsx('flex flex-col gap-3 rounded-lg border p-3 text-sm sm:flex-row sm:items-center',
      tones.box, className)}>
      <span className="flex flex-1 items-center gap-2">
        <Icon size={16} className={clsx('flex-shrink-0', tones.icon)} aria-hidden="true" />
        <span>{text}</span>
      </span>
      {action && <ActionControl action={action} small />}
    </div>
  )
}

export default function Notice(props: NoticeProps) {
  return props.variant === 'empty' ? <EmptyNotice {...props} /> : <BannerNotice {...props} />
}
