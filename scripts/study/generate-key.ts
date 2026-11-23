/**
 * scripts/study/generate-key.ts — Local CLI for generating Study Room access keys
 * ───────────────────────────────────────────────────────────────────────────────
 * Usage:
 *   pnpm run study:gen-key
 *   pnpm run study:gen-key -- --username student.one
 *
 * Generates a cryptographically random access key and its salted `scrypt-v1`
 * hash for manual provisioning in the private Notion "Study Users" database.
 * Never writes credentials to disk or commits anything.
 */

import { generateAccessKey, hashAccessKey } from '../../lib/study/auth/crypto'
import { normalizeUsername } from '../../lib/study/schemas'

function parseArg(flag: string): string | null {
  const idx = process.argv.indexOf(flag)
  if (idx === -1 || idx + 1 >= process.argv.length) return null
  return process.argv[idx + 1]
}

function main() {
  const rawUsername = parseArg('--username')
  let normalizedUser: string | null = null
  if (rawUsername) {
    try {
      normalizedUser = normalizeUsername(rawUsername)
    } catch (err) {
      console.error(`Invalid --username: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  }

  const accessKey = generateAccessKey(24)
  const { accessKeyHash, hashVersion } = hashAccessKey(accessKey)

  console.log('\nPrivate Study Room — Access Key Generator')
  console.log('─────────────────────────────────────────────────────────────')
  if (normalizedUser) {
    console.log(`Username           : ${normalizedUser}`)
  }
  console.log(`Plain Access Key   : ${accessKey}`)
  console.log(`Access Key Hash    : ${accessKeyHash}`)
  console.log(`Hash Version       : ${hashVersion}`)
  console.log(`Credential Version : 1`)
  console.log('─────────────────────────────────────────────────────────────')
  console.log('1. Share "Plain Access Key" with the user via a secure channel (never store it in Notion).')
  console.log('2. Paste "Access Key Hash" and "Hash Version" into the Notion "Study Users" database.')
  console.log('3. To revoke or rotate access later, set Status = revoked or increment Credential Version.\n')
}

main()
