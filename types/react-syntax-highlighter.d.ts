declare module 'react-syntax-highlighter' {
  import type { CSSProperties, ComponentType, ReactNode } from 'react'

  export type SyntaxHighlighterStyle = Record<string, CSSProperties>

  export interface SyntaxHighlighterProps {
    language?: string
    style?: SyntaxHighlighterStyle
    children?: ReactNode
    showLineNumbers?: boolean
    wrapLines?: boolean
    wrapLongLines?: boolean
    customStyle?: CSSProperties
    codeTagProps?: {
      style?: CSSProperties
      className?: string
    }
    lineNumberStyle?: CSSProperties
    PreTag?: string | ComponentType<Record<string, unknown>>
    CodeTag?: string | ComponentType<Record<string, unknown>>
  }

  export const Prism: ComponentType<SyntaxHighlighterProps>
}

declare module 'react-syntax-highlighter/dist/esm/styles/prism' {
  import type { SyntaxHighlighterStyle } from 'react-syntax-highlighter'

  export const oneLight: SyntaxHighlighterStyle
  export const oneDark: SyntaxHighlighterStyle
}
