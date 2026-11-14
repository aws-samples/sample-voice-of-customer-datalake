/**
 * @fileoverview Preview for `draft_prototype_revision` (docs/prototype-builder.md, parts 2 and 3): the prototype
 * the draft revises (its title and version, from the project record), then what the draft job gets: the EXACT
 * instruction as text, or for selected tester pins how many and where they are (screen and element, from the
 * feedback read: their text is not needed to approve) and that the server writes the instruction itself; then
 * that the draft is only a preview until it is applied on the prototype's page.
 *
 * @module assistant/approvals/previews/PrototypeDraftPreview
 */
import { useTranslation } from 'react-i18next'
import { usePinPlaces } from '../../../components/PrototypeFeedback/pinPlaces'
import type { PinPlace } from '../../../components/PrototypeFeedback/pinPlaces'
import { useProjectDetail } from './useProjectDetail'
import type { DraftPrototypeRevisionArgs } from '../prototypeSchemas'

/** The selected pins' items, once each, in the selection's order (a pin the read does not list is left out). */
function selectedItems(places: ReadonlyMap<string, PinPlace>, pinIds: readonly string[]): PinPlace[] {
  const byItem = new Map<string, PinPlace>()
  for (const id of pinIds) {
    const place = places.get(id)
    if (place !== undefined && !byItem.has(place.itemId)) byItem.set(place.itemId, place)
  }
  return [...byItem.values()]
}

function SelectedPins({ projectId, documentId, pinIds }: Readonly<{ projectId: string; documentId: string; pinIds: readonly string[] }>) {
  const { t } = useTranslation('assistantTools')
  const places = selectedItems(usePinPlaces(projectId, documentId), pinIds)
  return (
    <div data-testid="prototype-draft-pins">
      <p className="font-medium">{t('preview.prototypeDraft.pins', { count: pinIds.length })}</p>
      {places.length > 0 ? (
        <ul className="list-disc pl-5 break-words">
          {places.map((place) => (
            <li key={place.itemId}>
              {place.screen || t('preview.prototypeDraft.noScreen')}
              {place.element === '' ? null : <span className="text-muted"> · {place.element}</span>}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-1 text-muted">{t('preview.prototypeDraft.pinsInstruction')}</p>
    </div>
  )
}

export function PrototypeDraftPreview({ args }: Readonly<{ args: DraftPrototypeRevisionArgs }>) {
  const { t } = useTranslation('assistantTools')
  const { data } = useProjectDetail(args.project_id)
  const prototype = data?.documents.find((d) => d.document_id === args.document_id)
  return (
    <div className="space-y-2 text-[13px]">
      <p>
        <span className="font-medium">{t('preview.prototypeDraft.prototype')}</span>{' '}
        {/* The title carries its version, "Checkout (v3)"; the id until the project record is read. */}
        {prototype?.title ?? args.document_id}
      </p>
      {'pin_ids' in args ? (
        <SelectedPins projectId={args.project_id} documentId={args.document_id} pinIds={args.pin_ids} />
      ) : (
        <div>
          <p className="font-medium">{t('preview.prototypeDraft.instruction')}</p>
          {/* Verbatim and as text: what the draft job gets, never rendered as Markdown or HTML. */}
          <p data-testid="prototype-draft-instruction" className="whitespace-pre-wrap break-words rounded-md border bg-bg-accent p-2">
            {args.instruction}
          </p>
        </div>
      )}
      <p className="rounded-md border border-info/30 bg-info-subtle p-2 text-[12px] text-info">{t('preview.prototypeDraft.note')}</p>
    </div>
  )
}
