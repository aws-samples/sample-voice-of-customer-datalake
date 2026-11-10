/**
 * @fileoverview The Sources half of a user's access: next to the category
 * rule, an item is visible only when its source is admitted too.
 *
 * - default (nothing stored): every source whose profile is not restricted;
 * - all: every source, restricted ones included (`['*']`);
 * - selected: exactly the ticked profiles.
 *
 * Choosing "default" again saves `sources: null`, which clears a stored list.
 *
 * @module components/UserAdmin/SourceAccessFields
 */
import { useTranslation } from 'react-i18next'
import { Loader2, Lock } from 'lucide-react'
import { useSourceProfiles } from '../../hooks/useDimensions'
import type { SourceGrant, SourceGrantMode } from '../../api/categoryAccessApi'

interface SourceAccessFieldsProps {
  value: SourceGrant
  onChange: (grant: SourceGrant) => void
  disabled: boolean
}

const MODES: ReadonlyArray<{ mode: SourceGrantMode; labelKey: string }> = [
  { mode: 'default', labelKey: 'components:userAdmin.sourceAccess.default' },
  { mode: 'all', labelKey: 'components:userAdmin.sourceAccess.all' },
  { mode: 'list', labelKey: 'components:userAdmin.sourceAccess.selected' },
]

function SourceChecklist({ selected, onToggle, disabled }: Readonly<{
  selected: readonly string[]; onToggle: (id: string) => void; disabled: boolean
}>) {
  const { t } = useTranslation('components', { keyPrefix: 'userAdmin.sourceAccess' })
  const { data: profiles = [], isLoading } = useSourceProfiles()
  if (isLoading) return <Loader2 size={16} className="animate-spin text-muted" aria-hidden="true" />
  if (profiles.length === 0) return <p className="text-sm text-muted">{t('noProfiles')}</p>
  return (
    <ul className="max-h-48 overflow-y-auto space-y-1 rounded-md border border-border p-2">
      {profiles.map((p) => (
        <li key={p.id}>
          <label className="flex items-center gap-2 rounded-sm px-2 py-1 hover:bg-bg-hover cursor-pointer">
            <input type="checkbox" checked={selected.includes(p.id)} onChange={() => onToggle(p.id)} disabled={disabled} className="rounded-sm accent-accent" />
            <span className="text-sm text-text-strong">{p.label}</span>
            <span className="text-xs text-muted font-mono">{p.id}</span>
            {p.restricted && <span className="badge badge-warn text-xs"><Lock size={12} aria-hidden="true" />{t('restricted')}</span>}
          </label>
        </li>
      ))}
    </ul>
  )
}

export default function SourceAccessFields({ value, onChange, disabled }: Readonly<SourceAccessFieldsProps>) {
  const { t } = useTranslation('components', { keyPrefix: 'userAdmin.sourceAccess' })
  const { t: tAll } = useTranslation()
  const toggle = (id: string) => onChange({
    mode: 'list',
    sources: value.sources.includes(id) ? value.sources.filter((s) => s !== id) : [...value.sources, id],
  })
  return (
    <fieldset className="space-y-2 pt-2 border-t border-border">
      <legend className="text-sm font-medium text-text-strong">{t('title')}</legend>
      {MODES.map((m) => (
        <label key={m.mode} className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="source-access"
            checked={value.mode === m.mode}
            onChange={() => onChange({ mode: m.mode, sources: m.mode === 'list' ? value.sources : [] })}
            disabled={disabled}
            className="accent-accent"
          />
          <span className="text-text-strong">{tAll(m.labelKey)}</span>
        </label>
      ))}
      {value.mode === 'list' && <SourceChecklist selected={value.sources} onToggle={toggle} disabled={disabled} />}
    </fieldset>
  )
}
