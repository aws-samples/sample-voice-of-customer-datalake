/**
 * @fileoverview An owner's gate brief in the gate inspector, read only: the Registry's own brief panel (7.52.00 C3,
 * pages/Agents/Registry/GateBrief.tsx `BriefSurface` on gateBriefAdapter.ts: the panel variant, Rendered and Source,
 * Open full page), its text read when opened (`GET …/gates/briefs/<id>`, 45–156 KB each). Loaded lazily by
 * GatePacks.tsx, so the editor does not bring the document engine until a brief is opened.
 *
 * @module components/WorkflowEditor/inspector/GateBriefDocument
 */
import { BriefSurface } from '../../../pages/Agents/Registry/GateBrief'
import type { GateBrief } from '../../../api/flowSetupApi'

export default function GateBriefDocument({ brief }: Readonly<{ brief: GateBrief }>) {
  return <BriefSurface brief={brief} variant="panel" headingLevel={3} open />
}
