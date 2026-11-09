import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import defaultGlossaryJson from './servicenow-glossary.json'

export interface ServiceNowGlossaryData {
  version: string
  preserveExactTerms: string[]
  preserveCaseSensitiveAcronyms: string[]
  contextSensitiveTerms: string[]
  knownTables: string[]
  knownFields: string[]
  customObjectNames: string[]
}

export interface ProtectedTextResult {
  protectedText: string
  placeholders: Map<string, string>
  matchedTerms: string[]
  isFullyProtected: boolean
}

export interface TerminologyProtectionOptions {
  glossaryFilePath?: string
  customProtectedTerms?: readonly string[]
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function uniqueSortedByLengthDesc(items: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of items) {
    const trimmed = String(raw || '').trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out.sort((a, b) => b.length - a.length)
}

function uniqueCaseSensitiveSortedByLengthDesc(items: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of items) {
    const trimmed = String(raw || '').trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out.sort((a, b) => b.length - a.length)
}

let cachedGlossaryKey = ''
let cachedGlossaryData: ServiceNowGlossaryData | null = null
let cachedGlossaryHash = ''

export function loadServiceNowGlossary(
  options: TerminologyProtectionOptions = {}
): { glossary: ServiceNowGlossaryData; hash: string } {
  const filePath = (options.glossaryFilePath || '').trim()
  const customTerms = (options.customProtectedTerms || [])
    .map((t) => t.trim())
    .filter(Boolean)
  const cacheKey = `${filePath}::${customTerms.join('|')}`

  if (cachedGlossaryData && cachedGlossaryKey === cacheKey) {
    return { glossary: cachedGlossaryData, hash: cachedGlossaryHash }
  }

  let externalData: Partial<ServiceNowGlossaryData> = {}
  if (filePath) {
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.join(process.cwd(), filePath)
    if (fs.existsSync(resolved)) {
      try {
        externalData = JSON.parse(
          fs.readFileSync(resolved, 'utf8')
        ) as Partial<ServiceNowGlossaryData>
      } catch {
        // Fallback to default glossary if custom file is unreadable
      }
    }
  }

  const merged: ServiceNowGlossaryData = {
    version: externalData.version || defaultGlossaryJson.version || '1.0.0',
    preserveExactTerms: uniqueSortedByLengthDesc([
      ...(defaultGlossaryJson.preserveExactTerms || []),
      ...(externalData.preserveExactTerms || []),
    ]),
    preserveCaseSensitiveAcronyms: uniqueCaseSensitiveSortedByLengthDesc([
      ...(defaultGlossaryJson.preserveCaseSensitiveAcronyms || []),
      ...(externalData.preserveCaseSensitiveAcronyms || []),
    ]),
    contextSensitiveTerms: uniqueSortedByLengthDesc([
      ...(defaultGlossaryJson.contextSensitiveTerms || []),
      ...(externalData.contextSensitiveTerms || []),
    ]),
    knownTables: uniqueSortedByLengthDesc([
      ...(defaultGlossaryJson.knownTables || []),
      ...(externalData.knownTables || []),
    ]),
    knownFields: uniqueSortedByLengthDesc([
      ...(defaultGlossaryJson.knownFields || []),
      ...(externalData.knownFields || []),
    ]),
    customObjectNames: uniqueSortedByLengthDesc([
      ...(defaultGlossaryJson.customObjectNames || []),
      ...(externalData.customObjectNames || []),
      ...customTerms,
    ]),
  }

  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(merged))
    .digest('hex')
    .slice(0, 12)

  cachedGlossaryKey = cacheKey
  cachedGlossaryData = merged
  cachedGlossaryHash = hash

  return { glossary: merged, hash }
}

/**
 * Checks whether a text segment is purely technical/non-lexical (e.g. a standalone table name,
 * field name, sys_id, API call, URL, or placeholder) and requires zero AI translation.
 */
export function isPureTechnicalText(text: string): boolean {
  const trimmed = String(text || '').trim()
  if (!trimmed) return true

  // 1. Standalone 32-char hex sys_id
  if (/^[0-9a-fA-F]{32}$/.test(trimmed)) return true

  // 2. Standalone ticket/record number
  if (
    /^(?:RITM|SCTASK|REQ|INC|CHG|CTASK|PRB|PTASK|KB|TASK|CS|HR|SIR|VUL)\d{4,12}$/i.test(
      trimmed
    )
  ) {
    return true
  }

  // 3. Standalone snake_case identifier or dot-walked field path
  if (/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/.test(trimmed)) {
    // Only if it has an underscore or dot
    if (trimmed.includes('_') || trimmed.includes('.')) return true
  }

  // 4. Standalone URL or API path
  if (/^(?:https?:\/\/\S+|\/(?:api|now|sp|esc)\/[A-Za-z0-9_./-]+)$/i.test(trimmed)) {
    return true
  }

  // 5. Standalone Glide* / gs.* / g_form.* call
  if (
    /^(?:Glide[A-Za-z]+|gs|g_form|g_user|g_scratchpad|g_list|current|previous|producer)(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\([^()\r\n]*\))?)*$/.test(
      trimmed
    )
  ) {
    return true
  }

  return false
}

