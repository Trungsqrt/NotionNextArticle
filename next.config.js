/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    const privateStudyHeaders = [
      { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive, nosnippet' },
      { key: 'Cache-Control', value: 'private, no-store, max-age=0' },
    ]
    return [
      { source: '/study', headers: privateStudyHeaders },
      { source: '/study/:path*', headers: privateStudyHeaders },
      { source: '/api/study/:path*', headers: privateStudyHeaders },
    ]
  },
}

module.exports = nextConfig
