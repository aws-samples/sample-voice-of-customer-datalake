/**
 * @fileoverview Copy for the PII policies, shared by the profile editor and the
 * feedback badges. A Record, so every policy the contract has gets a label.
 *
 * @module components/SourcesManager/piiPolicy
 */
import { PII_POLICIES } from '../../api/sourceProfilesApi'
import type { PiiPolicy } from '../../api/types'

export const PII_COPY: Record<PiiPolicy, { labelKey: string; hintKey: string }> = {
  allow: { labelKey: 'components:sourcesManager.pii.allow', hintKey: 'components:sourcesManager.pii.allowHint' },
  redact: { labelKey: 'components:sourcesManager.pii.redact', hintKey: 'components:sourcesManager.pii.redactHint' },
  summary_only: { labelKey: 'components:sourcesManager.pii.summary_only', hintKey: 'components:sourcesManager.pii.summaryOnlyHint' },
}

export function isPiiPolicy(value: string): value is PiiPolicy {
  return PII_POLICIES.some((p) => p === value)
}

/** What the retention field starts at when "keep forever" is unticked. */
export const DEFAULT_RETENTION_DAYS = 365
