/**
 * @fileoverview A "Copied" flag that turns itself off: `true` after `markCopied()`, back to
 * `false` after COPIED_MS. Shared by the copy controls so each says "Copied" the same way.
 * @module hooks/useCopiedFlag
 */
import { useEffect, useState } from 'react'

/** How long "Copied" stays after a copy. */
const COPIED_MS = 2000

export function useCopiedFlag(): readonly [boolean, () => void] {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])
  return [copied, () => setCopied(true)]
}
