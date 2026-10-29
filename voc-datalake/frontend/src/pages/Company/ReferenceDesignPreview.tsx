/**
 * @fileoverview The compact preview of what a ready reference yielded: colour
 * swatches, font families, counts, the logo candidate, and — for admins — the
 * one-click "Use as design system" (loads a merged draft into the editor; nothing
 * is saved until Save) and "Use this logo".
 *
 * Up to six component mini previews are painted from the reference's own
 * validated component styles (token references resolve against its colours).
 *
 * Swatches paint the reference's OWN colours (user data — see "Out of scope" in
 * docs/kiro-design-system.md); a value that is not a recognisable colour is skipped.
 *
 * @module pages/Company/ReferenceDesignPreview
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Image, Loader2, Wand2 } from 'lucide-react'
import { isPaintableColor } from '../../api/designSystemApi'
import type { ExtractedDesign, LogoCandidate } from '../../api/designSystemApi'
import type { ComponentVariant, DesignComponent } from '../../api/designComponents'
import { MiniPreview } from './ComponentPreview'
import { designCounts, fontFamilies, urlHost } from './designDraftSummary'
import type { DesignCounts } from './designDraftSummary'
import { useInlineImage } from '../../hooks/useInlineImage'

const MAX_SWATCHES = 12
const MAX_COMPONENT_PREVIEWS = 6

interface PreviewSample {
  component: DesignComponent
  variant: ComponentVariant
}

/** Up to six samples: every component's first variant first, then their second variants, … */
function previewSamples(components: readonly DesignComponent[]): PreviewSample[] {
  return components
    .flatMap((component, c) => component.variants.map((variant, v) => ({ component, variant, order: v * 1000 + c })))
    .sort((a, b) => a.order - b.order)
    .slice(0, MAX_COMPONENT_PREVIEWS)
    .map(({ component, variant }) => ({ component, variant }))
}

export interface PreviewActions {
  applying: boolean
  applyError: string | null
  onApply: () => void
  adoptingLogo: boolean
  logoError: string | null
  onAdoptLogo: () => void
}

export default function ReferenceDesignPreview({ design, actions }: Readonly<{
  design: ExtractedDesign
  /** Admin actions; absent = read-only preview. */
  actions?: PreviewActions
}>) {
  const { t } = useTranslation('settings')
  const swatches = design.colors.filter((color) => isPaintableColor(color.value)).slice(0, MAX_SWATCHES)
  const fonts = fontFamilies(design)
  const samples = previewSamples(design.components)
  return (
    <div className="mt-3 rounded-md bg-bg-accent p-3 space-y-2" data-testid="reference-design-preview">
      <div className="flex items-start gap-3">
        {design.logo ? <LogoThumbnail logo={design.logo} /> : null}
        <div className="min-w-0 flex-1 space-y-2">
          {swatches.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5" aria-label={t('designSystem.preview.colors')}>
              {swatches.map((color) => (
                <li key={`${color.name}-${color.value}`}>
                  <span
                    role="img"
                    aria-label={t('designSystem.preview.swatch', { name: color.name, value: color.value })}
                    title={`${color.name} · ${color.value}`}
                    className="block w-6 h-6 rounded-sm border border-border-strong"
                    style={{ backgroundColor: color.value.trim() }}
                  />
                </li>
              ))}
            </ul>
          ) : null}
          {fonts.length > 0 ? (
            <p className="text-xs text-text break-words [overflow-wrap:anywhere]">
              <span className="text-muted">{t('designSystem.preview.fonts')}</span>{' '}
              {fonts.map((font, i) => (
                <span key={font.name}>
                  {i > 0 ? ' · ' : null}
                  <span title={font.stack}>{font.name}</span>
                </span>
              ))}
            </p>
          ) : null}
          {samples.length > 0 ? (
            <ul className="flex flex-wrap items-center gap-2" aria-label={t('designSystem.preview.components')} data-testid="reference-component-previews">
              {samples.map(({ component, variant }, i) => (
                <li key={i} title={`${component.name} · ${variant.name}`}>
                  <span className="sr-only">{`${component.name} · ${variant.name}`}</span>
                  <MiniPreview component={component} variant={variant} colors={design.colors} />
                </li>
              ))}
            </ul>
          ) : null}
          <p className="text-xs text-muted">{countsLine(designCounts(design), t)}</p>
          {design.logo?.rendered === true ? <p className="text-xs text-muted">{t('designSystem.preview.logoRendered')}</p> : null}
        </div>
      </div>
      {actions ? <PreviewButtons hasLogo={design.logo !== null} actions={actions} /> : null}
    </div>
  )
}

