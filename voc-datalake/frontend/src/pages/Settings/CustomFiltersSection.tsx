/**
 * @fileoverview Admin config card for custom-field filters (Phase 4d).
 *
 * Lets an admin expose up to 3 stored `custom_fields` keys as filters on the
 * Categories feedback page. Reads the current config and the recommended keys
 * (from the candidates endpoint) via useQuery, edits a local draft, and saves
 * the whole list via useMutation. The PUT is admin-gated server-side too — this
 * card renders only for admins, mirroring AiModelSection.
 *
 * @module pages/Settings/CustomFiltersSection
 */
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { SlidersHorizontal, CheckCircle2, Loader2, AlertCircle, Plus, X } from 'lucide-react'
import {
  getCustomFilters,
  saveCustomFilters,
  getCustomFieldCandidates,
} from '../../api/customFiltersApi'

const MAX_CUSTOM_FILTERS = 3

interface CustomFiltersSectionProps {
  readonly apiEndpoint: string
  /** Card renders only for admins — the backend gates the PUT server-side too. */
  readonly isAdmin: boolean
}

/** A draft filter row being edited. `label` may be blank; the server defaults it to key. */
interface DraftFilter {
  key: string
  label: string
}

export default function CustomFiltersSection({ apiEndpoint, isAdmin }: CustomFiltersSectionProps) {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState<DraftFilter[] | null>(null)
  const [justSaved, setJustSaved] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const enabled = isAdmin && apiEndpoint.length > 0

  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current)
  }, [])

  const { data, isLoading, isError } = useQuery({
    queryKey: ['custom-filters-config'],
    queryFn: () => getCustomFilters(),
    enabled,
  })

  const { data: candidates } = useQuery({
    queryKey: ['custom-field-candidates'],
    queryFn: () => getCustomFieldCandidates(),
    enabled,
  })

  // Seed the editable draft from the loaded config, and re-seed whenever the
  // loaded config changes identity (first load, or a refetch after save).
  // Render-phase adjustment per React's "adjusting state when a prop changes"
  // pattern — avoids a cascading-render effect while still tracking the query.
  const loaded = data?.custom_filters
  const [seededFrom, setSeededFrom] = useState<typeof loaded>(undefined)
  if (loaded && loaded !== seededFrom) {
    setSeededFrom(loaded)
    setDraft(loaded.map((f) => ({ key: f.key, label: f.label })))
  }

  const saveMutation = useMutation({
    mutationFn: (filters: DraftFilter[]) =>
      // Drop blank rows; send key + label (label omitted when blank so the
      // server defaults it to the key).
      saveCustomFilters(
        filters
          .filter((f) => f.key.trim())
          .map((f) => (f.label.trim() ? { key: f.key.trim(), label: f.label.trim() } : { key: f.key.trim() })),
      ),
    onSuccess: () => {
      setJustSaved(true)
      if (savedTimer.current) clearTimeout(savedTimer.current)
      savedTimer.current = setTimeout(() => setJustSaved(false), 2000)
      void queryClient.invalidateQueries({ queryKey: ['custom-filters-config'] })
    },
  })

  if (!enabled) return null

  const suggestionKeys = (candidates?.candidates ?? []).map((c) => c.key)

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-1">
        <SlidersHorizontal size={18} className="text-blue-600" />
        <h2 className="text-lg font-semibold">{t('customFilters.title')}</h2>
      </div>
      <p className="text-xs text-gray-500 mb-4">{t('customFilters.intro')}</p>
      <CustomFiltersBody
        draft={draft}
        isLoading={isLoading}
        isError={isError}
        suggestionKeys={suggestionKeys}
        onChange={setDraft}
      />
      {draft && (
        <SaveRow
          disabled={saveMutation.isPending}
          justSaved={justSaved}
          isError={saveMutation.isError}
          onSave={() => saveMutation.mutate(draft)}
        />
      )}
    </div>
  )
}

