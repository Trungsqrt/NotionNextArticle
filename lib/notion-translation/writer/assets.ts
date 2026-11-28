import type { Client } from '@notionhq/client'
import { reuploadNotionAsset } from '../notion-client'
import type { MissingMediaIssue } from '../types'
import type { AssetWriteOptions } from './types'

export function sanitizeIconForWrite(
  icon: unknown
): Record<string, unknown> | undefined {
  if (!icon || typeof icon !== 'object') return undefined
  const ic = icon as {
    type?: string
    emoji?: string
    external?: { url?: string }
    custom_emoji?: { id?: string }
    icon?: { name?: string }
    file_upload?: { id?: string }
  }
  if (ic.type === 'emoji' && ic.emoji) {
    return { type: 'emoji', emoji: ic.emoji }
  }
  if (ic.type === 'external' && ic.external?.url) {
    return { type: 'external', external: { url: ic.external.url } }
  }
  if (ic.type === 'custom_emoji' && ic.custom_emoji?.id) {
    return { type: 'custom_emoji', custom_emoji: { id: ic.custom_emoji.id } }
  }
  if (ic.type === 'icon' && ic.icon?.name) {
    return { type: 'icon', icon: ic.icon }
  }
  if (ic.type === 'file_upload' && ic.file_upload?.id) {
    return { type: 'file_upload', file_upload: { id: ic.file_upload.id } }
  }
  return undefined
}

export async function resolvePageCoverForWrite(
  client: Client,
  sourceCover: unknown,
  options: AssetWriteOptions = {}
): Promise<{
  cover: Record<string, unknown> | undefined
  issue: MissingMediaIssue | null
}> {
  if (!sourceCover || typeof sourceCover !== 'object') {
    return { cover: undefined, issue: null }
  }
  const sc = sourceCover as {
    type?: string
    external?: { url?: string }
    file?: { url?: string }
  }
  if (sc.type === 'external' && sc.external?.url) {
    return {
      cover: { type: 'external', external: { url: sc.external.url } },
      issue: null,
    }
  }
  if (sc.type === 'file' && sc.file?.url) {
    const cachedUpload = options.checkpoint?.getUploadedAsset?.('page:cover')
    if (cachedUpload?.fileUploadId) {
      return {
        cover: {
          type: 'file_upload',
          file_upload: { id: cachedUpload.fileUploadId },
        },
        issue: null,
      }
    }
    try {
      const uploaded = await reuploadNotionAsset(client, sc.file.url, options)
      options.checkpoint?.recordUploadedAsset?.('page:cover', uploaded)
      return {
        cover: {
          type: 'file_upload',
          file_upload: { id: uploaded.fileUploadId },
        },
        issue: null,
      }
    } catch (err) {
      return {
        cover: undefined,
        issue: {
          id: 'page_cover',
          type: 'cover',
          position: 'page.cover',
          reason: `Could not re-upload Notion-hosted cover image: ${err instanceof Error ? err.message : String(err)}`,
        },
      }
    }
  }
  return { cover: undefined, issue: null }
}

export async function resolvePageIconForWrite(
  client: Client,
  sourceIcon: unknown,
  options: AssetWriteOptions = {}
): Promise<{
  icon: Record<string, unknown> | undefined
  issue: MissingMediaIssue | null
}> {
  if (!sourceIcon || typeof sourceIcon !== 'object') {
    return { icon: undefined, issue: null }
  }
  const si = sourceIcon as {
    type?: string
    file?: { url?: string }
  }
  if (si.type === 'file' && si.file?.url) {
    const cachedUpload = options.checkpoint?.getUploadedAsset?.('page:icon')
    if (cachedUpload?.fileUploadId) {
      return {
        icon: {
          type: 'file_upload',
          file_upload: { id: cachedUpload.fileUploadId },
        },
        issue: null,
      }
    }
    try {
      const uploaded = await reuploadNotionAsset(client, si.file.url, options)
      options.checkpoint?.recordUploadedAsset?.('page:icon', uploaded)
      return {
        icon: {
          type: 'file_upload',
          file_upload: { id: uploaded.fileUploadId },
        },
        issue: null,
      }
    } catch (err) {
      return {
        icon: undefined,
        issue: {
          id: 'page_icon',
          type: 'icon',
          position: 'page.icon',
          reason: `Could not re-upload Notion-hosted icon: ${err instanceof Error ? err.message : String(err)}`,
        },
      }
    }
  }
  return { icon: sanitizeIconForWrite(sourceIcon), issue: null }
}
