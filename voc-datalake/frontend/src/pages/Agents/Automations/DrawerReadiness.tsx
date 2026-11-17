/**
 * @fileoverview The Set up drawer's step ④, "Before it can run" (7.52.00 C1; ux-agents-redesign part 1 §2.4, part 2 S5):
 * the readiness of the drawer's selection (api/engineeringReadinessApi.ts, 7.50.01's `&connection=&language=`): the
 * checks that hold Enable first (ReadinessList's order), then the failures and the unknowns, the warnings and the passes
 * each folded under one line. A fix in place where there is one: a connection, App, CI or issues check sends to
 * Connections; a failing way of working offers "Set mine to AI-driven" with its confirm (DialFix.tsx). The heading
 * carries "▲ N to fix" and takes the focus when the drawer is opened from a row's "N to fix".
 *
 * @module pages/Agents/Automations/DrawerReadiness
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { isBlocking } from '../../../api/engineeringReadinessApi'
import { agentsPath } from '../agentsPaths'
import { ReadinessList } from '../ReadinessChecks'
import { DialFix } from '../DialFix'
import { useReadiness } from '../useReadiness'
import type { ReactNode, RefObject } from 'react'
import type { ReadinessCheck, ReadinessSubject } from '../../../api/engineeringReadinessApi'

/** The checks whose fix is on the Connections tab (a connection, its App, its CI, its issues). */
const CONNECTIONS_CHECKS: ReadonlySet<string> = new Set([
  'connection', 'app_installation', 'ci_attestation', 'ci_protection', 'issues_source', 'issue_label',
])

/** A drawer step's number in its circle, then its title. */
export function StepTitle({ n, children }: Readonly<{ n: number; children: ReactNode }>) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-bg-hover text-[12px] text-muted" aria-hidden="true">{n}</span>
      {children}
    </span>
  )
}

/** A folded group of checks ("1 warning", "13 checks passed"). */
function FoldedChecks({ checks, summary, label }: Readonly<{ checks: readonly ReadinessCheck[]; summary: string; label: string }>) {
  if (checks.length === 0) return null
  return (
    <details className="rounded-md border border-border px-3 py-1">
      <summary className="cursor-pointer py-1 text-[12px] text-muted focus-ring rounded-sm">{summary}</summary>
      <ReadinessList checks={checks} label={label} />
    </details>
  )
}

/** The checks split as the step shows them: open (holding, failing, unknown), warnings, passes. */
function splitChecks(checks: readonly ReadinessCheck[]) {
  const open = checks.filter((check) => isBlocking(check) || check.status === 'fail' || check.status === 'unknown')
  const rest = checks.filter((check) => !open.includes(check))
  return {
    open,
    warnings: rest.filter((check) => check.status === 'warn'),
    passed: rest.filter((check) => check.status === 'pass'),
    toFix: checks.filter(isBlocking).length,
  }
}

/** Its state while it loads, fails or has nothing to check. */
function ReadState({ read }: Readonly<{ read: ReturnType<typeof useReadiness> }>) {
  const { t } = useTranslation('agents')
  if (read.isLoading) return <p role="status" className="text-[12px] text-muted">{t('readiness.loading')}</p>
  // (not an alert: Enable still checks, and answers with the failing checks)
  if (read.isError) return <p className="text-[12px] text-warn">{t('readiness.loadFailed')}</p>
  return read.data?.length === 0 ? <p className="text-[12px] text-muted">{t('readiness.none')}</p> : null
}

export function DrawerReadiness({ subject, headingRef }: Readonly<{
  subject: ReadinessSubject & { readonly automation: string }
  headingRef: RefObject<HTMLHeadingElement | null>
}>) {
  const { t } = useTranslation('agents')
  const read = useReadiness(subject, true)
  const { open, warnings, passed, toFix } = splitChecks(read.data ?? [])
  const headingId = `readiness-${subject.automation}`
  return (
    <section className="space-y-2 border-t border-border pt-4" aria-labelledby={headingId}>
      <h3 ref={headingRef} id={headingId} tabIndex={-1}
        className="flex flex-wrap items-center justify-between gap-2 rounded-sm text-sm font-semibold text-text-strong focus-ring">
        <StepTitle n={4}>{t('automations.drawer.readiness')}</StepTitle>
        {toFix > 0 && (
          <span className="inline-flex items-center gap-1 text-[12px] font-normal text-warn">
            <AlertTriangle size={14} aria-hidden="true" /> {t('automations.toFix', { count: toFix })}
          </span>
        )}
      </h3>
      <ReadState read={read} />
      {open.length > 0 && <ReadinessList checks={open} label={t('readiness.label')} />}
      {open.some((check) => CONNECTIONS_CHECKS.has(check.id)) && (
        <Link className="btn btn-secondary btn-sm" to={agentsPath({ view: 'connections' })}>{t('automations.drawer.openConnections')}</Link>
      )}
      <DialFix subject={subject} checks={read.data} />
      <FoldedChecks checks={warnings} summary={t('automations.warnings', { count: warnings.length })} label={t('readiness.label')} />
      <FoldedChecks checks={passed} summary={t('readiness.passedFolded', { count: passed.length })} label={t('readiness.passedLabel')} />
    </section>
  )
}
