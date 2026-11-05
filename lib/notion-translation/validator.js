'use strict'

const { normalizeTreeNodes } = require('./reader')
const { classifyBlock } = require('./block-classifier')

function flattenBlocks(treeOrNodes, depth = 0, parentType = 'root') {
  const nodes = normalizeTreeNodes(treeOrNodes)
  const list = []

  for (let idx = 0; idx < nodes.length; idx++) {
    const node = nodes[idx]
    if (!node) continue
    const raw = node.raw || node
    const type = node.type || raw.type || 'unsupported'
    list.push({
      id: node.id || raw.id || `idx-${idx}`,
      type,
      position: node.position ?? String(idx),
      depth,
      parentType,
      raw,
      node,
    })
    if (Array.isArray(node.children) && node.children.length > 0) {
      list.push(...flattenBlocks(node.children, depth + 1, type))
    }
  }

  return list
}

function normalizeComparableBlockType(type) {
  if (type === 'child_page' || type === 'child_database') return 'link_to_page'
  if (type === 'heading_5' || type === 'heading_6') return 'heading_4'
  return type
}

function getRichTextPlain(richTextArr) {
  if (!Array.isArray(richTextArr)) return ''
  return richTextArr
    .map(r => r?.text?.content ?? r?.plain_text ?? r?.equation?.expression ?? '')
    .join('')
}

function collectRichTextLinks(richTextArr) {
  if (!Array.isArray(richTextArr)) return []
  const urls = []
  for (const r of richTextArr) {
    const url = r?.text?.link?.url || r?.href
    if (url) urls.push(url)
  }
  return urls
}

function collectInlineEquations(richTextArr) {
  if (!Array.isArray(richTextArr)) return []
  const exprs = []
  for (const r of richTextArr) {
    if ((r?.type === 'equation' || r?.equation) && r.equation?.expression) {
      exprs.push(r.equation.expression)
    }
  }
  return exprs
}

function extractAllBlockLinks(rawBlock) {
  if (!rawBlock || !rawBlock.type) return []
  const type = rawBlock.type
  const payload = rawBlock[type] || {}
  const links = []

  if (Array.isArray(payload.rich_text)) {
    links.push(...collectRichTextLinks(payload.rich_text))
  }
  if (Array.isArray(payload.caption)) {
    links.push(...collectRichTextLinks(payload.caption))
  }
  if (type === 'table_row' && Array.isArray(payload.cells)) {
    for (const cell of payload.cells) {
      links.push(...collectRichTextLinks(cell))
    }
  }
  if ((type === 'bookmark' || type === 'embed') && payload.url) {
    links.push(payload.url)
  }
  return links
}

function extractAllInlineEquations(rawBlock) {
  if (!rawBlock || !rawBlock.type) return []
  const type = rawBlock.type
  const payload = rawBlock[type] || {}
  const equations = []

  if (Array.isArray(payload.rich_text)) {
    equations.push(...collectInlineEquations(payload.rich_text))
  }
  if (Array.isArray(payload.caption)) {
    equations.push(...collectInlineEquations(payload.caption))
  }
  if (type === 'table_row' && Array.isArray(payload.cells)) {
    for (const cell of payload.cells) {
      equations.push(...collectInlineEquations(cell))
    }
  }
  return equations
}

function hasValidMediaSource(rawBlock) {
  if (!rawBlock || !rawBlock.type) return false
  const payload = rawBlock[rawBlock.type] || {}
  if (payload.external?.url) return true
  if (payload.file?.url) return true
  if (payload.file_upload?.id) return true
  return false
}

/**
 * Compares the source Notion block tree with the target translated block tree.
 * Verifies:
 * 1. Block counts by type
 * 2. Nested hierarchy & block order
 * 3. Table row and cell counts
 * 4. Code block contents & language
 * 5. Equation / formula contents
 * 6. Link destinations
 * 7. Image / media availability
 * 8. Unsupported or missing content
 */
