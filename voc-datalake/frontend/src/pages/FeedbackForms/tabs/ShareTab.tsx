/**
 * @fileoverview The Share tab (UX §9.4): the link, its QR, the iframe and script embeds and the in-app call, each
 * built from the form's own address (tabs/snippets.ts). The iframe comes with its resizer, the script embed whole
 * (the element, the widget file from this app's origin, the `init` call), each with a line on what it needs. Live |
 * Test swaps the live link for the test link in every snippet. An Off form says what its live link shows, with
 * Publish as the one action. A form with hidden fields gets a link builder (their values in every snippet, and a
 * warning for each one its texts recall that the link leaves empty) and the link checks of its responses.
 *
 * @module pages/FeedbackForms/tabs/ShareTab
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FlaskConical, PowerOff, Radio } from 'lucide-react'
import SnippetBlock from '../ui/SnippetBlock'
import Notice from '../../../components/Notice/Notice'
import { useConfigStore } from '../../../store/configStore'
import { useDraft } from '../builder/formDraftContext'
import { useBuilderUi } from '../builder/builderUi'
import { PublishFlow } from '../builder/SaveButtons'
import Segmented from '../ui/Segmented'
import { formLink, iframeSnippet, scriptEmbedSnippet, widgetScriptUrl } from './snippets'
import type { SnippetInput } from './snippets'
import { LinkField, OpenLink, SaveFirstNotice } from './linkParts'
import { useTestToken } from './testToken'
import ShareTabLinkHealth from './ShareTabLinkHealth'
import ShareTabLinkValues from './ShareTabLinkValues'

type Mode = 'live' | 'test'

function OffBanner({ mode, testOn }: Readonly<{ mode: Mode; testOn: boolean }>) {
  const { t } = useTranslation('feedbackForms')
  const { form, publishErrors: errors, status } = useDraft()
  if (form.enabled) return null
  if (mode === 'test' && testOn) {
    return <Notice variant="banner" tone="warn" role="note" icon={FlaskConical} text={t('share.testWhileOff')} />
  }
  return (
    // (Publish here asks what the header's Publish asks: an incomplete language, an AI draft)
    <PublishFlow>
      {(publish) => (
        <Notice variant="banner" tone="warn" role="note" icon={PowerOff} text={t('share.offBanner')}
          action={{ label: t('share.publish'), icon: Radio, emphasis: 'primary', busy: status.kind === 'saving',
            disabled: errors.length > 0, onClick: publish }} />
      )}
    </PublishFlow>
  )
}

/** A snippet under its heading, with the line that says what it needs. */
function EmbedSnippet({ title, text, hint }: Readonly<{ title: string; text: string; hint: string }>) {
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-medium text-text">{title}</h3>
      <SnippetBlock text={text} label={title} />
      <p className="text-[12px] text-muted">{hint}</p>
    </div>
  )
}

/** The iframe and the script embed (null together: the endpoint cannot address the form). */
function Embeds({ input, link }: Readonly<{ input: SnippetInput; link: string }>) {
  const { t } = useTranslation('feedbackForms')
  const iframe = iframeSnippet(input)
  const widgetUrl = widgetScriptUrl()
  const script = scriptEmbedSnippet(input, widgetUrl)
  if (iframe === null || script === null) return <p className="text-sm text-muted">{t('configureApiFirst')}</p>
  return (
    <>
      <EmbedSnippet title={t('share.iframe')} text={iframe} hint={t('share.iframeHint')} />
      <EmbedSnippet title={t('share.script')} text={script}
        hint={t('share.scriptHint', { app: new URL(widgetUrl).origin, api: new URL(link).origin })} />
    </>
  )
}

function Snippets({ input, live, onValues }: Readonly<{ input: SnippetInput; live: boolean; onValues: (next: Readonly<Record<string, string>>) => void }>) {
  const { t } = useTranslation('feedbackForms')
  const { go } = useBuilderUi()
  const { form } = useDraft()
  const link = formLink(input, false)
  return (
    <div className="space-y-5">
      <LinkField label={t('share.link')} url={link} qrTitle={live ? t('share.qrTitle') : t('test.qrTitle')} formName={input.formName}
        hint={live ? t('share.liveHint') : undefined}>
        <OpenLink url={link} />
      </LinkField>
      <ShareTabLinkValues form={form} values={input.values ?? {}} onChange={onValues} />
      <p className="text-[12px] text-muted">
        {t('share.withHidden')}{' '}
        <button type="button" className="link" onClick={() => go('hidden-fields')}>{t('share.toHidden')}</button>
      </p>
      {link === null ? <p className="text-sm text-muted">{t('configureApiFirst')}</p> : <Embeds input={input} link={link} />}
      <p className="text-sm text-text"><span className="font-medium">{t('share.inApp')}</span> {t('share.inAppHint')}</p>
    </div>
  )
}

/** Test selected while the test link is off: where to turn it on. */
function TestOffNote() {
  const { t } = useTranslation('feedbackForms')
  const { go } = useBuilderUi()
  return (
    <p className="text-sm text-text">
      {t('share.testOff')}{' '}
      <button type="button" className="link" onClick={() => go('test')}>{t('share.openTest')}</button>
    </p>
  )
}

export default function ShareTab() {
  const { t } = useTranslation('feedbackForms')
  const { form } = useDraft()
  const { formId } = useBuilderUi()
  const apiEndpoint = useConfigStore((state) => state.config.apiEndpoint)
  const token = useTestToken()
  const [mode, setMode] = useState<Mode>('live')
  const [values, setValues] = useState<Readonly<Record<string, string>>>({})
  const testOn = form.settings.test.link_enabled
  const base: SnippetInput | null = formId === null ? null
    : { apiEndpoint, formId, formName: form.name, language: form.language, hidden: form.hidden_fields, testToken: null, values }
  const testReady = testOn && token !== null
  return (
    <section className="card space-y-4" aria-labelledby="share-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="share-heading" className="text-base font-semibold tracking-tight text-text-strong">{t('share.title')}</h2>
        <Segmented label={t('share.mode')} value={mode} onChange={setMode}
          choices={[{ value: 'live', label: t('share.live') }, { value: 'test', label: t('share.test'), icon: FlaskConical }]} />
      </div>
      {base === null ? <SaveFirstNotice /> : (
        <>
          <OffBanner mode={mode} testOn={testOn} />
          <ShareTabLinkHealth formId={base.formId} />
          {mode === 'test' && !testReady && <TestOffNote />}
          {mode === 'test' && testReady && <p role="note" className="flex items-center gap-2 text-sm text-text"><FlaskConical size={14} className="text-info" aria-hidden="true" />{t('share.testNotice')}</p>}
          {(mode === 'live' || testReady) && <Snippets input={mode === 'live' ? base : { ...base, testToken: token }} live={mode === 'live'} onValues={setValues} />}
        </>
      )}
    </section>
  )
}
