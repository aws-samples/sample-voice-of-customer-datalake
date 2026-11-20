/**
 * @fileoverview The Test tab (UX §9.1–9.2): the test link (it works while the form is Off, D2), what happens to its
 * responses (Keep them marked Test, or Check them and keep nothing), what testers see, and the recent test responses
 * with their hidden values, so an integrator sees at once whether the app passed `app_version`.
 *
 * The switch and Keep / Check only are settings of the form (`settings.test`): they save with it. Making the test
 * link, resetting it and deleting the test responses are immediate (they don't wait for Save), and never change the
 * saved settings: they send the stored form's back as they are. Make the test link issues a token only for a form
 * that has none (never a new one for a link in use), and is not offered while the token is still being read. A
 * failure says so (`role="alert"`) and keeps the dialog open.
 *
 * @module pages/FeedbackForms/tabs/TestTab
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { FlaskConical, RotateCcw } from 'lucide-react'
import SwitchField from '../../../components/SwitchField/SwitchField'
import RadioCard from '../../../components/RadioCard/RadioCard'
import ConfirmModal from '../../../components/ConfirmModal/ConfirmModal'
import Notice from '../../../components/Notice/Notice'
import { useConfigStore } from '../../../store/configStore'
import { useCopyToClipboard } from '../../../hooks/useCopyToClipboard'
import { feedbackFormsV2Api } from '../../../api/feedbackFormsV2Api'
import { useDraft } from '../builder/formDraftContext'
import { useBuilderUi } from '../builder/builderUi'
import type { TestRecord } from '../model/formsV2'
import ActionsMenu from '../ui/ActionsMenu'
import { formLink } from './snippets'
import type { SnippetInput } from './snippets'
import { LinkField, OpenLink, SaveFirstNotice } from './linkParts'
import { testTokenKey, useStoredTestSettings, useTestTokenState } from './testToken'
import RecentTestResponses from './RecentTestResponses'

/** The snippet input of this form's test link (null: no test token yet, or it is still being read). */
function useTestSnippet(): { readonly snippet: SnippetInput | null; readonly loading: boolean } {
  const { form } = useDraft()
  const { formId } = useBuilderUi()
  const apiEndpoint = useConfigStore((state) => state.config.apiEndpoint)
  const { token, loading } = useTestTokenState()
  if (formId === null || token === null) return { snippet: null, loading }
  return { snippet: { apiEndpoint, formId, formName: form.name, language: form.language, hidden: form.hidden_fields, testToken: token }, loading: false }
}

function TestLinkSwitch() {
  const { t } = useTranslation('feedbackForms')
  const { form, update } = useDraft()
  const on = form.settings.test.link_enabled
  return (
    <div className="space-y-1">
      <SwitchField label={t('test.linkSwitch')} checked={on}
        onChange={(checked) => update((current) => ({ ...current, settings: { ...current.settings, test: { ...current.settings.test, link_enabled: checked } } }))} />
      <p className="text-[12px] text-muted">{on ? t('test.linkOnHint') : t('test.linkOffHint')}</p>
    </div>
  )
}

