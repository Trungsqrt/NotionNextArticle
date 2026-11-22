/**
 * scripts/study/import-exams.ts — CLI for importing local HTML exam banks
 * ────────────────────────────────────────────────────────────────────────
 * Usage:
 *   pnpm study:import --source "<absolute-folder-path>" --dry-run
 *   pnpm study:import --source "<absolute-folder-path>"
 *   pnpm study:import --source "<absolute-folder-path>" --dry-run --json
 */

import path from 'node:path'
import { getStudyNotionConfig } from '../../lib/study/config'
import { createStudyNotionClient } from '../../lib/study/notion-client'
import {
  runStudyExamImport,
  type ImportDryRunReport,
} from '../../lib/study/importer/import-exams'

function parseFlagValue(flag: string): string | null {
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) return args[i + 1]
    if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1)
  }
  return null
}

function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag)
}

function printHumanReport(report: ImportDryRunReport): void {
  console.log('\nPrivate Study Room — Exam Import Dry-Run Report')
  console.log('─────────────────────────────────────────────────────────────')
  console.log(`Source Directory          : ${report.sourceDir}`)
  console.log(`Per-File Size Limit       : ${(report.maxFileBytes / (1024 * 1024)).toFixed(1)} MB (Notion Free Plan)`)
  console.log(`HTML Files Discovered     : ${report.htmlFilesDiscovered.length}`)
  console.log(`Total Questions Detected  : ${report.totalQuestions}`)
  console.log(`Image References Detected : ${report.imageReferencesDetected}`)
  console.log(`Unique Image Files Found  : ${report.uniqueImageFilesFound}`)
  console.log(`Missing Image Files       : ${report.missingImageFiles.length}`)
  console.log(`Oversized Image Files     : ${report.oversizedImageFiles.length}`)
  console.log(`Invalid Image References  : ${report.invalidImageReferences.length}`)
  console.log(`Duplicate Image Refs      : ${report.duplicateImageReferences.length}`)
  console.log(`Content Validation Errors : ${report.validationErrors.length}`)
  console.log(`Ready for Import          : ${report.canProceedToImport ? 'YES' : 'NO'}`)

  if (report.questionsPerExam.length > 0) {
    console.log('\nQuestions per Exam:')
    for (const exam of report.questionsPerExam) {
      console.log(`  - [${exam.examId}] ${exam.file} -> ${exam.questionCount} questions`)
    }
  }

  if (report.missingImageFiles.length > 0) {
    console.log('\nMissing Image Files:')
    for (const m of report.missingImageFiles) {
      console.log(`  - ${m.file} (${m.questionId}, ${m.placement}): ${m.sourceRef}`)
    }
  }

  if (report.oversizedImageFiles.length > 0) {
    console.log('\nOversized Image Files (exceeds per-file limit):')
    for (const ov of report.oversizedImageFiles) {
      const mb = (ov.byteLength / (1024 * 1024)).toFixed(2)
      const limitMb = (ov.maxFileBytes / (1024 * 1024)).toFixed(2)
      console.log(`  - ${ov.file} (${ov.questionId}, ${ov.placement}): ${ov.sourceRef} (${mb} MB > ${limitMb} MB)`)
    }
  }

  if (report.invalidImageReferences.length > 0) {
    console.log('\nInvalid Image References:')
    for (const inv of report.invalidImageReferences) {
      console.log(`  - ${inv.file} (${inv.questionId}, ${inv.placement}): ${inv.sourceRef} — ${inv.reason}`)
    }
  }

  if (report.duplicateImageReferences.length > 0) {
    console.log('\nDuplicate Image References:')
    for (const dup of report.duplicateImageReferences) {
      console.log(`  - ${dup.relativePath} (${dup.count}x): ${dup.referencedBy.join(', ')}`)
    }
  }

  if (report.validationErrors.length > 0) {
    console.log('\nContent Validation Errors:')
    for (const err of report.validationErrors) {
      console.log(`  - ${err.file} (${err.questionId}): ${err.message}`)
    }
  }
  console.log('─────────────────────────────────────────────────────────────\n')
}

async function main() {
  const rawSource = parseFlagValue('--source')
  const dryRun = hasFlag('--dry-run')
  const jsonOutput = hasFlag('--json')

  if (!rawSource) {
    console.error('Usage: pnpm study:import --source "<absolute-folder-path>" [--dry-run] [--json]')
    process.exit(1)
  }

  const sourceDir = path.resolve(rawSource)

  try {
    if (dryRun) {
      const summary = await runStudyExamImport({ sourceDir, dryRun: true })
      if (jsonOutput) {
        console.log(JSON.stringify(summary.report, null, 2))
      } else {
        printHumanReport(summary.report)
      }
      if (!summary.report.canProceedToImport) {
        process.exit(2)
      }
      return
    }

    const config = getStudyNotionConfig()
    const client = createStudyNotionClient(config)
    const summary = await runStudyExamImport({
      sourceDir,
      dryRun: false,
      client,
      config,
    })

    if (jsonOutput) {
      console.log(JSON.stringify(summary, null, 2))
    } else {
      printHumanReport(summary.report)
      console.log('Import Execution Summary:')
      console.log(`  Exams Upserted               : ${summary.examsUpserted}`)
      console.log(`  Questions Created            : ${summary.questionsCreated}`)
      console.log(`  Questions Updated            : ${summary.questionsUpdated}`)
      console.log(`  Questions Skipped (Unchanged): ${summary.questionsSkippedUnchanged}`)
      console.log(`  Images Uploaded              : ${summary.imagesUploaded}`)
      console.log(`  Images Reused (Checkpoint)   : ${summary.imagesReusedFromCheckpoint}`)
      if (summary.stateFilePath) {
        console.log(`  Checkpoint State File        : ${summary.stateFilePath}`)
      }
    }
  } catch (err) {
    console.error(`Study import failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

main()
