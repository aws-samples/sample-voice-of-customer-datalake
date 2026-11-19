/**
 * @fileoverview The fields a form keeps whatever its schema version (contract "Kept as today"): the theme, the
 * category routing, the linked project and document, the custom fields, the dimension defaults and tags, and the
 * form type. One lenient shape, read by the version 2 parser (formsV2Schema.ts) and the version 1 migration
 * (migrateV1.ts); the routing and link part by the version 1 record schema too (formSchema.ts).
 *
 * @module pages/FeedbackForms/model/keptFields
 */
import { z } from 'zod'
import { DEFAULT_THEME, THEME_FONTS, THEME_MODES, THEME_TEXT_SIZES } from './formsV2'

/** The category routing and the validation link: '' when absent. */
export const ROUTING_AND_LINK = {
  category: z.string().catch(''),
  subcategory: z.string().catch(''),
  project_id: z.string().catch(''),
  document_id: z.string().catch(''),
}

/** A stored colour: `#rgb`, `#rrggbb`, or an old form's `#rrggbbaa` (lambda/shared/form_theme.py HEX_COLOR). */
const STORED_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i
/** The dark palette is new in 7.04.00: `#rgb` or `#rrggbb` only (form_theme.py PALETTE_HEX). */
const PALETTE_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
const colour = (pattern: RegExp, fallback: string) => z.string().regex(pattern).catch(fallback)
const darkPalette = z.object({
  primary_color: colour(PALETTE_HEX, DEFAULT_THEME.dark.primary_color),
  background_color: colour(PALETTE_HEX, DEFAULT_THEME.dark.background_color),
  text_color: colour(PALETTE_HEX, DEFAULT_THEME.dark.text_color),
}).catch({ ...DEFAULT_THEME.dark })

/**
 * A form's theme as the editor holds it, every field present: one missing (a theme stored before 7.04.00 has no mode,
 * dark palette, font or size) or unusable is its default, as the server reads it (form_theme.py `with_defaults`).
 * The same for a version 2 form and a migrated version 1 one.
 */
export const themeSchema = z.object({
  primary_color: colour(STORED_HEX, DEFAULT_THEME.primary_color),
  background_color: colour(STORED_HEX, DEFAULT_THEME.background_color),
  text_color: colour(STORED_HEX, DEFAULT_THEME.text_color),
  border_radius: z.string().regex(/^\d{1,2}px$/).catch(DEFAULT_THEME.border_radius),
  mode: z.enum(THEME_MODES).catch(DEFAULT_THEME.mode),
  dark: darkPalette,
  font: z.enum(THEME_FONTS).catch(DEFAULT_THEME.font),
  text_size: z.enum(THEME_TEXT_SIZES).catch(DEFAULT_THEME.text_size),
}).catch({ ...DEFAULT_THEME })

export const KEPT_FIELDS = {
  theme: themeSchema,
  ...ROUTING_AND_LINK,
  custom_fields: z.array(z.unknown()).catch([]),
  dimension_defaults: z.record(z.string(), z.string()).catch({}),
  tags: z.array(z.string()).catch([]),
  form_type: z.enum(['standard', 'prototype_pin']).optional().catch(undefined),
}
