/**
 * @fileoverview The one place a feedback source becomes an icon.
 *
 * Feedback items carry a `source_platform` (and sometimes a `source_channel`);
 * plugin manifests carry a plain `icon` word. Both resolve to a lucide glyph
 * here (the same icon set as the navigation), so no source is ever shown as an
 * emoji, and a new source needs one line in one map.
 *
 * @module components/SourceIcon/sourceIcons
 */
import {
  CircleDot, FlaskConical, Globe, MessageSquare, MessageSquareText, Package, PenLine, Plug, Smartphone,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/** Feedback `source_platform` / `source_channel` values → icon. */
const PLATFORM_ICONS: Readonly<Record<string, LucideIcon>> = {
  webscraper: Globe,
  web_scrape: Globe,
  web_scrape_jsonld: Globe,
  manual_import: PenLine,
  s3_import: Package,
  // An issue tracker: lucide's brand logos are deprecated, so the "issue" glyph.
  github_issues: CircleDot,
  app_reviews_ios: Smartphone,
  app_reviews_android: Smartphone,
  synthetic_reviews: FlaskConical,
  feedback_form: MessageSquareText,
  prototype_feedback: MessageSquareText,
}

/** Plugin manifest `icon` words (plugins/<id>/manifest.json) → icon. */
const MANIFEST_ICONS: Readonly<Record<string, LucideIcon>> = {
  Web: Globe,
  iOS: Smartphone,
  Android: Smartphone,
  GitHub: CircleDot,
  Package,
  Synthetic: FlaskConical,
  Plugin: Plug,
}

/** `Object.hasOwn`, so an inherited name such as `constructor` never answers. */
function lookup(map: Readonly<Record<string, LucideIcon>>, key: string | undefined): LucideIcon | undefined {
  return key !== undefined && Object.hasOwn(map, key) ? map[key] : undefined
}

/** The icon for a feedback item's source; scrapers named `scraper_*` are web sources. */
export function sourceIcon(platform: string, channel?: string): LucideIcon {
  if (platform.startsWith('scraper_')) return Globe
  return lookup(PLATFORM_ICONS, platform) ?? lookup(PLATFORM_ICONS, channel) ?? MessageSquare
}

/** The icon for a plugin manifest; an unknown word falls back by category. */
export function manifestIcon(icon: string, category?: string): LucideIcon {
  return lookup(MANIFEST_ICONS, icon) ?? (category === 'import' ? Package : Plug)
}
