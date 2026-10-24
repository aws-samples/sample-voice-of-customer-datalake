/**
 * @fileoverview Administration → Sources → Radar, "Brands tracked": the one place to set up the
 * brands Radar follows (docs/radar.md). Add a brand with its name and website domains, edit its
 * domains, remove it (a confirm says its reviews are kept), then Save brands = one
 * PUT /radar/brands with the whole list. A legacy brand named only by a source profile is listed
 * with that origin and written into the list with the next real save (loading it is no change). The 90-day review counts come
 * from GET /radar.
 * @module pages/Settings/RadarBrandsEditor
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Save, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { radarApi, radarKeys } from '../../api/radarApi'
import { invalidateFeedbackData } from '../../api/invalidateFeedbackData'
import { MAX_RADAR_BRANDS, MAX_RADAR_DOMAINS } from '../../api/radarSchema'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import StickyActionBar from '../../components/StickyActionBar/StickyActionBar'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import { addProblem, needsSave, newBrand, splitDomains, toDraft, toInput } from './radarBrandDraft'
import type { RadarBrandEntry } from '../../api/radarSchema'
import type { AddProblem, BrandDraft } from './radarBrandDraft'

// Held as `…Key:` data so scripts/i18n-check.mjs sees each message.
const ADD_PROBLEMS: Record<AddProblem, { messageKey: string }> = {
  invalidName: { messageKey: 'radar:brands.invalidName' },
  duplicate: { messageKey: 'radar:brands.duplicate' },
  tooMany: { messageKey: 'radar:brands.tooMany' },
}

/** The 90-day review count of each brand key, from GET /radar. */
type BrandTotals = ReadonlyMap<string, number>

function DomainsEditor({ brand, onChange }: Readonly<{ brand: BrandDraft; onChange: (domains: string[]) => void }>) {
  const { t } = useTranslation('radar')
  const id = useId()
  // The text as typed; the draft keeps the parsed domains.
  const [text, setText] = useState(brand.domains.join(', '))
  return (
    <div>
      <label htmlFor={id} className="sr-only">{t('brands.editDomainsLabel', { brand: brand.label })}</label>
      <input id={id} type="text" className="input font-mono text-sm" value={text} placeholder="example.com"
        onChange={(e) => { setText(e.target.value); onChange(splitDomains(e.target.value)) }} />
      <p className="text-xs text-muted mt-1">{t('brands.domainsHint', { max: MAX_RADAR_DOMAINS })}</p>
    </div>
  )
}

function BrandSources({ brand }: Readonly<{ brand: BrandDraft }>) {
  const { t } = useTranslation('radar')
  const labels = useDisplayLabels()
  // A legacy brand names its profiles in its note instead.
  if (brand.sources.length === 0 || brand.origin === 'profile') return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted">{t('setup.sources')}</span>
      {brand.sources.map((source) => <span key={source} className="badge badge-muted">{labels.source(source)}</span>)}
    </div>
  )
}

function BrandRowActions({ brand, editing, onToggleEdit, onRemove }: Readonly<{
  brand: BrandDraft; editing: boolean; onToggleEdit: () => void; onRemove: () => void
}>) {
  const { t } = useTranslation('radar')
  return (
    <div className="flex items-center gap-1 shrink-0">
      <button type="button" className="btn btn-ghost btn-sm" aria-expanded={editing} onClick={onToggleEdit}>
        <Pencil size={14} aria-hidden="true" />
        {editing ? t('brands.doneEditing') : t('brands.editDomains')}
      </button>
      {/* A brand named only by a source profile stays tracked while that profile names it. */}
      {brand.origin === 'list' ? (
        <button type="button" className="btn btn-ghost btn-sm hover:text-danger" aria-label={t('brands.removeLabel', { brand: brand.label })}
          onClick={onRemove}>
          <Trash2 size={14} aria-hidden="true" />
          {t('brands.remove')}
        </button>
      ) : null}
    </div>
  )
}

