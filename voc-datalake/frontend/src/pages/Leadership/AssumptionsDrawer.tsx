/**
 * @fileoverview The leadership view's assumptions drawer: what the time-saved estimate rests on, beside the hours
 * (owner decision 11: an estimate, labelled, its assumptions on show). The label, each assumption, and per artifact
 * type the AI-made count in the range, the baseline hours (the admin's, or the default, said so) and their product;
 * the admin's note. An admin of the scope edits the baselines and the note here (`PUT /settings/adoption`); everyone
 * else who reads the view reads them only.
 * @module pages/Leadership/AssumptionsDrawer
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Info } from 'lucide-react'
import { ADOPTION_ROOT_KEY, ARTIFACT_TYPES, adoptionApi } from '../../api/adoptionApi'
import type { AdoptionView, ArtifactType } from '../../api/adoptionApi'
import SideSheet from '../../components/SideSheet/SideSheet'
import { formatCount, formatDecimal } from '../../utils/numberFormat'

const MAX_HOURS = 200
const MAX_NOTE = 500

type Draft = Record<ArtifactType, string>

function draftOf(view: AdoptionView): Draft {
  const baselines = view.time_saved.baselines
  return { personas: String(baselines.personas.hours), research: String(baselines.research.hours),
    prfaq: String(baselines.prfaq.hours), prd: String(baselines.prd.hours), prototype: String(baselines.prototype.hours) }
}

/** The hours a field holds, or null when it is not a number in range. */
function hoursOf(text: string): number | null {
  const value = Number(text.replace(',', '.'))
  return text.trim() !== '' && Number.isFinite(value) && value >= 0 && value <= MAX_HOURS ? value : null
}

/** Only the baselines the admin changed: a type left as shown is not sent, so one at its default stays a default
 *  (never saved as the admin's own). Undefined when none changed. */
function changedBaselines(view: AdoptionView, draft: Draft): Partial<Record<ArtifactType, number | null>> | undefined {
  const changed = ARTIFACT_TYPES.flatMap((type) => {
    const hours = hoursOf(draft[type])
    return hours === view.time_saved.baselines[type].hours ? [] : [[type, hours] as const]
  })
  return changed.length === 0 ? undefined : Object.fromEntries(changed)
}

function BaselineEditor({ view, onSaved }: Readonly<{ view: AdoptionView; onSaved: () => void }>) {
  const { t } = useTranslation('leadership')
  const client = useQueryClient()
  const [draft, setDraft] = useState<Draft>(() => draftOf(view))
  const [note, setNote] = useState(view.time_saved.note ?? '')
  const invalid = ARTIFACT_TYPES.some((type) => hoursOf(draft[type]) === null) || note.length > MAX_NOTE
  const save = useMutation({
    mutationFn: () => {
      const baselines = changedBaselines(view, draft)
      return adoptionApi.saveSettings({
        ...(baselines === undefined ? {} : { baselines }),
        note: note.trim() === '' ? null : note.trim(),
      })
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ADOPTION_ROOT_KEY })
      onSaved()
    },
  })
  return (
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (!invalid) save.mutate() }}>
      <h3 className="text-sm font-semibold text-text-strong">{t('assumptions.edit.title')}</h3>
      <div className="grid grid-cols-2 gap-3">
        {ARTIFACT_TYPES.map((type) => (
          <label key={type} className="flex flex-col gap-1 text-sm">
            <span className="text-muted">{t('assumptions.edit.hoursFor', { artifact: t(`artifacts.${type}`) })}</span>
            <input className="input" inputMode="decimal" value={draft[type]} aria-invalid={hoursOf(draft[type]) === null}
              onChange={(event) => setDraft({ ...draft, [type]: event.target.value })} />
          </label>
        ))}
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-muted">{t('assumptions.edit.note')}</span>
        <textarea className="input min-h-[5rem]" maxLength={MAX_NOTE} value={note}
          onChange={(event) => setNote(event.target.value)} />
      </label>
      {invalid ? <p className="text-sm text-danger" role="alert">{t('assumptions.edit.invalid', { max: MAX_HOURS })}</p> : null}
      {save.isError ? <p className="text-sm text-danger" role="alert">{t('assumptions.edit.failed')}</p> : null}
      <button type="submit" className="btn btn-primary" disabled={invalid || save.isPending}>
        {t('assumptions.edit.save')}
      </button>
    </form>
  )
}

interface AssumptionsDrawerProps {
  readonly isOpen: boolean
  readonly onClose: () => void
  readonly view: AdoptionView | undefined
  readonly canEdit: boolean
}

export default function AssumptionsDrawer({ isOpen, onClose, view, canEdit }: AssumptionsDrawerProps) {
  const { t, i18n } = useTranslation('leadership')
  const locale = i18n.language
  return (
    <SideSheet isOpen={isOpen} onClose={onClose} title={t('assumptions.title')} icon={Info}
      description={t('assumptions.description')}>
      {view === undefined ? null : (
        <div className="space-y-5">
          <p className="rounded-lg bg-warn-subtle p-3 text-sm text-warn" role="note">{t('assumptions.label')}</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-text">
            {view.time_saved.assumptions.map((assumption) => (
              <li key={assumption.code}>{t(`assumptions.codes.${assumption.code}`, { defaultValue: assumption.text })}</li>
            ))}
          </ul>
          <table className="w-full text-sm">
            <caption className="sr-only">{t('assumptions.tableCaption')}</caption>
            <thead>
              <tr className="text-left text-muted">
                <th scope="col" className="py-1 pr-2 font-medium">{t('assumptions.columns.artifact')}</th>
                <th scope="col" className="py-1 pr-2 text-right font-medium">{t('assumptions.columns.count')}</th>
                <th scope="col" className="py-1 pr-2 text-right font-medium">{t('assumptions.columns.baseline')}</th>
                <th scope="col" className="py-1 text-right font-medium">{t('assumptions.columns.hours')}</th>
              </tr>
            </thead>
            <tbody>
              {ARTIFACT_TYPES.map((type) => {
                const made = view.totals.artifacts[type].ai
                const baseline = view.time_saved.baselines[type]
                return (
                  <tr key={type} className="border-t border-border">
                    <th scope="row" className="py-1 pr-2 text-left font-normal text-text">{t(`artifacts.${type}`)}</th>
                    <td className="py-1 pr-2 text-right font-mono">{formatCount(made, locale)}</td>
                    <td className="py-1 pr-2 text-right font-mono">
                      {formatDecimal(baseline.hours, locale, 1)}
                      <span className="block text-xs font-sans text-muted">
                        {baseline.saved ? t('assumptions.saved') : t('assumptions.default')}
                      </span>
                    </td>
                    <td className="py-1 text-right font-mono">{formatDecimal(made * baseline.hours, locale, 1)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {view.time_saved.note === null ? null : (
            <p className="text-sm text-text"><span className="text-muted">{t('assumptions.note')} </span>{view.time_saved.note}</p>
          )}
          {canEdit ? <BaselineEditor key={view.time_saved.updated_at ?? 'defaults'} view={view} onSaved={onClose} /> : (
            <p className="text-sm text-muted">{t('assumptions.readOnly')}</p>
          )}
        </div>
      )}
    </SideSheet>
  )
}
