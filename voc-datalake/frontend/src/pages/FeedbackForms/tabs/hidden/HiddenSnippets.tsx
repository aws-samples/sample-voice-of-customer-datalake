/**
 * @fileoverview "Use them" on the Hidden fields tab (UX §6): the link, the script embed, the in-app SDK call and the
 * mobile WebView link, each with every hidden field as a `{PLACEHOLDER}` and the form's language, in the shared code
 * view. Live | Test swaps in the test link (D2), and says what that means; a new form has no links until saved.
 *
 * @module pages/FeedbackForms/tabs/hidden/HiddenSnippets
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FlaskConical, Save } from 'lucide-react'
import CodeView from '../../../../components/Document/text/CodeView'
import { useConfigStore } from '../../../../store/configStore'
import Segmented from '../../ui/Segmented'
import { useDraft } from '../../builder/formDraftContext'
import { useBuilderUi } from '../../builder/builderUi'
import { formLink, initSnippet } from '../snippets'
import type { SnippetInput } from '../snippets'
import InfoNote from './InfoNote'
import { useTestToken } from '../testToken'

const KINDS = ['link', 'script', 'sdk', 'webview'] as const
type SnippetKind = (typeof KINDS)[number]
type Mode = 'live' | 'test'

function snippetText(kind: SnippetKind, input: SnippetInput): string | null {
  return kind === 'script' || kind === 'sdk' ? initSnippet(input) : formLink(input, true)
}

function TestNotice({ ready }: Readonly<{ ready: boolean }>) {
  const { t } = useTranslation('feedbackForms')
  const { go } = useBuilderUi()
  return ready
    ? <InfoNote icon={FlaskConical}>{t('hidden.testShown')}</InfoNote>
    : <InfoNote icon={FlaskConical} action={{ label: t('hidden.openTest'), onClick: () => go('test') }}>{t('hidden.testOff')}</InfoNote>
}

const NOTES: Readonly<Partial<Record<SnippetKind, string>>> = { link: 'replace', sdk: 'sdk', webview: 'webview' }

function SnippetNotes({ kind }: Readonly<{ kind: SnippetKind }>) {
  const { t } = useTranslation('feedbackForms')
  const note = NOTES[kind]
  return (
    <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted">
      {note !== undefined && <li>{t(`hidden.notes.${note}`)}</li>}
      <li>{t('hidden.notes.ids')}</li>
    </ul>
  )
}

/** The snippet of `kind` (null: none to show: the test link is off, or the endpoint can't address the form). */
function SnippetBody({ kind, input, testShown, testReady }: Readonly<{ kind: SnippetKind; input: SnippetInput; testShown: boolean; testReady: boolean }>) {
  const { t } = useTranslation('feedbackForms')
  if (testShown && !testReady) return <TestNotice ready={false} />
  const text = snippetText(kind, input)
  return (
    <>
      {testShown && <TestNotice ready />}
      {text === null
        ? <p className="text-[13px] text-muted">{t('hidden.noEndpoint')}</p>
        : <CodeView text={text} label={t('hidden.codeLabel', { kind: t(`hidden.kinds.${kind}`) })} />}
    </>
  )
}

export default function HiddenSnippets() {
  const { t } = useTranslation('feedbackForms')
  const { config } = useConfigStore()
  const draft = useDraft()
  const { formId } = useBuilderUi()
  const [kind, setKind] = useState<SnippetKind>('link')
  const [mode, setMode] = useState<Mode>('live')
  const { form } = draft
  const token = useTestToken() ?? ''
  const testReady = form.settings.test.link_enabled && token !== ''
  if (formId === null) {
    return (
      <InfoNote icon={Save} action={{ label: t('hidden.save'), onClick: () => { void draft.save() } }}>{t('hidden.saveFirst')}</InfoNote>
    )
  }
  const input: SnippetInput = {
    apiEndpoint: config.apiEndpoint, formId, formName: form.name, language: form.language, hidden: form.hidden_fields,
    testToken: mode === 'test' && testReady ? token : null,
  }
  return (
    <section aria-labelledby="hidden-use-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="hidden-use-heading" className="text-sm font-semibold tracking-tight text-text-strong">{t('hidden.useThem')}</h3>
        <div className="flex flex-wrap gap-2">
          <Segmented label={t('hidden.kindLabel')} value={kind} onChange={setKind}
            choices={KINDS.map((value) => ({ value, label: t(`hidden.kinds.${value}`) }))} />
          <Segmented label={t('hidden.modeLabel')} value={mode} onChange={setMode}
            choices={[{ value: 'live', label: t('hidden.modes.live') }, { value: 'test', label: t('hidden.modes.test') }]} />
        </div>
      </div>
      <SnippetBody kind={kind} input={input} testShown={mode === 'test'} testReady={testReady} />
      <SnippetNotes kind={kind} />
    </section>
  )
}
