/**
 * @fileoverview The lucide icon of each workflow node type (palette, canvas, side panel, run log), from
 * nodeTypeIcons.ts.
 *
 * @module components/WorkflowEditor/NodeTypeIcon
 */
import { TYPE_ICONS } from './nodeTypeIcons'
import type { WorkflowNodeType } from '../../api/workflowsApi'

export function NodeTypeIcon({ type, size = 14, className }: Readonly<{ type: WorkflowNodeType; size?: number; className?: string }>) {
  const Icon = TYPE_ICONS[type]
  return <Icon size={size} className={className} aria-hidden="true" />
}
