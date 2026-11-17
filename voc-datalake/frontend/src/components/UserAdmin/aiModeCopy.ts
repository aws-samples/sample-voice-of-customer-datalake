/**
 * @fileoverview The copy keys of each way of working with AI (`components:userAdmin.aiMode.*`): its label, its
 * tooltip and its row of "How the modes differ", spelled out so the i18n audit sees every key.
 * @module components/UserAdmin/aiModeCopy
 */
import type { AiModeName } from '../../api/aiModeApi'

interface ModeKeys {
  readonly labelKey: string
  readonly tooltipKey: string
  /** Its row of "How the modes differ": the person's PR/FAQs and PRDs, and the automations they enable. */
  readonly documentsKey: string
  readonly automationsKey: string
}

export const MODE_KEYS: Readonly<Record<AiModeName, ModeKeys>> = {
  human_driven: {
    labelKey: 'components:userAdmin.aiMode.humanDriven', tooltipKey: 'components:userAdmin.aiMode.humanDrivenTooltip',
    documentsKey: 'components:userAdmin.aiMode.compare.humanDriven.documents', automationsKey: 'components:userAdmin.aiMode.compare.humanDriven.automations',
  },
  ai_assisted: {
    labelKey: 'components:userAdmin.aiMode.aiAssisted', tooltipKey: 'components:userAdmin.aiMode.aiAssistedTooltip',
    documentsKey: 'components:userAdmin.aiMode.compare.aiAssisted.documents', automationsKey: 'components:userAdmin.aiMode.compare.aiAssisted.automations',
  },
  ai_driven: {
    labelKey: 'components:userAdmin.aiMode.aiDriven', tooltipKey: 'components:userAdmin.aiMode.aiDrivenTooltip',
    documentsKey: 'components:userAdmin.aiMode.compare.aiDriven.documents', automationsKey: 'components:userAdmin.aiMode.compare.aiDriven.automations',
  },
}
