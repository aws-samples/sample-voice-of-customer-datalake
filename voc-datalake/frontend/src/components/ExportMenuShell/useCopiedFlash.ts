/**
 * @fileoverview The two-second "Copied!" flash shown by export-menu copy items.
 */
import { useCallback, useState } from 'react'

const COPIED_FLASH_MS = 2000

/** `[copied, flashCopied]`: `flashCopied()` sets `copied` for two seconds. */
export function useCopiedFlash(): readonly [boolean, () => void] {
  const [copied, setCopied] = useState(false)
  const flashCopied = useCallback(() => {
    setCopied(true)
    setTimeout(() => setCopied(false), COPIED_FLASH_MS)
  }, [])
  return [copied, flashCopied]
}
