import { NextResponse, type NextRequest } from 'next/server'
import { getChildBlocks, renderBlocks } from '../../../../lib/notion'
import type { NotionChildrenApiResponse } from '../../../../lib/notion-types'

export async function GET(request: NextRequest): Promise<NextResponse<NotionChildrenApiResponse>> {
  const { searchParams } = new URL(request.url)
  const blockId = searchParams.get('blockId')
  if (!blockId) return NextResponse.json({ error: 'Missing blockId' }, { status: 400 })

  try {
    const blocks = await getChildBlocks(blockId)
    const html = await renderBlocks(blocks)
    return NextResponse.json({ html })
  } catch (error: unknown) {
    console.error('Failed to fetch toggle children:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
