import fs from 'node:fs'
import os from 'node:os'
import type { Client } from '@notionhq/client'
import {
  TRANSLATION_STATUS,
  getTranslationConfig,
  validateConfig,
  type TranslationConfig,
} from '../lib/notion-translation/config'
import {
  createNotionClient,
  resolveArticlesDataSource,
  ensureTranslationSchema,
  queryAllPages,
  normalizeNotionId,
} from '../lib/notion-translation/notion-client'
import {
  extractPageWorkflowMeta,
  processTranslationJob,
  recoverStaleProcessingPages,
  type ProcessTranslationJobOptions,
} from '../lib/notion-translation/workflow'
import type {
  IndexedDatabasePage,
  PageWorkflowMeta,
  PollCycleSummary,
  TranslationJobResult,
  WorkerLogger,
} from '../lib/notion-translation/types'
import { defaultLogger } from './logger'

export function isProcessAlive(pid: number): boolean {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return Boolean(
      err && typeof err === 'object' && (err as { code?: string }).code === 'EPERM'
    )
  }
}

export interface WorkerLockHandle {
  acquired: boolean
  lockFilePath?: string
  release: () => void
}

/**
 * Acquires a local single-instance lock file to prevent multiple worker processes
 * from concurrently polling and translating the same Notion pages.
 * Automatically recovers stale lock files left behind by dead processes.
 */
export function acquireWorkerLock(
  lockFilePath: string | null | undefined,
  logger: WorkerLogger = defaultLogger
): WorkerLockHandle {
  if (!lockFilePath) {
    return { acquired: true, release: () => {} }
  }

  const payload = JSON.stringify(
    {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: os.hostname(),
    },
    null,
    2
  )

  function tryWriteExclusive(): void {
    const fd = fs.openSync(lockFilePath!, 'wx')
    try {
      fs.writeFileSync(fd, payload, 'utf8')
    } finally {
      fs.closeSync(fd)
    }
  }

  try {
    tryWriteExclusive()
  } catch (err) {
    const code =
      err && typeof err === 'object' ? (err as { code?: string }).code : undefined
    if (code !== 'EEXIST') {
      throw err
    }

    let existingLock: { pid?: number; startedAt?: string } | null = null
    try {
      existingLock = JSON.parse(fs.readFileSync(lockFilePath, 'utf8')) as {
        pid?: number
        startedAt?: string
      }
    } catch {
      existingLock = null
    }

    if (existingLock?.pid && isProcessAlive(existingLock.pid)) {
      const lockErr = new Error(
        `Another translation worker instance is already running (PID ${existingLock.pid}, started at ${existingLock.startedAt}).`
      ) as Error & { code?: string }
      lockErr.code = 'WORKER_LOCKED'
      throw lockErr
    }

    logger.warn('Replacing stale worker lock file from dead process', {
      stalePid: existingLock?.pid,
      lockFilePath,
    })
    try {
      fs.unlinkSync(lockFilePath)
    } catch {
      // Ignore unlink race
    }
    tryWriteExclusive()
  }

  let released = false
  function release(): void {
    if (released || !lockFilePath) return
    released = true
    try {
      if (fs.existsSync(lockFilePath)) {
        const current = JSON.parse(fs.readFileSync(lockFilePath, 'utf8')) as {
          pid?: number
        }
        if (!current?.pid || current.pid === process.pid) {
          fs.unlinkSync(lockFilePath)
        }
      }
    } catch {
      // Ignore cleanup errors on shutdown
    }
  }

  return {
    acquired: true,
    lockFilePath,
    release,
  }
}

export interface RunPollCycleOptions extends ProcessTranslationJobOptions {
  targetPageId?: string | null
  activePageIds?: Set<string>
  shouldStop?: () => boolean
}

/**
 * Runs a single polling cycle:
 * 1. Resolves Articles database & ensures schema properties exist.
 * 2. Recovers any stale `Processing` jobs (>30m) safely.
 * 3. Finds pages with `Translation Status = Requested` and `Locale = en` (or missing Locale).
 * 4. Processes each requested page sequentially and returns a structured cycle summary.
 */