interface CustomFiltersBodyProps {
  readonly draft: DraftFilter[] | null
  readonly isLoading: boolean
  readonly isError: boolean
  readonly suggestionKeys: string[]
  readonly onChange: (next: DraftFilter[]) => void
}

function CustomFiltersBody({ draft, isLoading, isError, suggestionKeys, onChange }: CustomFiltersBodyProps) {
  const { t } = useTranslation('settings')

  if (isError) {
    return (
      <div className="flex items-center gap-2 text-sm text-red-600" role="alert">
        <AlertCircle size={16} /> {t('customFilters.loadFailed')}
      </div>
    )
  }
  if (isLoading || !draft) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <Loader2 size={16} className="animate-spin" /> {t('customFilters.loading')}
      </div>
    )
  }

  const setRow = (index: number, patch: Partial<DraftFilter>) =>
    onChange(draft.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  const removeRow = (index: number) => onChange(draft.filter((_, i) => i !== index))
  const addRow = (key = '') => onChange([...draft, { key, label: '' }])

  // Suggestions not already present in the draft, surfaced as quick-add chips.
  const unusedSuggestions = suggestionKeys.filter((k) => !draft.some((row) => row.key === k))

  return (
    <div className="space-y-3">
      {draft.length === 0 && <p className="text-xs text-gray-500">{t('customFilters.empty')}</p>}
      {draft.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <input
            value={row.key}
            onChange={(e) => setRow(index, { key: e.target.value })}
            placeholder={t('customFilters.keyPlaceholder')}
            aria-label={t('customFilters.keyPlaceholder')}
            className="input py-1.5 text-sm flex-1 min-w-0"
          />
          <input
            value={row.label}
            onChange={(e) => setRow(index, { label: e.target.value })}
            placeholder={t('customFilters.labelPlaceholder')}
            aria-label={t('customFilters.labelPlaceholder')}
            className="input py-1.5 text-sm flex-1 min-w-0"
          />
          <button
            onClick={() => removeRow(index)}
            aria-label={t('customFilters.remove')}
            className="p-1.5 text-gray-400 hover:text-red-600"
          >
            <X size={16} />
          </button>
        </div>
      ))}

      {draft.length < MAX_CUSTOM_FILTERS && (
        <button
          onClick={() => addRow()}
          className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700"
        >
          <Plus size={14} /> {t('customFilters.add')}
        </button>
      )}
      <p className="text-xs text-gray-400">{t('customFilters.capHint')}</p>

      <div>
        <p className="text-xs font-medium text-gray-600 mb-1">{t('customFilters.suggestionsTitle')}</p>
        {unusedSuggestions.length === 0 ? (
          <p className="text-xs text-gray-400">{t('customFilters.noSuggestions')}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {unusedSuggestions.map((key) => (
              <button
                key={key}
                onClick={() => addRow(key)}
                disabled={draft.length >= MAX_CUSTOM_FILTERS}
                className="px-2 py-1 text-xs rounded-full border border-gray-200 bg-gray-50 hover:bg-blue-50 hover:border-blue-200 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                + {key}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

interface SaveRowProps {
  readonly disabled: boolean
  readonly justSaved: boolean
  readonly isError: boolean
  readonly onSave: () => void
}

function SaveRow({ disabled, justSaved, isError, onSave }: SaveRowProps) {
  const { t } = useTranslation('settings')
  return (
    <div className="flex items-center gap-3 mt-4">
      <button onClick={onSave} disabled={disabled} className="btn-primary text-sm disabled:opacity-75">
        {t('customFilters.save')}
      </button>
      {justSaved && (
        <span className="text-xs text-green-600 flex items-center gap-1">
          <CheckCircle2 size={14} /> {t('customFilters.saved')}
        </span>
      )}
      {isError && (
        <span className="text-xs text-red-600" role="alert">{t('customFilters.saveFailed')}</span>
      )}
    </div>
  )
}
