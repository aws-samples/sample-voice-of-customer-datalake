/**
 * DocumentList - the selectable document rail of the Documents tab, in the project's four sections
 * (docs/prototype-builder.md "Part 4"): PRD, PR/FAQ, Prototypes and Documents, always in that order
 * (api/documentSections.ts), each newest first by last edit. A PRD / PR/FAQ series is one row, its newest version
 * (seriesHeads; the page has the older ones), selected while any version of it is.
 *
 * From `xl` (1280 px) the list is a narrow column beside the page: each section is a disclosure (a heading whose
 * button names the section and its count, `aria-expanded`), every one open on each page view (folding is not
 * remembered), with its New beside it for editors. Below `xl` the list is a strip above the page: the sections
 * become a row of section buttons above it and the strip holds one section (the selected document's, else the
 * first with documents), so it never scrolls sideways through all four. Rows are cards (DocumentCard), buttons with
 * `aria-current` on the selected one; titles are plain text rather than headings, because a heading inside a button
 * is flattened into the button's name anyway and a list of them broke the page outline (h1 → h4). Each card has its
 * menu (a right-click, the ContextMenu key or Shift+F10, its "⋯"): Open, and for an editor Rename and Delete. A series
 * card acts on the version it shows, the latest: Open opens it, Delete deletes that one version (as the page's own
 * Delete does; the next one down is the series' card then), and there is no Rename (a PRD / PR/FAQ title is its
 * series').
 */
import clsx from 'clsx'
import { ChevronRight, Loader2, Plus } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isVersionManagedDocument, ordinalByType, type DocumentOrdinal } from '../../api/documentLineage'
import { byNewestEdit, groupBySection, sectionOf, type DocumentSectionGroup, type DocumentSectionId } from '../../api/documentSections'
import DocumentCard, { type DocumentCardActions } from './DocumentCard'
import { listedIdOf, seriesHeads } from './documentEdit'
import SectionNewMenu, { type SectionNewChoice } from './SectionNewMenu'
import type { ReactNode } from 'react'
import type { TFunction } from 'i18next'
import type { ProjectDocument } from '../../api/types'

/** A section's New: what it opens, and whether (and why) it cannot be used now. */
export interface SectionNewAction {
  /** What New does; ignored when it is a menu (`choices`). */
  readonly onClick: () => void
  /** New is a menu of these (the PRD / PR/FAQ: Blank, With the wizard) instead of one action. */
  readonly choices?: readonly SectionNewChoice[]
  /** Its action is on its way (a blank document being created): disabled, with a spinner. */
  readonly busy?: boolean
  readonly disabled?: boolean
  /** Why it is disabled, said under the section's heading (and as the button's description). */
  readonly reason?: string
  /** A line under the section about the action's last use (a build that failed to start, or began). */
  readonly status?: ReactNode
}

interface DocumentListProps {
  readonly documents: ProjectDocument[]
  readonly selectedDoc: ProjectDocument | null
  readonly onSelectDoc: (doc: ProjectDocument) => void
  /** Each section's New, for an editor; absent for a viewer, who sees no New at all. */
  readonly newActions?: Readonly<Record<DocumentSectionId, SectionNewAction>>
  /** Each card's Rename and Delete, for an editor; absent for a viewer, whose card menu has Open only. */
  readonly cardActions?: DocumentCardActions
}

type Group = DocumentSectionGroup<ProjectDocument>

/** The names and New labels, as literal keys (a key built at runtime is invisible to the i18n extractor). */
function sectionTexts(t: TFunction<'projectDetail'>): Readonly<Record<DocumentSectionId, { name: string; newLabel: string }>> {
  return {
    prd: { name: t('documents.sections.prd'), newLabel: t('documents.sections.newPrd') },
    prfaq: { name: t('documents.sections.prfaq'), newLabel: t('documents.sections.newPrfaq') },
    prototypes: { name: t('documents.sections.prototypes'), newLabel: t('documents.sections.newPrototype') },
    documents: { name: t('documents.sections.documents'), newLabel: t('documents.newDocument') },
  }
}

