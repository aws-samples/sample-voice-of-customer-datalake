/**
 * WCAG 1.4.10 (reflow) contracts from the wave-5 sweep: at 390 px with 200 %
 * text these rows pushed the page sideways. jsdom has no layout, so the guards
 * pin the classes that make each row wrap.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8')

/** The `@apply` line of a recipe in index.css, e.g. `.badge`. */
function recipe(selector: string): string {
  const css = read('../index.css')
  const start = css.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`${selector} not found in index.css`)
  return css.slice(start, css.indexOf('}', start))
}

describe('rows reflow at 390 px and 200 % text', () => {
  it('badges wrap once they are as wide as their container, and keep one line until then', () => {
    const badge = recipe('.badge')
    expect(badge).not.toContain('whitespace-nowrap')
    expect(badge).toMatch(/\bmax-w-full\b/)
    expect(badge).toMatch(/\bwhitespace-normal\b/)
    expect(badge).toMatch(/\bflex-none\b/)
  })

  it('a one-word heading longer than its card hyphenates instead of overflowing', () => {
    const headings = recipe('h1, h2, h3, h4, h5, h6')
    expect(headings).toContain('hyphens: auto')
    expect(headings).toContain('overflow-wrap: break-word')
  })

  it('the Categories star-rating group wraps (its six buttons pushed the page to 521 px)', () => {
    const filterBar = read('../pages/Categories/FilterBar.tsx')
    const group = filterBar.split('\n').find((line) => line.includes("aria-label={t('starRating')}"))
    expect(group).toMatch(/\bflex-wrap\b/)
  })

  it('buttons never grow past their container; a long one-word label hyphenates', () => {
    const btn = recipe('.btn')
    expect(btn).toMatch(/\bmax-w-full\b/)
    expect(btn).toMatch(/\bhyphens-auto\b/)
  })

  it('Home "How it works" stacks the step number above the text in a narrow list', () => {
    const source = read('../pages/Home/HowItWorks.tsx')
    expect(source).toContain('className="@container space-y-3"')
    expect(source).toMatch(/className="flex flex-col gap-3 [^"]*@\[18rem\]:flex-row/)
  })

  it.each([
    ['../pages/Settings/SettingsSections.tsx', 'w-full flex flex-wrap items-center justify-between'],
    ['../pages/Settings/SettingsSections.tsx', 'flex flex-wrap items-center justify-between gap-3 mb-4'],
    ['../pages/Settings/LogsSection.tsx', 'flex flex-wrap items-center justify-between gap-3 mb-4'],
    ['../pages/Settings/LogsSection.tsx', 'grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))]'],
    ['../pages/Settings/SourceLogList.tsx', "'flex flex-wrap items-center gap-2 mb-3'"],
    ['../pages/Settings/AlertsCard.tsx', 'flex flex-wrap items-center gap-2 px-3 py-2'],
    ['../pages/Settings/AlertsCard.tsx', '<div className="flex flex-wrap items-center gap-2 mb-3">'],
    ['../pages/Settings/AlertsCard.tsx', 'className="min-w-0 break-words hyphens-auto text-base font-semibold'],
    ['../pages/Settings/SourceCard.tsx', 'flex flex-wrap items-center justify-end gap-3 ml-auto sm:ml-0 flex-shrink-0 max-w-full'],
    ['../components/CategoriesManager/CategoriesManager.tsx', 'flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-3'],
    ['../pages/ProjectDetail/OverviewTab.tsx', 'text-text-strong break-words hyphens-auto">'],
    ['../pages/ProjectDetail/OverviewTab.tsx', 'text-muted mt-0.5 break-words hyphens-auto">{description}'],
    // Wave 6: "Accoun/t" next to the avatar, project names split mid-word, "Mit mir geteilt" at 405 px.
    ['../pages/Account/ProfileSections.tsx', 'className="flex flex-wrap items-center gap-4 min-w-0" data-testid="account-identity"'],
    ['../pages/Account/ProfileSections.tsx', '<div className="min-w-0 flex-1 basis-[10em]">'],
    ['../pages/Projects/ProjectCard.tsx', 'text-text-strong break-words hyphens-auto">{project.name}'],
    ['../pages/Projects/ProjectCard.tsx', 'flex-shrink-0 @max-[16em]:hidden'],
    ['../pages/Projects/ProjectListControls.tsx', 'className="inline-flex flex-wrap max-w-full rounded-lg'],
    ['../components/SocialFeed/SocialFeed.tsx', '<span className="ml-auto flex flex-wrap items-center gap-3">'],
  ])('%s keeps the wrapping row "%s"', (file, classes) => {
    expect(read(file)).toContain(classes)
  })

  it('a project name hyphenates instead of breaking anywhere', () => {
    expect(read('../pages/Projects/ProjectCard.tsx')).not.toContain('[overflow-wrap:anywhere]">{project.name}')
  })
})
