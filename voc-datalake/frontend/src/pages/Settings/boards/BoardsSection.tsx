/**
 * @fileoverview Administration → Feedback boards (admin-only, docs/feature-requests.md): the list of feedback boards
 * with "New board", the company domains (`/admin/boards/domains`) and the participant email
 * (`/admin/boards/participants`, moved here from Users in 7.54.00: who counts as a colleague and what the emails say),
 * and — at `/admin/boards/<id>` (adminPaths.ts) — one board's editor. Opening or leaving a board is a path change
 * (Back works, a link opens the editor), so the editor's unsaved-changes guard catches it.
 * @module pages/Settings/boards/BoardsSection
 */
import ParticipantSettingsCard from '../ParticipantSettingsCard'
import { SectionAnchor } from '../SectionAnchor'
import { useBoardInPath } from '../useAdminLocation'
import BoardEditor from './BoardEditor'
import BoardList from './BoardList'
import CompanyDomainsCard from './CompanyDomainsCard'

export default function BoardsSection() {
  const [boardId, openBoard] = useBoardInPath()
  if (boardId !== null) return <BoardEditor boardId={boardId} onClose={() => openBoard(null)} />
  return (
    <div className="space-y-6">
      <BoardList onOpen={openBoard} />
      <SectionAnchor section="domains"><CompanyDomainsCard /></SectionAnchor>
      <SectionAnchor section="participants"><ParticipantSettingsCard /></SectionAnchor>
    </div>
  )
}
