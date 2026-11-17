/**
 * A lazy part of the canvas that must never take the page down with it: when its chunk cannot load (no network, or a
 * tab older than a deploy that the stale-build reload did not refresh: lib/staleBuildReload.ts), the part is left out
 * and the text, its editing and Save carry on, instead of the page's error screen replacing a document mid-edit.
 */
import type { ComponentType } from 'react'

export function orNothing<P extends object>(load: () => Promise<{ default: ComponentType<P> }>): Promise<{ default: ComponentType<P> }> {
  return load().catch(() => ({ default: () => null }))
}