function validateTranslation(sourceTree, targetTree, context = {}) {
  const unsupportedBlocks = [...(context.unsupportedBlocks || [])]
  const missingMedia = [...(context.missingMedia || [])]
  const linkedResources = [...(context.linkedResources || [])]
  const syncedBlocks = [...(context.syncedBlocks || [])]
  const validationErrors = []
  const warnings = []

  const skippedSourceIds = new Set([
    ...unsupportedBlocks.map(b => b.id),
    ...missingMedia.map(m => m.id),
  ])

  const sourceFlat = flattenBlocks(sourceTree)
  const targetFlat = flattenBlocks(targetTree)

  // Filter source blocks to those expected to exist in target
  const expectedSourceFlat = sourceFlat.filter(item => {
    const classification = classifyBlock(item.node)
    if (!classification.supported) return false
    if (skippedSourceIds.has(item.id)) return false
    return true
  })

  // 1. Compare block counts by normalized type
  const sourceCountsByType = {}
  const targetCountsByType = {}

  for (const item of expectedSourceFlat) {
    const normType = normalizeComparableBlockType(item.type)
    sourceCountsByType[normType] = (sourceCountsByType[normType] || 0) + 1
  }
  for (const item of targetFlat) {
    const normType = normalizeComparableBlockType(item.type)
    targetCountsByType[normType] = (targetCountsByType[normType] || 0) + 1
  }

  const allTypes = new Set([
    ...Object.keys(sourceCountsByType),
    ...Object.keys(targetCountsByType),
  ])

  for (const type of allTypes) {
    const srcCount = sourceCountsByType[type] || 0
    const tgtCount = targetCountsByType[type] || 0
    if (srcCount !== tgtCount) {
      validationErrors.push(
        `Block count mismatch for type "${type}": expected ${srcCount}, found ${tgtCount}`
      )
    }
  }

  // 2. Compare recursive hierarchy and block order
  function compareBranches(srcNodes, tgtNodes, pathLabel = 'root') {
    const expectedSrc = (srcNodes || []).filter(n => {
      const cls = classifyBlock(n)
      const id = n.id || n.raw?.id
      return cls.supported && !skippedSourceIds.has(id)
    })
    const actualTgt = tgtNodes || []

    if (expectedSrc.length !== actualTgt.length) {
      validationErrors.push(
        `Hierarchy child count mismatch at ${pathLabel}: expected ${expectedSrc.length} blocks, found ${actualTgt.length}`
      )
    }

    const len = Math.min(expectedSrc.length, actualTgt.length)
    for (let i = 0; i < len; i++) {
      const sNode = expectedSrc[i]
      const tNode = actualTgt[i]
      const sRaw = sNode.raw || sNode
      const tRaw = tNode.raw || tNode
      const sType = normalizeComparableBlockType(sNode.type || sRaw.type)
      const tType = normalizeComparableBlockType(tNode.type || tRaw.type)
      const itemPath = `${pathLabel}[${i}]`

      if (sType !== tType) {
        validationErrors.push(
          `Block order/type mismatch at ${itemPath}: expected "${sType}", found "${tType}"`
        )
        continue
      }

      // 3. Table & table_row verification
      if (sType === 'table') {
        const sRows = (sNode.children || []).filter(r => (r.type || r.raw?.type) === 'table_row')
        const tRows = (tNode.children || []).filter(r => (r.type || r.raw?.type) === 'table_row')
        if (sRows.length !== tRows.length) {
          validationErrors.push(
            `Table row count mismatch at ${itemPath}: expected ${sRows.length} rows, found ${tRows.length}`
          )
        }
        const sWidth = sRaw.table?.table_width
        const tWidth = tRaw.table?.table_width
        if (sWidth && tWidth && sWidth !== tWidth) {
          validationErrors.push(
            `Table width mismatch at ${itemPath}: expected ${sWidth}, found ${tWidth}`
          )
        }
      }

      if (sType === 'table_row') {
        const sCells = sRaw.table_row?.cells || []
        const tCells = tRaw.table_row?.cells || []
        if (sCells.length !== tCells.length) {
          validationErrors.push(
            `Table row cell count mismatch at ${itemPath}: expected ${sCells.length} cells, found ${tCells.length}`
          )
        }
      }

      // 4. Code block contents verification
      if (sType === 'code') {
        const sCode = getRichTextPlain(sRaw.code?.rich_text)
        const tCode = getRichTextPlain(tRaw.code?.rich_text)
        if (sCode !== tCode) {
          validationErrors.push(`Code block content was altered at ${itemPath}`)
        }
        const sLang = sRaw.code?.language || 'plain text'
        const tLang = tRaw.code?.language || 'plain text'
        if (sLang !== tLang) {
          validationErrors.push(
            `Code block language mismatch at ${itemPath}: expected "${sLang}", found "${tLang}"`
          )
        }
      }

      // 5. Equation / formula verification
      if (sType === 'equation') {
        const sExpr = sRaw.equation?.expression || ''
        const tExpr = tRaw.equation?.expression || ''
        if (sExpr !== tExpr) {
          validationErrors.push(
            `Equation expression mismatch at ${itemPath}: expected "${sExpr}", found "${tExpr}"`
          )
        }
      }

      const sInlineEqs = extractAllInlineEquations(sRaw)
      const tInlineEqs = extractAllInlineEquations(tRaw)
      if (JSON.stringify(sInlineEqs) !== JSON.stringify(tInlineEqs)) {
        validationErrors.push(
          `Inline equation mismatch at ${itemPath}: expected ${JSON.stringify(sInlineEqs)}, found ${JSON.stringify(tInlineEqs)}`
        )
      }

      // 6. Link destinations verification
      const sLinks = extractAllBlockLinks(sRaw)
      const tLinks = extractAllBlockLinks(tRaw)
      for (const link of sLinks) {
        if (!tLinks.includes(link)) {
          validationErrors.push(`Missing hyperlink destination "${link}" at ${itemPath}`)
        }
      }

      // 7. Image & media availability verification
      if (
        sType === 'image' ||
        sType === 'video' ||
        sType === 'file' ||
        sType === 'pdf' ||
        sType === 'audio'
      ) {
        if (!hasValidMediaSource(tRaw)) {
          validationErrors.push(`Media block (${sType}) at ${itemPath} is missing a valid source URL or upload ID`)
        }
      }

      // Recurse into children
      if (
        (sNode.children && sNode.children.length > 0) ||
        (tNode.children && tNode.children.length > 0)
      ) {
        compareBranches(sNode.children || [], tNode.children || [], `${itemPath}.${sType}`)
      }
    }
  }

  compareBranches(normalizeTreeNodes(sourceTree), normalizeTreeNodes(targetTree), 'root')

  if (unsupportedBlocks.length > 0) {
    warnings.push(
      `${unsupportedBlocks.length} unsupported block(s) could not be reproduced: ` +
        unsupportedBlocks.map(b => `${b.type} (id: ${b.id}, pos: ${b.position})`).join(', ')
    )
  }

  if (missingMedia.length > 0) {
    warnings.push(
      `${missingMedia.length} media asset(s) could not be reproduced: ` +
        missingMedia.map(m => `${m.type} (id: ${m.id}, pos: ${m.position}: ${m.reason})`).join(', ')
    )
  }

  const untranslatedLinked = linkedResources.filter(r => !r.usedLocalizedCounterpart)
  if (untranslatedLinked.length > 0) {
    warnings.push(
      `${untranslatedLinked.length} linked resource(s) reference original untranslated pages/databases: ` +
        untranslatedLinked.map(r => `${r.type} "${r.title || r.id}" (pos: ${r.position})`).join(', ')
    )
  }

  if (syncedBlocks.length > 0) {
    warnings.push(
      `${syncedBlocks.length} synced_block(s) recreated as independent blocks (synchronization with English source is not retained).`
    )
  }

  // Mark as needing review when important content was not reproduced or validation errors occurred
  const needsReview =
    validationErrors.length > 0 ||
    unsupportedBlocks.length > 0 ||
    missingMedia.length > 0 ||
    untranslatedLinked.length > 0 ||
    syncedBlocks.length > 0

  return {
    valid: validationErrors.length === 0,
    needsReview,
    fidelity100Percent:
      validationErrors.length === 0 &&
      unsupportedBlocks.length === 0 &&
      missingMedia.length === 0 &&
      untranslatedLinked.length === 0 &&
      syncedBlocks.length === 0,
    sourceCountsByType,
    targetCountsByType,
    validationErrors,
    warnings,
    unsupportedBlocks,
    missingMedia,
    linkedResources,
    syncedBlocks,
  }
}

