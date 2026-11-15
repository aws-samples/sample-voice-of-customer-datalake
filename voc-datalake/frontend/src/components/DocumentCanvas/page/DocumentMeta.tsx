/**
 * @fileoverview The row of details under the page's title, as chips: who wrote it (its creator when the project
 * knows them, else the project's owner, each said as such), when it was last edited (relative, kept current), how
 * long it reads (its words and minutes, counted on the text being written) and its type. Only what the document
 * records: nothing is shown for a detail it does not have.
 *
 * @module components/DocumentCanvas/page/DocumentMeta
 */
import { Clock, UserRound } from 'lucide-react'
import { useDeferredValue, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNow } from '../../../hooks/useNow'
import { formatRelativeDate } from '../../../utils/dateUtils'
import { DocumentTypeBadge } from '../../DocumentTypeBadge/DocumentTypeBadge'
import { countWords, readingMinutes } from './wordCount'
import type { Project, ProjectMember, ProjectOwner } from '../../../api/projectTypes'
import type { ProjectDocument } from '../../../api/types'

interface DocumentMetaProps {
  readonly project: Project
  readonly document: ProjectDocument
  /** The text being written (the draft), or the stored text read only. */
  readonly text: string
}

const CHIP_CLASS = 'badge badge-muted'

/**
 * `when` (formatRelativeDate) as it reads inside a sentence: its "Now" and "Yesterday" are capitalised to open one,
 * so after "Edited" they go back to the language's own spelling; a date ("Oct 6") stays as it is.
 */
function midSentence(when: string, language: string): string {
  const relative = new Intl.RelativeTimeFormat(language || 'en', { numeric: 'auto', style: 'short' })
  const own = [relative.format(0, 'second'), relative.format(-1, 'day')]
  return own.find((word) => word.toLocaleLowerCase(language || 'en') === when.toLocaleLowerCase(language || 'en')) ?? when
}

/** The document's creator, if the project lists them; else its owner. Null when neither is known. */
function authorOf(project: Project, document: ProjectDocument): { readonly name: string; readonly creator: boolean } | null {
  const sub = document.created_by_sub
  const owner = project.owner ?? null
  const members = project.members ?? []
  const people: readonly (ProjectOwner | ProjectMember)[] = owner === null ? members : [owner, ...members]
  const creator = sub === undefined ? undefined : people.find((person) => person.sub === sub)
  if (creator !== undefined) return { name: creator.username || creator.email, creator: true }
  return owner === null ? null : { name: owner.username || owner.email, creator: false }
}

export default function DocumentMeta({ project, document, text }: DocumentMetaProps) {
  const { t, i18n } = useTranslation('projectDetail')
  const now = useNow()
  const author = authorOf(project, document)
  const edited = midSentence(formatRelativeDate(document.updated_at ?? document.created_at, i18n.language, now), i18n.language)
  // Counted behind the typing (a long document's count never holds a keystroke up).
  const deferred = useDeferredValue(text)
  const words = useMemo(() => countWords(deferred, i18n.language), [deferred, i18n.language])
  const minutes = readingMinutes(words)
  return (
    <ul aria-label={t('canvas.meta.label')} data-testid="document-meta" className="mt-3 flex flex-wrap items-center gap-2">
      {author === null ? null : (
        <li className={CHIP_CLASS}>
          <UserRound size={12} aria-hidden />
          {author.creator ? t('canvas.meta.author', { name: author.name }) : t('canvas.meta.owner', { name: author.name })}
        </li>
      )}
      {edited === '' ? null : (
        <li className={CHIP_CLASS}><Clock size={12} aria-hidden />{t('canvas.meta.edited', { when: edited })}</li>
      )}
      <li className={CHIP_CLASS}>
        {minutes === 0
          ? t('canvas.meta.words', { count: words })
          : t('canvas.meta.wordsAndMinutes', { words: t('canvas.meta.words', { count: words }), minutes: t('canvas.meta.minutes', { count: minutes }) })}
      </li>
      <li className="flex"><DocumentTypeBadge type={document.document_type} /></li>
    </ul>
  )
}
