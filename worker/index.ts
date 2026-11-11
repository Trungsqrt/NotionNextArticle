#!/usr/bin/env node

import { getTranslationConfig } from '../lib/notion-translation/config'
import { startPoller } from './poller'
import { createLogger } from './logger'

export interface WorkerCliFlags {
  once: boolean
  dryRun: boolean
  help: boolean
  targetPageId: string | null
  pollIntervalMs: number | undefined
}

export function parseCliArgs(
  argv: readonly string[] = process.argv.slice(2)
): WorkerCliFlags {
  const flags: WorkerCliFlags = {
    once: false,
    dryRun: false,
    help: false,
    targetPageId: null,
    pollIntervalMs: undefined,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg) continue

    if (arg === '--once') {
      flags.once = true
    } else if (arg === '--dry-run' || arg === '--dryRun') {
      flags.dryRun = true
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true
    } else if (arg.startsWith('--page-id=') || arg.startsWith('--page=')) {
      flags.targetPageId = arg.split('=')[1]?.trim() || null
      if (flags.targetPageId) flags.once = true
    } else if ((arg === '--page-id' || arg === '--page') && argv[i + 1]) {
      flags.targetPageId = argv[++i]!.trim()
      if (flags.targetPageId) flags.once = true
    } else if (arg.startsWith('--interval=')) {
      const val = Number(arg.split('=')[1])
      if (!Number.isNaN(val) && val > 0) flags.pollIntervalMs = val
    }
  }

  return flags
}

export function printHelp(): void {
  console.log(`
ServiceNow Knowledge Hub — Local Notion AI Translation Worker (TypeScript)

Usage:
  pnpm translate:worker                     Run continuous polling worker (default: 60s)
  pnpm translate --page <notion-page-id>    Translate a specific page (and its nested hierarchy) once
  pnpm translate:worker -- --once           Run a single polling cycle and exit
  pnpm translate:worker -- --dry-run        Read and translate without modifying Notion
  pnpm translate:worker -- --once --dry-run
  pnpm translate:worker -- --once --page-id=<notion-page-id>

Options:
  --once                Scan and process one polling cycle, then exit
  --dry-run             Translate in memory and validate without writing to Notion
  --page <id>           Process a specific English source page ID (alias: --page-id=<id>)
  --interval=<ms>       Override polling interval in milliseconds (default: 60000)
  --help, -h            Show this help message
`)
}

export async function main(
  argv: readonly string[] = process.argv.slice(2)
): Promise<0 | 1> {
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
    const pollerResult = await startPoller({
      config,
      once: cli.once,
      dryRun: cli.dryRun,
      targetPageId: cli.targetPageId,
      logger,
    })

    const failedCount = pollerResult.lastCycleSummary?.failedCount || 0
    if (pollerResult.exitCode === 1 || (cli.once && failedCount > 0)) {
      logger.error(
        `Worker finished with ${failedCount} failed translation job(s).`,
        {
          succeededCount: pollerResult.lastCycleSummary?.succeededCount || 0,
          needsReviewCount:
            pollerResult.lastCycleSummary?.needsReviewCount || 0,
          failedCount,
        }
      )
      process.exitCode = 1
      return 1
    }

    return 0
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error(`Worker exited with error: ${message}`)
    process.exitCode = 1
    return 1
  }
}

const isMainExecution =
  Boolean(process.argv[1]) &&
  /worker[\\/]index\.(ts|js)$/i.test(process.argv[1]!)

if (isMainExecution) {
  void main()
}

