/**
 * api/boardFields.ts against `lambda/shared/feature_board_fields.py`, read as TEXT: every constant
 * above its `# ── Validation` marker is one `NAME: Final = <literal>` (strings, numbers, booleans,
 * tuples and dicts), parsed here into JSON. A field, limit, choice, template, status or total added
 * on one side only fails this suite.
 *
 * The Python module is the backend track's; on a branch without it the Python half is skipped and
 * the contract half (the brief's templates) still runs.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  BOARD_TEMPLATES, DESCRIPTION_REQUIRED_TEMPLATES, FIELD_KEYS, FIELD_LEVELS, FIELD_SPECS, LEVEL_FIELD_KEYS, MAX_LINK_CHARS, MAX_STATUSES, MAX_STATUS_LABEL,
  STATUS_KEY, TEMPLATE_DEFAULTS, isDescriptionRequired, isEnabled, isRequired,
} from './boardFields'
import type { FieldSpec, LevelFields } from './boardFields'

const PYTHON = join(__dirname, '../../../lambda/shared/feature_board_fields.py')

/** A string, a comment, a bracket, or a run of anything else (the module's literals hold no escapes). */
const TOKEN = /'[^']*'|"[^"]*"|#[^\n]*|[()]|[^'"#()]+/g

function tokenToJson(token: string): string {
  if (token.startsWith("'") || token.startsWith('"')) return JSON.stringify(token.slice(1, -1))
  if (token.startsWith('#')) return ''
  if (token === '(') return '['
  return token === ')' ? ']' : token
}

/** One Python literal (the subset the module promises) as JSON text. */
function pythonLiteralToJson(literal: string): string {
  return (literal.match(TOKEN) ?? []).map(tokenToJson).join('')
    .replaceAll(/\bTrue\b/g, 'true').replaceAll(/\bFalse\b/g, 'false').replaceAll(/\bNone\b/g, 'null')
    .replaceAll(/,(\s*[\]}])/g, '$1')
}

/** `NAME: Final = <literal>` constants above the validation marker, by name. */
function pythonConstants(source: string): Record<string, unknown> {
  // The marker as a line of its own (the module docstring names it too).
  const head = source.split('\n# ── Validation')[0] ?? ''
  const starts = [...head.matchAll(/^([A-Z_]+): Final = /gm)]
  return Object.fromEntries(starts.map((match, index) => {
    const from = match.index + match[0].length
    const to = starts[index + 1]?.index ?? head.length
    const literal = head.slice(from, to).trim()
    const value: unknown = JSON.parse(pythonLiteralToJson(literal))
    return [match[1] ?? '', value]
  }))
}

const specsOfType = (types: readonly FieldSpec['type'][]) =>
  FIELD_KEYS.filter((key) => types.some((type) => type === FIELD_SPECS[key].type))

/** A level's switches as the Python templates list them: enabled fields only. */
function enabledSwitches(fields: LevelFields, level: (typeof FIELD_LEVELS)[number]) {
  return Object.fromEntries(LEVEL_FIELD_KEYS[level].filter((key) => isEnabled(fields, key))
    .map((key) => [key, { enabled: true, required: isRequired(fields, key) }]))
}

const switchesSchema = z.record(z.string(), z.object({ enabled: z.boolean(), required: z.boolean() })).catch({})

/** The enabled entries of a Python level. */
function enabledOf(raw: unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(switchesSchema.parse(raw)).filter(([, flags]) => flags.enabled))
}

