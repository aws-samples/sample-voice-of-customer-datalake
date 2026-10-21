/**
 * PersonaRegenerationNote - The persona wizard's "what happens to the personas
 * you already have" line. Generating replaces every unprotected persona, so the
 * wizard says how many go and how many stay before anyone clicks Generate.
 */
import { Lock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { ProjectPersona } from '../../api/types'

function regenerationMessage(t: TFunction, kept: number, replaced: number): string {
  if (kept === 0) return t('wizards.personasReplacedAll', { count: replaced })
  const keptSentence = t('wizards.personasKept', { count: kept })
  if (replaced === 0) return keptSentence
  return `${keptSentence} ${t('wizards.personasReplaced', { count: replaced })}`
}

export default function PersonaRegenerationNote({ personas }: { readonly personas: ProjectPersona[] }) {
  const { t } = useTranslation('projectDetail')
  if (personas.length === 0) return null

  const kept = personas.filter((p) => p.protected === true).length
  return (
    <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-900">
      <Lock size={16} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
      <p>{regenerationMessage(t, kept, personas.length - kept)}</p>
    </div>
  )
}
