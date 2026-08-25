import { NextResponse } from 'next/server'
import { getChildBlocks, renderBlocks } from '../../../../lib/notion'

export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const blockId = searchParams.get('blockId')
  if (!blockId) return NextResponse.json({ error: 'Missing blockId' }, { status: 400 })

  try {
    const blocks = await getChildBlocks(blockId)
    const html = await renderBlocks(blocks)
    return NextResponse.json({ html })
  } catch (error) {
    console.error('Failed to fetch toggle children:', error)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
