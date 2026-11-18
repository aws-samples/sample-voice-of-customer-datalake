/**
 * @fileoverview The Share tab (UX §9.4): the link, its QR, the iframe and script embeds and the in-app call, each
 * built from the form's own address (tabs/snippets.ts). Live | Test swaps the live link for the test link in every
 * snippet. An Off form says what its live link shows, with Publish as the one action.
 *
 * @module pages/FeedbackForms/tabs/ShareTab
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, FlaskConical, PowerOff, Radio } from 'lucide-react'
import CodeView from '../../../components/Document/text/CodeView'
import Notice from '../../../components/Notice/Notice'
import { useConfigStore } from '../../../store/configStore'
import { useDraft } from '../builder/formDraftContext'
import { useBuilderUi } from '../builder/builderUi'
import Segmented from '../ui/Segmented'
import { formLink, iframeSnippet, initSnippet } from './snippets'
import type { SnippetInput } from './snippets'
import { LinkField, SaveFirstNotice } from './linkParts'
import { useTestToken } from './testToken'

type Mode = 'live' | 'test'

function OffBanner({ mode, testOn }: Readonly<{ mode: Mode; testOn: boolean }>) {
  const { t } = useTranslation('feedbackForms')
  const { form, publish, errors, status } = useDraft()
  if (form.enabled) return null
  if (mode === 'test' && testOn) {
    return <Notice variant="banner" tone="warn" role="note" icon={FlaskConical} text={t('share.testWhileOff')} />
  }
  return (
    <Notice variant="banner" tone="warn" role="note" icon={PowerOff} text={t('share.offBanner')}
      action={{ label: t('share.publish'), icon: Radio, emphasis: 'primary', busy: status.kind === 'saving',
        disabled: errors.length > 0, onClick: () => { void publish() } }} />
  )
}

function Snippets({ input, live }: Readonly<{ input: SnippetInput; live: boolean }>) {
  const { t } = useTranslation('feedbackForms')
  const { go } = useBuilderUi()
  const link = formLink(input, false)
  const iframe = iframeSnippet(input)
  return (
    <div className="space-y-5">
      <LinkField label={t('share.link')} url={link} qrTitle={live ? t('share.qrTitle') : t('test.qrTitle')} formName={input.formName}
        hint={live ? t('share.liveHint') : undefined}>
        {link !== null && (
          <a href={link} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm">
            {t('share.open')}<ExternalLink size={14} aria-hidden="true" /><span className="sr-only">{t('share.newTab')}</span>
          </a>
        )}
      </LinkField>
      <p className="text-[12px] text-muted">
        {t('share.withHidden')}{' '}
        <button type="button" className="link" onClick={() => go('hidden-fields')}>{t('share.toHidden')}</button>
      </p>
      {iframe === null
        ? <p className="text-sm text-muted">{t('configureApiFirst')}</p>
        : (
          <div className="space-y-1">
            <h3 className="text-sm font-medium text-text">{t('share.iframe')}</h3>
            <CodeView text={iframe} label={t('share.iframe')} />
          </div>
        )}
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-text">{t('share.script')}</h3>
        <CodeView text={initSnippet(input)} label={t('share.script')} />
      </div>
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
  const testOn = form.settings.test.link_enabled
  const base: SnippetInput | null = formId === null ? null
    : { apiEndpoint, formId, formName: form.name, language: form.language, hidden: form.hidden_fields, testToken: null }
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
          {mode === 'test' && !testReady && <TestOffNote />}
          {mode === 'test' && testReady && <p role="note" className="flex items-center gap-2 text-sm text-text"><FlaskConical size={14} className="text-info" aria-hidden="true" />{t('share.testNotice')}</p>}
          {(mode === 'live' || testReady) && <Snippets input={mode === 'live' ? base : { ...base, testToken: token }} live={mode === 'live'} />}
        </>
      )}
    </section>
  )
}
