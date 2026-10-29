/**
 * @fileoverview The words for a list's kind (literal keys, so i18n-check sees each one).
 * @module pages/Participants/kindLabel
 */
import type { ListKind } from '../../api/participantsSchema'

type Translate = (key: string) => string

export function kindLabel(kind: ListKind, t: Translate): string {
  switch (kind) {
    case 'employees': return t('participants:kind.employees')
    case 'paid': return t('participants:kind.paid')
    case 'beta': return t('participants:kind.beta')
    case 'sales': return t('participants:kind.sales')
    case 'customers': return t('participants:kind.customers')
    case 'requesters': return t('participants:kind.requesters')
    case 'custom': return t('participants:kind.custom')
  }
}
