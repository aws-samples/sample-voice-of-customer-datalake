/**
 * Vite plugin: the public feedback widget as a static file of the app, `/widget/feedback-widget.js` (7.55.01).
 *
 * A customer's page loads the widget with `<script src="<app origin>/widget/feedback-widget.js">` (the Share tab's
 * script embed, src/pages/FeedbackForms/tabs/snippets.ts). The app's own CloudFront serves it from the SPA bucket like
 * every other file of the build, with its own CORS, cache and security headers (`/widget/*` in
 * lib/stacks/core-cdn.ts), never through an API route. There is one source, `lambda/api/static/feedback-widget.js`
 * (the API inlines it into its iframe page and the builder's preview loads it too), so no copy is kept by hand: the
 * build emits it under that stable name with a banner naming the release, and the dev server serves the file as it
 * is on disk, read again on every request.
 *
 * The name carries no hash and no version on purpose. A customer pastes the address once and it has to survive every
 * deploy (BucketDeployment prunes, and deploy.sh deletes, any file the new build does not have), so the file is
 * replaced in place and cached briefly (5 minutes, then revalidated). A fixed `integrity` hash cannot go with a file
 * that changes with each release; docs/feedback-forms.md says what a site that requires SRI does instead.
 *
 * Wired in vite.config.ts: `widgetAssetPlugin({ version: platformVersion(), commit: gitShortSha() ?? 'unknown' })`.
 */
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

/** The one widget source (a path from this folder, not a URL: the specs import this file under jsdom). */
export const WIDGET_SOURCE = resolve(import.meta.dirname, '../lambda/api/static/feedback-widget.js')

/** Where the build writes the file (under dist/), and so where the app serves it. */
export const WIDGET_FILE_NAME = 'widget/feedback-widget.js'
export const WIDGET_PATH = `/${WIDGET_FILE_NAME}`

export interface WidgetAssetOptions {
  /** The platform version (the repo-root package.json). */
  readonly version: string
  /** The commit the build came from. */
  readonly commit: string
}

/** The comment the served file starts with, so whoever opens it can tell which release it is. */
export function widgetBanner({ version, commit }: WidgetAssetOptions): string {
  return `/*! VoC feedback widget ${version} (${commit}), served at ${WIDGET_PATH}. See docs/feedback-forms.md. */\n`
}

/** The file as served: the banner, then the source exactly as it is. */
export function widgetFile(options: WidgetAssetOptions): string {
  return widgetBanner(options) + readFileSync(WIDGET_SOURCE, 'utf8')
}

type Next = (error?: unknown) => void

/**
 * The dev server's answer for the widget's address: the file read now (an edit shows on the next load), `no-cache`,
 * and the same CORS and `nosniff` as CloudFront, so a local test page on another port can load it, with SRI too.
 */
export function serveWidget(options: WidgetAssetOptions) {
  return (req: IncomingMessage, res: ServerResponse, next: Next): void => {
    const [pathname] = (req.url ?? '').split('?')
    if (pathname !== WIDGET_PATH || (req.method !== 'GET' && req.method !== 'HEAD')) {
      next()
      return
    }
    try {
      const body = widgetFile(options)
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.end(req.method === 'HEAD' ? undefined : body)
    } catch (error: unknown) {
      next(error)
    }
  }
}

export function widgetAssetPlugin(options: WidgetAssetOptions): Plugin {
  return {
    name: 'voc-widget-asset',
    configureServer(server) {
      server.middlewares.use(serveWidget(options))
    },
    buildStart() {
      this.addWatchFile(WIDGET_SOURCE)
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: WIDGET_FILE_NAME, source: widgetFile(options) })
    },
  }
}
