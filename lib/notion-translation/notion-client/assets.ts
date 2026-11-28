import type { Client } from '@notionhq/client'
import type { UploadedAssetRecord } from '../types'
import { defaultLogger } from '../../../worker/logger'
import { withNotionRetry, type NotionOperationOptions } from './client'

function inferFilenameFromUrl(
  urlStr: string,
  fallback = 'notion-asset'
): string {
  try {
    const parsed = new URL(urlStr)
    const base = decodeURIComponent(parsed.pathname.split('/').pop() || '')
    if (base && base.includes('.')) return base
  } catch {
    // Ignore URL parse error
  }
  return `${fallback}.bin`
}

function inferContentTypeFromFilename(filename: string): string {
  const ext = (filename.split('.').pop() || '').toLowerCase()
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    pdf: 'application/pdf',
  }
  return map[ext] || 'application/octet-stream'
}

/**
 * Reads a fetch Response body while enforcing a strict maximum byte limit
 * during streaming so oversized assets are aborted before buffering in memory.
 */
async function readResponseWithByteLimit(
  response: Response,
  maxAssetBytes: number,
  controller: AbortController
): Promise<ArrayBuffer> {
  const headersAny = response.headers as unknown as {
    get?: (name: string) => string | null
    [key: string]: unknown
  }
  const rawContentLength =
    headersAny?.get?.('content-length') ??
    headersAny?.['content-length'] ??
    headersAny?.['Content-Length']

  if (
    rawContentLength !== undefined &&
    rawContentLength !== null &&
    String(rawContentLength).trim() !== ''
  ) {
    const declaredBytes = Number(rawContentLength)
    if (Number.isFinite(declaredBytes) && declaredBytes > maxAssetBytes) {
      controller.abort()
      throw new Error(
        `Asset size (${declaredBytes} bytes from Content-Length) exceeds maximum allowed limit (${maxAssetBytes} bytes)`
      )
    }
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let receivedBytes = 0

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          const chunk =
            value instanceof Uint8Array ? value : new Uint8Array(value)
          receivedBytes += chunk.byteLength
          if (receivedBytes > maxAssetBytes) {
            controller.abort()
            await reader.cancel().catch(() => {})
            throw new Error(
              `Asset download exceeded maximum allowed size (${maxAssetBytes} bytes; received >${receivedBytes} bytes)`
            )
          }
          chunks.push(chunk)
        }
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // Ignore reader lock release errors
      }
    }

    const combined = new Uint8Array(receivedBytes)
    let offset = 0
    for (const chunk of chunks) {
      combined.set(chunk, offset)
      offset += chunk.byteLength
    }
    return combined.buffer
  }

  // Fallback for environments where response.body is not a ReadableStream
  const arrayBuffer = await response.arrayBuffer()
  if (arrayBuffer && arrayBuffer.byteLength > maxAssetBytes) {
    controller.abort()
    throw new Error(
      `Asset size (${arrayBuffer.byteLength} bytes) exceeds maximum allowed limit (${maxAssetBytes} bytes)`
    )
  }
  return arrayBuffer
}

/**
 * Re-uploads a Notion-hosted expiring file asset using the Notion File Upload API
 * (`client.fileUploads.create` + `client.fileUploads.send`).
 * Enforces both download timeout (`TRANSLATION_ASSET_TIMEOUT_MS`) and max byte size (`TRANSLATION_MAX_ASSET_BYTES`).
 */
export async function reuploadNotionAsset(
  client: Client,
  assetUrl: string,
  options: NotionOperationOptions = {}
): Promise<UploadedAssetRecord> {
  const {
    fetchImpl = globalThis.fetch,
    logger = defaultLogger,
    filename: explicitFilename,
  } = options

  if (!assetUrl) {
    throw new Error('Empty asset URL')
  }
  if (!client.fileUploads || typeof client.fileUploads.create !== 'function') {
    throw new Error('Notion client does not expose fileUploads API')
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is unavailable for downloading Notion asset')
  }

  const assetTimeoutMs = Math.max(
    1000,
    Number(
      options.assetTimeoutMs ??
        options.config?.assetTimeoutMs ??
        process.env.TRANSLATION_ASSET_TIMEOUT_MS ??
        60000
    ) || 60000
  )

  const maxAssetBytes = Math.max(
    1024,
    Number(
      options.maxAssetBytes ??
        options.config?.maxAssetBytes ??
        process.env.TRANSLATION_MAX_ASSET_BYTES ??
        20 * 1024 * 1024
    ) || 20 * 1024 * 1024
  )

  const filename = explicitFilename || inferFilenameFromUrl(assetUrl, 'asset')
  const controller = new AbortController()
  let timedOut = false
  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, assetTimeoutMs)

  let arrayBuffer: ArrayBuffer
  let contentType: string
  try {
    const response = await fetchImpl(assetUrl, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(
        `Failed to download source asset (${response.status} ${response.statusText})`
      )
    }

    contentType =
      response.headers?.get?.('content-type')?.split(';')[0]?.trim() ||
      inferContentTypeFromFilename(filename)

    arrayBuffer = await readResponseWithByteLimit(
      response,
      maxAssetBytes,
      controller
    )
  } catch (err) {
    const isAbort =
      timedOut || (err instanceof Error && err.name === 'AbortError')
    if (isAbort) {
      throw new Error(`Asset download timed out after ${assetTimeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
  }

  const blob = new Blob([arrayBuffer], { type: contentType })

  const createdUpload = await withNotionRetry(
    () =>
      client.fileUploads.create({
        mode: 'single_part',
        filename,
        content_type: contentType,
      }),
    {
      isIdempotent: false,
      maxRetries: 2,
      label: 'fileUploads.create',
      logger,
      ...options.retryOptions,
    }
  )

  if (!createdUpload?.id) {
    throw new Error('fileUploads.create did not return an upload ID')
  }

  await withNotionRetry(
    () =>
      client.fileUploads.send({
        file_upload_id: createdUpload.id,
        file: {
          filename,
          data: blob,
        },
      }),
    {
      isIdempotent: false,
      maxRetries: 2,
      label: 'fileUploads.send',
      logger,
      ...options.retryOptions,
    }
  )

  return {
    fileUploadId: createdUpload.id,
    filename,
    contentType,
  }
}
