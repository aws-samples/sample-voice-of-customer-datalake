/**
 * @fileoverview A stored text read: rendered by the light reader, or (Source) exactly as stored in a code view. The
 * read mode of DocumentSurface, and a version opened from History.
 *
 * @module components/Document/read/ReadView
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import CodeView from '../text/CodeView'
import MarkdownRead from './MarkdownRead'
import ViewToggle from './ViewToggle'
import type { Ref } from 'react'
import type { MarkdownPolicy } from './markdownPolicy'
import type { TextView } from './ViewToggle'
import type { OutlineItem } from '../types'

interface ReadViewProps {
  readonly source: string
  readonly policy: MarkdownPolicy
  /** The text's name (its title): the Source view's region is "Source of …". */
  readonly title: string
  readonly className?: string
  readonly onOutline?: (items: readonly OutlineItem[]) => void
  readonly headingIds?: boolean
  readonly rootRef?: Ref<HTMLDivElement>
}

export default function ReadView({ source, policy, title, className, onOutline, headingIds, rootRef }: ReadViewProps) {
  const { t } = useTranslation('documents')
  const [view, setView] = useState<TextView>('rendered')
  return (
    <div className="space-y-3">
      <ViewToggle value={view} onChange={setView} />
      {view === 'rendered' ? (
        <MarkdownRead source={source} policy={policy} className={className} onOutline={onOutline} headingIds={headingIds}
          rootRef={rootRef} />
      ) : <CodeView text={source} label={t('view.sourceOf', { title })} />}
    </div>
  )
}
