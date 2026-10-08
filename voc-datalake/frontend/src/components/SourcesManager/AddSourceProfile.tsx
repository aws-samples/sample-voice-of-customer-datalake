/**
 * @fileoverview Add a profile: pick a source the platform already writes
 * (plugins, feedback forms, manual import) or type an import source id of your
 * own (`sales_csv`, `support_tickets`) — that id is what CSV uploads select.
 * A web scraper's source id is its scraper NAME, so suggestions list scraper
 * names in the id format (`knownSourceIds`).
 *
 * @module components/SourcesManager/AddSourceProfile
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { newIdProblem } from './sourceDraft'
import type { DraftProfile } from './sourceDraft'

interface AddSourceProfileProps {
  knownIds: readonly string[]
  draft: readonly DraftProfile[]
  disabled: boolean
  onAdd: (id: string) => void
}

export default function AddSourceProfile({ knownIds, draft, disabled, onAdd }: Readonly<AddSourceProfileProps>) {
  const { t } = useTranslation('components', { keyPrefix: 'sourcesManager' })
  const { t: tAll } = useTranslation()
  const inputId = useId()
  const listId = useId()
  const [id, setId] = useState('')
  const trimmed = id.trim()
  const problem = trimmed === '' ? null : newIdProblem(trimmed, draft)
  const unprofiled = knownIds.filter((known) => !draft.some((d) => d.profile.id === known))

  const add = () => {
    if (trimmed === '' || problem !== null) return
    onAdd(trimmed)
    setId('')
  }

  return (
    <div>
      <label htmlFor={inputId} className="block text-xs font-medium text-text mb-1">{t('addLabel')}</label>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          id={inputId}
          type="text"
          list={listId}
          value={id}
          onChange={(e) => setId(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add() }}
          placeholder="support_tickets"
          aria-invalid={problem !== null}
          className={problem === null ? 'input font-mono flex-1' : 'input font-mono flex-1 border-danger'}
        />
        <datalist id={listId}>
          {unprofiled.map((known) => <option key={known} value={known} />)}
        </datalist>
        <button type="button" onClick={add} disabled={disabled || trimmed === '' || problem !== null} className="btn btn-secondary">
          <Plus size={14} aria-hidden="true" /> {t('add')}
        </button>
      </div>
      <p className={problem === null ? 'text-xs text-muted mt-1' : 'text-xs text-danger mt-1'}>
        {problem === null ? t('addHint') : tAll(problem)}
      </p>
      <p className="text-xs text-muted mt-1">{t('scraperHint')}</p>
    </div>
  )
}