function BrandRow({ brand, total, onDomains, onRemove }: Readonly<{
  brand: BrandDraft; total: number | undefined; onDomains: (domains: string[]) => void; onRemove: () => void
}>) {
  const { t } = useTranslation('radar')
  const labels = useDisplayLabels()
  const [editing, setEditing] = useState(false)
  return (
    <li className="py-3 space-y-1.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 min-w-0">
          <span className="text-sm font-medium text-text-strong">{brand.label}</span>
          <span className="badge badge-muted">{brand.origin === 'list' ? t('brands.originList') : t('brands.originProfile')}</span>
          {total === undefined ? null : <span className="text-xs text-muted font-mono">{t('setup.reviews', { count: total })}</span>}
        </div>
        <BrandRowActions brand={brand} editing={editing} onToggleEdit={() => setEditing(!editing)} onRemove={onRemove} />
      </div>
      {editing ? <DomainsEditor brand={brand} onChange={onDomains} /> : (
        <p className="text-xs text-muted">
          {t('setup.domains', { list: brand.domains.length === 0 ? t('setup.noDomains') : brand.domains.join(', ') })}
        </p>
      )}
      <BrandSources brand={brand} />
      {brand.origin === 'profile'
        ? <p className="text-xs text-muted">{t('brands.legacyNote', { sources: brand.sources.map(labels.source).join(', ') })}</p>
        : null}
    </li>
  )
}

function AddBrandForm({ draft, onAdd }: Readonly<{ draft: readonly BrandDraft[]; onAdd: (brand: BrandDraft) => void }>) {
  const { t } = useTranslation('radar')
  const nameId = useId()
  const domainsId = useId()
  const [name, setName] = useState('')
  const [domains, setDomains] = useState('')
  const [tried, setTried] = useState(false)
  const problem = name.trim() === '' ? null : addProblem(draft, name)
  const add = () => {
    setTried(true)
    if (name.trim() === '' || problem !== null) return
    onAdd(newBrand(name, domains))
    setName(''); setDomains(''); setTried(false)
  }
  return (
    <fieldset className="rounded-lg border border-border p-3 space-y-3">
      <legend className="px-1 text-sm font-semibold tracking-tight text-text-strong">{t('brands.addTitle')}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={nameId} className="block text-xs font-medium text-text mb-1">{t('brands.nameLabel')}</label>
          <input id={nameId} type="text" maxLength={64} className="input" value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }} />
        </div>
        <div>
          <label htmlFor={domainsId} className="block text-xs font-medium text-text mb-1">{t('brands.domainsLabel')}</label>
          <input id={domainsId} type="text" className="input font-mono" value={domains} placeholder="example.com"
            onChange={(e) => setDomains(e.target.value)} />
          <p className="text-xs text-muted mt-1">{t('brands.domainsHint', { max: MAX_RADAR_DOMAINS })}</p>
        </div>
      </div>
      {tried && problem !== null ? (
        <p role="alert" className="text-xs text-danger">
          {t(ADD_PROBLEMS[problem].messageKey, { brand: name.trim(), max: MAX_RADAR_BRANDS })}
        </p>
      ) : null}
      <button type="button" className="btn btn-secondary btn-sm" disabled={name.trim() === ''} onClick={add}>
        <Plus size={14} aria-hidden="true" />
        {t('brands.add')}
      </button>
    </fieldset>
  )
}

interface SaveState { readonly isPending: boolean; readonly isSuccess: boolean; readonly error: string | null }

function SaveBar({ dirty, save, onSave }: Readonly<{ dirty: boolean; save: SaveState; onSave: () => void }>) {
  const { t } = useTranslation('radar')
  return (
    <StickyActionBar variant="inline" className="flex flex-wrap items-center gap-3 py-2">
      <button type="button" className="btn btn-primary btn-sm" disabled={save.isPending || !dirty} onClick={onSave}>
        <Save size={14} aria-hidden="true" />
        {t('brands.save')}
      </button>
      {dirty ? <p className="text-xs text-muted">{t('brands.unsaved')}</p> : null}
      {save.isSuccess && !dirty ? <p role="status" className="text-xs text-ok">{t('brands.saved')}</p> : null}
      {save.error === null ? null : <p role="alert" className="text-xs text-danger">{t('brands.saveFailed')} {save.error}</p>}
    </StickyActionBar>
  )
}

