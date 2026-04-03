/**
 * @fileoverview Shared hook for copy-to-clipboard with auto-reset feedback state.
 * @module hooks/useCopyToClipboard
 */

import {
  useState, useCallback, useRef, useEffect,
} from 'react'

/**
 * Copy text to clipboard with auto-resetting "copied" state.
 * Supports keyed mode (track which item was copied) and simple boolean mode.
 *
 * @example
 * // Simple (single copy target)
 * const { copy, copiedKey } = useCopyToClipboard()
 * <button onClick={() => copy(text)}>
 *   {copiedKey ? 'Copied!' : 'Copy'}
 * </button>
 *
 * @example
 * // Keyed (multiple copy targets)
 * const { copy, copiedKey } = useCopyToClipboard()
 * <button onClick={() => copy(text, 'url')}>
 *   {copiedKey === 'url' ? 'Copied!' : 'Copy URL'}
 * </button>
 */
export function useCopyToClipboard(timeout = 2000) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => () => clearTimeout(timerRef.current), [])

  const copy = useCallback((text: string, key = '_') => {
    void navigator.clipboard.writeText(text)
    setCopiedKey(key)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setCopiedKey(null), timeout)
  }, [timeout])

  return {
    copy,
    copiedKey,
  } as const
}
