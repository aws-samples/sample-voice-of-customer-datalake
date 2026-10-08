/**
 * @fileoverview Memory — what the assistant and the autonomous agents remember.
 *
 * Tabs:
 * - **Company**: shared knowledge (product, customers, strategy…), visible to
 *   everyone. Anyone may +1; curators (admins and memory reviewers) edit,
 *   forget, restore and merge.
 * - **Personal**: the caller's own memories — private to them.
 * - **Needs review** (curators): proposed items and conflicts, side by side,
 *   with supporter counts and a suggested resolution.
 * - **Imports** (curators): paste a page to learn from.
 *
 * Curator status is not a client claim: an admin is one, and anyone else is one
 * exactly when `GET /memory/review` answers (the server's own gate).
 *
 * @module pages/Memory
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { AlertCircle, Building2, ClipboardPaste, Scale, User } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import { useIsAdmin } from '../../store/authStore'
import { useConfigStore } from '../../store/configStore'
import { memoryApi, memoryKeys } from '../../api/memoryApi'
import { PageTitle } from '../../components/PageTitle/PageTitle'
import MemoryList from './MemoryList'
import MemoryReview from './MemoryReview'
import MemoryImports from './MemoryImports'

type MemoryTab = 'company' | 'personal' | 'review' | 'imports'

interface TabDef {
  readonly id: MemoryTab
  readonly icon: LucideIcon
  readonly count?: number
}

/** The review route's refusal for a caller who is not a curator. */
const NOT_A_CURATOR = 403

/** Admins curate; anyone else does when the review route lets them in.
 *
 * A 403 is the server's gate saying "not a curator" — expected, and silent. Any
 * other failure (a 5xx, a network fault) is NOT an answer: it is surfaced, or the
 * page reads as an empty memory while the queue is in fact unreadable. */
function useCanCurate(enabled: boolean) {
  const isAdmin = useIsAdmin()
  const review = useQuery({ queryKey: memoryKeys.review(), queryFn: memoryApi.review, enabled, retry: false })
  return {
    canCurate: isAdmin || review.isSuccess,
    reviewCount: review.data?.length,
    reviewFailed: review.isError && apiErrorStatus(review.error) !== NOT_A_CURATOR,
    retryReview: () => void review.refetch(),
  }
}

function ReviewLoadFailed({ onRetry }: Readonly<{ onRetry: () => void }>) {
  const { t } = useTranslation('memory')
  return (
    <div role="alert" className="card text-sm text-danger bg-danger-subtle border-danger/30 flex flex-wrap items-center justify-between gap-2">
      <span className="flex items-center gap-2"><AlertCircle size={16} /> {t('reviewLoadFailed')}</span>
      <button type="button" onClick={onRetry} className="btn btn-secondary btn-sm">{t('retry')}</button>
    </div>
  )
}

export default function Memory() {
  const { t } = useTranslation('memory')
  const { config } = useConfigStore()
  const configured = Boolean(config.apiEndpoint)
  const { canCurate, reviewCount, reviewFailed, retryReview } = useCanCurate(configured)
  const [tab, setTab] = useState<MemoryTab>('company')

  const tabs: TabDef[] = [
    { id: 'company', icon: Building2 },
    { id: 'personal', icon: User },
    ...(canCurate ? [{ id: 'review', icon: Scale, count: reviewCount } satisfies TabDef, { id: 'imports', icon: ClipboardPaste } satisfies TabDef] : []),
  ]
  const active = tabs.some((d) => d.id === tab) ? tab : 'company'

  return (
    <div className="max-w-5xl mx-auto min-w-0 w-full space-y-4 sm:space-y-6">
      <PageTitle title={t('title')} subtitle={t('subtitle')} />

      <div className="tabs-rail overflow-x-auto">
        <div className="tabs-track" role="tablist" aria-label={t('title')}>
          {tabs.map((def) => (
            <button
              key={def.id}
              type="button"
              role="tab"
              aria-selected={active === def.id}
              onClick={() => setTab(def.id)}
              className={clsx('tab', active === def.id && 'tab-active')}
            >
              <def.icon size={14} />
              {t(`tabs.${def.id}`)}
              {def.count ? <span className="font-mono">({def.count})</span> : null}
            </button>
          ))}
        </div>
      </div>

      {configured && reviewFailed ? <ReviewLoadFailed onRetry={retryReview} /> : null}

      {configured ? <MemoryTabContent tab={active} canCurate={canCurate} /> : (
        <div className="card text-sm text-warn bg-warn-subtle border-warn/30">{t('configureFirst')}</div>
      )}
    </div>
  )
}

function MemoryTabContent({ tab, canCurate }: Readonly<{ tab: MemoryTab; canCurate: boolean }>) {
  if (tab === 'review') return <MemoryReview />
  if (tab === 'imports') return <MemoryImports />
  // Keyed by scope so filters, selection and pages never leak between the tabs.
  return <MemoryList key={tab} scope={tab} canCurate={canCurate} />
}