export async function runPollCycle(
  options: RunPollCycleOptions = {}
): Promise<PollCycleSummary> {
  const config = options.config || getTranslationConfig(options)
  const logger = options.logger || defaultLogger
  const dryRun = Boolean(options.dryRun ?? config.dryRun)
  const client = options.client || createNotionClient(config)
  const activePageIds = options.activePageIds || new Set<string>()
  const shouldStop =
    typeof options.shouldStop === 'function' ? options.shouldStop : () => false

  const dataSourceInfo =
    options.dataSourceInfo ||
    (await resolveArticlesDataSource(client, config, {
      logger,
      retryOptions: options.retryOptions,
    }))

  await ensureTranslationSchema(
    client,
    dataSourceInfo as Awaited<ReturnType<typeof resolveArticlesDataSource>>,
    {
      dryRun,
      logger,
      retryOptions: options.retryOptions,
    }
  )

  const allDatabasePages = await queryAllPages(
    client,
    dataSourceInfo as Awaited<ReturnType<typeof resolveArticlesDataSource>>,
    {},
    { config, logger, retryOptions: options.retryOptions }
  )

  // 1. Recover stale Processing jobs (>30 minutes) safely
  const recoveredJobs = await recoverStaleProcessingPages(allDatabasePages, {
    ...options,
    config,
    client,
    dataSourceInfo,
    dryRun,
    logger,
  })

  // 2. Filter pages where Translation Status = Requested (or specific target page if --page-id is supplied)
  const requestedPages: IndexedDatabasePage[] = []
  const skippedNonEnglish: PageWorkflowMeta[] = []

  for (const page of allDatabasePages) {
    if (!page || page.in_trash || page.archived) continue
    const meta = extractPageWorkflowMeta(page, dataSourceInfo)

    if (options.targetPageId) {
      if (
        normalizeNotionId(meta.id) === normalizeNotionId(options.targetPageId)
      ) {
        requestedPages.push({ page, meta })
      }
      continue
    }

    if (meta.translationStatus !== TRANSLATION_STATUS.REQUESTED) {
      continue
    }

    if (meta.locale !== (config.sourceLocale || 'en')) {
      skippedNonEnglish.push(meta)
      continue
    }

    requestedPages.push({ page, meta })
  }

  if (skippedNonEnglish.length > 0) {
    logger.info(
      `Ignored ${skippedNonEnglish.length} Requested page(s) with non-English locale`,
      {
        pages: skippedNonEnglish.map((m) => ({
          id: m.id,
          locale: m.locale,
          title: m.title,
        })),
      }
    )
  }

  logger.info(
    `Poll scan complete: ${requestedPages.length} English article(s) queued for translation.`
  )

  const results: TranslationJobResult[] = []

  // 3. Process sequentially by default
  for (const { page, meta } of requestedPages) {
    if (shouldStop()) {
      logger.info(
        'Shutdown signal active; stopping before starting next queued article.'
      )
      break
    }

    const normId = normalizeNotionId(meta.id)
    if (activePageIds.has(normId)) {
      logger.warn(
        `Skipping page "${meta.title}" (${meta.id}) because it is already being processed in this worker.`
      )
      continue
    }

    activePageIds.add(normId)
    try {
      logger.info(
        `Starting translation job for "${meta.title}" (${meta.id})...`
      )
      const jobResult = await processTranslationJob(page, {
        ...options,
        config,
        client,
        dataSourceInfo,
        allDatabasePages,
        dryRun,
        logger,
      })
      results.push(jobResult)

      if (jobResult.targetPageId && !dryRun) {
        try {
          const updatedPages = await queryAllPages(
            client,
            dataSourceInfo as Awaited<
              ReturnType<typeof resolveArticlesDataSource>
            >,
            {},
            { config, logger, retryOptions: options.retryOptions }
          )
          allDatabasePages.length = 0
          allDatabasePages.push(...updatedPages)
        } catch {
          // Ignore refresh error; next cycle will re-query
        }
      }
    } finally {
      activePageIds.delete(normId)
    }
  }

  const allOutcomes = [...recoveredJobs, ...results]
  let succeededCount = 0
  let needsReviewCount = 0
  let failedCount = 0

  for (const outcome of allOutcomes) {
    if (outcome?.status === TRANSLATION_STATUS.DRAFT_READY) {
      succeededCount += 1
    } else if (outcome?.status === TRANSLATION_STATUS.NEEDS_REVIEW) {
      needsReviewCount += 1
    } else if (outcome?.status === TRANSLATION_STATUS.FAILED) {
      failedCount += 1
    }
  }

  const summary: PollCycleSummary = {
    scannedCount: allDatabasePages.length,
    requestedCount: requestedPages.length,
    processedCount: results.length,
    succeededCount,
    needsReviewCount,
    failedCount,
    recoveredCount: recoveredJobs.length,
    recoveredJobs,
    results,
    hasFailures: failedCount > 0,
  }

  logger.info('Poll cycle summary', {
    scannedCount: summary.scannedCount,
    requestedCount: summary.requestedCount,
    succeededCount: summary.succeededCount,
    needsReviewCount: summary.needsReviewCount,
    failedCount: summary.failedCount,
    recoveredCount: summary.recoveredCount,
  })

  return summary
}

