/**
 * @fileoverview The workspace's form brand (the theme editor's "Your brand" preset, the theme a new form starts on):
 * `form_theme` on the `/settings/brand` row (api/brandApi.ts), read through the brand's one shared query
 * (hooks/useBrandSettings.ts, so the shell's read serves it), saved by the workspace's admins only (the server's
 * `require_settings_admin`; outside a workspace, the deployment's admins: Settings/useBrandEditRight.ts).
 *
 * @module pages/FeedbackForms/theme/useFormBrand
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { formBrandApi, readFormBrand } from '../../../api/brandApi'
import { brandSettingsKey, useBrandSettings } from '../../../hooks/useBrandSettings'
import { useConfigStore } from '../../../store/configStore'
import { useIsAdmin } from '../../../store/authStore'
import { useBrandEditRight } from '../../Settings/useBrandEditRight'
import type { FormTheme, FormV2 } from '../model/formsV2'

export interface FormBrand {
  /** The saved form brand; null while none is saved (or while it loads). */
  readonly brand: FormTheme | null
  /** May this person save it (the workspace's admins)? */
  readonly canSave: boolean
  readonly save: (theme: FormTheme) => Promise<unknown>
  readonly saving: boolean
  /** The last save: whether the server took it, or refused it. */
  readonly saved: boolean
  readonly failed: boolean
}

/** The saved form brand only (no save): what a new form starts on. Null while none is saved, or while it loads. */
export function useSavedFormBrand(): FormTheme | null {
  const apiEndpoint = useConfigStore((state) => state.config.apiEndpoint)
  return readFormBrand(useBrandSettings(apiEndpoint).data)
}

export function useFormBrand(): FormBrand {
  const brand = useSavedFormBrand()
  const canSave = useBrandEditRight(useIsAdmin())
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (theme: FormTheme) => formBrandApi.save(theme),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: brandSettingsKey() }),
  })
  return {
    brand, canSave, save: mutation.mutateAsync, saving: mutation.isPending,
    saved: mutation.isSuccess, failed: mutation.isError,
  }
}

/** A new form on the workspace's brand when one is saved (templates and AI drafts carry the default theme). */
export const onBrand = (form: FormV2, brand: FormTheme | null): FormV2 => (brand === null ? form : { ...form, theme: brand })
