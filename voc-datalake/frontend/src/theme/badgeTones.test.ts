/**
 * Labels vs status (docs/kiro-design-system.md, rule 15): colour on a badge or
 * chip carries meaning, never identity.
 *
 * On 2026-10-09 the feedback card painted its descriptive labels by identity —
 * category accent, subcategory `aim`, persona `info`, dimension chips `info`,
 * journey stage and tags grey — so one card showed four tones for five labels
 * next to its real status badges (KiroCrew's `SourceBadge`: "one coloured chip
 * among grey peers reads as 'why is this one different?' rather than as a
 * category"). This reads the feedback surfaces and fails when that comes back:
 * a descriptive field in an `info` / `aim` pill, a second accent label on the
 * card row, or the hand-set marker losing the icon that makes its tone legible.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = resolve(__dirname, '..')
const read = (file: string) => readFileSync(join(SRC, file), 'utf8')

/** The surfaces that show a review's labels together. */
const FEEDBACK_SURFACES = [
  'components/FeedbackCard/FeedbackCard.tsx',
  'components/FeedbackDimensions/FeedbackDimensionChips.tsx',
  'pages/FeedbackDetail/FeedbackDetail.tsx',
  'pages/FeedbackDetail/FeedbackDetailSections.tsx',
] as const

/** A field whose value says WHICH ONE — a descriptive label, never a state. */
const DESCRIPTIVE_FIELD = /\.(category|subcategory|journey_stage|persona_name|source_platform|tags)\b|chip\.(label|value)|\{tag\}/

/** An `info` / `aim` tint, as the badge recipe or hand-rolled. */
const IDENTITY_TINT = /badge-(?:info|aim)\b|bg-(?:info|aim)-subtle/g

/**
 * Every `info` / `aim` pill in `source` whose content (up to the element's
 * closing tag) names a descriptive field, as `line: snippet`.
 */
function identityColouredLabels(source: string): string[] {
  const offenders: string[] = []
  for (const match of source.matchAll(IDENTITY_TINT)) {
    const rest = source.slice(match.index)
    const element = /^[\s\S]*?<\/(?:span|button|li)>/.exec(rest)?.[0] ?? rest.slice(0, 400)
    if (DESCRIPTIVE_FIELD.test(element)) {
      const line = source.slice(0, match.index).split('\n').length
      offenders.push(`${line}: ${element.replace(/\s+/g, ' ').slice(0, 120)}`)
    }
  }
  return offenders
}