describe.skipIf(!existsSync(PYTHON))('boardFields.ts mirrors shared/feature_board_fields.py', () => {
  const py = existsSync(PYTHON) ? pythonConstants(readFileSync(PYTHON, 'utf8')) : {}
  const record = (name: string): Record<string, unknown> => {
    const value = py[name]
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
  }

  it('reads the Python constants (anti-vacuous)', () => {
    expect(Object.keys(py)).toStrictEqual(expect.arrayContaining(['TEMPLATES', 'REQUEST_FIELD_KEYS', 'TEMPLATE_FIELDS', 'TEMPLATE_STATUSES', 'TEMPLATE_TOTALS']))
  })

  it('has the same templates, levels and catalogues', () => {
    expect(py['TEMPLATES']).toStrictEqual([...BOARD_TEMPLATES])
    expect(py['LEVELS']).toStrictEqual([...FIELD_LEVELS])
    expect(py['REQUEST_FIELD_KEYS']).toStrictEqual([...LEVEL_FIELD_KEYS.request])
    expect(py['SUPPORT_FIELD_KEYS']).toStrictEqual([...LEVEL_FIELD_KEYS.support])
  })

  it('requires a description on the same templates', () => {
    expect(py['DESCRIPTION_REQUIRED_TEMPLATES']).toStrictEqual([...DESCRIPTION_REQUIRED_TEMPLATES])
  })

  it('limits text the same way', () => {
    const textLimits = Object.fromEntries(specsOfType(['text', 'longtext']).map((key) => {
      const spec: FieldSpec = FIELD_SPECS[key]
      return [key, 'max' in spec ? spec.max : 0]
    }))
    expect(record('TEXT_FIELD_LIMITS')).toStrictEqual(textLimits)
  })

  it('offers the same choices and number ranges', () => {
    expect(record('CHOICE_FIELD_OPTIONS')).toStrictEqual(Object.fromEntries(specsOfType(['choice']).map((key) => {
      const spec: FieldSpec = FIELD_SPECS[key]
      return [key, spec.type === 'choice' ? [...spec.choices] : []]
    })))
    expect(record('NUMBER_FIELD_RANGES')).toStrictEqual(Object.fromEntries(specsOfType(['int']).map((key) => {
      const spec: FieldSpec = FIELD_SPECS[key]
      return [key, spec.type === 'int' ? [spec.min, spec.max] : []]
    })))
  })

  it('checks emails and links the same way', () => {
    expect(py['EMAIL_FIELDS']).toStrictEqual(specsOfType(['email']))
    expect(py['URL_FIELDS']).toStrictEqual(specsOfType(['url']))
    expect(py['MAX_LINK_CHARS']).toBe(MAX_LINK_CHARS)
  })

  it('bounds statuses the same way', () => {
    expect(py['MAX_STATUSES']).toBe(MAX_STATUSES)
    expect(py['MAX_STATUS_LABEL']).toBe(MAX_STATUS_LABEL)
    expect(py['STATUS_KEY_PATTERN']).toBe(STATUS_KEY.source)
  })

  it.each(BOARD_TEMPLATES.flatMap((template) => FIELD_LEVELS.map((level) => [template, level] as const)))(
    'starts a %s board with the same %s fields', (template, level) => {
      const levels = z.record(z.string(), z.unknown()).catch({}).parse(record('TEMPLATE_FIELDS')[template])
      expect(enabledOf(levels[level])).toStrictEqual(enabledSwitches(TEMPLATE_DEFAULTS[template].fields[level], level))
    })

  it.each(BOARD_TEMPLATES)('starts a %s board with the same statuses and totals', (template) => {
    expect(record('TEMPLATE_STATUSES')[template]).toStrictEqual(TEMPLATE_DEFAULTS[template].statuses)
    expect(record('TEMPLATE_TOTALS')[template]).toStrictEqual(TEMPLATE_DEFAULTS[template].totals)
  })
})

/** The brief's contract (2026-10-26), which holds with or without the Python module on the branch. */
describe('the template contract', () => {
  it.each([
    ['sales', ['customer', 'impact'], ['new', 'under_review', 'planned', 'shipped', 'declined']],
    ['service', ['kind', 'severity'], ['new', 'confirmed', 'fixed', 'wont_fix']],
    ['beta', ['area', 'outcome'], ['new', 'seen', 'fixed']],
    ['blank', [], ['new', 'done']],
  ] as const)('%s: required request fields and statuses', (template, required, statuses) => {
    const { fields, statuses: defaults } = TEMPLATE_DEFAULTS[template]
    expect(LEVEL_FIELD_KEYS.request.filter((key) => isRequired(fields.request, key))).toStrictEqual([...required])
    expect(defaults.map((status) => status.key)).toStrictEqual([...statuses])
  })

  it('requires a description on sales and service boards only (title + description are always on)', () => {
    expect(BOARD_TEMPLATES.filter(isDescriptionRequired)).toStrictEqual(['sales', 'service'])
  })
})
