/**
 * @fileoverview An engineering automation's readiness checks (7.50.00; api/engineeringReadinessApi.ts), as the Set up
 * dialog, the agents list's card, an agent's Enabled control and the setup guide show them: each check passed, failed,
 * with a warning or unknown (a read the server could not make), whether a run needs it, what the server found, its fix
 * in the server's own words and its doc link. The way-of-working
 * check also links to Administration → Users, where an administrator sets their way of working (AI-driven for the
 * agents to push and open the pull request themselves). Every text is the server's, rendered as text.
 *
 * @module pages/Agents/ReadinessChecks
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, ExternalLink, HelpCircle, XCircle } from 'lucide-react'
import clsx from 'clsx'
import { WAY_OF_WORKING_CHECK, docsHref } from '../../api/engineeringReadinessApi'
import { adminPath } from '../Settings/adminPaths'
import { useReadiness } from './useReadiness'
import type { LucideIcon } from 'lucide-react'
import type { CheckStatus, ReadinessCheck, ReadinessSubject } from '../../api/engineeringReadinessApi'

/** Where an administrator sets their way of working (the dial a run's pushes follow). */
const USERS_PATH = adminPath({ tab: 'access', section: 'users' })

const STATUS_LOOK: Readonly<Record<CheckStatus, { icon: LucideIcon; tone: string; badge: string }>> = {
  pass: { icon: CheckCircle2, tone: 'text-ok', badge: 'badge badge-ok' },
  fail: { icon: XCircle, tone: 'text-danger', badge: 'badge badge-danger' },
  warn: { icon: AlertTriangle, tone: 'text-warn', badge: 'badge badge-warn' },
  unknown: { icon: HelpCircle, tone: 'text-muted', badge: 'badge badge-muted' },
}

function CheckLinks({ check }: Readonly<{ check: ReadinessCheck }>) {
  const { t } = useTranslation('agents')
  const href = docsHref(check.docs)
  const toUsers = check.id === WAY_OF_WORKING_CHECK && check.status !== 'pass'
  if (href === null && !toUsers) return null
  return (
    <p className="flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
      {toUsers && <Link className="link" to={USERS_PATH}>{t('readiness.setWayOfWorking')}</Link>}
      {href !== null && (
        <a className="link inline-flex items-center gap-1" href={href} target="_blank" rel="noopener noreferrer">
          {t('readiness.docs')}<ExternalLink size={12} aria-hidden="true" />
          <span className="sr-only">{t('readiness.opensNewTab')}</span>
        </a>
      )}
    </p>
  )
}

function CheckRow({ check }: Readonly<{ check: ReadinessCheck }>) {
  const { t } = useTranslation('agents')
  const look = STATUS_LOOK[check.status]
  const Icon = look.icon
  return (
    <li className="flex items-start gap-2 py-2" data-testid={`readiness-${check.id}`} data-status={check.status}>
      <Icon size={16} className={clsx('mt-0.5 flex-shrink-0', look.tone)} aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-center gap-2 text-sm text-text-strong">
          <span className="break-words [overflow-wrap:anywhere]">{t(`readiness.check.${check.id}`, { defaultValue: check.id })}</span>
          <span className={look.badge}>{t(`readiness.status.${check.status}`)}</span>
          {check.required && <span className="text-[12px] text-muted">{t('readiness.required')}</span>}
        </p>
        {check.detail !== '' && <p className="text-[12px] text-muted break-words [overflow-wrap:anywhere]">{check.detail}</p>}
        {check.status !== 'pass' && check.fix !== '' && (
          <p className="text-[12px] text-text break-words [overflow-wrap:anywhere]">
            <span className="font-semibold">{t('readiness.fix')}</span> {check.fix}
          </p>
        )}
        <CheckLinks check={check} />
      </div>
    </li>
  )
}

/** The checks, failing ones first, then unknown ones, warnings and those that passed (the server's order within each). */
export function ReadinessList({ checks, label }: Readonly<{ checks: readonly ReadinessCheck[]; label: string }>) {
  const order: readonly CheckStatus[] = ['fail', 'unknown', 'warn', 'pass']
  const sorted = order.flatMap((status) => checks.filter((check) => check.status === status))
  return (
    <ul aria-label={label} className="divide-y divide-border">
      {sorted.map((check) => <CheckRow key={check.id} check={check} />)}
    </ul>
  )
}

/** "Failing: 2 · Unknown: 1 · Warnings: 1 · Passed: 9", the summary a collapsed list shows. */
function ReadinessSummary({ checks }: Readonly<{ checks: readonly ReadinessCheck[] }>) {
  const { t } = useTranslation('agents')
  const count = (status: CheckStatus) => checks.filter((check) => check.status === status).length
  return (
    <span className="text-[12px] text-muted">
      {t('readiness.summary', { fail: count('fail'), unknown: count('unknown'), warn: count('warn'), pass: count('pass') })}
    </span>
  )
}

/**
 * The readiness of `subject` as a section: its state while it loads or when it fails (Enable stays the server's to
 * refuse then), else the checks. `collapsed` folds the list under its summary (the agents list's card).
 */
export function ReadinessSection({ subject, enabled, collapsed = false }: Readonly<{
  subject: ReadinessSubject; enabled: boolean; collapsed?: boolean
}>) {
  const { t } = useTranslation('agents')
  const read = useReadiness(subject, enabled)
  if (!enabled) return null
  if (read.isLoading) return <p role="status" className="text-[12px] text-muted">{t('readiness.loading')}</p>
  // (not an alert: Enable still checks, and answers with the failing checks)
  if (read.isError) return <p className="text-[12px] text-warn">{t('readiness.loadFailed')}</p>
  const checks = read.data ?? []
  if (checks.length === 0) return <p className="text-[12px] text-muted">{t('readiness.none')}</p>
  const list = <ReadinessList checks={checks} label={t('readiness.label')} />
  if (!collapsed) {
    return (
      <section className="space-y-1" aria-label={t('readiness.label')}>
        <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-text-strong">
          {t('readiness.title')} <ReadinessSummary checks={checks} />
        </h3>
        {list}
      </section>
    )
  }
  return (
    <details className="rounded-md border border-border px-3 py-1 text-left">
      <summary className="cursor-pointer py-1 text-[12px] font-semibold text-text-strong focus-ring rounded-sm">
        {t('readiness.title')} <ReadinessSummary checks={checks} />
      </summary>
      {list}
    </details>
  )
}

/** The checks an Enable's 409 named as failing, under the refusal's words. */
export function FailingChecks({ checks }: Readonly<{ checks: readonly ReadinessCheck[] }>) {
  const { t } = useTranslation('agents')
  return (
    <div role="alert" className="rounded-md border border-danger/30 bg-danger-subtle p-2 text-left">
      <p className="text-[12px] font-semibold text-danger">{t('readiness.enableRefused')}</p>
      <ReadinessList checks={checks} label={t('readiness.failingLabel')} />
    </div>
  )
}
