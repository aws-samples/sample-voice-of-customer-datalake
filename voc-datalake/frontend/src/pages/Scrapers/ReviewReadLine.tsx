/**
 * @fileoverview A review page's last run, in words: which method read it and, for an Automatic page, what was
 * tried first ("Browser blocked by Cloudflare → read via Bedrock web index (11 reviews)", "Known: Bedrock web index
 * (learned 15 Nov 2026) — 11 reviews", "Re-checked the browser: still blocked by Cloudflare → read via …"), with an
 * "Excerpts" badge when the reviews are AgentCore web search snippets (reviewReads.ts reads the run row).
 * @module pages/Scrapers/ReviewReadLine
 */
import { useTranslation } from 'react-i18next'
import { formatDate } from '../../utils/dateUtils'
import { STEP_KEYS, readChain, readsExcerpts } from './reviewReads'
import { Tooltip } from '../../components/Tooltip/Tooltip'
import type { ReadStep, StepOutcome, StepRead, TargetRead } from './reviewReads'

const ARROW = ' → '

/** A step that did not read the page, by its outcome. */
const FAILED_KEYS: Readonly<Record<Exclude<StepOutcome, 'readable' | 'blocked'>, string>> = {
  no_reviews: 'appCard.read.failed.no_reviews',
  error: 'appCard.read.failed.error',
  skipped_time: 'appCard.read.failed.skipped_time',
  not_offered: 'appCard.read.failed.not_offered',
}

type Translate = (key: string, options?: Record<string, unknown>) => string

/** The phrases a run's sentence is built of, in the UI language. */
interface Words {
  step: (method: ReadStep) => string
  failed: (step: StepRead) => string
  reviews: (count: number) => string
  date: (iso: string | null) => string
  t: Translate
}

function useWords(): Words {
  const { t, i18n } = useTranslation('scrapers')
  const tr: Translate = (key, options) => t(key, options)
  const step = (method: ReadStep) => tr(STEP_KEYS[method])
  return {
    step,
    failed: (read) => {
      if (read.outcome === 'blocked') {
        return read.vendor === undefined
          ? tr('appCard.read.failed.blockedUnknown', { method: step(read.method) })
          : tr('appCard.read.failed.blocked', { method: step(read.method), vendor: read.vendor })
      }
      return read.outcome === 'readable' ? step(read.method) : tr(FAILED_KEYS[read.outcome], { method: step(read.method) })
    },
    reviews: (count) => tr('appCard.read.reviews', { count }),
    date: (iso) => formatDate(iso, i18n.language),
    t: tr,
  }
}

function knownHead(read: TargetRead, method: ReadStep, words: Words): string {
  const date = words.date(read.learned_at)
  return date === ''
    ? words.t('appCard.read.knownUndated', { method: words.step(method) })
    : words.t('appCard.read.known', { method: words.step(method), date })
}

function reprobeHead(browser: StepRead | undefined, read: TargetRead, words: Words): string {
  if (browser?.outcome === 'readable') return words.t('appCard.read.reprobeReads', { amount: words.reviews(read.reviews) })
  if (browser?.outcome === 'blocked' && browser.vendor !== undefined) {
    return words.t('appCard.read.reprobeStill', { vendor: browser.vendor })
  }
  return words.t('appCard.read.reprobeUnreadable')
}

/** The steps after a head: each failure, then the one that read the page. */
function tail(failed: readonly StepRead[], success: StepRead | undefined, read: TargetRead, words: Words): string[] {
  const parts = failed.map((step) => words.failed(step))
  if (success !== undefined) {
    parts.push(words.t('appCard.read.thenRead', { method: words.step(success.method), amount: words.reviews(read.reviews) }))
  }
  return parts
}

/** A page that was read: by its plan's head, else by its chain. */
function readSentence(read: TargetRead, success: StepRead, failed: readonly StepRead[], words: Words): string {
  if (read.plan === 'known' && read.known_method !== null) {
    const head = knownHead(read, read.known_method, words)
    if (failed.length === 0) return `${head} — ${words.reviews(read.reviews)}`
    return [head, ...tail(failed, success, read, words)].join(ARROW)
  }
  if (read.plan === 'reprobe') {
    const [first] = read.steps
    const head = reprobeHead(first, read, words)
    if (first?.outcome === 'readable') return head
    return [head, ...tail(failed.filter((step) => step !== first), success, read, words)].join(ARROW)
  }
  if (failed.length === 0) {
    return success.method === 'browser'
      ? words.t('appCard.read.readWithBrowser', { amount: words.reviews(read.reviews) })
      : words.t('appCard.read.readVia', { method: words.step(success.method), amount: words.reviews(read.reviews) })
  }
  return tail(failed, success, read, words).join(ARROW)
}

/** The run's sentence for `read`; '' when it tried no step. */
function runSentence(read: TargetRead, words: Words): string {
  const { failed, success } = readChain(read)
  if (success !== undefined) return readSentence(read, success, failed, words)
  if (failed.length === 0) return ''
  const chain = failed.map((step) => words.failed(step)).join(ARROW)
  return read.method === 'auto' ? words.t('appCard.read.nothing', { chain }) : words.t('appCard.read.notRead', { chain })
}

/** The "Excerpts" badge: the reviews are cut passages of search results, each with its source link. */
function ExcerptsBadge() {
  const { t } = useTranslation('scrapers')
  return (
    <Tooltip kind="description" content={t('appCard.read.excerptsTitle')}>
      <span className="badge badge-muted">{t('appCard.read.excerpts')}</span>
    </Tooltip>
  )
}

/** How the card's page was read in its last run (nothing when the run row says nothing about it). */
export default function ReviewReadLine({ read }: Readonly<{ read: TargetRead }>) {
  const words = useWords()
  const sentence = runSentence(read, words)
  if (sentence === '') return null
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text">
      <span className="break-words [overflow-wrap:anywhere]">{sentence}</span>
      {readsExcerpts(read) ? <ExcerptsBadge /> : null}
    </div>
  )
}
