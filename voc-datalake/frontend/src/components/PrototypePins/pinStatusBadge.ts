/**
 * @fileoverview A pin status's badge recipe: the pins panel's cards and the feedback
 * view's items wear the same (a module of its own, so a component file exports only components).
 * @module components/PrototypePins/pinStatusBadge
 */
import type { PrototypePin } from '../../api/prototypePinsApi'

export const STATUS_BADGE: Record<PrototypePin['status'], string> = {
  open: 'badge badge-warn',
  addressed: 'badge badge-info',
  resolved: 'badge badge-ok',
}
