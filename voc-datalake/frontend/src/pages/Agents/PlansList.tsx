/**
 * @fileoverview The caller's assistant plans on the Agents page
 * (docs/assistant-plan-mode.md → "UI"): newest first, each with its goal and
 * status; opening one shows the same live progress view as the assistant
 * bubble (steps, inline step approval, Cancel). A finished plan can be removed
 * from the list ("Delete", after a confirmation); it is kept on the server and
 * only leaves the list. Every signed-in user sees their own plans.
 *
 * @module pages/Agents/PlansList
 */
import { memo, useCallback, useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, ListChecks, Loader2, Trash2 } from 'lucide-react'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { failedReads } from '../../utils/failedReads'
import { isTerminalPlan, plansApi, plansKeys } from '../../api/plansApi'
import { useConfigStore } from '../../store/configStore'
import PlanProgress from '../../assistant/planProgress/PlanProgress'
import { PlanStatusBadge } from '../../assistant/planProgress/PlanBadges'
import type { PlanSummary } from '../../api/plansApi'
import { formatDateTime } from '../../utils/dateUtils'

/** The list refreshes this often while one of its plans is still running. */
const LIST_POLL_MS = 15_000

interface PlanRowProps {
  plan: PlanSummary
  open: boolean
  onToggle: (planId: string) => void
  removing: boolean
  onRemove: (plan: PlanSummary) => void
}

/**
 * One plan. Memoised with stable callbacks: the list polls every 15 s while a plan runs, and
 * an unchanged row (react-query keeps an unchanged plan's object) is not rendered again, so its
 * Delete button stays the same, still node under a pointer (5.34.00 live: it "detached" while a
 * plan ran).
 */
const PlanRow = memo(function PlanRow({ plan, open, onToggle, removing, onRemove }: Readonly<PlanRowProps>) {
  const { t, i18n } = useTranslation('agents')
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <li className="space-y-2" data-testid={`plan-row-${plan.plan_id}`}>
      <div className="flex items-stretch gap-2">
        <button type="button" aria-expanded={open} onClick={() => onToggle(plan.plan_id)}
          className="card focus-ring flex min-w-0 flex-1 flex-wrap items-center gap-3 p-4 text-left hover:border-border-strong transition-colors">
          <Chevron size={16} className="text-muted" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-sm font-semibold text-text-strong">{plan.goal}</span>
          <PlanStatusBadge status={plan.status} />
          <span className="font-mono text-[12px] text-muted">{formatDateTime(plan.created_at, i18n.language)}</span>
        </button>
        {/* Beside the toggle, not inside it: a button cannot hold a button. Only a finished plan can go. */}
        {isTerminalPlan(plan.status) && (
          <button type="button" className="icon-btn self-center hover:text-danger" disabled={removing} onClick={() => onRemove(plan)}
            aria-label={t('plans.removeNamed', { goal: plan.goal })} title={t('plans.remove')}>
            {removing ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Trash2 size={16} aria-hidden="true" />}
          </button>
        )}
      </div>
      {open && <PlanProgress planId={plan.plan_id} onOpen={ignoreOpen} />}
    </li>
  )
})

const ignoreOpen = () => undefined

export function PlansList() {
  const { t } = useTranslation('agents')
  const configured = useConfigStore((s) => s.config.apiEndpoint !== '')
  const listQuery = useQuery({
    queryKey: plansKeys.list(),
    queryFn: () => plansApi.list(),
    enabled: configured,
    refetchInterval: (q) => (q.state.data?.some((p) => !isTerminalPlan(p.status)) === true ? LIST_POLL_MS : false),
  })
  const failure = failedReads([listQuery])
  const [openId, setOpenId] = useState<string | null>(null)
  const [pending, setPending] = useState<PlanSummary | null>(null)
  const queryClient = useQueryClient()
  const remove = useMutation({
    mutationFn: (planId: string) => plansApi.remove(planId),
    onSuccess: (_view, planId) => {
      setOpenId((current) => (current === planId ? null : current))
      void queryClient.invalidateQueries({ queryKey: plansKeys.all() })
    },
  })
  const toggle = useCallback((planId: string) => setOpenId((current) => (current === planId ? null : planId)), [])
  const { reset } = remove
  const askRemove = useCallback((plan: PlanSummary) => { reset(); setPending(plan) }, [reset])
  const confirmRemove = () => {
    if (pending !== null) remove.mutate(pending.plan_id)
    setPending(null)
  }
  const plans = listQuery.data
  const titleId = useId()
  return (
    <section className="space-y-3" aria-labelledby={titleId}>
      <div>
        <h2 id={titleId} className="text-base font-semibold text-text-strong">{t('plans.title')}</h2>
        <p className="text-sm text-muted mt-1 max-w-prose">{t('plans.subtitle')}</p>
      </div>
      {listQuery.isLoading && <div className="skeleton h-16" />}
      {failure.loadFailed && <LoadFailed message={t('plans.loadFailed')} onRetry={failure.retry} retrying={failure.retrying} />}
      {remove.isError && <p role="alert" className="text-[12px] text-danger">{t('plans.removeFailed')}</p>}
      {plans?.length === 0 && (
        <div className="card text-center py-8">
          <ListChecks size={20} className="mx-auto text-muted" aria-hidden="true" />
          <p className="mt-2 text-sm text-muted">{t('plans.empty')}</p>
        </div>
      )}
      {plans !== undefined && plans.length > 0 && (
        <ul className="space-y-2">
          {plans.map((plan) => (
            <PlanRow key={plan.plan_id} plan={plan} open={openId === plan.plan_id} onToggle={toggle}
              removing={remove.isPending && remove.variables === plan.plan_id} onRemove={askRemove} />
          ))}
        </ul>
      )}
      <ConfirmModal
        isOpen={pending !== null}
        title={t('plans.removeTitle')}
        message={t('plans.removeMessage', { goal: pending?.goal ?? '' })}
        confirmLabel={t('plans.remove')}
        cancelLabel={t('common.cancel')}
        variant="danger"
        onConfirm={confirmRemove}
        onCancel={() => setPending(null)}
      />
    </section>
  )
}
