/**
 * WCAG 1.4.4 (resize text) contract for the shared shell: font sizes in the
 * global recipes and the app chrome are in rem, so they grow with the user's
 * text size (verify4: the 13 px rail titles and 12 px meta stayed put at 200 %).
 * Covers the shell, the header time range and the Admin files this track owns;
 * other page-owned `text-[Npx]` are tracked as integrator requests.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8')

const SHARED_FILES = [
  '../index.css',
  '../components/Layout/Layout.tsx',
  '../components/Layout/SidebarComponents.tsx',
  '../components/ProfileMenu/ProfileMenu.tsx',
  '../components/MetricCard/MetricCard.tsx',
  '../components/Breadcrumbs/Breadcrumbs.tsx',
  '../components/TimeRangeSelector/TimeRangeSelector.tsx',
  '../pages/Settings/IntegrationSetupGuide.tsx',
  '../pages/Settings/ScraperRunsPanel.tsx',
  '../pages/Settings/VersionSection.tsx',
] as const

/** `text-[13px]` utilities and `font-size: 12px` declarations. */
const PX_FONT_SIZE = /text-\[\d+(?:\.\d+)?px\]|font-size:\s*\d+(?:\.\d+)?px/g

describe('shared text scales with the user font size', () => {
  it.each(SHARED_FILES)('%s sets no font size in px', (file) => {
    expect(read(file).match(PX_FONT_SIZE) ?? []).toStrictEqual([])
  })

  it('keeps the 100 % sizes: 13 px buttons and menu items, 12 px small buttons, 15 px dialog titles', () => {
    const css = read('../index.css')
    expect(css).toMatch(/\.btn-sm \{ @apply [^}]*text-\[0\.75rem\]/)
    expect(css).toMatch(/\.dialog-title \{ @apply [^}]*text-\[0\.9375rem\]/)
    expect(css.match(/text-\[0\.8125rem\]/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })
})
