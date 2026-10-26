import { useEffect, useState } from 'react'
import { useAssistantUiStore } from './assistantStore'

/**
 * Hand the store's `pendingDraft` (from `openAssistant`) to the panel's composer draft
 * once, then clear it from the store, so reopening the panel later never brings the
 * same prompt back. Adoption is render-time derived state, like the Composer's own.
 */
export function usePendingDraft(adopt: (text: string) => void): void {
  const pendingDraft = useAssistantUiStore((s) => s.pendingDraft)
  const setPendingDraft = useAssistantUiStore((s) => s.setPendingDraft)
  const [adoptedId, setAdoptedId] = useState<number | null>(null)
  if (pendingDraft !== null && pendingDraft.id !== adoptedId) {
    setAdoptedId(pendingDraft.id)
    adopt(pendingDraft.text)
  }
  useEffect(() => {
    if (pendingDraft !== null) setPendingDraft(null)
  }, [pendingDraft, setPendingDraft])
}
