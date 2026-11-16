/**
 * @fileoverview Administration → Privacy & access → Boards (admin-only, docs/feature-requests.md):
 * the company domains, the list of feedback boards with "New board", and — at
 * `/admin/access/boards/<id>` (adminPaths.ts) — that board's editor. Opening or leaving a board is a
 * path change (Back works, a link opens the editor), so the editor's unsaved-changes guard catches it.
 * @module pages/Settings/boards/BoardsSection
 */
import { useBoardInPath } from '../useAdminLocation'
import BoardEditor from './BoardEditor'
import BoardList from './BoardList'
import CompanyDomainsCard from './CompanyDomainsCard'

export default function BoardsSection() {
  const [boardId, openBoard] = useBoardInPath()
  if (boardId !== null) return <BoardEditor boardId={boardId} onClose={() => openBoard(null)} />
  return (
    <div className="space-y-6">
      <CompanyDomainsCard />
      <BoardList onOpen={openBoard} />
    </div>
  )
}
