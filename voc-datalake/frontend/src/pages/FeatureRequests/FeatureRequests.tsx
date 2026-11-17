/**
 * @fileoverview `/feature-requests` (docs/feature-requests.md): two tabs over the app session —
 * Boards (the feedback boards as cards; an admin's gear opens Administration → Privacy & access →
 * Boards) and Insights (`/feature-requests/insights`: the boards as their own evidence source, never
 * mixed into review metrics). A request known only by its id (`/feature-requests/requests/<id>`: a
 * document's citation, Insights) opens that request on its board instead. Board-pool users reach the same boards at `/board`, without Insights.
 */
import { BarChart3, LayoutGrid, Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { IconTabs } from '../../components/IconTabs/IconTabs'
import { Link, useLocation } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'
import { PageTitle } from '../../components/PageTitle/PageTitle'
import BoardList from './BoardList'
import InsightsTab from './InsightsTab'
import RequestLookup from './RequestLookup'
import { APP_BOARD_HOST, BOARDS_ADMIN_PATH, BoardHostContext, isAppAdmin } from './boardContext'
import { INSIGHTS_SEGMENT, REQUEST_LOOKUP_SEGMENT } from './boardPaths'
import { searchWithout, segmentsUnder, usePlaceNavigate } from '../../utils/pathPlace'
import { useBoardList } from './useBoardQueries'
import { INSIGHTS_VIEW_PARAMS } from './useInsights'
import { Tooltip } from '../../components/Tooltip/Tooltip'

type PageTab = 'boards' | 'insights'
const BOARDS_PATH = APP_BOARD_HOST.basePath
const INSIGHTS_PATH = `${BOARDS_PATH}/${INSIGHTS_SEGMENT}`
const PAGE_TABS: readonly PageTab[] = ['boards', 'insights']
const TAB_ICONS: Readonly<Record<PageTab, LucideIcon>> = { boards: LayoutGrid, insights: BarChart3 }

/** The tab the path names (`/feature-requests/insights`) and the switch to the other (a history entry); leaving
 * Insights drops its view parameters. */
function usePageTab(): readonly [PageTab, (tab: PageTab) => void] {
  const { pathname, search } = useLocation()
  const tab: PageTab = pathname === INSIGHTS_PATH ? 'insights' : 'boards'
  const move = usePlaceNavigate()
  const setTab = (next: PageTab) => {
    if (next === 'boards') move({ pathname: BOARDS_PATH, search: searchWithout(search, INSIGHTS_VIEW_PARAMS) })
    else move({ pathname: INSIGHTS_PATH, search })
  }
  return [tab, setTab]
}

/** The request a link knows only by its id: `/feature-requests/requests/<id>`. */
function lookedUpRequest(pathname: string): string | null {
  const [first, requestId] = segmentsUnder(BOARDS_PATH, pathname) ?? []
  return first === REQUEST_LOOKUP_SEGMENT && requestId !== undefined ? requestId : null
}

function PageTabs({ active, onChange }: Readonly<{ active: PageTab; onChange: (tab: PageTab) => void }>) {
  const { t } = useTranslation('featureRequests')
  return (
    <IconTabs tabs={PAGE_TABS} active={active} icons={TAB_ICONS} label={t('page.title')}
      labelOf={(id) => (id === 'boards' ? t('tabs.boards') : t('tabs.insights'))} onSelect={onChange} />
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
          <Tooltip kind="label" content={t('boards.configure')}>
            <Link className="btn btn-ghost btn-sm" to={BOARDS_ADMIN_PATH} aria-label={t('boards.configure')}>
              <Settings size={16} aria-hidden="true" />
            </Link>
          </Tooltip>
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
  const requestId = lookedUpRequest(useLocation().pathname)
  return (
    <div className="max-w-5xl mx-auto min-w-0 w-full space-y-4 sm:space-y-6">
      <BoardHostContext.Provider value={APP_BOARD_HOST}>
        {requestId === null ? <Boards /> : <RequestLookup requestId={requestId} />}
      </BoardHostContext.Provider>
    </div>
  )
}
