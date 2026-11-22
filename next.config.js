/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Allow images served from Notion's CDN and AWS S3
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'www.notion.so' },
      { protocol: 'https', hostname: 'notion.so' },
      { protocol: 'https', hostname: 'images.unsplash.com' },
      { protocol: 'https', hostname: 's3.us-west-2.amazonaws.com' },
      { protocol: 'https', hostname: 'prod-files-secure.s3.us-west-2.amazonaws.com' },
      { protocol: 'https', hostname: 'file.notion.so' },
    ],
  },

  // Experimental: optimise CSS loading
  experimental: {
    optimizeCss: false,
  },

  serverExternalPackages: ['keyv'],
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
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      canvas: false,
    }
    return config
  },
  turbopack: {},
}

module.exports = nextConfig