/** A section button picked below `xl`, valid while the selection it was picked under is still the selection. */
interface NarrowPick {
  readonly section: DocumentSectionId
  readonly underDoc: string | null
}

/** The one section the strip holds below `xl`: the one picked, else the selected document's, else the first with documents. */
function narrowSection(groups: readonly Group[], selectedDoc: ProjectDocument | null, pick: NarrowPick | null): DocumentSectionId {
  const selectedId = selectedDoc?.document_id ?? null
  if (pick !== null && pick.underDoc === selectedId) return pick.section
  if (selectedDoc !== null) return sectionOf(selectedDoc)
  return groups.find((group) => group.documents.length > 0)?.section ?? 'prd'
}

export default function DocumentList({
  documents, selectedDoc, onSelectDoc, newActions, cardActions,
}: DocumentListProps) {
  const { t } = useTranslation('projectDetail')
  const baseId = useId()
  // One pass for the whole list rather than one per row, and memoised because the
  // list re-renders on every selection change while the documents themselves do not.
  const ordinals = useMemo(() => ordinalByType(documents), [documents])
  const listed = useMemo(() => seriesHeads(documents), [documents])
  const groups = useMemo(
    () => groupBySection(listed).map((group) => ({ ...group, documents: [...group.documents].sort(byNewestEdit) })),
    [listed],
  )
  const selectedId = selectedDoc === null ? undefined : listedIdOf(selectedDoc, listed)
  // Every section starts open on each page view; folding lives only as long as the list.
  const [folded, setFolded] = useState<ReadonlySet<DocumentSectionId>>(() => new Set())
  const [pick, setPick] = useState<NarrowPick | null>(null)
  const open = narrowSection(groups, selectedDoc, pick)
  const texts = sectionTexts(t)
  const listIdOf = (section: DocumentSectionId) => `${baseId}-${section}`
  const toggle = (section: DocumentSectionId) => setFolded((current) => {
    const next = new Set(current)
    if (!next.delete(section)) next.add(section)
    return next
  })

  return (
    <div className="min-w-0 space-y-3">
      <div role="group" aria-label={t('documents.sections.label')} className="tabs-track flex-wrap xl:hidden">
        {groups.map(({ section, documents: inSection }) => (
          <button key={section} type="button" aria-expanded={open === section} aria-controls={listIdOf(section)}
            className={clsx('tab', open === section && 'tab-active')}
            onClick={() => setPick({ section, underDoc: selectedDoc?.document_id ?? null })}>
            <SectionLabel name={texts[section].name} count={inSection.length} countClassName="font-mono" />
          </button>
        ))}
      </div>
      {groups.map((group) => (
        <DocumentSection key={group.section} group={group} listId={listIdOf(group.section)} texts={texts[group.section]}
          expanded={!folded.has(group.section)} narrowOpen={open === group.section} onToggle={() => toggle(group.section)}
          newAction={newActions?.[group.section]} selectedId={selectedId} ordinals={ordinals}
          onSelectDoc={onSelectDoc} cardActions={cardActions} />
      ))}
    </div>
  )
}

interface DocumentSectionProps {
  readonly group: Group
  readonly listId: string
  readonly texts: { readonly name: string; readonly newLabel: string }
  /** Open in the wide column (its disclosure). */
  readonly expanded: boolean
  /** The section the narrow strip holds. */
  readonly narrowOpen: boolean
  readonly onToggle: () => void
  readonly newAction?: SectionNewAction
  readonly selectedId?: string
  readonly ordinals: ReadonlyMap<string, DocumentOrdinal>
  readonly onSelectDoc: (doc: ProjectDocument) => void
  readonly cardActions?: DocumentCardActions
}

