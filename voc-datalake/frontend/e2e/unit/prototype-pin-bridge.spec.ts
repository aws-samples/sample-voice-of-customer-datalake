/**
 * The prototype pin bridge in a REAL browser, offline: the production widget
 * (lambda/shared/static/prototype-pin-widget.js) inside an iframe sandboxed exactly as
 * production sandboxes it (the attribute AND the CloudFront CSP `sandbox` directive),
 * so its origin is opaque — the case jsdom cannot model.
 *
 * Pins down what the v5.10 production sweep asked about:
 * - host → widget messages ARRIVE (markers are drawn inside the frame);
 * - nothing logs "target origin provided (...) does not match the recipient window's
 *   origin ('null')", which is what posting to an opaque frame with the app's own
 *   origin as targetOrigin produces (the host talks on the widget's private port);
 * - the widget's own message carries origin 'null' and comes from the frame's window.
 *
 * The host page mirrors components/PrototypePins/usePinBridge.ts and pinMessages.ts:
 * accept only `event.source === frame.contentWindow` with origin 'null', adopt
 * `event.ports[0]`, post on it.
 *   npx playwright test -c playwright.unit.config.ts unit/prototype-pin-bridge.spec.ts
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WIDGET = fs.readFileSync(path.resolve(HERE, '../../../lambda/shared/static/prototype-pin-widget.js'), 'utf-8')
const FORM_ID = 'pf_0123456789abcdef'
/** lib/utils/prototype-csp.ts PROTOTYPE_SANDBOX, as CloudFront serves it on /prototypes/*. */
const PROTOTYPE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
  + "frame-ancestors 'self'; sandbox allow-scripts allow-popups;"

const PROTOTYPE = `<!doctype html><html><body><button id="target">Pay</button>
<script>${WIDGET}
window.VoCPinWidget && window.VoCPinWidget.init({ formId: '${FORM_ID}' });</script></body></html>`

const HOST = `<!doctype html><html><body>
<iframe id="frame" sandbox="allow-scripts allow-popups" src="/prototype.html" style="width:600px;height:400px"></iframe>
<script>
  const frame = document.getElementById('frame');
  window.hostSeen = [];
  window.addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow || event.origin !== 'null') return;
    window.hostSeen.push({ type: event.data && event.data.type, origin: event.origin, ports: event.ports.length });
    const port = event.ports[0];
    if (!port || !event.data || event.data.type !== 'ready') return;
    port.postMessage({ source: 'voc-pin-host', type: 'show', pins: [
      { pin_id: 'p1', number: 1, selector: '#target', bbox: { x: 0, y: 0, w: 10, h: 10 }, status: 'open' },
    ] });
  });
</script></body></html>`

const server = http.createServer((req, res) => {
  if (req.url === '/prototype.html') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': PROTOTYPE_CSP })
    res.end(PROTOTYPE)
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end(HOST)
})

/** The port the server bound (0 = any free one), read with a runtime check rather than a cast. */
function listeningPort(): number {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the test server is not listening on TCP')
  return address.port
}

test.beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('the host reaches the sandboxed widget on its port, with no target-origin warning', async ({ page }) => {
  const consoleLines: string[] = []
  page.on('console', (message) => consoleLines.push(message.text()))
  await page.goto(`http://127.0.0.1:${listeningPort()}/host.html`)

  const frame = page.frameLocator('#frame')
  await expect(frame.locator('#voc-pin-marker-0')).toHaveText('1')
  expect(await page.evaluate(() => Reflect.get(window, 'hostSeen'))).toStrictEqual([
    { type: 'ready', origin: 'null', ports: 1 },
  ])
  expect(consoleLines.filter((line) => line.includes('does not match the recipient window'))).toStrictEqual([])
})
