/**
 * _app.js — Next.js Application Root
 * ────────────────────────────────────
 * Imports global CSS (including the Wabi-Sabi theme overrides).
 * IMPORTANT: Does NOT modify any NotionNext data props.
 */

import '../styles/globals.css'

// Import react-notion-x base styles (must come before our overrides)
import 'react-notion-x/build/third-party/collection.css'
import 'react-notion-x/build/third-party/equation.css'

export default function App({ Component, pageProps }) {
  return <Component {...pageProps} />
}
