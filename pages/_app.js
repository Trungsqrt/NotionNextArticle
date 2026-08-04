/**
 * _app.js — Next.js Application Root
 * ────────────────────────────────────
 * Imports global CSS (including the Wabi-Sabi theme overrides).
 * IMPORTANT: Does NOT modify any NotionNext data props.
 */

import '../styles/globals.css'

// Import react-notion-x base styles (must come before our overrides)
import 'react-notion-x/src/styles.css'

// Required by Collection component for code blocks inside galleries/databases
import 'prismjs/themes/prism-tomorrow.css'

// Required by Equation component and math rendering inside collections
import 'katex/dist/katex.min.css'

export default function App({ Component, pageProps }) {
  return <Component {...pageProps} />
}
