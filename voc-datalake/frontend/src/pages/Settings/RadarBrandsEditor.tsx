/**
 * @fileoverview Administration → Sources → Radar, "Brands tracked": the one place to set up the
 * brands Radar follows (docs/radar.md). Add a brand with its name and website domains (and,
 * optionally, its search language and news feeds), edit them, remove it (a confirm says its reviews are kept), then Save brands = one
 * PUT /radar/brands with the whole list. A legacy brand named only by a source profile is listed
 * with that origin and written into the list with the next real save (loading it is no change). The 90-day review counts come
 * from GET /radar.
 * @module pages/Settings/RadarBrandsEditor
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Save, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { radarApi, radarKeys } from '../../api/radarApi'
import { invalidateFeedbackData } from '../../api/invalidateFeedbackData'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { serverReason } from '../../lib/errors'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import StickyActionBar from '../../components/StickyActionBar/StickyActionBar'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import RadarAddBrandForm from './RadarAddBrandForm'
import { DomainsField, FeedsField, LanguageSelect, TermsField } from './RadarBrandFields'
import { useLanguageSummary } from './useLanguageSummary'
import { feedsProblem, needsSave, termsProblem, toDraft, toInput } from './radarBrandDraft'
import type { RadarBrandEntry } from '../../api/radarSchema'
import type { BrandDraft } from './radarBrandDraft'

/** The 90-day review count of each brand key, from GET /radar. */
type BrandTotals = ReadonlyMap<string, number>

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
      <button type="button" className="btn btn-ghost btn-sm" aria-expanded={editing} onClick={onToggleEdit}
        aria-label={editing ? undefined : t('brands.editLabel', { brand: brand.label })}>
        <Pencil size={14} aria-hidden="true" />
        {editing ? t('brands.doneEditing') : t('brands.edit')}
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

/** A brand's fields, open for editing. */
function BrandEditor({ brand, onChange }: Readonly<{ brand: BrandDraft; onChange: (patch: Partial<BrandDraft>) => void }>) {
  const { t } = useTranslation('radar')
  return (
    <div className="space-y-3 pt-1">
      <DomainsField label={t('brands.editDomainsLabel', { brand: brand.label })} domains={brand.domains}
        onChange={(domains) => onChange({ domains })} />
      <div className="grid gap-3 sm:grid-cols-2">
        <LanguageSelect language={brand.language} effective={brand.effective_language} onChange={(language) => onChange({ language })} />
        <FeedsField feeds={brand.feed_urls} onChange={(feeds) => onChange({ feed_urls: feeds })} />
        <TermsField field="search_terms" terms={brand.search_terms} onChange={(terms) => onChange({ search_terms: terms })} />
        <TermsField field="exclude_terms" terms={brand.exclude_terms} onChange={(terms) => onChange({ exclude_terms: terms })} />
      </div>
    </div>
  )
}

/** A brand's fields at rest: domains, search language, news feeds, and its terms when it has some. */
function BrandSummary({ brand }: Readonly<{ brand: BrandDraft }>) {
  const { t } = useTranslation('radar')
  const languageSummary = useLanguageSummary()
  const none = (list: readonly string[], empty: string) => (list.length === 0 ? empty : list.join(', '))
  return (
    <div className="text-xs text-muted space-y-0.5 [overflow-wrap:anywhere]">
      <p>{t('setup.domains', { list: none(brand.domains, t('setup.noDomains')) })}</p>
      <p>{t('brands.languageSummary', { language: languageSummary(brand.language, brand.effective_language) })}</p>
      <p>{t('brands.feedsSummary', { list: none(brand.feed_urls, t('brands.noFeeds')) })}</p>
      {brand.search_terms.length === 0 ? null : <p>{t('brands.searchTermsSummary', { list: brand.search_terms.join(', ') })}</p>}
      {brand.exclude_terms.length === 0 ? null : <p>{t('brands.excludeTermsSummary', { list: brand.exclude_terms.join(', ') })}</p>}
    </div>
  )
}

function BrandRow({ brand, total, onChange, onRemove }: Readonly<{
  brand: BrandDraft; total: number | undefined; onChange: (patch: Partial<BrandDraft>) => void; onRemove: () => void
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
      {editing ? <BrandEditor brand={brand} onChange={onChange} /> : <BrandSummary brand={brand} />}
      <BrandSources brand={brand} />
      {brand.origin === 'profile'
        ? <p className="text-xs text-muted">{t('brands.legacyNote', { sources: brand.sources.map(labels.source).join(', ') })}</p>
        : null}
    </li>
  )
}

interface SaveState { readonly isPending: boolean; readonly isSuccess: boolean; readonly error: string | null }

/** Which list holds the save back (its own box says what is wrong), or null. */
type Blocked = 'feeds' | 'terms' | null

// Held as `…Key:` data so scripts/i18n-check.mjs sees each message.
const BLOCKED_MESSAGES: Record<'feeds' | 'terms', { messageKey: string }> = {
  feeds: { messageKey: 'radar:brands.fixFeeds' },
  terms: { messageKey: 'radar:brands.fixTerms' },
}

function blockedBy(draft: readonly BrandDraft[]): Blocked {
  if (draft.some((brand) => feedsProblem(brand.feed_urls) !== null)) return 'feeds'
  const badTerms = (brand: BrandDraft) => termsProblem(brand.search_terms) !== null || termsProblem(brand.exclude_terms) !== null
  return draft.some(badTerms) ? 'terms' : null
}

function SaveBar({ dirty, blocked, save, onSave }: Readonly<{ dirty: boolean; blocked: Blocked; save: SaveState; onSave: () => void }>) {
  const { t } = useTranslation('radar')
  return (
    <StickyActionBar variant="inline" className="flex flex-wrap items-center gap-3 py-2">
      <button type="button" className="btn btn-primary btn-sm" disabled={save.isPending || !dirty || blocked !== null} onClick={onSave}>
        <Save size={14} aria-hidden="true" />
        {t('brands.save')}
      </button>
      {dirty ? <p className="text-xs text-muted">{t('brands.unsaved')}</p> : null}
      {blocked === null ? null : <p className="text-xs text-danger">{t(BLOCKED_MESSAGES[blocked].messageKey)}</p>}
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
  const change = (key: string, patch: Partial<BrandDraft>) =>
    setDraft(draft.map((brand) => (brand.key === key ? { ...brand, ...patch } : brand)))
  return (
    <div className="space-y-3">
      {draft.length === 0
        ? <p className="text-sm text-muted">{t('setup.brandsEmpty')}</p>
        : (
          <ul className="divide-y divide-border">
            {draft.map((brand) => (
              <BrandRow key={brand.key} brand={brand} total={totals.get(brand.key)}
                onChange={(patch) => change(brand.key, patch)} onRemove={() => setRemoving(brand)} />
            ))}
          </ul>
        )}
      <RadarAddBrandForm draft={draft} onAdd={(brand) => setDraft([...draft, brand])} />
      <SaveBar dirty={needsSave(draft, initial)} blocked={blockedBy(draft)} save={save}
        onSave={() => onSave(draft)} />
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
  // Our own line, then the server's reason when it gave one (a bare status adds nothing).
  const error = mutation.error === null ? null : (serverReason(mutation.error) ?? '')
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
