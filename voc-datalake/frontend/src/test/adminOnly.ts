/**
 * Why a control is off for a non-admin, as the English catalogue says it (`common:adminOnly`, which
 * hooks/useAdminOnlyReason gives the control's Tooltip and description). Specs whose subject is an admin
 * gate import it rather than restating the wording.
 */
import enCommon from '../../public/locales/en/common.json'

export const ADMIN_ONLY: string = enCommon.adminOnly