function DocumentSection({
  group, listId, texts, expanded, narrowOpen, onToggle, newAction, selectedId, ordinals, onSelectDoc, cardActions,
}: DocumentSectionProps) {
  const { t } = useTranslation('projectDetail')
  const count = group.documents.length
  return (
    // Below xl only the strip's section shows; from xl every section, open or folded.
    <div className={clsx('space-y-2', !narrowOpen && 'hidden xl:block')}>
      <SectionHeader listId={listId} texts={texts} count={count} expanded={expanded} onToggle={onToggle} newAction={newAction} />
      {expanded || narrowOpen ? (
        <ul id={listId}
          className={clsx(
            'flex xl:flex-col gap-3 xl:gap-2 overflow-x-auto xl:overflow-x-visible pb-2 xl:pb-0 -mx-4 px-4 xl:mx-0 xl:px-0',
            !expanded && 'xl:hidden',
          )}>
          {count === 0 ? (
            <li className="px-1 py-1 text-sm text-muted">{t('documents.noDocuments')}</li>
          ) : group.documents.map((document) => (
            <li key={document.document_id} className="flex-shrink-0 xl:w-full">
              <DocumentCard document={document} selected={selectedId === document.document_id}
                ordinal={isVersionManagedDocument(document) ? undefined : ordinals.get(document.document_id)}
                onSelect={() => onSelectDoc(document)} actions={cardActions} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** A section's heading (its disclosure, from xl), its New and the New's reason and status lines. */
function SectionHeader({ listId, texts, count, expanded, onToggle, newAction }: Readonly<{
  listId: string
  texts: { readonly name: string; readonly newLabel: string }
  count: number
  expanded: boolean
  onToggle: () => void
  newAction?: SectionNewAction
}>) {
  const reasonId = `${listId}-reason`
  const reason = newAction?.disabled === true ? newAction.reason : undefined
  return (
    <>
      <div className="flex items-center gap-2">
        <h2 className="hidden xl:block min-w-0 flex-1">
          <button type="button" aria-expanded={expanded} aria-controls={listId} onClick={onToggle}
            className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-sm font-semibold text-text-strong hover:bg-bg-hover focus-ring">
            <ChevronRight size={14} aria-hidden
              className={clsx('flex-shrink-0 text-muted transition-transform motion-reduce:transition-none', expanded && 'rotate-90')} />
            <SectionLabel name={texts.name} count={count} nameClassName="truncate" countClassName="badge badge-muted font-mono" />
          </button>
        </h2>
        {newAction === undefined ? null : (
          <SectionNewButton action={newAction} label={texts.newLabel} describedBy={reason === undefined ? undefined : reasonId} />
        )}
      </div>
      {reason === undefined ? null : <p id={reasonId} className="text-xs text-muted">{reason}</p>}
      {newAction?.status}
    </>
  )
}

/** A section's New: one button, or the menu of its ways to start (`choices`). */
function SectionNewButton({ action, label, describedBy }: Readonly<{
  action: SectionNewAction; label: string; describedBy: string | undefined
}>) {
  const { t } = useTranslation('projectDetail')
  const disabled = action.disabled === true || action.busy === true
  if (action.choices !== undefined) {
    return <SectionNewMenu label={label} choices={action.choices} disabled={disabled} describedBy={describedBy} />
  }
  return (
    <button type="button" onClick={action.onClick} disabled={disabled} aria-label={label} aria-describedby={describedBy}
      aria-busy={action.busy === true ? true : undefined} className="btn btn-secondary btn-sm ml-auto flex-shrink-0">
      {action.busy === true ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Plus size={14} aria-hidden />}
      {t('documents.sections.new')}
    </button>
  )
}

/**
 * A section button's text: the name and its count on screen ("PR/FAQ 2"), and one sentence for a screen reader
 * ("PR/FAQ, 2 documents"; the button adds "expanded"). Its content names the button, never an `aria-label`, so the
 * name starts with the words on screen.
 */
function SectionLabel({ name, count, nameClassName, countClassName }: Readonly<{
  name: string
  count: number
  nameClassName?: string
  countClassName: string
}>) {
  const { t } = useTranslation('projectDetail')
  return (
    <>
      <span className={nameClassName} aria-hidden>{name}</span>
      <span className={countClassName} aria-hidden>{count}</span>
      <span className="sr-only">{t('documents.sections.toggle', { name, count })}</span>
    </>
  )
}
