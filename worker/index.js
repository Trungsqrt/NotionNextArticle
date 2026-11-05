#!/usr/bin/env node
'use strict'

const { getTranslationConfig } = require('../lib/notion-translation/config')
const { startPoller } = require('./poller')
const { createLogger } = require('./logger')

function parseCliArgs(argv = process.argv.slice(2)) {
  const flags = {
    once: false,
    dryRun: false,
    help: false,
    targetPageId: null,
    pollIntervalMs: undefined,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--once') {
      flags.once = true
    } else if (arg === '--dry-run' || arg === '--dryRun') {
      flags.dryRun = true
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true
    } else if (arg.startsWith('--page-id=')) {
      flags.targetPageId = arg.split('=')[1]?.trim() || null
    } else if (arg === '--page-id' && argv[i + 1]) {
      flags.targetPageId = argv[++i].trim()
    } else if (arg.startsWith('--interval=')) {
      const val = Number(arg.split('=')[1])
      if (!Number.isNaN(val) && val > 0) flags.pollIntervalMs = val
    }
  }

  return flags
}

function printHelp() {
  console.log(`
ServiceNow Knowledge Hub — Local Notion AI Translation Worker

Usage:
  pnpm run translate:worker                 Run continuous polling worker (default: 60s)
  pnpm run translate:worker -- --once       Run a single polling cycle and exit
  pnpm run translate:worker -- --dry-run    Read and translate without modifying Notion
  pnpm run translate:worker -- --once --dry-run
  pnpm run translate:worker -- --once --page-id=<notion-page-id>

Options:
  --once                Scan and process one polling cycle, then exit
  --dry-run             Translate in memory and validate without writing to Notion
  --page-id=<id>        Process a specific English source page ID
  --interval=<ms>       Override polling interval in milliseconds (default: 60000)
  --help, -h            Show this help message
`)
}

async function main(argv = process.argv.slice(2)) {
  const cli = parseCliArgs(argv)
  if (cli.help) {
    printHelp()
    return 0
  }

  const logger = createLogger({ prefix: 'translation-worker' })
  const config = getTranslationConfig({
    once: cli.once,
    dryRun: cli.dryRun,
    ...(cli.pollIntervalMs ? { pollIntervalMs: cli.pollIntervalMs } : {}),
  })

  try {
    await startPoller({
      config,
      once: cli.once,
      dryRun: cli.dryRun,
      targetPageId: cli.targetPageId,
      logger,
    })
    return 0
  } catch (err) {
    logger.error(`Worker exited with error: ${err?.message || err}`)
    process.exitCode = 1
    return 1
  }
}

if (require.main === module) {
  main()
}

module.exports = {
  parseCliArgs,
  main,
}

