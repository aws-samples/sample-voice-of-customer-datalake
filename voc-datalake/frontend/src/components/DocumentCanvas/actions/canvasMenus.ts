/**
 * @fileoverview The entries of the menu bar's Edit, Format, Insert and View menus: the canvas's existing actions
 * only, each with the shortcut the editor already answers.
 * - Edit: Undo, Redo (the editor's history; disabled with nothing to undo / redo).
 * - Format: Text, Heading 1-3; Bold, Italic, Strikethrough, Inline code; the lists, Quote, Code (blocks.ts).
 * - Insert: Link (the Mod+K popover), Image (the "/" menu's dialog), Table, Divider, Callout.
 * - View: Comments (the comments panel; a PR/FAQ or PRD), Contents (the outline), Full width, Full screen (the
 *   focus view).
 * The editor's entries run through its handle (CanvasEditorHandle `run` / `can`), read when the menu opens. The Review
 * menu's entries are the toolbar's AI flows (toolbarItems.ts `reviewMenuEntries`).
 *
 * @module components/DocumentCanvas/actions/canvasMenus
 */
import {
  Bold, CodeXml, Code, Heading1, Heading2, Heading3, ImageIcon, Italic, Link, List, ListOrdered, ListTodo, Megaphone,
  Minus, Pilcrow, Quote, Redo2, Strikethrough, Table2, Undo2,
} from 'lucide-react'
import type { TFunction } from 'i18next'
import type { LucideIcon } from 'lucide-react'
import type { CanvasCommand } from '../../Document/edit/editor/commands'
import type { CanvasEditorHandle } from '../../Document/edit/editor/CanvasEditor'
import type { CanvasMenuEntry } from './CanvasMenu'
import type { Shortcut } from './menuShortcuts'

/** A view setting of the page, on or off, and its switch. */
export interface ViewToggle {
  readonly on: boolean
  readonly toggle: () => void
}

/** What View switches: the comments panel (absent: the document has none), the outline, the width, full screen. */
export interface CanvasViewControls {
  readonly comments?: ViewToggle
  readonly outline: ViewToggle
  readonly fullWidth: ViewToggle
}

interface CommandEntry {
  readonly command: CanvasCommand
  readonly label: string
  readonly icon: LucideIcon
  readonly shortcut?: Shortcut
}

type Handle = () => CanvasEditorHandle | null

function commandEntries(handle: Handle, entries: readonly (CommandEntry | 'separator')[], menu: string): CanvasMenuEntry[] {
  return entries.map((entry, index) => {
    if (entry === 'separator') return { kind: 'separator', id: `${menu}-separator-${String(index)}` }
    const { command, label, icon, shortcut } = entry
    return {
      kind: 'action', id: command, label, icon, shortcut,
      disabled: handle()?.can(command) !== true,
      onSelect: () => { handle()?.run(command) },
    }
  })
}

export function editEntries(handle: Handle, t: TFunction<'projectDetail'>): CanvasMenuEntry[] {
  return commandEntries(handle, [
    { command: 'undo', label: t('documents:menubar.undo'), icon: Undo2, shortcut: { key: 'z' } },
    { command: 'redo', label: t('documents:menubar.redo'), icon: Redo2, shortcut: { key: 'z', shift: true } },
  ], 'edit')
}

export function formatEntries(handle: Handle, t: TFunction<'projectDetail'>): CanvasMenuEntry[] {
  return commandEntries(handle, [
    { command: 'paragraph', label: t('documents:editor.blocks.paragraph'), icon: Pilcrow, shortcut: { key: '0', alt: true } },
    { command: 'heading1', label: t('documents:editor.blocks.heading1'), icon: Heading1, shortcut: { key: '1', alt: true } },
    { command: 'heading2', label: t('documents:editor.blocks.heading2'), icon: Heading2, shortcut: { key: '2', alt: true } },
    { command: 'heading3', label: t('documents:editor.blocks.heading3'), icon: Heading3, shortcut: { key: '3', alt: true } },
    'separator',
    { command: 'bold', label: t('documents:editor.format.bold'), icon: Bold, shortcut: { key: 'b' } },
    { command: 'italic', label: t('documents:editor.format.italic'), icon: Italic, shortcut: { key: 'i' } },
    { command: 'strike', label: t('documents:editor.format.strike'), icon: Strikethrough, shortcut: { key: 's', shift: true } },
    { command: 'code', label: t('documents:editor.format.code'), icon: Code, shortcut: { key: 'e' } },
    'separator',
    { command: 'bulletList', label: t('documents:editor.blocks.bulletList'), icon: List, shortcut: { key: '8', shift: true } },
    { command: 'orderedList', label: t('documents:editor.blocks.orderedList'), icon: ListOrdered, shortcut: { key: '7', shift: true } },
    { command: 'taskList', label: t('documents:editor.blocks.taskList'), icon: ListTodo, shortcut: { key: '9', shift: true } },
    { command: 'blockquote', label: t('documents:editor.blocks.blockquote'), icon: Quote, shortcut: { key: 'b', shift: true } },
    { command: 'codeBlock', label: t('documents:editor.blocks.codeBlock'), icon: CodeXml, shortcut: { key: 'c', alt: true } },
  ], 'format')
}

export function insertEntries(handle: Handle, t: TFunction<'projectDetail'>): CanvasMenuEntry[] {
  return commandEntries(handle, [
    { command: 'link', label: t('documents:menubar.link'), icon: Link, shortcut: { key: 'k' } },
    { command: 'image', label: t('documents:menubar.image'), icon: ImageIcon },
    'separator',
    { command: 'table', label: t('documents:editor.blocks.table'), icon: Table2 },
    { command: 'divider', label: t('documents:editor.blocks.divider'), icon: Minus },
    { command: 'callout', label: t('documents:editor.blocks.callout'), icon: Megaphone },
  ], 'insert')
}

/** View: the panels and the width, then Full screen (the page's focus view). */
export function viewEntries(view: CanvasViewControls, focus: ViewToggle, t: TFunction<'projectDetail'>): CanvasMenuEntry[] {
  const { comments } = view
  const commentsPanel: CanvasMenuEntry[] = comments === undefined ? [] : [
    { kind: 'toggle', id: 'comments', label: t('documents:menubar.comments'), checked: comments.on, onToggle: comments.toggle },
  ]
  return [
    ...commentsPanel,
    { kind: 'toggle', id: 'outline', label: t('documents:page.contents'), checked: view.outline.on, onToggle: view.outline.toggle },
    { kind: 'toggle', id: 'fullWidth', label: t('documents:menubar.fullWidth'), checked: view.fullWidth.on, onToggle: view.fullWidth.toggle },
    { kind: 'separator', id: 'view-separator' },
    {
      kind: 'toggle', id: 'fullScreen', label: t('documents:focus.button'), checked: focus.on, onToggle: focus.toggle,
      shortcut: { key: 'f', shift: true },
    },
  ]
}
