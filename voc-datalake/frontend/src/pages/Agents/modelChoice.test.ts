/**
 * @fileoverview The model choice (7.58.00): the named choices and what each runs on Kiro and on the native harness,
 * Kiro's name for a Claude Bedrock id, a typed id's shape, the form's state both ways, what keeps an other id from being saved, and the short names the
 * run page and the canvas read for Bedrock's and Kiro's ids.
 */
import { describe, it, expect } from 'vitest'
import { modelShortName } from '../../components/WorkflowEditor/nodes/nodeText'
import {
  BEDROCK_MODELS, KIRO_MODELS, NAMED_MODEL_CHOICES, draftOf, isModelId, kiroName, modelChoiceOf, modelIssue, modelOn,
} from './modelChoice'
import type { ModelDraft } from './modelChoice'

const DEFAULT = 'global.anthropic.claude-sonnet-5-5'

describe('modelChoice', () => {
  it('names Auto and the three 5.5 models, as the backend maps them', () => {
    expect(NAMED_MODEL_CHOICES).toStrictEqual(['auto', 'opus', 'sonnet', 'haiku'])
    expect(KIRO_MODELS).toStrictEqual({ auto: 'auto', opus: 'claude-opus-5.5', sonnet: 'claude-sonnet-5.5', haiku: 'claude-haiku-5.5' })
    expect(BEDROCK_MODELS).toStrictEqual({ opus: 'global.anthropic.claude-opus-5-5', sonnet: DEFAULT,
      haiku: 'global.anthropic.claude-haiku-5-5' })
  })

  it.each([
    ['auto', 'kiro', 'auto'], ['auto', 'native', DEFAULT], ['opus', 'kiro', 'claude-opus-5.5'],
    ['haiku', 'native', 'global.anthropic.claude-haiku-5-5'], ['claude-sonnet-5.5', 'kiro', 'claude-sonnet-5.5'],
    ['global.anthropic.claude-opus-5-5', 'native', 'global.anthropic.claude-opus-5-5'], [null, 'kiro', 'claude-sonnet-5.5'],
    ['', 'native', DEFAULT], ['global.anthropic.claude-opus-5', 'kiro', 'claude-opus-5'], ['my-model', 'kiro', 'my-model'],
  ] as const)('runs %s on the %s harness as %s', (choice, harness, model) => {
    expect(modelOn(choice, harness, DEFAULT)).toBe(model)
  })

  it('names a Claude Bedrock id by Kiro\'s name, as the backend does, and any other id as it is', () => {
    const ids = [DEFAULT, 'global.anthropic.claude-haiku-4-5-20251001-v1:0', 'anthropic.claude-opus-5', 'us.anthropic.claude-sonnet-5-5',
      'openai.gpt-5.6-luna', 'claude-sonnet-5.5']
    expect(ids.map(kiroName)).toStrictEqual(['claude-sonnet-5.5', 'claude-haiku-4.5', 'claude-opus-5', 'claude-sonnet-5.5',
      'openai.gpt-5.6-luna', 'claude-sonnet-5.5'])
  })

  it('takes a model id of its shape and refuses spaces, a URL, a leading mark and anything past 128 characters', () => {
    const good = ['claude-sonnet-5.5', 'global.anthropic.claude-opus-5-5', 'arn:aws:bedrock:us-east-1:1:inference-profile/x', 'a',
      'a'.repeat(128)]
    const bad = ['', ' claude', 'claude sonnet', 'https://example.com/m', '-claude', '.x', 'a'.repeat(129), 'model?x=1']
    expect(good.filter((id) => !isModelId(id))).toStrictEqual([])
    expect(bad.filter((id) => isModelId(id))).toStrictEqual([])
  })

  it('reads a stored choice into the form and back, an other id trimmed', () => {
    expect([draftOf(null), draftOf('sonnet'), draftOf('claude-sonnet-5.5')]).toStrictEqual([
      { pick: '', other: '' }, { pick: 'sonnet', other: '' }, { pick: 'other', other: 'claude-sonnet-5.5' }])
    const drafts: ModelDraft[] = [{ pick: '', other: 'x' }, { pick: 'haiku', other: '' }, { pick: 'other', other: '  my-model  ' }]
    expect(drafts.map(modelChoiceOf)).toStrictEqual([null, 'haiku', 'my-model'])
  })

  it('says why an other id cannot be saved: none, off its shape, or (native) not enabled here', () => {
    const enabled = [DEFAULT]
    const issues = [
      modelIssue({ pick: 'opus', other: '' }, enabled), modelIssue({ pick: 'other', other: '   ' }),
      modelIssue({ pick: 'other', other: 'two words' }), modelIssue({ pick: 'other', other: 'global.anthropic.claude-opus-5' }, enabled),
      modelIssue({ pick: 'other', other: DEFAULT }, enabled), modelIssue({ pick: 'other', other: 'claude-sonnet-5.5' }),
    ]
    expect(issues).toStrictEqual([null, 'empty', 'format', 'notEnabled', null, null])
  })

  it('gives Bedrock\'s and Kiro\'s ids the same short name, and Kiro\'s auto its own', () => {
    const ids = [DEFAULT, 'claude-sonnet-5.5', 'claude-opus-5.5', 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      'global.anthropic.claude-opus-5', 'auto', 'arn:aws:bedrock:us-east-1:1:inference-profile/custom']
    expect(ids.map(modelShortName)).toStrictEqual(['Sonnet 5.5', 'Sonnet 5.5', 'Opus 5.5', 'Haiku 4.5', 'Opus 5', 'Auto', 'custom'])
  })
})