/**
 * Protects official ServiceNow terms, custom object names, table/field identifiers,
 * sys_ids, API calls, URLs, and paths using compact placeholders (`__SN0__`, `__SN1__`, ...).
 */
export function protectServiceNowTerminology(
  rawText: string,
  options: TerminologyProtectionOptions = {}
): ProtectedTextResult {
  const text = String(rawText ?? '')
  const placeholders = new Map<string, string>()
  const reverseLookup = new Map<string, string>()
  const matchedTermsSet = new Set<string>()

  if (!text.trim()) {
    return {
      protectedText: text,
      placeholders,
      matchedTerms: [],
      isFullyProtected: true,
    }
  }

  const { glossary } = loadServiceNowGlossary(options)

  function allocatePlaceholder(originalValue: string): string {
    const existing = reverseLookup.get(originalValue)
    if (existing) return existing
    const token = `__SN${placeholders.size}__`
    placeholders.set(token, originalValue)
    reverseLookup.set(originalValue, token)
    matchedTermsSet.add(originalValue)
    return token
  }

  function replaceMatches(input: string, regex: RegExp): string {
    return input.replace(regex, (match) => {
      if (/^__SN\d+__$/.test(match)) return match
      return allocatePlaceholder(match)
    })
  }

  let working = text

  // 1. Protect URLs, REST endpoint paths, and Windows/Unix file paths
  working = replaceMatches(
    working,
    /\bhttps?:\/\/[^\s<>")]+|(?<![A-Za-z0-9])\/(?:api|now|sp|esc)\/[A-Za-z0-9_./-]+/g
  )

  // 2. Protect ServiceNow encoded queries (e.g. active=true^ORDERBYDESC...)
  working = replaceMatches(
    working,
    /\b[a-z][a-z0-9_.]*=(?:true|false|NULL|[^\s^,;()]+)\^[A-Za-z0-9_!=^><.@]+\b/g
  )

  // 3. Protect 32-character hexadecimal sys_ids and ServiceNow record numbers
  working = replaceMatches(working, /\b[0-9a-fA-F]{32}\b/g)
  working = replaceMatches(
    working,
    /\b(?:RITM|SCTASK|REQ|INC|CHG|CTASK|PRB|PTASK|KB|TASK|CS|HR|SIR|VUL)\d{4,12}\b/g
  )

  // 4. Protect ServiceNow APIs & dot-walked chains (Glide*, gs.*, g_form.*, current.*, etc.)
  working = replaceMatches(
    working,
    /\b(?:GlideRecord|GlideRecordSecure|GlideAggregate|GlideAjax|GlideSystem|GlideDateTime|GlideDate|GlideTime|GlideDuration|GlideElement|GlideFilter|GlideSession|GlideURI|GlideSysAttachment|RESTMessageV2|SOAPMessageV2)(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\([^()\r\n]*\))?)*\b/g
  )
  working = replaceMatches(
    working,
    /\b(?:gs|g_form|g_user|g_scratchpad|g_list|g_aw|g_navigation|current|previous|producer|inputs|outputs|fd_data)\.[A-Za-z_][A-Za-z0-9_.]*(?:\([^()\r\n]*\))?/g
  )

  // 5. Protect snake_case identifiers (table names like sc_req_item, cmdb_ci, field names like short_description, sys_id, u_*, x_*)
  working = replaceMatches(
    working,
    /\b[a-z][a-z0-9_]*_[a-z0-9_]+(?:\.[a-z][a-z0-9_]*)*\b/g
  )

  // 6. Protect dot-walked lowercase field chains (e.g. caller_id.department.name, cat_item.name)
  working = replaceMatches(
    working,
    /\b[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+\b/g
  )

  // 7. Protect single-word known table/field names when directly paired with "table" or "field" or "column"
  const singleWordTablesAndFields = uniqueSortedByLengthDesc([
    ...glossary.knownTables.filter((t) => !t.includes('_')),
    ...glossary.knownFields.filter((f) => !f.includes('_')),
  ])
  if (singleWordTablesAndFields.length > 0) {
    const tableFieldAlt = singleWordTablesAndFields.map(escapeRegExp).join('|')
    const beforeTableOrFieldRegex = new RegExp(
      `\\b(${tableFieldAlt})(?=\\s+(?:table|tables|field|fields|column|columns)\\b)`,
      'gi'
    )
    working = working.replace(beforeTableOrFieldRegex, (match) => {
      if (/^__SN\d+__$/.test(match)) return match
      return allocatePlaceholder(match)
    })
  }

  // 8. Protect configured custom ServiceNow object names (exact match, case-insensitive)
  if (glossary.customObjectNames.length > 0) {
    const customPattern = glossary.customObjectNames
      .map(escapeRegExp)
      .join('|')
    const customRegex = new RegExp(`\\b(?:${customPattern})\\b`, 'gi')
    working = replaceMatches(working, customRegex)
  }

  // 9. Protect dynamically detected Title-Case or quoted custom object names immediately preceding a ServiceNow object type
  //    e.g., "Configure the New Hire Hardware Request catalog item" -> protects "New Hire Hardware Request"
  //    or 'the "Onboard Employee" flow' -> protects '"Onboard Employee"'
  const objectTypeSuffixAlt = [
    'catalog item',
    'record producer',
    'order guide',
    'variable set',
    'update set',
    'business rule',
    'script include',
    'client script',
    'ui policy',
    'ui action',
    'flow',
    'subflow',
    'action',
    'assignment group',
    'workspace',
    'scoped application',
    'transform map',
    'import set',
    'data source',
  ].join('|')

  const quotedObjectBeforeTypeRegex = new RegExp(
    `(["“][^"”\\r\\n]{2,80}["”])(?=\\s+(?:${objectTypeSuffixAlt})s?\\b)`,
    'gi'
  )
  working = working.replace(quotedObjectBeforeTypeRegex, (match) => {
    if (/^__SN\d+__$/.test(match)) return match
    return allocatePlaceholder(match)
  })

  const titleCaseObjectBeforeTypeRegex = new RegExp(
    `(?<=\\b(?:the|a|an|for|in|on|to|from|of|named|called)\\s+)([A-Z][A-Za-z0-9/&-]+(?:\\s+[A-Z][A-Za-z0-9/&-]+){1,6})(?=\\s+(?:${objectTypeSuffixAlt})s?\\b)`,
    'g'
  )
  working = working.replace(titleCaseObjectBeforeTypeRegex, (match) => {
    if (/^__SN\d+__$/.test(match)) return match
    return allocatePlaceholder(match)
  })

  // 10. Protect official multi-word ServiceNow terms (case-insensitive, with optional plural s/es)
  if (glossary.preserveExactTerms.length > 0) {
    const multiWordPatterns = glossary.preserveExactTerms.map((term) => {
      const escaped = escapeRegExp(term)
      if (term.endsWith('y')) {
        return `${escaped.slice(0, -1)}(?:y|ies)`
      }
      return `${escaped}(?:s|es)?`
    })
    const exactTermsRegex = new RegExp(
      `\\b(?:${multiWordPatterns.join('|')})\\b`,
      'gi'
    )
    working = replaceMatches(working, exactTermsRegex)
  }

  // 11. Protect case-sensitive ServiceNow acronyms (e.g. CMDB, CSDM, CI, IRE, RITM, SCTASK, ACL, ITSM, ITOM, ITAM, HRSD, CSM)
  if (glossary.preserveCaseSensitiveAcronyms.length > 0) {
    const acronymPatterns = glossary.preserveCaseSensitiveAcronyms.map(
      (acr) => `${escapeRegExp(acr)}s?`
    )
    const acronymRegex = new RegExp(
      `\\b(?:${acronymPatterns.join('|')})\\b`,
      'g'
    )
    working = replaceMatches(working, acronymRegex)
  }

  // 12. Protect Named Workspaces / Applications / Modules / Flows when Title-Cased (e.g. "Service Operations Workspace", "Agent Workspace", "HR Agent Workspace")
  working = replaceMatches(
    working,
    /\b(?:[A-Z][A-Za-z0-9]+\s+){1,4}(?:Workspace|Portal|Center|Navigator|Builder|Studio|Designer|Discovery)\b/g
  )

  // Check if the remaining text outside placeholders has any translatable words
  const strippedOfPlaceholders = working
    .replace(/__SN\d+__/g, '')
    .replace(/[\s\p{P}\p{N}\p{S}]+/gu, '')
  const isFullyProtected =
    strippedOfPlaceholders.length === 0 || isPureTechnicalText(text)

  return {
    protectedText: working,
    placeholders,
    matchedTerms: Array.from(matchedTermsSet),
    isFullyProtected,
  }
}

/**
 * Verifies that all placeholders (`__SN0__`, `__SN1__`, ...) present in the protected source text
 * remain intact in the translated output.
 */
export function verifyPlaceholdersIntact(
  translatedText: string,
  placeholders: ReadonlyMap<string, string>
): { valid: boolean; missingPlaceholders: string[] } {
  if (!placeholders || placeholders.size === 0) {
    return { valid: true, missingPlaceholders: [] }
  }

  const missingPlaceholders: string[] = []
  const output = String(translatedText ?? '')

  for (const token of placeholders.keys()) {
    const tokenPattern = new RegExp(escapeRegExp(token), 'i')
    if (!tokenPattern.test(output)) {
      missingPlaceholders.push(token)
    }
  }

  return {
    valid: missingPlaceholders.length === 0,
    missingPlaceholders,
  }
}

/**
 * Restores all `__SN<n>__` placeholders back to their original protected ServiceNow terms.
 */
export function restoreServiceNowTerminology(
  translatedText: string,
  placeholders: ReadonlyMap<string, string>
): string {
  if (!placeholders || placeholders.size === 0) {
    return String(translatedText ?? '')
  }

  let restored = String(translatedText ?? '')
  for (const [token, originalValue] of placeholders.entries()) {
    const tokenRegex = new RegExp(escapeRegExp(token), 'gi')
    restored = restored.replace(tokenRegex, () => originalValue)
  }
  return restored
}

