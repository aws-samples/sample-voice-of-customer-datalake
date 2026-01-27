/**
 * Menu configuration module with proper typing.
 * Wraps the JSON config with runtime validation.
 */
import { z } from 'zod'
import rawMenuConfig from './menu-config.json'

const MenuConfigSchema = z.record(z.string(), z.boolean())

type MenuConfig = z.infer<typeof MenuConfigSchema>

function parseMenuConfig(): MenuConfig {
  const result = MenuConfigSchema.safeParse(rawMenuConfig)
  if (!result.success) {
    console.warn('Invalid menu config, using empty config')
    return {}
  }
  return result.data
}

const menuConfig = parseMenuConfig()

export function isMenuItemEnabled(menuKey: string): boolean {
  return menuConfig[menuKey] ?? true
}
