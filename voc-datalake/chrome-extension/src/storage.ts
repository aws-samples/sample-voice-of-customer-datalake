import type { ExtensionConfig, AuthTokens } from './types'

const CONFIG_KEY = 'voc_config'
const TOKENS_KEY = 'voc_tokens'

/** Get extension config from chrome.storage.local */
export async function getConfig(): Promise<ExtensionConfig | null> {
  const result = await chrome.storage.local.get(CONFIG_KEY)
  const config: unknown = result[CONFIG_KEY]
  if (
    config !== null &&
    config !== undefined &&
    typeof config === 'object' &&
    'apiEndpoint' in config &&
    typeof (config as Record<string, unknown>).apiEndpoint === 'string'
  ) {
    return config as ExtensionConfig
  }
  return null
}

/** Save extension config to chrome.storage.local */
export async function saveConfig(config: ExtensionConfig): Promise<void> {
  await chrome.storage.local.set({ [CONFIG_KEY]: config })
}

/** Get auth tokens from chrome.storage.session */
export async function getTokens(): Promise<AuthTokens | null> {
  const result = await chrome.storage.session.get(TOKENS_KEY)
  const tokens: unknown = result[TOKENS_KEY]
  if (
    tokens !== null &&
    tokens !== undefined &&
    typeof tokens === 'object' &&
    'idToken' in tokens &&
    typeof (tokens as Record<string, unknown>).idToken === 'string'
  ) {
    return tokens as AuthTokens
  }
  return null
}

/** Save auth tokens to chrome.storage.session */
export async function saveTokens(tokens: AuthTokens): Promise<void> {
  await chrome.storage.session.set({ [TOKENS_KEY]: tokens })
}

/** Clear auth tokens */
export async function clearTokens(): Promise<void> {
  await chrome.storage.session.remove(TOKENS_KEY)
}