describe('labels vs status on the feedback surfaces', () => {
  it.each(FEEDBACK_SURFACES)('%s never tints a descriptive label info or aim', (file) => {
    expect(identityColouredLabels(read(file))).toStrictEqual([])
  })

  it('catches the 3.14.00 card (subcategory aim, persona info, dimension info) if it comes back', () => {
    const regressed = [
      '<span className="badge badge-aim text-xs">{feedback.subcategory}</span>',
      '<span className="badge badge-info">{feedback.persona_name}</span>',
      '<span className="badge badge-info" title={x}><span className="text-muted">{chip.label}:</span> {chip.value}</span>',
      '<button className="px-3 bg-info-subtle text-info rounded-full">{feedback.subcategory}</button>',
    ].join('\n')
    expect(identityColouredLabels(regressed)).toHaveLength(4)
    // A state marker in `info` is fine even when it mentions a category in a translation key.
    expect(identityColouredLabels('<span className="badge badge-info">{t(\'categoryChange.manual\')}</span>')).toStrictEqual([])
  })

  it('gives the card row one emphasised label, the category', () => {
    const cardTags = /function CardTags[\s\S]*?\n}\n/.exec(read('components/FeedbackCard/FeedbackCard.tsx'))?.[0] ?? ''
    expect(cardTags).toMatch(/badge-accent">\{labels\.category\(feedback\.category\)\}/)
    expect(cardTags.match(/badge-accent/g)).toHaveLength(1)
    expect(cardTags).toMatch(/<LabelBadge>\{labels\.subcategory\(feedback\.subcategory/)
    expect(cardTags).toMatch(/<LabelBadge>\{feedback\.persona_name\}/)
  })

  it('keeps every other card label neutral', () => {
    const card = read('components/FeedbackCard/FeedbackCard.tsx')
    expect(card).toMatch(/function LabelBadge[\s\S]*?className="badge badge-muted hidden sm:inline-flex"/)
    expect(card).toMatch(/<LabelBadge>\{labels\.plain\(feedback\.journey_stage\)\}/)
  })

  it('keeps dimension chips and tags neutral, a hand-set value marked by icon and title', () => {
    const chips = read('components/FeedbackDimensions/FeedbackDimensionChips.tsx')
    expect(chips).toMatch(/className="badge badge-muted" title=\{manual \? t\('setByHand'\) : undefined\}/)
    expect(chips).toMatch(/\{manual && <UserPen size=\{12\} aria-label=\{t\('setByHand'\)\} \/>\}/)
    expect(chips).toMatch(/<span key=\{tag\} className="badge badge-muted">/)
    expect(chips).not.toMatch(/badge-(?:info|aim|accent)/)
  })

  it('keeps the status badges their state tones', () => {
    const card = read('components/FeedbackCard/FeedbackCard.tsx')
    const chips = read('components/FeedbackDimensions/FeedbackDimensionChips.tsx')
    expect(card.match(/badge badge-warn">\s*<AlertTriangle/g)).toHaveLength(2)
    expect(chips.match(/badge badge-warn" title=/g)).toHaveLength(2)
  })

  it('marks a hand-set category as informational state: info tone, icon and text', () => {
    const badge = /export function ManualCategoryBadge[\s\S]*?\n}\n/.exec(read('components/CategoryChangeControl/CategoryChangeControl.tsx'))?.[0] ?? ''
    expect(badge).toMatch(/className="badge badge-info" title=/)
    expect(badge).toMatch(/<UserPen size=\{12\} aria-hidden="true" \/>/)
    expect(badge).toMatch(/t\('categoryChange\.manual'\)/)
  })

  it('tones the detail page chips the same way: one accent filter, neutral peers, warn for urgent', () => {
    const detail = read('pages/FeedbackDetail/FeedbackTags.tsx')
    expect(detail.match(/<FilterChip emphasised /g)).toHaveLength(1)
    expect(detail).toMatch(/<FilterChip emphasised onClick=\{\(\) => onOpen\(categoriesLinkFor\(\{ category: /)
    expect(detail).toMatch(/const LABEL_CHIP = `\$\{CHIP\} bg-bg-hover text-muted/)
    expect(detail).toMatch(/bg-warn-subtle text-warn`\}>\s*<Flame/)
  })

  it('documents the rule where the badge recipe is defined', () => {
    const doc = readFileSync(resolve(SRC, '../../../docs/kiro-design-system.md'), 'utf8')
    expect(doc).toMatch(/### Labels vs status/)
    expect(doc).toMatch(/\| 15 \| \*\*MUST\*\* tone a badge or chip by \*\*meaning\*\*/)
    expect(doc).toContain('one coloured chip among grey peers reads as "why is this one different?" rather than as a category')
    expect(doc).toMatch(/theme\/badgeTones\.test\.ts/)
  })
})


/**
 * 3.14.02 took the same rule over the rest of the app, where labels were still
 * coloured by identity: a document type per tone, a source kind per tile tone, a
 * persona section (and its chips) per tone, a wizard per accent. These pins read
 * those surfaces and fail when a per-kind tone comes back.
 */

/** Every `info` / `aim` / `ok` / `warn` tint class in `source` (recipe or hand-rolled), in order. */
function statusTints(source: string): string[] {
  return [...source.matchAll(/\b(?:badge|text|bg|border)-(?:info|aim|ok|warn)(?:-subtle|-fg|\/\d+)?\b/g)]
    .map((match) => match[0])
}

/** Every `<Tag … />` element of `source`, flattened to one line each. */
function elements(source: string, tag: string): string[] {
  return [...source.matchAll(new RegExp(`<${tag}[\\s\\S]*?/>`, 'g'))].map((match) => match[0].replace(/\s+/g, ' '))
}

const SCRAPER_PAGE = join(SRC, 'pages/Scrapers')
const scraperFiles = readdirSync(SCRAPER_PAGE).filter((file) => file.endsWith('.tsx') && !file.includes('.test.'))

describe('labels vs status across the app (3.14.02)', () => {
  describe('a document type is identity: one neutral pill, the icon tells them apart', () => {
    it('renders every type as badge-muted with its icon', () => {
      const badge = read('components/DocumentTypeBadge/DocumentTypeBadge.tsx')
      expect(badge).toMatch(/className="badge badge-muted"/)
      expect(badge).toMatch(/<IconGlyph icon=\{documentTypeIcon\(type\)\} size=\{12\} \/>/)
      expect(statusTints(badge)).toStrictEqual([])
    })

    it('maps a type to an icon only, never to a tone', () => {
      const types = read('components/DocumentTypeBadge/documentTypes.ts')
      expect(types).toMatch(/Record<KnownProjectDocumentType, LucideIcon>/)
      expect(statusTints(types)).toStrictEqual([])
    })

    it.each([
      'pages/ProjectDetail/DocumentLabels.tsx',
      'components/DataSourceWizard/ItemSelectionStep.tsx',
    ])('%s keeps no second type → tone map', (file) => {
      expect(statusTints(read(file))).toStrictEqual([])
    })

    it('shares the one helper with the wizard picker and the prioritization rows', () => {
      expect(read('components/DataSourceWizard/ItemSelectionStep.tsx')).toMatch(/import \{ documentTypeIcon, documentTypeLabel \} from '\.\.\/DocumentTypeBadge\/documentTypes'/)
      expect(read('pages/Prioritization/prioritizationUtils.ts')).not.toMatch(/badgeColor/)
      expect(read('pages/Prioritization/PRFAQRow.tsx')).toMatch(/import \{ DocumentTypeBadge \} from '\.\.\/\.\.\/components\/DocumentTypeBadge\/DocumentTypeBadge'/)
    })

    it('catches the 3.14.01 maps (PRD info, PR/FAQ ok, research warn, custom aim) if they come back', () => {
      expect(statusTints([
        "prd: 'bg-info-subtle text-info',",
        "prfaq: 'bg-ok-subtle text-ok',",
        "if (type === 'research') return 'bg-warn-subtle'",
        "return 'text-aim'",
      ].join('\n'))).toHaveLength(6)
    })
  })

  describe('a kind of source is identity: every source tile is accent', () => {
    it('keeps only accent and the paused state in SourceTone', () => {
      const header = read('pages/Scrapers/SourceDialogHeader.tsx')
      expect(header).toMatch(/export type SourceTone = Extract<Tone, 'accent' \| 'muted'>/)
      expect(header).toMatch(/const TONE_TILE: Record<SourceTone, string> = \{\n\s+accent: 'bg-accent-subtle text-accent-text',\n\s+muted: 'bg-bg-hover text-muted',\n\}/)
      expect(header).toMatch(/tone = 'accent'/)
    })

    it('passes no tone to a dialog header: a dialog is always about a source', () => {
      const toned = scraperFiles.flatMap((file) => elements(read(`pages/Scrapers/${file}`), 'SourceDialogHeader'))
        .filter((header) => /\btone=/.test(header))
      expect(toned).toStrictEqual([])
    })

    it('passes a tone to one tile only — the scraper card, for its paused state', () => {
      const toned = scraperFiles.flatMap((file) => elements(read(`pages/Scrapers/${file}`), 'ToneTile')
        .filter((tile) => /\btone=/.test(tile))
        .map((tile) => `${file}: ${tile}`))
      expect(toned).toStrictEqual(["ScraperCard.tsx: <ToneTile icon={Globe} tone={scraper.enabled ? 'accent' : 'muted'} />"])
    })

    // The grouped "New source" menu (wave 3) tells tiles apart by icon and a one-line
    // description; the internal "Auto-discovered" provenance badge is gone, so no tint at all.
    it('tells the template tiles apart by icon alone, with no status tint', () => {
      const selector = read('pages/Scrapers/TemplateSelector.tsx')
      expect(selector).not.toMatch(/SourceTone|tone[:=]/)
      expect(statusTints(selector)).toStrictEqual([])
    })
  })

  describe('a persona attribute is identity: neutral chips, neutral sections, danger only for pain points', () => {
    const sections = read('pages/ProjectDetail/PersonaSections.tsx')

    it('uses badge-muted chips and muted sub-headings, with no per-kind tint', () => {
      expect(statusTints(sections)).toStrictEqual([])
      expect(sections).toMatch(/function AttributeChip[\s\S]*?className="badge badge-muted whitespace-normal"/)
      expect(sections).toMatch(/function LabelledPanel[\s\S]*?bg-bg-accent rounded-lg border border-border[\s\S]*?text-xs text-muted font-medium/)
      // Every chip goes through AttributeChip: it is the only `badge` in the file (ChipList and the identity row use it).
      expect(sections.match(/className="badge\b/g)).toHaveLength(1)
    })

    it('tones one section by state (pain points = negative sentiment) and none by kind', () => {
      expect(sections.match(/color="[a-z]+"/g)).toStrictEqual(['color="danger"'])
      expect(sections).toMatch(/title=\{t\('personaSections\.painPoints'\)\} icon=\{Frown\} color="danger"/)
    })

    it('offers a section only the state tones, and a neutral card by default', () => {
      const types = read('pages/ProjectDetail/types.ts')
      expect(types).toMatch(/type SectionColor = Extract<Tone, 'danger' \| 'muted'>/)
      expect(types).toMatch(/const NEUTRAL_SECTION_CLASSES: SectionClasses = \{\n\s+border: 'border-border bg-card',\n\s+title: 'text-text-strong',/)
    })

    it('catches the 3.14.01 chips (identity aim, behaviours info, devices warn, primary goal ok) if they come back', () => {
      expect(statusTints([
        '<span className="px-2 py-1 bg-aim-subtle border border-aim/20 rounded-sm text-xs text-aim">',
        '<span className="px-2 py-1 bg-info-subtle border border-info/20 rounded-sm text-xs text-info">',
        '<span className="px-2 py-1 bg-warn-subtle border border-warn/30 rounded-sm text-xs text-warn">',
        '<div className="p-3 bg-ok-subtle rounded-lg border border-ok/30"><p className="text-xs text-ok font-medium mb-1">',
      ].join('\n'))).toHaveLength(12)
    })
  })

  describe('which wizard is open is identity: accent tiles, accent selection, primary buttons', () => {
    const wizards = read('pages/ProjectDetail/Wizards.tsx')
    // The wizard and its split-out customer-questions section read as one surface.
    const docWizard = `${read('pages/ProjectDetail/DocWizard.tsx')}${read('pages/ProjectDetail/DocWizardQuestions.tsx')}`
    const wizard = read('components/DataSourceWizard/DataSourceWizard.tsx')

    it('opens every project wizard with the one accent tile', () => {
      expect(wizards).toMatch(/export function WizardIconTile[\s\S]*?className="w-10 h-10 bg-accent-subtle text-accent-text rounded-lg flex items-center justify-center"/)
      expect(wizards.match(/<WizardIconTile icon=\{(?:Users|Search|Shuffle)\} \/>/g)).toHaveLength(3)
      expect(docWizard).toMatch(/<WizardIconTile icon=\{FileText\} \/>/)
    })

    it('has no accentColor prop left (comments may still tell its story)', () => {
      expect(`${wizards}${docWizard}${wizard}`).not.toMatch(/accentColor[=:]|readonly accentColor/)
    })

    it('marks a chosen option with the selected recipe and hovers neutral (rule 7)', () => {
      expect(wizards).toMatch(/mergeConfig\.outputType === type \? 'bg-accent-subtle border-accent' : 'bg-card border-border'/)
      expect(wizards).toMatch(/hover:bg-bg-hover hover:border-border-strong/)
      expect(wizards).not.toMatch(/hover:(?:bg|border)-warn/)
      expect(docWizard.match(/\? 'bg-accent-subtle border-accent' : 'bg-card border-border'/g)).toHaveLength(2)
    })

    it('labels the PR/FAQ methodology neutrally and keeps the document wizard free of per-kind tints', () => {
      expect(docWizard).toMatch(/className="badge badge-muted">\{t\('wizards\.workingBackwards'/)
      expect(statusTints(docWizard)).toStrictEqual([])
    })

    it('advances every wizard with btn-primary over an accent progress bar', () => {
      expect(wizard.match(/className="btn btn-primary/g)).toHaveLength(2)
      expect(wizard).toMatch(/className="h-full transition-all bg-accent"/)
      expect(statusTints(wizard)).toStrictEqual([])
    })

    it('selects a filter accent-subtle; a selected sentiment keeps its meaning colour, the one tint left', () => {
      const steps = read('components/DataSourceWizard/DataSourceSteps.tsx')
      expect(steps).toMatch(/const SELECTED_FILTER = 'bg-accent-subtle border-accent text-accent-text'/)
      expect(statusTints(steps)).toStrictEqual(['bg-ok-subtle', 'border-ok/30', 'text-ok'])
    })

    it('keeps the real warning in the remix wizard', () => {
      expect(wizards).toMatch(/bg-warn-subtle border border-warn\/30 rounded-lg p-3 text-sm text-warn flex items-center gap-2">\s*<AlertTriangle/)
    })
  })

  describe('the sweep', () => {
    it.each([
      'pages/Settings/SourceCardSections.tsx',
      'pages/Scrapers/PluginConfigParts.tsx',
    ])('%s gives every plugin the same neutral setup-instructions panel, whatever its manifest colour', (file) => {
      const source = read(file)
      // No colour lookup is left to read the manifest's `setup.color`.
      expect(source).not.toMatch(/getInstructionColors|getSetupColors|setup\.color \?\?/)
      expect(source).toMatch(/rounded-lg text-(?:xs sm:text-)?sm border bg-bg-accent border-border/)
    })

    it('draws every Data Explorer object icon in the idle grey', () => {
      const browser = read('pages/DataExplorer/S3Browser.tsx')
      expect(browser).toMatch(/<IconGlyph icon=\{objectIcon\(obj\)\} size=\{18\} className="text-muted flex-shrink-0" \/>/)
      expect(statusTints(browser)).toStrictEqual([])
    })

    it('prints the team score numbers in the text colour, not a hue per axis', () => {
      const score = read('pages/Prioritization/RowTeamScore.tsx')
      // One per configured metric (rendered by a map over the setup) + the team composite.
      expect(score.match(/font-bold font-mono text-text-strong"><TeamNumber/g)).toHaveLength(2)
      expect(score).not.toMatch(/font-mono text-(?:info|aim|ok)"><TeamNumber/)
    })
  })

  it.each(['DocumentTypeBadge', 'SourceDialogHeader', 'PersonaSections', 'DataSourceWizard'])(
    'documents %s in the worked-example list',
    (surface) => {
      expect(readFileSync(resolve(SRC, '../../../docs/kiro-design-system.md'), 'utf8')).toContain(surface)
    },
  )
})
