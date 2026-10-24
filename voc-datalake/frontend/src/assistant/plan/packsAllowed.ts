/**
 * The packs a caller may use in a plan (integrator deviation 4 of
 * docs/assistant-plan-mode.md): every pack, minus ADMIN_ONLY_PACKS for a
 * non-admin. Per-tool admin checks still apply on top.
 */
import { ADMIN_ONLY_PACKS, TOOL_PACKS } from '../contract'
import type { ToolPack } from '../contract'

export function packsAllowedFor(isAdmin: boolean): ToolPack[] {
  return TOOL_PACKS.filter((pack) => isAdmin || !ADMIN_ONLY_PACKS.includes(pack))
}
