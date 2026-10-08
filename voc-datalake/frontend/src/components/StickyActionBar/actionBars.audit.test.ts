/**
 * @fileoverview Audit: the assistant launcher can never cover a form's primary
 * save / submit action (3.00.00 R3).
 *
 * R3: at 390 px the launcher covered the full-width "Save Changes" on /company,
 * because that row was a plain div: the launcher only keeps clear of rows that
 * register as a `StickyActionBar`. This test scans every non-dialog module
 * under `pages/` and `components/` that renders a primary button and requires
 * it to be classified:
 *
 * - `REGISTERED`: its primary save / submit row is a `StickyActionBar` (or the
 *   shared `SaveRow`, which is one) — and the source must show it;
 * - `EXEMPT`: why its primary button is not a form's save row (page-header and
 *   toolbar actions, empty-state CTAs, per-item list controls, pages outside
 *   the layout that have no launcher).
 *
 * Dialogs are out of scope: ModalShell paints over the launcher. A new module
 * with a primary button fails here until someone decides which list it is in.
 */
import { describe, expect, it } from 'vitest'

const sources = import.meta.glob(
  ['../../pages/**/*.tsx', '../**/*.tsx', '!../../**/*.test.tsx', '!../../**/*fixtures*.tsx'],
  { query: '?raw', import: 'default', eager: true },
)

/** Module name (file name without extension) → where its primary save / submit row is registered. */
const REGISTERED: Readonly<Record<string, string>> = {
  ContextParts: 'SaveRow — Company vision/objectives, design system, design tokens, Account objectives',
  AgentDetail: 'the config Save bar',
  PasswordSection: 'Account → Change password',
  MintTokenForm: 'Connect → Create token',
  AddMemoryForm: 'Memory → Add',
  MemoryImports: 'Memory → Import',
  SourceCardSections: 'Administration → Data sources → Save to secrets / Test',
  ReprocessPanel: 'Administration → Categories → Start reprocess',
  CategoryChangeControl: 'Feedback detail → Change category → Save',
  DimensionsEditControl: 'Feedback detail / card → Edit dimensions → Save',
  DraftSaveBar: 'Administration → Dimensions / Sources & privacy → Save',
  RowCompositionPanel: 'Prioritization → row composition → Save',
  ResearchNotes: 'Project → personas → Add note',
  ProductInterviewChat: 'Project → product interview → Send',
}

/** Module name → why its primary button is not a form's save / submit row. */
const EXEMPT: Readonly<Record<string, string>> = {
  CategoriesManager: 'Generate categories sits at the top of the tab, above the list (saves are automatic)',
  PrototypeRenderer: 'the submit lives inside the sandboxed prototype preview, not the app page',
  GoHomeLink: 'error-state navigation link, centred in the page',
  'RouteErrorBoundary/index': 'error-state retry, centred in the page',
  S3ImportExplorer: 'inline "create folder" control in the explorer toolbar',
  TimeRangeSelector: 'popover in the page header',
  UserAdmin: 'Create user is a page-header action',
  RunsTab: 'Run now heads the runs list',
  EndpointCard: 'Download skill is a card action at the top of Connect',
  Dashboard: 'header action',
  DashboardEmptyState: 'empty-state CTA, centred',
  DashboardWindowEmpty: 'empty-state CTA, centred',
  DataExplorer: 'New file is a page-header action',
  FeedbackForms: 'header Create and the empty-state CTA',
  FormCard: 'per-card Enable notice at the top of the card',
  Home: 'navigation link inside the onboarding card',
  OnboardingBuddy: 'navigation links inside the onboarding card',
  LoginSharedComponents: '/login is outside the layout: no launcher',
  BallotForm: '/vote is outside the layout: no launcher',
  MemoryList: 'Merge heads the selected-items toolbar above the list',
  MemoryReview: 'per-conflict Apply, one of many in the review list',
  PrioritizationHeader: 'Save sits in the page header',
  RoomVotePanel: 'Open room vote is a per-row control in the expanded row',
  DocWizard: 'Autofill is inline beside the questions heading',
  DocumentsTab: 'New document is a tab-header action',
  OverviewTab: 'per-step card CTAs in the overview grid',
  PersonasTab: 'Generate personas is a tab-header action',
  ProductTab: 'Generate report is a one-button side card, not a form',
  Scrapers: 'New source is a page-header action',
  SettingsSections: 'Administration Save Changes sits in the page header',
  InviteSection: 'inside the project sharing dialog',
  AiModelSurfaceRow: 'per-surface Save in each AI-model row, one of many in the card list',
}

const isDialog = (text: string): boolean => /ModalShell|dialog-footer/.test(text)
/** File name without extension; an `index` file is named by its folder (`RouteErrorBoundary/index`). */
const moduleName = (path: string): string => {
  const [folder = '', file = ''] = path.replace(/\.tsx$/, '').split('/').slice(-2)
  return file === 'index' ? `${folder}/index` : file
}

const withPrimary = Object.entries(sources)
  .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  .filter(([path, text]) => text.includes('btn-primary') && !isDialog(text) && !path.includes('/assistant/'))

describe('primary save / submit rows are registered action bars (R3)', () => {
  it('scans the app (not vacuous)', () => {
    expect(withPrimary.length).toBeGreaterThan(30)
    expect(withPrimary.map(([path]) => moduleName(path))).toStrictEqual(expect.arrayContaining(['ContextParts', 'PasswordSection']))
  })

  it.each(withPrimary.map(([path, text]) => [moduleName(path), path, text]))('%s is classified', (name, path) => {
    const registered = Object.hasOwn(REGISTERED, name)
    const exempt = Object.hasOwn(EXEMPT, name)
    expect(registered || exempt, `${path} renders a primary button: add it to REGISTERED (wrap its save row in StickyActionBar) or EXEMPT (say why)`).toBe(true)
    expect(registered && exempt, `${name} is in both lists`).toBe(false)
  })

  it.each(Object.keys(REGISTERED))('%s renders its save row in a StickyActionBar', (name) => {
    const match = withPrimary.find(([path]) => moduleName(path) === name)
    expect(match, `${name} is listed but no longer renders a primary button`).toBeDefined()
    expect(match?.[1]).toMatch(/<StickyActionBar\b/)
  })

  it('lists no module that is gone', () => {
    const names = new Set(withPrimary.map(([path]) => moduleName(path)))
    expect(Object.keys(EXEMPT).filter((name) => !names.has(name))).toStrictEqual([])
  })
})
