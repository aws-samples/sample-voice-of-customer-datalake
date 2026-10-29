/**
 * @fileoverview "Add a brand" under Brands tracked (docs/radar.md): a name and website domains,
 * and under "More options" its search language, news feeds, search terms and exclude terms. The brand joins the draft; nothing
 * is written until Save brands.
 * @module pages/Settings/RadarAddBrandForm
 */
import { Plus } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MAX_RADAR_BRANDS, MAX_RADAR_DOMAINS } from '../../api/radarSchema'
import { FeedsField, LanguageSelect, TermsField } from './RadarBrandFields'
import { addProblem, brandSavable, newBrand } from './radarBrandDraft'
import type { AddProblem, BrandDraft, BrandExtras } from './radarBrandDraft'

// Held as `…Key:` data so scripts/i18n-check.mjs sees each message.
const ADD_PROBLEMS: Record<AddProblem, { messageKey: string }> = {
  invalidName: { messageKey: 'radar:brands.invalidName' },
  duplicate: { messageKey: 'radar:brands.duplicate' },
  tooMany: { messageKey: 'radar:brands.tooMany' },
}

const NO_EXTRAS: BrandExtras = { language: null, feed_urls: [], search_terms: [], exclude_terms: [] }

/** Language, feeds and terms, folded away: most brands need none of them. */
function MoreOptions({ extras, onChange }: Readonly<{ extras: BrandExtras; onChange: (extras: BrandExtras) => void }>) {
  const { t } = useTranslation('radar')
  return (
    <details className="rounded-md border border-border px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium text-text">{t('brands.moreOptions')}</summary>
      <div className="grid gap-3 sm:grid-cols-2 mt-3">
        <LanguageSelect language={extras.language} effective={null} onChange={(language) => onChange({ ...extras, language })} />
        <FeedsField feeds={extras.feed_urls} onChange={(feeds) => onChange({ ...extras, feed_urls: feeds })} />
        <TermsField field="search_terms" terms={extras.search_terms} onChange={(terms) => onChange({ ...extras, search_terms: terms })} />
        <TermsField field="exclude_terms" terms={extras.exclude_terms} onChange={(terms) => onChange({ ...extras, exclude_terms: terms })} />
      </div>
    </details>
  )
}

export default function RadarAddBrandForm({ draft, onAdd }: Readonly<{ draft: readonly BrandDraft[]; onAdd: (brand: BrandDraft) => void }>) {
  const { t } = useTranslation('radar')
  const nameId = useId()
  const domainsId = useId()
  const [name, setName] = useState('')
  const [domains, setDomains] = useState('')
  const [extras, setExtras] = useState<BrandExtras>(NO_EXTRAS)
  // Bumped after an add so the folded fields start empty again (they hold their own typed text).
  const [round, setRound] = useState(0)
  const [tried, setTried] = useState(false)
  const problem = name.trim() === '' ? null : addProblem(draft, name)
  // The feed and term boxes say what is wrong themselves; here they only hold the brand back.
  const blocked = name.trim() === '' || !brandSavable(extras)
  const add = () => {
    setTried(true)
    if (blocked || problem !== null) return
    onAdd(newBrand(name, domains, extras))
    setName(''); setDomains(''); setExtras(NO_EXTRAS); setRound(round + 1); setTried(false)
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
      <MoreOptions key={round} extras={extras} onChange={setExtras} />
      {tried && problem !== null ? (
        <p role="alert" className="text-xs text-danger">
          {t(ADD_PROBLEMS[problem].messageKey, { brand: name.trim(), max: MAX_RADAR_BRANDS })}
        </p>
      ) : null}
      <button type="button" className="btn btn-secondary btn-sm" disabled={blocked} onClick={add}>
        <Plus size={14} aria-hidden="true" />
        {t('brands.add')}
      </button>
    </fieldset>
  )
}
