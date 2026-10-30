/**
 * @fileoverview "Copied from the company library on 18 Oct 2026" / "Copied from
 * {project} on …" under a copied persona's name (5.60). A copy is independent: this
 * line only says where it started.
 *
 * @module pages/ProjectDetail/CopiedFromLine
 */
import { Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { formatDate } from '../../utils/dateUtils'
import type { PersonaCopiedFrom } from '../../api/projectTypes'

/** The source's name as the line shows it; a project whose name the copy did not record reads generically. */
function copySourceLabel(copiedFrom: PersonaCopiedFrom, t: TFunction<'projectDetail'>): string {
  if (copiedFrom.scope === 'company') return t('personas.copiedFrom.company')
  const name = copiedFrom.project_name?.trim() ?? ''
  return name === '' ? t('personas.copiedFrom.unnamedProject') : name
}

export default function CopiedFromLine({ copiedFrom }: Readonly<{ copiedFrom: PersonaCopiedFrom | undefined }>) {
  const { t, i18n } = useTranslation('projectDetail')
  if (copiedFrom === undefined) return null
  const source = copySourceLabel(copiedFrom, t)
  const date = formatDate(copiedFrom.copied_at, i18n.language)
  return (
    <p className="mt-1.5 text-[12px] text-muted inline-flex items-start gap-1 break-words" data-testid="persona-copied-from">
      <Copy size={12} className="mt-0.5 flex-shrink-0" aria-hidden />
      <span>{date === '' ? t('personas.copiedFrom.lineNoDate', { source }) : t('personas.copiedFrom.line', { source, date })}</span>
    </p>
  )
}
