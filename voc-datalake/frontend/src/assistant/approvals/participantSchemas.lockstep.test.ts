/**
 * LOCKSTEP: the participants approval boundary (./participantSchemas) ⇄ the
 * stream Lambda's (`lambda/stream/src/assistant/tools/client/participant-schemas.ts`)
 * ⇄ what the engagement routes accept (`lambda/shared/participants_intake.py`,
 * `participants_store.py`, `participants_lists.py`, `ops_alerts.py`). The stream
 * module is imported directly; the Python bounds are read as TEXT. A bound
 * accepted by one side only would mean a card the server proposes but the SPA
 * refuses — or rows the route rejects after the user approved them.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LIST_KINDS } from '../../api/participantsSchema'
import {
  LIST_ID_PATTERN, SPA_PARTICIPANT_LIMITS, addParticipantsArgs, createParticipantListArgs, isParticipantEmail, participantPersonArgs,
} from './participantSchemas'
// Self-contained (zod only), like the review-import lockstep.
import * as stream from '../../../../lambda/stream/src/assistant/tools/client/participant-schemas'
import { optionalNonEmpty as streamOptionalNonEmpty } from '../../../../lambda/stream/src/assistant/tools/client/text-schemas'
import { optionalNonEmpty } from './schemas'

const ROOT = join(__dirname, '../../../..')
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8')
const intake = read('lambda/shared/participants_intake.py')
const store = read('lambda/shared/participants_store.py')
const lists = read('lambda/shared/participants_lists.py')
const opsAlerts = read('lambda/shared/ops_alerts.py')
const common = read('lambda/shared/engagement_common.py')

/** `NAME: Final = <int>` (or `NAME = <int>`) at the start of a line. */
function pythonInt(source: string, name: string): number {
  const captured = new RegExp(`^${name}(?:: Final)? = ([\\d_]+)`, 'm').exec(source)?.[1]
  if (captured === undefined) throw new Error(`${name} not found`)
  return Number(captured.replaceAll('_', ''))
}

/** `ops_alerts._EMAIL` itself (it is a valid JS pattern), full-matched as `re.fullmatch` does. */
const ROUTE_EMAIL_SOURCE = /^_EMAIL: Final = re\.compile\(r'([^']+)'\)$/m.exec(opsAlerts)?.[1] ?? '(?!)'
const ROUTE_EMAIL = new RegExp(`^(?:${ROUTE_EMAIL_SOURCE})$`)

const keysOf = (schema: { shape: object }) => Object.keys(schema.shape).sort((a, b) => a.localeCompare(b))
const sorted = (values: readonly string[]) => [...values].sort((a, b) => a.localeCompare(b))

describe('participants tools: stream ⇄ SPA', () => {
  it('the same limits, kinds, list id rule and argument shapes', () => {
    expect({ ...stream.PARTICIPANT_LIMITS }).toStrictEqual({ ...SPA_PARTICIPANT_LIMITS })
    expect([...stream.PARTICIPANT_LIST_KINDS]).toStrictEqual([...LIST_KINDS])
    expect(stream.LIST_ID_PATTERN.source).toBe(LIST_ID_PATTERN.source)
    expect([keysOf(addParticipantsArgs), keysOf(participantPersonArgs), keysOf(createParticipantListArgs)]).toStrictEqual([
      keysOf(stream.addParticipantsArgsSchema), keysOf(stream.addParticipantsArgsSchema.shape.people.element),
      keysOf(stream.createParticipantListArgsSchema),
    ])
  })

  it.each([
    'ana@example.com', 'Ana.Lopez+beta@Example.CO.uk', 'a_b%c@acme-example.example', 'a@b.c',
    'no-at.example.com', 'a@@example.com', 'a@localhost', 'a@example..com', 'a b@example.com', '@example.com', 'a@example.com.',
    `${'x'.repeat(65)}@example.com`, `a@${'x'.repeat(64)}.com`,
  ])('both sides judge the address %j as the route\u2019s own pattern does', (value) => {
    const routeAccepts = value.length <= SPA_PARTICIPANT_LIMITS.maxEmailChars && ROUTE_EMAIL.test(value.trim().toLowerCase())
    expect([stream.isParticipantEmail(value), isParticipantEmail(value)]).toStrictEqual([routeAccepts, routeAccepts])
  })
})

describe('participants tools: SPA ⇄ the routes', () => {
  it('one card is one members request, with the person field bounds of the store', () => {
    const L = SPA_PARTICIPANT_LIMITS
    expect(L.maxPeople).toBe(pythonInt(intake, 'MAX_PEOPLE_PER_REQUEST'))
    expect(store).toContain(`TEXT_LIMITS: Final = {'name': ${String(L.maxNameChars)}, 'company': ${String(L.maxCompanyChars)}, 'title': ${String(L.maxTitleChars)}, `)
    expect([L.maxTags, L.maxTagChars]).toStrictEqual([pythonInt(store, 'MAX_TAGS'), pythonInt(store, 'MAX_TAG_CHARS')])
  })

  it('the address rule is ops_alerts.normalize_email\u2019s', () => {
    expect(SPA_PARTICIPANT_LIMITS.maxEmailChars).toBe(pythonInt(opsAlerts, 'MAX_EMAIL_LENGTH'))
    expect(opsAlerts).toContain(String.raw`_EMAIL: Final = re.compile(r'[a-z0-9._%+\-]{1,64}@[a-z0-9\-]{1,63}(?:\.[a-z0-9\-]{1,63})+')`)
  })

  it('a list is participants_lists\u2019 name, description, kinds and id', () => {
    expect(SPA_PARTICIPANT_LIMITS.maxListNameChars).toBe(pythonInt(lists, 'MAX_LIST_NAME'))
    expect(SPA_PARTICIPANT_LIMITS.maxListDescriptionChars).toBe(pythonInt(lists, 'MAX_LIST_DESCRIPTION'))
    const kinds = /^LIST_KINDS: Final = frozenset\(\{([^}]*)\}\)/m.exec(lists)?.[1] ?? ''
    expect(sorted(kinds.split(',').map((kind) => kind.trim().replaceAll("'", '')))).toStrictEqual(sorted(LIST_KINDS))
    expect(LIST_ID_PATTERN.source).toBe(`^lst_[0-9a-f]{${String(pythonInt(common, 'ID_HEX_BYTES') * 2)}}$`)
  })
})

describe('optionalNonEmpty (the text rule both boundaries build their optional fields from)', () => {
  it('accepts and refuses the same values on both sides', () => {
    const samples: unknown[] = [undefined, '', '   ', ' ok ', 'abcd', 'abcde', 7, null]
    const verdicts = (schema: { safeParse: (v: unknown) => { success: boolean } }) => samples.map((v) => schema.safeParse(v).success)
    expect(verdicts(optionalNonEmpty(4))).toStrictEqual([true, false, false, true, true, false, false, false])
    expect(verdicts(streamOptionalNonEmpty(4))).toStrictEqual(verdicts(optionalNonEmpty(4)))
  })
})
