/**
 * lib/notion-datasource-recovery.ts — Pure Notion data_source_id recovery helpers
 * ───────────────────────────────────────────────────────────────────────────────
 * Shared by public `lib/notion.ts` (and directly testable in Node without RSC).
 */

export type PublicNotionExplicitKind = 'database_id' | 'data_source_id' | null

export interface ParsedPublicNotionId {
  id: string
  explicitKind: PublicNotionExplicitKind
}

export interface ExecutePublicDataSourceQueryOptions<TResult> {
  targetId: string
  isDataSourceId?: boolean
  parentDatabaseId?: string | null
  resolveDataSource: (id: string, forceRefresh?: boolean) => Promise<string>
  invalidateMapping?: (id: string) => void
  runQuery: (dsId: string) => Promise<TResult>
}

export function normalizeNotionId(id: string | null | undefined): string {
  return id ? String(id).replace(/-/g, '').trim().toLowerCase() : ''
}

export function isNotionNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const candidate = err as { status?: unknown; code?: unknown }
  return candidate.status === 404 || candidate.code === 'object_not_found'
}

export function parsePublicNotionId(raw: string | null | undefined): ParsedPublicNotionId {
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
export async function executePublicDataSourceQueryWithRecovery<TResult>({
  targetId,
  isDataSourceId = false,
  parentDatabaseId = null,
  resolveDataSource,
  invalidateMapping,
  runQuery,
}: ExecutePublicDataSourceQueryOptions<TResult>): Promise<TResult> {
  const initialDsId = isDataSourceId ? targetId : await resolveDataSource(targetId, false)
  try {
    return await runQuery(initialDsId)
  } catch (err: unknown) {
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