type Translate = ReturnType<typeof useTranslation>['t']

/** "12 colors · 3 fonts · 4 corner radii · 9 components" — groups with none are left out. */
function countsLine(counts: DesignCounts, t: Translate): string {
  const parts = [
    counts.colors > 0 ? t('designSystem.preview.colorsCount', { count: counts.colors }) : null,
    counts.fonts > 0 ? t('designSystem.preview.fontsCount', { count: counts.fonts }) : null,
    counts.spacing > 0 ? t('designSystem.preview.spacingCount', { count: counts.spacing }) : null,
    counts.radii > 0 ? t('designSystem.preview.radiiCount', { count: counts.radii }) : null,
    counts.components > 0 ? t('designSystem.preview.componentsCount', { count: counts.components }) : null,
    counts.variants > 0 ? t('designSystem.preview.variantsCount', { count: counts.variants }) : null,
  ].filter((part) => part !== null)
  return parts.length > 0 ? parts.join(' · ') : t('designSystem.preview.onlyGuidelines')
}

/**
 * The candidate, from the copy the server downloaded (`preview_url`, a presigned S3 URL,
 * read through `useInlineImage` so the app's CSP `img-src 'self' data:` allows it). Without one — or when it fails to
 * load — a neutral glyph with the file's host; the remote original is never loaded.
 */
function LogoThumbnail({ logo }: Readonly<{ logo: LogoCandidate }>) {
  const { t } = useTranslation('settings')
  const [failed, setFailed] = useState(false)
  // The server's copy is a presigned S3 URL: shown as a data: URL so the CSP's img-src allows it.
  const inline = useInlineImage(logo.preview_url)
  const src = failed ? undefined : inline
  return (
    <div className="w-14 h-14 rounded-md border border-border bg-bg-elevated flex items-center justify-center overflow-hidden flex-shrink-0" title={urlHost(logo.source_url)}>
      {src === undefined ? (
        <Image size={18} className="text-muted" role="img" aria-label={t('designSystem.preview.logoCandidate')} />
      ) : (
        <img
          src={src}
          alt={t('designSystem.preview.logoCandidate')}
          referrerPolicy="no-referrer"
          className="max-w-full max-h-full object-contain"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  )
}

function PreviewButtons({ hasLogo, actions }: Readonly<{ hasLogo: boolean; actions: PreviewActions }>) {
  const { t } = useTranslation('settings')
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={actions.onApply} disabled={actions.applying} className="btn btn-primary btn-sm flex items-center gap-1.5">
          {actions.applying ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />} {t('designSystem.preview.apply')}
        </button>
        {hasLogo ? (
          <button type="button" onClick={actions.onAdoptLogo} disabled={actions.adoptingLogo} className="btn btn-ghost btn-sm flex items-center gap-1.5">
            {actions.adoptingLogo ? <Loader2 size={14} className="animate-spin" /> : <Image size={14} />} {t('designSystem.preview.useLogo')}
          </button>
        ) : null}
      </div>
      {actions.applyError ? <p role="alert" className="text-xs text-danger">{actions.applyError}</p> : null}
      {actions.logoError ? <p role="alert" className="text-xs text-danger">{actions.logoError}</p> : null}
    </div>
  )
}
