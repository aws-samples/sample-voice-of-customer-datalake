/**
 * The Registry's and the knowledge flows' answers as the screens read them (7.52.00): an answer with no list where the
 * list should be is an error, never "none"; a bad entry costs itself; a card, a brief, a source, a preview and a
 * publish are read strictly; a role's card names no version, a made card its own.
 */
import { describe, it, expect } from 'vitest'
import { parseCardDetail, parseGates, parseRegistry, parseSavedModel, parseTemplateSource } from './engineeringRegistryApi'
import { parseKnowledge, parseKnowledgeVersion, parsePreview, parsePublished, parseTenets, isPublishRefusal } from './engineeringKnowledgeApi'

describe('the Registry\'s answers', () => {
  it('refuse an answer with no list, and drop a bad card', () => {
    expect(() => parseRegistry({})).toThrow('The Registry answer was unreadable')
    expect(parseRegistry({ cards: [{ kind: 'role', id: 'fixer', skill: {} }, { kind: 'wizard', id: 'x', skill: {} }]})
      .map((card) => [card.id, card.version, card.skill.source])).toStrictEqual([['fixer', null, 'store']])
  })

  it('read a card\'s page strictly, its versions kept', () => {
    expect(() => parseCardDetail({ versions: [] })).toThrow('The Registry card answer was unreadable')
    const made = { kind: 'card', id: 'fixer-careful', version: 2, skill: { version: 3 } }
    expect(parseCardDetail({ card: made, versions: [made], events: [{ version: 2, event: 'created', by: 'a', at: 't' }] }).versions
      .map((version) => [version.id, version.version])).toStrictEqual([['fixer-careful', 2]])
  })

  it('read a card\'s model choice, its harness and the enabled models (7.58.00), each missing one as none', () => {
    const role = { kind: 'role', id: 'builder', skill: {}, model_choice: 'claude-opus-5.5', runs_on: 'kiro',
      model_choice_updated_by: 'admin', model_choice_updated_at: '2026-11-19T09:00:00Z' }
    const detail = parseCardDetail({ card: role, versions: [], bedrock_enabled: ['global.anthropic.claude-opus-5-5', 7] })
    expect([detail.card.model_choice, detail.card.runs_on, detail.card.model_choice_updated_by, detail.card.template_model_choice,
      detail.bedrockEnabled]).toStrictEqual(['claude-opus-5.5', 'kiro', 'admin', null, []])
    const [sparse] = parseRegistry({ cards: [{ kind: 'role', id: 'fixer', skill: {}, runs_on: 'elsewhere' }] })
    expect([sparse?.model_choice, sparse?.runs_on, parseCardDetail({ card: role }).bedrockEnabled]).toStrictEqual([null, 'native', []])
    expect(parseSavedModel({ role: 'builder', model_choice: null, updated_at: 't', updated_by: 'a' }).model_choice).toBeNull()
    expect(() => parseSavedModel({ model_choice: 'opus' })).toThrow('The answer to saving the model was unreadable')
  })

  it('read the quality gates with their packs, and a template\'s source only with its text', () => {
    expect(() => parseGates({ briefs: [] })).toThrow('The quality gates answer was unreadable')
    expect(parseGates({ packs: [{ id: 'python', steps: [{ id: 'py.ruff' }] }] }).packs[0]?.steps[0]?.looked_at_nothing).toBeNull()
    expect(() => parseTemplateSource({ kind: 'skill', id: 'fixer', path: 'p' })).toThrow('The template source answer was unreadable')
  })
})

describe('the knowledge flows\' answers', () => {
  it('refuse an overview with no list, and read each package\'s versions', () => {
    expect(() => parseKnowledge({})).toThrow('The knowledge answer was unreadable')
    expect(parseKnowledge({ packages: [{ package: '.', segment: '=2E', approved_version: null, versions: [{ version: 1 }] }], rendering: null })
      .packages[0]?.versions.map((version) => version.version)).toStrictEqual([1])
    expect(() => parseKnowledgeVersion({ documents: {} })).toThrow('The knowledge version answer was unreadable')
  })

  it('read the tenets\' counter strictly, a version\'s record leniently', () => {
    expect(() => parseTenets({ versions: [] })).toThrow('The tenets answer was unreadable')
    expect(parseTenets({ head: { versions: 0 }, versions: [{ version: 1, record: 'x' }] }).versions[0]?.record)
      .toStrictEqual({ summary: '', tenets: [] })
  })

  it('read a preview and a publish strictly, and know the publish\'s refusals', () => {
    expect(() => parsePreview({ kind: 'knowledge', files: [] })).toThrow('The docs preview answer was unreadable')
    expect(parsePublished({ pr: { url: 'u', number: 4, branch: 'b' }, kind: 'tenets', version: 1, digest: 'd' }).draft).toBe(false)
    expect(['human_driven', 'already_published', 'digest_mismatch', 'not_approved', 'refused', null].map(isPublishRefusal))
      .toStrictEqual([true, true, true, true, false, false])
  })
})
