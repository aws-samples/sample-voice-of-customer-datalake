/**
 * `account.mcpHint` (Account → Profile) must not say MCP tokens are per project
 * "for now": one global token for the whole app exists (docs/mcp.md, Connect).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** The copy before the fix, which said tokens were minted per project for now. */
const OLD_HINTS: Record<string, string> = {
  "en": "Tokens for external assistants are minted per project for now.",
  "de": "Tokens für externe Assistenten werden derzeit pro Projekt erstellt.",
  "es": "Por ahora, los tokens para asistentes externos se generan por proyecto.",
  "fr": "Les jetons pour les assistants externes sont pour l'instant créés par projet.",
  "ja": "外部アシスタント用のトークンは、現在プロジェクトごとに発行されます。",
  "ko": "외부 어시스턴트용 토큰은 현재 프로젝트별로 발급됩니다.",
  "pt": "Por enquanto, os tokens para assistentes externos são gerados por projeto.",
  "zh": "目前外部助手的令牌按项目生成。"
}

function hint(locale: string): unknown {
  const catalogue: unknown = JSON.parse(readFileSync(resolve(__dirname, `../../../public/locales/${locale}/common.json`), 'utf8'))
  if (typeof catalogue !== 'object' || catalogue === null || !('account' in catalogue)) return undefined
  const account: unknown = catalogue.account
  return typeof account === 'object' && account !== null && 'mcpHint' in account ? account.mcpHint : undefined
}

describe.each(Object.keys(OLD_HINTS))('account.mcpHint (%s)', (locale) => {
  it('no longer claims tokens are per project for now', () => {
    expect(hint(locale)).not.toBe(OLD_HINTS[locale])
    expect(typeof hint(locale)).toBe('string')
  })
})

describe('account.mcpHint (en)', () => {
  it('points at the one app-wide token on Connect', () => {
    expect(hint('en')).toMatch(/one MCP token for the whole app, minted on Connect/)
  })
})
