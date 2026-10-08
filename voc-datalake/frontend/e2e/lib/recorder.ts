/**
 * Per-step evidence: every network call (method, path, status, duration),
 * console errors/warnings, page errors, failed requests, navigation timing,
 * a screenshot, an axe-core scan and the design-system checks. One JSON file
 * per step under OUT_DIR/steps.
 */
import fs from 'node:fs'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import type { Page, Request } from '@playwright/test'
import { OUT_DIR, SCREENS_DIR, type Role } from './env'
import { designAudit, type DesignAudit } from './design'

export interface NetCall {
  method: string
  url: string
  path: string
  host: string
  status: number | null
  durationMs: number | null
  /** Time to the first response byte (headers), ms from request start; for streams this is TTFB. */
  ttfbMs: number | null
  failure: string | null
  resourceType: string
}

export interface ConsoleEntry {
  type: string
  text: string
}

export interface AxeSummary {
  violations: Array<{ id: string; impact: string | null; help: string; nodes: number; targets: string[] }>
  counts: Record<string, number>
}

export interface StepRecord {
  role: Role
  theme: string
  step: string
  url: string
  ok: boolean
  error: string | null
  notes: string[]
  startedAt: string
  wallMs: number
  navigation: { domContentLoadedMs: number | null; loadMs: number | null; ttfbMs: number | null } | null
  calls: NetCall[]
  console: ConsoleEntry[]
  pageErrors: string[]
  screenshot: string | null
  axe: AxeSummary | null
  design: DesignAudit | null
  /** Named extra evidence a spec attached (deep design audit, keyboard walk, …). */
  extra?: Record<string, unknown>
}

const STEPS_DIR = path.join(OUT_DIR, 'steps')

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120)
}

/**
 * This app never puts tokens in URLs, but as a precaution any `token=`, `code=`,
 * `access_token=` or `id_token=` query value is masked before a URL is recorded.
 */
function redactUrl(raw: string): string {
  return raw.replace(/([?&](?:token|code|access_token|id_token)=)[^&]+/gi, '$1***')
}

/** Total duration and time to first byte, both ms from request start (null when unknown). */
export function timingOf(request: Request): { durationMs: number | null; ttfbMs: number | null } {
  const timing = request.timing()
  const ms = (n: number): number | null => (n >= 0 ? Math.round(n) : null)
  return { durationMs: ms(timing.responseEnd), ttfbMs: ms(timing.responseStart) }
}

export class StepRecorder {
  private readonly calls: NetCall[] = []
  private readonly consoleEntries: ConsoleEntry[] = []
  private readonly pageErrors: string[] = []
  private readonly pending = new Set<Promise<void>>()
  private readonly started = Date.now()
  readonly notes: string[] = []
  private readonly extra: Record<string, unknown> = {}
  private earlyShot: string | null = null

  constructor(
    private readonly page: Page,
    private readonly role: Role,
    private readonly theme: string,
    private readonly step: string,
  ) {
    page.on('requestfinished', this.onFinished)
    page.on('requestfailed', this.onFailed)
    page.on('console', this.onConsole)
    page.on('pageerror', this.onPageError)
  }

  private readonly onFinished = (request: Request): void => {
    const job = request.response().then((response) => {
      this.push(request, response?.status() ?? null, null)
    }).catch(() => this.push(request, null, 'no response'))
    this.pending.add(job)
    void job.finally(() => this.pending.delete(job))
  }

  private readonly onFailed = (request: Request): void => {
    this.push(request, null, request.failure()?.errorText ?? 'failed')
  }

  private readonly onConsole = (message: { type: () => string; text: () => string }): void => {
    const type = message.type()
    if (type === 'error' || type === 'warning') {
      this.consoleEntries.push({ type, text: message.text().slice(0, 500) })
    }
  }

  private readonly onPageError = (error: Error): void => {
    this.pageErrors.push(`${error.name}: ${error.message}`.slice(0, 500))
  }

  private push(request: Request, status: number | null, failure: string | null): void {
    const url = new URL(request.url())
    if (url.protocol === 'data:' || url.protocol === 'blob:') return
    this.calls.push({
      method: request.method(),
      url: redactUrl(request.url()),
      path: url.pathname,
      host: url.host,
      status,
      ...timingOf(request),
      failure,
      resourceType: request.resourceType(),
    })
  }

