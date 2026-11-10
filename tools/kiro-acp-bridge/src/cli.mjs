#!/usr/bin/env node
/**
 * kiro-acp-bridge CLI.
 *
 *   node src/cli.mjs --workspace ~/code/project [--workspace ...] [--port 8765]
 *                    [--agent <kiro-agent>] [--model <id>] [--permission-timeout <seconds>]
 *
 * Prints the page URL and a one-time token to this terminal. Paste the token
 * into the page; it is never written anywhere else.
 */
import { parseArgs } from 'node:util'
import { startBridge } from './bridge.mjs'

const USAGE = `Usage: kiro-acp-bridge --workspace <dir> [--workspace <dir>...] [--port 8765]
                       [--agent <kiro-agent>] [--model <model-id>] [--permission-timeout <seconds>]`

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      workspace: { type: 'string', multiple: true },
      port: { type: 'string', default: '8765' },
      agent: { type: 'string' },
      model: { type: 'string' },
      'permission-timeout': { type: 'string', default: '120' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  })
  if (values.help) return null

  const port = Number(values.port)
  const timeoutSeconds = Number(values['permission-timeout'])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid --port ${values.port}`)
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error(`Invalid --permission-timeout ${values['permission-timeout']}`)
  }

  const agentArgs = ['acp']
  if (values.agent) agentArgs.push('--agent', values.agent)
  if (values.model) agentArgs.push('--model', values.model)

  return {
    workspaceRoots: values.workspace ?? [process.cwd()],
    port,
    agentArgs,
    permissionTimeoutMs: timeoutSeconds * 1000,
  }
}

async function main() {
  let options
  try {
    options = parseCli(process.argv.slice(2))
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`)
    process.exitCode = 2
    return
  }
  if (options === null) {
    console.log(USAGE)
    return
  }

  const bridge = await startBridge(options)
  console.log(`Kiro ACP bridge listening on ${bridge.url} (localhost only)`)
  console.log(`Workspace: ${options.workspaceRoots.join(', ')}`)
  console.log(`One-time token (paste into the page): ${bridge.token}`)

  const stop = () => {
    void bridge.close().finally(() => process.exit(0))
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

main().catch((err) => {
  console.error(`kiro-acp-bridge failed: ${err.message}`)
  process.exitCode = 1
})
