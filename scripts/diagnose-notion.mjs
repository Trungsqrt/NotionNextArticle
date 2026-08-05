/**
 * Notion 403 Diagnostic Script
 * Run with: node scripts/diagnose-notion.mjs
 * 
 * Tests multiple raw HTTP strategies to isolate the 403 root cause.
 * Bypasses notion-client entirely so we can see exactly what Notion responds to.
 */

import https from 'https'

const PAGE_ID = '3b0ac39b0efb80eb9f8de858429de794'
const TOKEN = process.env.NOTION_TOKEN_V2 || process.env.NOTION_TOKEN || ''

function postToNotion(body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const options = {
      hostname: 'www.notion.so',
      port: 443,
      path: '/api/v3/getRecordValues',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
    }

    const req = https.request(options, (res) => {
      let raw = ''
      res.on('data', chunk => raw += chunk)
      res.on('end', () => {
        resolve({ status: res.statusCode, body: raw })
      })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

const requestBody = {
  requests: [{ id: PAGE_ID, table: 'block' }]
}

async function run() {
  console.log('=== Notion 403 Diagnostic Tool ===')
  console.log(`Page ID: ${PAGE_ID}`)
  console.log(`Token present: ${TOKEN ? 'YES (' + TOKEN.slice(0, 20) + '...)' : 'NO'}`)
  console.log('')

  // Test 1: No headers at all
  console.log('--- Test 1: No token, no headers ---')
  try {
    const r = await postToNotion(requestBody, {})
    console.log(`  HTTP Status: ${r.status}`)
    if (r.status === 200) console.log(`  ✅ SUCCESS - Page is publicly accessible`)
    else console.log(`  ❌ FAILED - Body preview: ${r.body.slice(0, 200)}`)
  } catch (e) { console.error('  Error:', e.message) }
  console.log('')

  // Test 2: Browser User-Agent only (no token)
  console.log('--- Test 2: No token, browser User-Agent only ---')
  try {
    const r = await postToNotion(requestBody, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
    })
    console.log(`  HTTP Status: ${r.status}`)
    if (r.status === 200) console.log(`  ✅ SUCCESS - User-Agent is sufficient`)
    else console.log(`  ❌ FAILED`)
  } catch (e) { console.error('  Error:', e.message) }
  console.log('')

  // Test 3: Full WAF-proof headers, no token
  console.log('--- Test 3: No token, full WAF-proof headers (Origin + Referer + Sec-Fetch) ---')
  try {
    const r = await postToNotion(requestBody, {
      'Origin': 'https://www.notion.so',
      'Referer': 'https://www.notion.so/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    })
    console.log(`  HTTP Status: ${r.status}`)
    if (r.status === 200) console.log(`  ✅ SUCCESS - WAF headers bypass works, page is public`)
    else console.log(`  ❌ FAILED - Body preview: ${r.body.slice(0, 200)}`)
  } catch (e) { console.error('  Error:', e.message) }
  console.log('')

  // Test 4: With token (if present)
  if (TOKEN) {
    console.log('--- Test 4: Full WAF-proof headers + NOTION_TOKEN_V2 ---')
    try {
      const r = await postToNotion(requestBody, {
        'Origin': 'https://www.notion.so',
        'Referer': 'https://www.notion.so/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'cookie': `token_v2=${TOKEN}`,
      })
      console.log(`  HTTP Status: ${r.status}`)
      if (r.status === 200) console.log(`  ✅ SUCCESS - Token is valid and working!`)
      else console.log(`  ❌ FAILED (Token may be expired) - Body preview: ${r.body.slice(0, 200)}`)
    } catch (e) { console.error('  Error:', e.message) }
    console.log('')
  } else {
    console.log('--- Test 4: SKIPPED (no token in env) ---')
    console.log('')
  }

  console.log('=== Diagnosis Guide ===')
  console.log('If ALL tests return 403  → Page is PRIVATE. Enable "Share to web" in Notion.')
  console.log('If Test 4 is 200 only    → Token valid, page is private. App needs token.')
  console.log('If Test 3 is 200 only    → WAF headers work. notion-client kyOptions may be broken.')
  console.log('If Test 1-2 are 200      → Page is public. Bug is elsewhere in integration.')
}

run().catch(console.error)
