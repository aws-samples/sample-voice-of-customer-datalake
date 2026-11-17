/**
 * @fileoverview The inspector's Assertions tab (7.51.00): each step's assertions from the run's copy of its flow, with
 * what the board recorded of each (`…/assertions`): pass, fail, pending (none recorded yet) or unread, whether a
 * failure blocks or only warns, the record's detail and the attempt it judged. They are the run's, whatever agent is open.
 *
 * @module pages/Agents/RunWorkspace/AssertionsTab
 */
import { useTranslation } from 'react-i18next'
import LoadFailed from '../../../components/LoadFailed/LoadFailed'
import { useRunAssertions } from './useRunWorkspace'
import type { RunAssertion } from '../../../api/engineeringRunWorkspaceApi'

const STATUS_TONE: Readonly<Record<string, string>> = {
  pass: 'badge badge-ok', fail: 'badge badge-danger', pending: 'badge badge-muted', unread: 'badge badge-warn',
}

export function AssertionsTab({ runId, live, titles }: Readonly<{
  runId: string; live: boolean
  /** Each step's title in the run's flow. */
  titles: ReadonlyMap<string, string>
}>) {
  const { t } = useTranslation('agents')
  const assertions = useRunAssertions(runId, live)
  if (assertions.isLoading) return <div className="skeleton h-24" />
  if (assertions.data === undefined) return <LoadFailed onRetry={() => { void assertions.refetch() }} retrying={assertions.isFetching} />
  const list = assertions.data
  if (list.length === 0) return <p className="text-sm text-muted">{t('runWorkspace.assertions.none')}</p>
  const steps = [...new Set(list.map((assertion) => assertion.step))]
  const of = (step: string): RunAssertion[] => list.filter((assertion) => assertion.step === step)
  return (
    <div className="space-y-3">
      {steps.map((step) => (
        <section key={step} aria-label={titles.get(step) ?? step}>
          <h3 className="text-[12px] font-semibold text-text-strong">{titles.get(step) ?? step}</h3>
          <ul className="mt-1 space-y-1">
            {of(step).map((assertion) => (
              <li key={assertion.check} className="flex flex-wrap items-center gap-2 text-[12px]">
                <span className={STATUS_TONE[assertion.status] ?? 'badge badge-muted'}>
                  {t(`runWorkspace.assertions.status.${assertion.status}`, { defaultValue: assertion.status })}
                </span>
                <span className="font-mono">{assertion.check}</span>
                <span className="text-muted">{t(`runWorkspace.assertions.onFail.${assertion.on_fail}`, { defaultValue: assertion.on_fail })}</span>
                {assertion.detail !== '' && <span className="min-w-0 break-words text-muted">· {assertion.detail}</span>}
                {assertion.attempt > 0 && <span className="text-[12px] text-muted">{t('runWorkspace.assertions.attempt', { n: assertion.attempt })}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
