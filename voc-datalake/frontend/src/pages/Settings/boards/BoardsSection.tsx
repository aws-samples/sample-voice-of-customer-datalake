/**
 * @fileoverview Administration → Privacy & access → Boards (admin-only, docs/feature-requests.md; main's section,
 * 7.59.00 again): the list of feedback boards with "New board", the company domains (`#domains`) and the participant
 * email (`#participants`, with the boards since 7.54.00: who counts as a colleague and what the emails say), and — at
 * `/admin/access/boards/<id>` (adminPaths.ts) — one board's editor. Opening or leaving a board is a path change
 * (Back works, a link opens the editor), so the editor's unsaved-changes guard catches it.
 * @module pages/Settings/boards/BoardsSection
 */
import ParticipantSettingsCard from '../ParticipantSettingsCard'
import { CardAnchor } from '../CardAnchor'
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
      <CardAnchor card="domains"><CompanyDomainsCard /></CardAnchor>
      <CardAnchor card="participants"><ParticipantSettingsCard /></CardAnchor>
    </div>
  )
}