function TestLink({ snippet }: Readonly<{ snippet: SnippetInput }>) {
  const { t } = useTranslation('feedbackForms')
  const queryClient = useQueryClient()
  const { copy } = useCopyToClipboard()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const keep = useStoredTestSettings()
  const reset = async () => {
    setBusy(true)
    setFailed(false)
    try {
      const token = await feedbackFormsV2Api.rotateTestToken(snippet.formId, keep)
      queryClient.setQueryData(testTokenKey(snippet.formId), token)
      setConfirming(false)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  const withHidden = formLink(snippet, true)
  const link = formLink(snippet, false)
  return (
    <>
      <LinkField label={t('test.linkLabel')} url={link} qrTitle={t('test.qrTitle')} formName={snippet.formName}>
        {/* (opening the test link is the commonest thing done here: beside Copy and QR, not in ⋯) */}
        {link !== null && <OpenLink url={link} />}
        <ActionsMenu label={t('test.linkMenu')} items={[
          { label: t('test.copyWithHidden'), onSelect: () => { if (withHidden !== null) copy(withHidden, 'hidden') } },
          { label: t('test.reset'), icon: RotateCcw, onSelect: () => setConfirming(true) },
        ]} />
      </LinkField>
      {failed && !confirming && <p role="alert" className="text-[12px] text-danger">{t('test.resetFailed')}</p>}
      <ConfirmModal isOpen={confirming} title={t('test.resetTitle')} message={t('test.resetMessage')} confirmLabel={t('test.resetConfirm')}
        variant="danger" isLoading={busy} onConfirm={() => { void reset() }} onCancel={() => { setConfirming(false); setFailed(false) }}>
        {failed && <p role="alert" className="mt-3 text-[13px] text-danger">{t('test.resetFailed')}</p>}
      </ConfirmModal>
    </>
  )
}

function MakeTestLink({ formId }: Readonly<{ formId: string }>) {
  const { t } = useTranslation('feedbackForms')
  const queryClient = useQueryClient()
  const keep = useStoredTestSettings()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const make = async () => {
    setBusy(true)
    setFailed(false)
    try {
      // (no `rotate`: a form that has a token keeps it, so a link in use never stops working here)
      const issued = await feedbackFormsV2Api.issueTestLink(formId, keep)
      queryClient.setQueryData(testTokenKey(formId), issued.token)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-2">
      <Notice variant="banner" tone="warn" icon={FlaskConical} text={t('test.noToken')}
        action={{ label: t('test.makeLink'), busy, onClick: () => { void make() } }} />
      {failed && <p role="alert" className="text-[12px] text-danger">{t('test.makeLinkFailed')}</p>}
    </div>
  )
}

function RecordChoice() {
  const { t } = useTranslation('feedbackForms')
  const { form, update } = useDraft()
  const choose = (record: TestRecord) => update((current) => ({ ...current, settings: { ...current.settings, test: { ...current.settings.test, record } } }))
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold tracking-tight text-text-strong">{t('test.recordTitle')}</legend>
      <RadioCard name="test-record" value="tag" checked={form.settings.test.record === 'tag'} onSelect={choose}
        title={t('test.keep')} hint={t('test.keepHint')} />
      <RadioCard name="test-record" value="drop" checked={form.settings.test.record === 'drop'} onSelect={choose}
        title={t('test.checkOnly')} hint={t('test.checkOnlyHint')} />
    </fieldset>
  )
}

function TestLinkBody() {
  const { t } = useTranslation('feedbackForms')
  const { formId } = useBuilderUi()
  const { snippet, loading } = useTestSnippet()
  if (formId === null) return <SaveFirstNotice />
  if (snippet !== null) return <TestLink snippet={snippet} />
  return loading ? <p role="status" className="text-sm text-muted">{t('test.tokenLoading')}</p> : <MakeTestLink formId={formId} />
}

export default function TestTab() {
  const { t } = useTranslation('feedbackForms')
  const { form } = useDraft()
  const { formId } = useBuilderUi()
  const { link_enabled: on, record } = form.settings.test
  return (
    <div className="space-y-6">
      <section className="card space-y-4" aria-labelledby="test-link-heading">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="test-link-heading" className="text-base font-semibold tracking-tight text-text-strong">{t('test.title')}</h2>
            <p className="text-sm text-muted">{t('test.subtitle')}</p>
          </div>
          <TestLinkSwitch />
        </div>
        {on ? <TestLinkBody /> : <p className="text-sm text-text">{t('test.linkOff')}</p>}
      </section>
      <section className="card space-y-4">
        <RecordChoice />
        <p className="text-sm text-text"><span className="font-medium">{t('test.testersSee')}</span> {record === 'tag' ? t('test.bannerKeep') : t('test.bannerDrop')}</p>
        <p className="text-[12px] text-muted">{t('test.previewNote')}</p>
      </section>
      {formId !== null && (record === 'tag'
        ? <RecentTestResponses formId={formId} />
        : <Notice variant="empty" icon={FlaskConical} title={t('test.recentTitle')} text={t('test.checkOnlyEmpty')} role="note" />)}
    </div>
  )
}