export interface StartPollerOptions extends RunPollCycleOptions {
  once?: boolean
  pollIntervalMs?: number
  skipLock?: boolean
  registerSignalHandlers?: boolean
  client?: Client
  config?: TranslationConfig
}

export interface PollerRunResult {
  cyclesCompleted: number
  lastCycleSummary: PollCycleSummary | null
  hasFailedJobs: boolean
  exitCode: 0 | 1
  requestStop: (signal?: string) => void
}

/**
 * Starts the single-loop async polling worker.
 * Supports `--once`, `--dry-run`, and graceful SIGINT/SIGTERM shutdown.
 */
export async function startPoller(
  options: StartPollerOptions = {}
): Promise<PollerRunResult> {
  const config = options.config || getTranslationConfig(options)
  const logger = options.logger || defaultLogger
  const once = Boolean(options.once ?? config.once)
  const dryRun = Boolean(options.dryRun ?? config.dryRun)
  const pollIntervalMs =
    Number(options.pollIntervalMs ?? config.pollIntervalMs) || 60000

  const validation = validateConfig(config, {
    requireAi: typeof options.aiAdapter !== 'function',
  })
  if (!validation.valid) {
    const msg = `Invalid worker configuration:\n- ${validation.errors.join('\n- ')}`
    logger.error(msg)
    throw new Error(msg)
  }

  const lock = acquireWorkerLock(
    options.skipLock ? null : config.lockFilePath,
    logger
  )

  let stopping = false
  let wakeUpSleep: (() => void) | null = null
  const activePageIds = new Set<string>()

  function requestStop(signal = 'SIGTERM'): void {
    if (stopping) return
    stopping = true
    logger.info(
      `Received ${signal}. Finishing active translation job (if any) before exiting...`
    )
    if (typeof wakeUpSleep === 'function') {
      wakeUpSleep()
    }
  }

  function interruptibleSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (stopping) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        wakeUpSleep = null
        resolve()
      }, ms)
      wakeUpSleep = () => {
        clearTimeout(timer)
        wakeUpSleep = null
        resolve()
      }
    })
  }

  const onSigInt = () => requestStop('SIGINT')
  const onSigTerm = () => requestStop('SIGTERM')

  if (options.registerSignalHandlers !== false) {
    process.once('SIGINT', onSigInt)
    process.once('SIGTERM', onSigTerm)
  }

  const client = options.client || createNotionClient(config)
  let cyclesCompleted = 0
  let lastCycleSummary: PollCycleSummary | null = null

  logger.info('Local Notion AI Translation Worker started', {
    mode: once ? 'once' : 'continuous-polling',
    dryRun,
    pollIntervalMs,
    targetLocale: config.targetLocale,
    aiProvider: config.aiProvider,
    aiModel: config.aiModel,
  })

  try {
    while (!stopping) {
      cyclesCompleted += 1
      try {
        lastCycleSummary = await runPollCycle({
          ...options,
          config,
          client,
          dryRun,
          logger,
          activePageIds,
          shouldStop: () => stopping,
        })
      } catch (cycleErr) {
        const errMessage =
          cycleErr instanceof Error ? cycleErr.message : String(cycleErr)
        logger.error(
          `Error during polling cycle #${cyclesCompleted}: ${errMessage}`,
          cycleErr instanceof Error ? cycleErr : { error: errMessage }
        )
        if (once) throw cycleErr
      }

      if (once || stopping) {
        break
      }

      logger.info(
        `Waiting ${Math.round(pollIntervalMs / 1000)}s until next poll cycle...`
      )
      await interruptibleSleep(pollIntervalMs)
    }
  } finally {
    if (options.registerSignalHandlers !== false) {
      process.removeListener('SIGINT', onSigInt)
      process.removeListener('SIGTERM', onSigTerm)
    }
    lock.release()
    logger.info('Local Notion AI Translation Worker stopped cleanly.', {
      cyclesCompleted,
    })
  }

  const hasFailedJobs = Boolean(
    lastCycleSummary && lastCycleSummary.failedCount > 0
  )

  return {
    cyclesCompleted,
    lastCycleSummary,
    hasFailedJobs,
    exitCode: once && hasFailedJobs ? 1 : 0,
    requestStop,
  }
}

