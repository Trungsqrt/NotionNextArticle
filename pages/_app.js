/**
 * _app.js — Next.js Application Root
 * ────────────────────────────────────
 * Imports global CSS (including Wabi-Sabi theme & highlight.js styles).
 */

import '../styles/globals.css'
import 'highlight.js/styles/github-dark.css'

export default function App({ Component, pageProps }) {
  return <Component {...pageProps} />
}
