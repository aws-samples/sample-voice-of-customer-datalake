/**
 * @fileoverview Spec support shared by the menus built on `ExportMenuShell`
 * (document and persona export).
 */
import type { ReactElement } from 'react'
import userEvent from '@testing-library/user-event'
import { renderExportMenu } from '../../test/export-menu'

/**
 * Mount `ui` and read the trigger's `aria-expanded` before and after one click,
 * for a single structured assertion: `{ before: 'false', after: 'true' }`.
 */
export async function ariaExpandedAcrossClick(
  ui: ReactElement, triggerName: string | RegExp,
): Promise<{ before: string | null; after: string | null }> {
  const button = renderExportMenu(ui, triggerName)
  const before = button.getAttribute('aria-expanded')
  await userEvent.setup().click(button)
  return { before, after: button.getAttribute('aria-expanded') }
}
