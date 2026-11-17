/**
 * @fileoverview Why a control is off for a non-admin ("Admin access required"), translated
 * (`common:adminOnly`): the Tooltip, and the description, of a control that stays focusable with
 * `aria-disabled` because the route behind it is admin-gated server-side (constants/admin.ts).
 *
 * @module hooks/useAdminOnlyReason
 */
import { useTranslation } from 'react-i18next'

/** The reason, or undefined for an admin (nothing to explain). */
export function useAdminOnlyReason(isAdmin: boolean): string | undefined {
  const { t } = useTranslation('common')
  return isAdmin ? undefined : t('adminOnly')
}
