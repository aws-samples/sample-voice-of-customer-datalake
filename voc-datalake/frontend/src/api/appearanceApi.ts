/**
 * @fileoverview The workspace's start theme (`GET|PUT /settings/appearance`,
 * lambda/shared/appearance_routes.py).
 *
 * Every signed-in user reads it; only an admin saves it (the server answers 403
 * otherwise, and 400 for an id it does not ship). A person's own pick stays in
 * this browser (theme/themeStore.ts); this is what `workspace` resolves to.
 *
 * @module api/appearanceApi
 */
import { z } from 'zod'
import { put } from './requestKit'
import { fetchApi } from './client'
import { COLOR_THEME_IDS, DEFAULT_COLOR_THEME } from '../theme/themeCatalog'
import type { ColorThemeId } from '../theme/themeCatalog'

const PATH = '/settings/appearance'

export interface AppearanceSettings {
  readonly default_theme: ColorThemeId
}

/** Lenient: an id this build does not ship (a newer server, a bad row) reads as the default. */
const AppearanceSchema = z.object({
  default_theme: z.enum(COLOR_THEME_IDS).catch(DEFAULT_COLOR_THEME),
}).catch({ default_theme: DEFAULT_COLOR_THEME })

/** A PUT answer's `settings.default_theme`, read strictly (no default). */
const SavedSchema = z.looseObject({ settings: z.looseObject({ default_theme: z.enum(COLOR_THEME_IDS) }) })

/** A GET answer: lenient, so an unknown or missing id reads as the default. */
export function readAppearance(raw: unknown): AppearanceSettings {
  return AppearanceSchema.parse(raw)
}

/** The appearance query: `settings` is a `config`-family root (api/queryPolicies.ts). */
export const appearanceKey = () => ['settings', 'appearance'] as const

export const appearanceApi = {
  get: async (): Promise<AppearanceSettings> => readAppearance(await fetchApi<unknown>(PATH)),
  /**
   * The server answered 2xx, so it stored `theme`: an answer that does not echo a known id
   * keeps the requested one, never the default (that would claim the workspace is on Kiro).
   */
  save: async (theme: ColorThemeId): Promise<AppearanceSettings> => {
    const saved = SavedSchema.safeParse(await fetchApi<unknown>(PATH, put({ default_theme: theme })))
    return { default_theme: saved.success ? saved.data.settings.default_theme : theme }
  },
}
