/**
 * @fileoverview Administration → Privacy & access → Boards (admin-only, docs/feature-requests.md):
 * the company domains, the list of feedback boards with "New board", and — with `&board=<id>` in
 * the URL — that board's editor. Opening or leaving a board is a URL change (Back works, a link
 * opens the editor), so the editor's unsaved-changes guard catches it.
 * @module pages/Settings/boards/BoardsSection
 */
import { useSearchParams } from 'react-router-dom'
import BoardEditor from './BoardEditor'
import BoardList from './BoardList'
import CompanyDomainsCard from './CompanyDomainsCard'

const BOARD_PARAM = 'board'

export default function BoardsSection() {
  const [searchParams, setSearchParams] = useSearchParams()
  const boardId = searchParams.get(BOARD_PARAM)
  const openBoard = (next: string | null) => {
    const params = new URLSearchParams(searchParams)
    if (next === null) params.delete(BOARD_PARAM)
    else params.set(BOARD_PARAM, next)
    setSearchParams(params)
  }
  if (boardId !== null && boardId !== '') return <BoardEditor boardId={boardId} onClose={() => openBoard(null)} />
  return (
    <div className="space-y-6">
      <CompanyDomainsCard />
      <BoardList onOpen={openBoard} />
    </div>
  )
}
