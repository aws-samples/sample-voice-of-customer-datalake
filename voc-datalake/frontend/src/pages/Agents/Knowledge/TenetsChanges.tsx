/**
 * @fileoverview What a tenets version changes, keyed by tenet id (§6.3 structured diff): each tenet added, changed
 * (and which of its fields) or removed, said in words beside its tone (never by colour alone), its title and id.
 *
 * @module pages/Agents/Knowledge/TenetsChanges
 */
import { useTranslation } from 'react-i18next'
import type { TenetChange } from '../documents/tenetsDocument'

const TONES = { added: 'badge badge-ok', changed: 'badge badge-info', removed: 'badge badge-danger' } as const

export function TenetsChanges({ changes, first }: Readonly<{ changes: readonly TenetChange[]; first: boolean }>) {
  const { t } = useTranslation('agents')
  if (changes.length === 0) return <p className="text-sm text-muted">{t('tenets.changes.none')}</p>
  return (
    <section aria-label={t('tenets.changes.label')} className="space-y-1">
      <h4 className="text-[12px] font-semibold text-muted">{first ? t('tenets.changes.first') : t('tenets.changes.label')}</h4>
      <ul className="space-y-1">
        {changes.map((change) => (
          <li key={`${change.kind}-${change.tenet.id}`} className="flex flex-wrap items-center gap-2 text-sm">
            <span className={TONES[change.kind]}>{t(`tenets.changes.${change.kind}`)}</span>
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">{change.tenet.title}</span>
            <span className="font-mono text-[12px] text-muted">{change.tenet.id}</span>
            {change.kind === 'changed' && (
              <span className="text-[12px] text-muted">
                {t('tenets.changes.fields', { list: change.fields.map((field) => t(`tenets.fields.${field}`)).join(', ') })}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
