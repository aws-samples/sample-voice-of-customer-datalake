/**
 * @fileoverview The persona header's lock (ported from #429 by @aws-bryan): a protected persona
 * is kept when the project's personas are replaced by a new generation. Editors toggle it;
 * everyone sees the "Protected" badge.
 *
 * @module pages/ProjectDetail/PersonaProtectToggle
 */
import { Loader2, Lock, LockOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PersonaProtection } from './usePersonaProtection'

interface PersonaProtectToggleProps {
  readonly personaId: string
  readonly isProtected: boolean
  readonly protection: PersonaProtection
}

export function PersonaProtectToggle({ personaId, isProtected, protection }: PersonaProtectToggleProps) {
  const { t } = useTranslation('projectDetail')
  const pending = protection.isPendingFor(personaId)
  const label = isProtected ? t('personas.unprotect') : t('personas.protect')
  const Icon = isProtected ? Lock : LockOpen
  return (
    <button
      type="button"
      onClick={() => protection.setProtected(personaId, !isProtected)}
      disabled={pending}
      aria-pressed={isProtected}
      className="icon-btn p-2"
      title={label}
      aria-label={label}
    >
      {pending ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Icon size={16} aria-hidden />}
    </button>
  )
}

/** The badge under the persona's name, and the failed save, announced. */
export function PersonaProtectStatus({ personaId, isProtected, protection }: PersonaProtectToggleProps) {
  const { t } = useTranslation('projectDetail')
  return (
    <>
      {isProtected ? (
        <span className="badge badge-muted mt-1.5 inline-flex items-center gap-1" title={t('personas.protectedHint')}>
          <Lock size={12} aria-hidden />{t('personas.protected')}
        </span>
      ) : null}
      {protection.failedFor(personaId) ? (
        <p role="alert" className="mt-1.5 text-[12px] text-danger">{t('personas.protectFailed')}</p>
      ) : null}
    </>
  )
}
