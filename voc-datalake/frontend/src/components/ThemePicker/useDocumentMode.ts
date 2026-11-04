/**
 * @fileoverview The mode (`light` | `dark`) painted on `<html data-mode>` right now
 * (theme/useThemeSync.ts writes it), live: a preview follows a mode change at once.
 * @module components/ThemePicker/useDocumentMode
 */
import { useSyncExternalStore } from 'react'
import type { ThemeMode } from '../../theme/themeCatalog'

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] })
  return () => observer.disconnect()
}

function readMode(): ThemeMode {
  return document.documentElement.dataset.mode === 'light' ? 'light' : 'dark'
}

export function useDocumentMode(): ThemeMode {
  return useSyncExternalStore(subscribe, readMode, () => 'dark')
}
