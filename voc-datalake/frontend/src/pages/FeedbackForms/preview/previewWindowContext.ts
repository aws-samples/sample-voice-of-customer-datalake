/**
 * @fileoverview The builder's preview window, for whatever opens or follows it (the preview pane, the header's ⋯,
 * the narrow editor's Preview): `PreviewWindowProvider` (in FormBuilderPage) holds the one channel to the window and
 * keeps it showing the draft wherever the person is in the builder.
 *
 * @module pages/FeedbackForms/preview/previewWindowContext
 */
import { createContext, useContext } from 'react'
import type { FormLanguage } from '../model/formsV2'
import type { WindowPreset } from './previewChannel'
import type { PreviewScheme } from './widgetScript'

/** What the builder's preview shows, mirrored into the window: its language, the card it follows, a forced palette. */
export interface PreviewView {
  readonly language: FormLanguage
  readonly target: string | null
  readonly scheme: PreviewScheme | null
}

export type WindowCommand = { readonly kind: 'goTo'; readonly target: string } | { readonly kind: 'restart' }

export interface PreviewWindowApi {
  /** The preview session's shuffle seed: the pane and the window show the same order. */
  readonly seed: number
  /**
   * Open the window at `preset` (or bring it forward, resized), in a new tab with `tab`. Call it in the click
   * handler itself (pop-up rules). False when the browser blocked it.
   */
  readonly open: (preset: WindowPreset, options?: { readonly tab?: boolean }) => boolean
  readonly setView: (view: PreviewView) => void
  /** Restart or Start here, pressed in the pane: the window does the same. */
  readonly send: (command: WindowCommand) => void
  /** Since when the window has been open (its first word this time), or null while it is not: the builder's in-pane
   * preview collapses meanwhile and gives the editor the width. */
  readonly openSince: number | null
}

export const PreviewWindowContext = createContext<PreviewWindowApi | null>(null)

/** The builder's preview window; null outside the builder (the picker keeps its own). */
export function usePreviewWindow(): PreviewWindowApi | null {
  return useContext(PreviewWindowContext)
}
