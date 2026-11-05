'use strict'

const fs = require('node:fs')
const os = require('node:os')
const { TRANSLATION_STATUS, getTranslationConfig, validateConfig } = require('../lib/notion-translation/config')
const {
  createNotionClient,
  resolveArticlesDataSource,
  ensureTranslationSchema,
  queryAllPages,
  normalizeNotionId,
} = require('../lib/notion-translation/notion-client')
const {
  extractPageWorkflowMeta,
  processTranslationJob,
  recoverStaleProcessingPages,
} = require('../lib/notion-translation/workflow')
const { defaultLogger } = require('./logger')

function isProcessAlive(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // ESRCH = no such process; EPERM = process exists under another user
    return err?.code === 'EPERM'
  }
}

/**
 * Acquires a local single-instance lock file to prevent multiple worker processes
 * from concurrently polling and translating the same Notion pages.
 * Automatically recovers stale lock files left behind by dead processes.
 */
function acquireWorkerLock(lockFilePath, logger = defaultLogger) {
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

  function tryWriteExclusive() {
    const fd = fs.openSync(lockFilePath, 'wx')
    try {
      fs.writeFileSync(fd, payload, 'utf8')
    } finally {
      fs.closeSync(fd)
    }
  }

  try {
    tryWriteExclusive()
  } catch (err) {
    if (err?.code !== 'EEXIST') {
      throw err
    }

    // Lock file already exists; inspect whether the owning PID is still alive
    let existingLock = null
    try {
      existingLock = JSON.parse(fs.readFileSync(lockFilePath, 'utf8'))
    } catch {
      existingLock = null
    }

    if (existingLock?.pid && isProcessAlive(existingLock.pid)) {
      const lockErr = new Error(
        `Another translation worker instance is already running (PID ${existingLock.pid}, started at ${existingLock.startedAt}).`
      )
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
  function release() {
    if (released) return
    released = true
    try {
      if (fs.existsSync(lockFilePath)) {
        const current = JSON.parse(fs.readFileSync(lockFilePath, 'utf8'))
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

/**
 * Runs a single polling cycle:
 * 1. Resolves Articles database & ensures schema properties exist.
 * 2. Recovers any stale `Processing` jobs (>30m) safely.
 * 3. Finds pages with `Translation Status = Requested` and `Locale = en` (or missing Locale).
 * 4. Processes each requested page sequentially.
 */
async function runPollCycle(options = {}) {
  const config = options.config || getTranslationConfig(options)
  const logger = options.logger || defaultLogger
  const dryRun = Boolean(options.dryRun ?? config.dryRun)
  const client = options.client || createNotionClient(config)
  const activePageIds = options.activePageIds || new Set()
  const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : () => false

  const dataSourceInfo =
    options.dataSourceInfo ||
    (await resolveArticlesDataSource(client, config, {
      logger,
      retryOptions: options.retryOptions,
    }))

  await ensureTranslationSchema(client, dataSourceInfo, {
    dryRun,
    logger,
    retryOptions: options.retryOptions,
  })

  // Fetch all pages in the Articles database so we can:
  // - Recover stale Processing jobs
  // - Check existing Vietnamese translations across both Published and Draft pages
  // - Process all Requested English pages
  const allDatabasePages = await queryAllPages(
    client,
    dataSourceInfo,
    {},
    { logger, retryOptions: options.retryOptions }
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
  const requestedPages = []
  const skippedNonEnglish = []

  for (const page of allDatabasePages) {
    if (!page || page.in_trash || page.archived) continue
    const meta = extractPageWorkflowMeta(page, dataSourceInfo)

    if (options.targetPageId) {
      if (normalizeNotionId(meta.id) === normalizeNotionId(options.targetPageId)) {
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
    logger.info(`Ignored ${skippedNonEnglish.length} Requested page(s) with non-English locale`, {
      pages: skippedNonEnglish.map(m => ({ id: m.id, locale: m.locale, title: m.title })),
    })
  }

  logger.info(`Poll scan complete: ${requestedPages.length} English article(s) queued for translation.`)

  const results = []

  // 3. Process sequentially by default
  for (const { page, meta } of requestedPages) {
    if (shouldStop()) {
      logger.info('Shutdown signal active; stopping before starting next queued article.')
      break
    }

    const normId = normalizeNotionId(meta.id)
    if (activePageIds.has(normId)) {
      logger.warn(`Skipping page "${meta.title}" (${meta.id}) because it is already being processed in this worker.`)
      continue
    }

    activePageIds.add(normId)
    try {
      logger.info(`Starting translation job for "${meta.title}" (${meta.id})...`)
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

      // Refresh allDatabasePages in-memory list if a new page was created so subsequent jobs in the same batch see it
      if (jobResult.targetPageId && !dryRun) {
        try {
          const updatedPages = await queryAllPages(
            client,
            dataSourceInfo,
            {},
            { logger, retryOptions: options.retryOptions }
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

  return {
    scannedCount: allDatabasePages.length,
    requestedCount: requestedPages.length,
    processedCount: results.length,
    recoveredCount: recoveredJobs.length,
    recoveredJobs,
    results,
  }
}

/**
 * Starts the single-loop async polling worker (no overlapping setInterval).
 * Supports `--once`, `--dry-run`, and graceful SIGINT/SIGTERM shutdown.
 */
async function startPoller(options = {}) {
  const config = options.config || getTranslationConfig(options)
  const logger = options.logger || defaultLogger
  const once = Boolean(options.once ?? config.once)
  const dryRun = Boolean(options.dryRun ?? config.dryRun)
  const pollIntervalMs = Number(options.pollIntervalMs ?? config.pollIntervalMs) || 60000

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
  let wakeUpSleep = null
  const activePageIds = new Set()

  function requestStop(signal = 'SIGTERM') {
    if (stopping) return
    stopping = true
    logger.info(`Received ${signal}. Finishing active translation job (if any) before exiting...`)
    if ( typeof wakeUpSleep === 'function' ) {
      wakeUpSleep()
    }
  }

  function interruptibleSleep(ms) {
    return new Promise(resolve => {
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
  let lastCycleSummary = null

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
        logger.error(`Error during polling cycle #${cyclesCompleted}: ${cycleErr.message}`, cycleErr)
        if (once) throw cycleErr
      }

      if (once || stopping) {
        break
      }

      logger.info(`Waiting ${Math.round(pollIntervalMs / 1000)}s until next poll cycle...`)
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

  return {
    cyclesCompleted,
    lastCycleSummary,
    requestStop,
  }
}

module.exports = {
  startPoller,
  runPollCycle,
  acquireWorkerLock,
  isProcessAlive,
}