function BrandsForm({ initial, totals, save, onSave }: Readonly<{
  initial: readonly BrandDraft[]; totals: BrandTotals; save: SaveState; onSave: (draft: readonly BrandDraft[]) => void
}>) {
  const { t } = useTranslation('radar')
  const [draft, setDraft] = useState<readonly BrandDraft[]>(initial)
  const [removing, setRemoving] = useState<BrandDraft | null>(null)
  const setDomains = (key: string, domains: string[]) =>
    setDraft(draft.map((brand) => (brand.key === key ? { ...brand, domains } : brand)))
  return (
    <div className="space-y-3">
      {draft.length === 0
        ? <p className="text-sm text-muted">{t('setup.brandsEmpty')}</p>
        : (
          <ul className="divide-y divide-border">
            {draft.map((brand) => (
              <BrandRow key={brand.key} brand={brand} total={totals.get(brand.key)}
                onDomains={(domains) => setDomains(brand.key, domains)} onRemove={() => setRemoving(brand)} />
            ))}
          </ul>
        )}
      <AddBrandForm draft={draft} onAdd={(brand) => setDraft([...draft, brand])} />
      <SaveBar dirty={needsSave(draft, initial)} save={save} onSave={() => onSave(draft)} />
      {removing === null ? null : (
        <ConfirmModal isOpen variant="danger" title={t('brands.removeTitle', { brand: removing.label })} message={t('brands.removeMessage')}
          confirmLabel={t('brands.remove')}
          onConfirm={() => { setDraft(draft.filter((brand) => brand.key !== removing.key)); setRemoving(null) }}
          onCancel={() => setRemoving(null)} />
      )}
    </div>
  )
}

/** The save goes through here so its outcome outlives the form, which restarts from the saved list. */
function useSaveBrands() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (draft: readonly BrandDraft[]) => radarApi.saveBrands(toInput(draft)),
    onSuccess: (brands: RadarBrandEntry[]) => {
      queryClient.setQueryData(radarKeys.brands(), brands)
      // Every Radar read (overview, detail, releases, compare, reviews) depends on the brand
      // list; the list itself (config, not in the radar scope) was just written from the PUT's answer.
      void invalidateFeedbackData(queryClient, { scope: 'radar' })
    },
  })
}

function saveState(mutation: ReturnType<typeof useSaveBrands>): SaveState {
  const error = mutation.error === null ? null : mutation.error.message.replace(/^API Error: \d+$/u, '')
  return { isPending: mutation.isPending, isSuccess: mutation.isSuccess, error }
}

export default function RadarBrandsEditor({ totals }: Readonly<{ totals: BrandTotals }>) {
  const { t } = useTranslation('radar')
  const brands = useQuery({ queryKey: radarKeys.brands(), queryFn: () => radarApi.getBrands() })
  const save = useSaveBrands()
  const body = () => {
    if (brands.isError) {
      return <LoadFailed message={t('brands.loadFailed')} onRetry={() => { void brands.refetch() }} retrying={brands.isFetching} />
    }
    if (!brands.data) return <p className="text-sm text-muted">{t('loading')}</p>
    return <BrandsForm key={JSON.stringify(brands.data)} initial={toDraft(brands.data)} totals={totals} save={saveState(save)}
      onSave={(draft) => save.mutate(draft)} />
  }
  return (
    <section aria-labelledby="radar-brands-tracked" className="space-y-2">
      <h3 id="radar-brands-tracked" className="text-sm font-semibold tracking-tight text-text-strong">{t('setup.brandsTitle')}</h3>
      <p className="text-xs text-muted max-w-prose">{t('brands.hint')}</p>
      {body()}
    </section>
  )
}
