/**
 * @fileoverview "Promote to company" on a project persona (admins, 5.60): copies the
 * persona into the company library (Knowledge → Company → Personas). The copy is
 * independent and starts without research notes; the project keeps its own.
 *
 * @module pages/ProjectDetail/PromotePersonaButton
 */
import { Building2, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { COMPANY_PERSONAS_PATH, usePromotePersona } from './usePromotePersona'
import { serverReason } from '../../lib/errors'

type PromoteMutation = ReturnType<typeof usePromotePersona>

/** The header icon button; render it only for an admin who can edit the project. */
export function PromotePersonaButton({ promote }: Readonly<{ promote: PromoteMutation }>) {
  const { t } = useTranslation('projectDetail')
  return (
    <button
      type="button"
      onClick={() => promote.mutate()}
      disabled={promote.isPending}
      className="icon-btn p-2"
      title={t('personas.promote.button')}
      aria-label={t('personas.promote.button')}
    >
      {promote.isPending ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Building2 size={16} aria-hidden />}
    </button>
  )
}

/** What the last promote did: a link to the library, or why it failed. */
export function PromoteStatus({ promote }: Readonly<{ promote: PromoteMutation }>) {
  const { t } = useTranslation('projectDetail')
  if (promote.isSuccess) {
    return (
      <p role="status" className="mt-3 text-[12px] text-ok">
        {t('personas.promote.done')}{' '}
        <Link to={COMPANY_PERSONAS_PATH} className="link">{t('personas.promote.openLibrary')}</Link>
      </p>
    )
  }
  if (promote.isError) {
    return <p role="alert" className="mt-3 text-[12px] text-danger">{serverReason(promote.error) ?? t('personas.promote.failed')}</p>
  }
  return null
}
