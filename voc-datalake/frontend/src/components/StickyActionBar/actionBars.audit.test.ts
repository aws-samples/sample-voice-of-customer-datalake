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
  OAuthConsent: 'MCP sign-in consent → Approve / Deny',
  MemoryImports: 'Memory → Import',
  SourceCardSections: 'Administration → Data sources → a source → Save to Secrets Manager',
  ReprocessPanel: 'Administration → Categories → Start reprocess',
  CategoryChangeControl: 'Feedback detail → Change category → Save',
  DimensionsEditControl: 'Feedback detail / card → Edit dimensions → Save',
  DraftSaveBar: 'Administration → Categories → Dimensions / Privacy → Source policies → Save',
  RowCompositionPanel: 'Prioritization → row composition → Save',
  ResearchNotes: 'Project → personas → Add note',
  DecisionForm: 'Project → Decisions → Save decision',
  RadarSection: 'Administration → Data sources → Radar → Save',
  RadarBrandsEditor: 'Administration → Data sources → Radar → Save brands',
  RadarExaCard: 'Administration → Data sources → Radar → Exa → Save key',
  ParticipantSettingsCard: 'Administration → Feedback boards → Participant email → Save',
  CompanyDomainsCard: 'Administration → Feedback boards → Company domains → Save domains',
  BoardEditor: 'Administration → Feedback boards → board editor → Save board',
  DefaultThemeCard: 'Administration → Brand & appearance → Default theme → Save',
  BrandEditorCard: 'Administration → Brand & appearance → Brand → Save; Workspace settings → Brand → Save; Administration → Platform → Deployment brand → Save',
  SaveBar: 'the document surface\'s own save row (components/Document/surface): Discard and Save',
  TenetsReview: 'Agent orchestration → Setup guide → Tenets: a version\'s reason, then Reject or Accept',
}

