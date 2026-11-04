/**
 * @fileoverview `/feature-requests` (docs/feature-requests.md): two tabs over the app session —
 * Boards (the feedback boards as cards; an admin's gear opens Administration → Privacy & access →
 * Boards) and Insights (`?tab=insights`: the boards as their own evidence source, never mixed into
 * review metrics). A pre-boards request link (`?request=<id>`) opens that request on its board
 * instead. Board-pool users reach the same boards at `/board`, without Insights.
 */
import clsx from 'clsx'
import { BarChart3, LayoutGrid, Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'
import { PageTitle } from '../../components/PageTitle/PageTitle'
import BoardList from './BoardList'
import InsightsTab from './InsightsTab'
import OldRequestLink from './OldRequestLink'
import { APP_BOARD_HOST, BOARDS_ADMIN_PATH, BoardHostContext, isAppAdmin } from './boardContext'
import { useBoardList } from './useBoardQueries'
import { INSIGHTS_VIEW_PARAMS } from './useInsights'

const TAB_PARAM = 'tab'
type PageTab = 'boards' | 'insights'
const TABS: ReadonlyArray<{ id: PageTab; icon: LucideIcon }> = [
  { id: 'boards', icon: LayoutGrid },
  { id: 'insights', icon: BarChart3 },
]

/** The tab in the URL (anything else is Boards) and its setter; leaving Insights drops its view parameters. */
function usePageTab(): readonly [PageTab, (tab: PageTab) => void] {
  const [params, setParams] = useSearchParams()
  const tab: PageTab = params.get(TAB_PARAM) === 'insights' ? 'insights' : 'boards'
  const setTab = (next: PageTab) => {
    setParams((prev) => {
      const updated = new URLSearchParams(prev)
      if (next === 'boards') {
        for (const name of [TAB_PARAM, ...INSIGHTS_VIEW_PARAMS]) updated.delete(name)
      } else updated.set(TAB_PARAM, next)
      return updated
    })
  }
  return [tab, setTab]
}

function PageTabs({ active, onChange }: Readonly<{ active: PageTab; onChange: (tab: PageTab) => void }>) {
  const { t } = useTranslation('featureRequests')
  const label = (id: PageTab) => (id === 'boards' ? t('tabs.boards') : t('tabs.insights'))
  return (
    <div className="tabs-rail overflow-x-auto">
      <div className="tabs-track" role="tablist" aria-label={t('page.title')}>
        {TABS.map((def) => (
          <button key={def.id} type="button" role="tab" aria-selected={active === def.id}
            onClick={() => onChange(def.id)} className={clsx('tab', active === def.id && 'tab-active')}>
            <def.icon size={14} aria-hidden="true" />{label(def.id)}
          </button>
        ))}
      </div>
    </div>
  )
}

function Boards() {
  const { t } = useTranslation('featureRequests')
  const query = useBoardList()
  const isAdmin = isAppAdmin(query.data?.viewer)
  const [tab, setTab] = usePageTab()
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageTitle title={t('page.title')} subtitle={t('page.subtitle')} />
        {isAdmin ? (
          <Link className="btn btn-ghost btn-sm" to={BOARDS_ADMIN_PATH} aria-label={t('boards.configure')} title={t('boards.configure')}>
            <Settings size={16} aria-hidden="true" />
          </Link>
        ) : null}
      </div>
      <PageTabs active={tab} onChange={setTab} />
      {tab === 'insights'
        ? <InsightsTab boards={query.data?.boards ?? []} isAdmin={isAdmin} />
        : <BoardList query={query} />}
    </>
  )
}

export default function Page() {
  const [params] = useSearchParams()
  const requestId = params.get('request')
  return (
    <div className="max-w-5xl mx-auto min-w-0 w-full space-y-4 sm:space-y-6">
      <BoardHostContext.Provider value={APP_BOARD_HOST}>
        {requestId === null ? <Boards /> : <OldRequestLink requestId={requestId} />}
      </BoardHostContext.Provider>
    </div>
  )
}