  note(text: string): void {
    this.notes.push(text)
  }

  /** The calls recorded so far (a copy), for mid-step evidence such as the UI's polling cadence. */
  callsSnapshot(): NetCall[] {
    return [...this.calls]
  }

  /** Adds named evidence to the step record (written with it). */
  attach(key: string, value: unknown): void {
    this.extra[key] = value
  }

  /**
   * Takes the step's screenshot now instead of at the end — for steps whose
   * later actions (a keyboard walk) would leave the page scrolled or focused.
   */
  async screenshotNow(): Promise<void> {
    this.earlyShot = await this.shoot(this.baseName())
  }

  /** Waits for in-flight response bookkeeping and assembles the record (not yet written). */
  async build(options: { audit?: boolean; screenshot?: boolean }): Promise<StepRecord> {
    const { page } = this
    await Promise.allSettled([...this.pending])
    page.off('requestfinished', this.onFinished)
    page.off('requestfailed', this.onFailed)
    page.off('console', this.onConsole)
    page.off('pageerror', this.onPageError)

    const screenshot = options.screenshot === false ? null : this.earlyShot ?? await this.shoot(this.baseName())
    const navigation = await this.navigationTiming()
    const axe = options.audit === false ? null : await this.runAxe()
    const design = options.audit === false ? null : await designAudit(page).catch(() => null)

    return {
      role: this.role,
      theme: this.theme,
      step: this.step,
      url: redactUrl(page.url()),
      ok: true,
      error: null,
      notes: this.notes,
      startedAt: new Date(this.started).toISOString(),
      wallMs: Date.now() - this.started,
      navigation,
      calls: this.calls,
      console: this.consoleEntries,
      pageErrors: this.pageErrors,
      screenshot,
      axe,
      design,
      ...(Object.keys(this.extra).length > 0 ? { extra: this.extra } : {}),
    }
  }

  write(record: StepRecord): void {
    fs.mkdirSync(STEPS_DIR, { recursive: true })
    fs.writeFileSync(path.join(STEPS_DIR, `${this.baseName()}.json`), JSON.stringify(record, null, 2))
  }

  /** build + write, with the caller's verdict. */
  async finish(options: { ok: boolean; error?: string | null; audit?: boolean; screenshot?: boolean }): Promise<StepRecord> {
    const record = { ...(await this.build(options)), ok: options.ok, error: options.error ?? null }
    this.write(record)
    return record
  }

  private baseName(): string {
    return safeName(`${this.role}-${this.theme}-${this.step}`)
  }

  private async shoot(base: string): Promise<string | null> {
    fs.mkdirSync(SCREENS_DIR, { recursive: true })
    const file = path.join(SCREENS_DIR, `${base}.png`)
    try {
      await this.page.screenshot({ path: file, fullPage: false, timeout: 15_000 })
      return file
    } catch {
      return null
    }
  }

  private async navigationTiming(): Promise<StepRecord['navigation']> {
    try {
      return await this.page.evaluate(() => {
        const entries = performance.getEntriesByType('navigation')
        const nav = entries[entries.length - 1]
        if (!(nav instanceof PerformanceNavigationTiming)) return null
        const round = (n: number): number | null => (n > 0 ? Math.round(n) : null)
        return {
          domContentLoadedMs: round(nav.domContentLoadedEventEnd),
          loadMs: round(nav.loadEventEnd),
          ttfbMs: round(nav.responseStart),
        }
      })
    } catch {
      return null
    }
  }

  private async runAxe(): Promise<AxeSummary | null> {
    try {
      const result = await new AxeBuilder({ page: this.page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
        .analyze()
      const counts: Record<string, number> = {}
      const violations = result.violations.map((v) => {
        const impact = v.impact ?? 'unknown'
        counts[impact] = (counts[impact] ?? 0) + v.nodes.length
        return {
          id: v.id,
          impact: v.impact ?? null,
          help: v.help,
          nodes: v.nodes.length,
          targets: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
        }
      })
      return { violations, counts }
    } catch (error) {
      this.note(`axe failed: ${String(error).slice(0, 200)}`)
      return null
    }
  }
}