/**
 * Generates a structured and human-readable translation report.
 */
function generateTranslationReport(params = {}) {
  const {
    sourcePageTitle = 'Untitled',
    sourcePageId = '',
    targetPageId = '',
    targetPageUrl = '',
    totalSourceBlocks = 0,
    totalTranslatedTextFields = 0,
    totalPreservedBlocks = 0,
    totalRecreatedNestedBlocks = 0,
    unsupportedBlocks = [],
    missingMedia = [],
    linkedResources = [],
    syncedBlocks = [],
    validationErrors = [],
    warnings = [],
    startedAt = null,
    completedAt = new Date().toISOString(),
  } = params

  const durationMs =
    startedAt && completedAt
      ? Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime())
      : null

  const lines = [
    `=== Translation Report ===`,
    `Source Title: ${sourcePageTitle}`,
    `Source Page ID: ${sourcePageId}`,
    `Target Page ID: ${targetPageId || 'N/A'}`,
    `Target Page URL: ${targetPageUrl || 'N/A'}`,
    `Completed At: ${completedAt}${durationMs !== null ? ` (${durationMs}ms)` : ''}`,
    `Total Source Blocks: ${totalSourceBlocks}`,
    `Translated Text Fields: ${totalTranslatedTextFields}`,
    `Preserved Non-Translatable Blocks: ${totalPreservedBlocks}`,
    `Recreated Nested Blocks: ${totalRecreatedNestedBlocks}`,
    `Unsupported Blocks: ${unsupportedBlocks.length}`,
    `Missing Media: ${missingMedia.length}`,
    `Validation Errors: ${validationErrors.length}`,
  ]

  if (unsupportedBlocks.length > 0) {
    lines.push(
      `Unsupported Details: ${unsupportedBlocks
        .map(b => `${b.type}[id=${b.id}, pos=${b.position}]`)
        .join('; ')}`
    )
  }

  if (missingMedia.length > 0) {
    lines.push(
      `Missing Media Details: ${missingMedia
        .map(m => `${m.type}[id=${m.id}, pos=${m.position}]: ${m.reason}`)
        .join('; ')}`
    )
  }

  if (linkedResources.length > 0) {
    lines.push(
      `Linked Resources: ${linkedResources
        .map(r => `${r.type}[id=${r.id}, pos=${r.position}]: ${r.note || r.title}`)
        .join('; ')}`
    )
  }

  if (syncedBlocks.length > 0) {
    lines.push(
      `Synced Blocks: ${syncedBlocks.length} recreated independently (not synced with original).`
    )
  }

  if (validationErrors.length > 0) {
    lines.push(`Validation Errors: ${validationErrors.join(' | ')}`)
  }

  const fullText = lines.join('\n')

  // Concise summary for Notion's `Translation Error` property when review/errors exist
  const issueParts = []
  if (validationErrors.length > 0) {
    issueParts.push(`Validation errors (${validationErrors.length}): ${validationErrors.join('; ')}`)
  }
  if (unsupportedBlocks.length > 0) {
    issueParts.push(
      `Unsupported blocks (${unsupportedBlocks.length}): ` +
        unsupportedBlocks.map(b => `${b.type} (id: ${b.id}, pos: ${b.position})`).join(', ')
    )
  }
  if (missingMedia.length > 0) {
    issueParts.push(
      `Missing media (${missingMedia.length}): ` +
        missingMedia.map(m => `${m.type} at ${m.position} (${m.reason})`).join(', ')
    )
  }
  const untranslatedLinks = linkedResources.filter(r => !r.usedLocalizedCounterpart)
  if (untranslatedLinks.length > 0) {
    issueParts.push(
      `Linked untranslated resources (${untranslatedLinks.length}): ` +
        untranslatedLinks.map(r => `${r.type} "${r.title || r.id}" at ${r.position}`).join(', ')
    )
  }
  if (syncedBlocks.length > 0) {
    issueParts.push(
      `Synced blocks (${syncedBlocks.length}): recreated as independent blocks without live sync.`
    )
  }

  const concisePropertySummary =
    issueParts.length > 0
      ? `[Needs Review] Target Page: ${targetPageId || 'N/A'} | ${issueParts.join(' | ')}`.slice(0, 1950)
      : ''

  return {
    sourcePageTitle,
    sourcePageId,
    targetPageId,
    targetPageUrl,
    totalSourceBlocks,
    totalTranslatedTextFields,
    totalPreservedBlocks,
    totalRecreatedNestedBlocks,
    unsupportedBlocks,
    missingMedia,
    linkedResources,
    syncedBlocks,
    validationErrors,
    warnings,
    completedAt,
    durationMs,
    fullText,
    concisePropertySummary,
  }
}

module.exports = {
  validateTranslation,
  generateTranslationReport,
  flattenBlocks,
  normalizeComparableBlockType,
}

