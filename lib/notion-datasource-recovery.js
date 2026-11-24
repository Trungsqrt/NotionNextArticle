/**
 * lib/notion-datasource-recovery.js — Pure Notion data_source_id recovery helpers
 * ───────────────────────────────────────────────────────────────────────────────
 * Shared by public `lib/notion.js` (and directly testable in Node without RSC).
 */

export function isNotionNotFoundError(err) {
  return Boolean(err && (err.status === 404 || err.code === 'object_not_found'))
}

export function parsePublicNotionId(raw) {
  const trimmed = String(raw || '').trim()
  const match = /^(db|database|ds|data_source):(.+)$/i.exec(trimmed)
  if (!match) return { id: trimmed, explicitKind: null }
  const prefix = match[1].toLowerCase()
  return {
    id: match[2].trim(),
    explicitKind: prefix === 'ds' || prefix === 'data_source' ? 'data_source_id' : 'database_id',
  }
}

/**
 * Recovery wrapper for public Notion data_source queries (including nested
 * child databases that pass both `isDataSourceId` and `parentDatabaseId`).
 * On `404 object_not_found`, invalidates the stale mapping, re-resolves from
 * the parent `database_id`, and retries the read AT MOST ONCE.
 */
export async function executePublicDataSourceQueryWithRecovery({
  targetId,
  isDataSourceId = false,
  parentDatabaseId = null,
  resolveDataSource,
  invalidateMapping,
  runQuery,
}) {
  const initialDsId = isDataSourceId ? targetId : await resolveDataSource(targetId, false)
  try {
    return await runQuery(initialDsId)
  } catch (err) {
    const recoveryDbId = parentDatabaseId || (!isDataSourceId ? targetId : null)
    if (recoveryDbId && isNotionNotFoundError(err)) {
      if (typeof invalidateMapping === 'function') {
        invalidateMapping(recoveryDbId)
      }
      const freshDsId = await resolveDataSource(recoveryDbId, true)
      return await runQuery(freshDsId)
    }
    throw err
  }
}