/** Module name → why its primary button is not a form's save / submit row. */
const EXEMPT: Readonly<Record<string, string>> = {
  CategoryGeneratePanel: 'Generate categories sits at the top of the Categories tab, above the list (saves are automatic)',
  PrototypeRenderer: 'the submit lives inside the sandboxed prototype preview, not the app page',
  DocumentToolbar: 'Share is the document page\'s toolbar action (it opens the review link dialog), not a form\'s save row',
  GoHomeLink: 'error-state navigation link, centred in the page',
  AddMemberForm: 'Members → Add a member: a one-line add form (email, role, Add) above the list, nothing left unsaved',
  CreateWorkspaceForm: 'Administration → Workspaces: a two-field create form above the list, nothing left unsaved',
  WorkspaceExportCard: 'Workspace settings → Export: Start an export and Download act at once on the server; no form, nothing left unsaved',
  ProposalReview: 'Revise from comments: per-change Accept and Accept all put text into the draft; the save is the page bar\'s own Save',
  BlankDocumentDraft: 'Documents → New PRD / PR/FAQ → Blank: Start writing sits right under the name being typed, at the top of the pane (Enter does the same); nothing else is left unsaved',
  McpJsonSnippets: 'Connect → mcp.json: the pressed client of a toggle group (aria-pressed) wears the primary style; nothing is saved',
  DataQualitySectionProfile: 'Data Explorer → Data quality: the pressed facet of a toggle group (aria-pressed) wears the primary style; nothing is saved',
  'RouteErrorBoundary/index': 'error-state retry, centred in the page',
  S3ImportExplorer: 'inline "create folder" control in the explorer toolbar',
  TimeRangeSelector: 'popover in the page header',
  UserAdmin: 'Create user is a page-header action',
  RunsTab: 'Run now heads the runs list',
  RunRequests: 'Agents → Runs → run requests: Confirm and Decline are each request\'s own controls in the list, nothing left unsaved',
  Agents: 'New automation is a page-header action',
  AutomationHeader: 'An automation page\'s one primary (its state\'s action: Set up, Enable, Resume, Run now) sits in its header beside its state chip; it acts at once or opens the Set up drawer, nothing left unsaved',
  AutomationRow: 'A setup guide step\'s one primary is its automation\'s row action (Set up, Enable…) beside the row\'s state; it acts at once or opens the Set up drawer, nothing left unsaved',
  GitHubAppPanel: 'Create the App on GitHub ends a two-field choice inside the Connect GitHub card, the page\'s one card while nothing is connected (it posts to github.com at once, nothing left unsaved)',
  DialFix: 'Set to AI-driven confirms one inline readiness fix inside the Set up dialog (it saves the caller\'s way of working at once, nothing left unsaved); the dialog\'s own save row is its footer',
  GitHubAppCreated: 'Install on GitHub is a link to github.com in the page\'s one card, under what was created; nothing to save',
  SkillActions: 'Accept is one of a version\'s actions beside its status; it opens an approval card, whose footer holds the confirmation',
  SkillTemplateUpdate: 'Adopt as a proposal sits in the role\'s Template updated card, under the diff it adopts; it acts at once (a proposal an administrator accepts later), no form to save',
  SetupGuideEntry: 'Start the setup guide is the first visit\'s choice in the Engineering group\'s card on Automations, saved at once; nothing left unsaved',
  ReadyStep: 'Run on an issue now is the Ready to go step\'s action inside the step\'s card (it opens a confirmation dialog); nothing left unsaved',
  WorkflowPage: 'Start a run is a page-header action beside the title (it opens a dialog)',
  EditorParts: 'the flow editor\'s Save sits in its toolbar above the canvas, top of the page, next to Save as (7.52.00 C2)',
  KnowledgeReview: 'Approve a knowledge pack version is the one action of its review card in the setup guide, nothing typed left unsaved',
  RegistryPage: 'Create from a skill heads the Registry\'s list (it opens the Create card sheet)',
  SteerComposer: 'Send is the run workspace thread\'s composer, under the session pane it steers (a message to the orchestrator, not a form\'s save row)',
  EngineeringBoardControls: 'Post is a small fold-out form\'s at the top of the board it adds a task to (an action, not a page\'s save row)',
  RunDecisionForm: 'Make the decision sits in the decision card at the top of the selected run, above the graph, left-aligned',
  AddPasskeyButton: 'a one-action card button (the passkey offer above the page, Account → Passkey), no form to save',
  EndpointCard: 'Download skill is a card action at the top of Connect',
  Dashboard: 'header action',
  DashboardEmptyState: 'empty-state CTA, centred',
  DashboardWindowEmpty: 'empty-state CTA, centred',
  CompanyContextSection: 'empty-state CTA ("Not set yet" → start writing) that opens the editor; the editor\'s own save row is the action bar',
  DataExplorer: 'New file is a page-header action',
  FeedbackForms: 'header New form and the empty-state CTA',
  SaveButtons: 'the forms builder\'s Save / Publish: in the page header from sm, and on a phone in BuilderActionBar, a StickyActionBar at the end of the builder after the tab\'s content (only while a button shows)',
  linkParts: 'the new form\'s "Save the form to get its links" empty state on Test, Share and Hidden fields: a centred CTA (with why it is off); the builder\'s save row is its header and BuilderActionBar',
  DescribePanel:'Draft it ends the "Describe your form" panel at the top of the picker (it starts an AI draft; nothing to save)',
  DescribeExamples: 'Replace answers the inline "Replace your description?" question, beside Keep mine',
  TemplatePreview: 'Use this template ends the picker\'s preview panel (it opens the builder; nothing to save)',
  PasteOptions: 'Add N options ends the choice editor\'s inline paste box, one of the question\'s fields',
  ResultsFilterBar: 'Add filter ends the Results filter bar\'s inline hidden-field filter',
  HiddenFieldEditor: 'Add / Save end the inline hidden-field row of the table (the form saves with its header\'s Save)',
  Notice: 'a notice\'s one action: the empty-state CTA (Feedback Forms → Create form) or a banner\'s fix (a disabled form\'s Enable), never a form\'s save row',
  BoardList: 'New board heads the Boards list card (it opens a dialog)',
  OnboardingBuddy: 'navigation links inside the onboarding card',
  BriefCardItem: 'per-card act buttons on Home, one card among many in the brief list',
  AgentDecisionCards: 'per-card navigation link to the agent\'s runs, at the top of Home, one card per waiting agent',
  BriefSettings: 'Subscribe sits inside the subscribe card (Home while not subscribed, and atop Account → Morning brief), left-aligned; settings save per control',
  LoginSharedComponents: '/login is outside the layout: no launcher',
  BallotForm: '/vote is outside the layout: no launcher',
  MemoryList: 'Add memory (opens a dialog) and Merge head the list, in its toolbar',
  MemoryReview: 'per-conflict Apply, one of many in the review list',
  MemoryEditor: 'inline Save inside one memory card, one of many in the memory list',
  PrioritizationHeader: 'Save sits in the page header',
  RoomVotePanel: 'Open room vote is a per-row control in the expanded row',
  WalkthroughEditor: 'Save as a new version ends the walkthrough editor\'s side panel beside the prototype preview, inside the panel\'s own scroll, not the page\'s form',
  PrototypeDraftBanner: 'Apply as vN sits in the draft banner at the top of the prototype pane, above the preview, left-aligned; no form to save',
  DecisionsTab: 'New decision is a tab-header action',
  DecisionCard: 'per-decision Draft PR/FAQ, one of many in the decision list',
  OverviewTab: 'per-step card CTAs in the overview grid',
  PersonasTab: 'Generate personas is a tab-header action',
  ProductTabHeader: 'Fill with AI assistant is a page-header action (it opens the assistant; the form autosaves per field)',
  Scrapers: 'New source is a page-header action',
  SettingsSections: 'Administration Save Changes sits in the page header',
  InviteSection: 'inside the project sharing dialog',
  AiModelSurfaceRow: 'per-surface Save in each AI-model row, one of many in the card list',
  Participants: 'New ask is a page-header action (it opens the composer dialog)',
  ListsTab: 'per-list Open, one of many in the list cards (and the empty-state New list CTA)',
  ParticipantsTab: 'Ask for feedback is a tab-header action (it opens the composer dialog)',
  Unsubscribe: 'public page outside the layout: its one button is the whole page',
  FeatureBoard: 'New request is a page-header action (it opens a dialog)',
  AddSupportForm: 'rendered only inside the feature-request detail dialog (RequestDetailModal)',
  AppEditorForm: 'rendered only inside the data source dialog (PluginConfigModal): one app or review page form',
  SupportRow: 'per-support Save, rendered only inside the feature-request detail dialog',
  PromotePanel: 'admin Promote, rendered only inside the feature-request detail dialog',
  BoardLogin: '/board/login is outside the layout: no launcher',
  FeedbackTypeBackfill: 'Classify review types is a card action in the built-in feedback_type card; it opens a confirm dialog that starts a job, no form to save',
  DocumentComments: 'the Comment button floats next to the selected text in the document, not a form row',
  CommentComposer: 'inline Post in the margin beside one thread or selection, one of many in the comment rail',
  ReferenceDesignPreview: 'per-reference Use as design system, one of many in the references list (it only loads a draft)',
  DocumentActionsBar: 'the canvas\'s Save and Discard register themselves as an action bar (useRegisterActionBar) and pin to the bottom on a phone while dirty',
}

// (a SideSheet is a ModalShell too: its footer sits over the launcher)
const isDialog = (text: string): boolean => /ModalShell|dialog-footer|<SideSheet\b/.test(text)
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
