/**
 * Server-side JSX pre-compile for the hosted-app runner (Decision 8, U8/U9).
 *
 * The builder preview (`/preview`) compiles JSX in the browser with
 * @babel/standalone + `unsafe-eval`. The DEPLOYED runner must NOT: its frame
 * loads model-authored code, so giving that frame `unsafe-eval` would widen the
 * attack surface. Instead we run the EXACT same transform here, ONCE, at approval
 * time, and store the plain compiled JS in `code.approvedSnapshot.compiled`; the
 * runner then serves pre-compiled JS under a CSP with no `unsafe-eval`.
 *
 * The transform mirrors PREVIEW_SHELL's runtime transform byte-for-byte: strip
 * ES import/export statements (React et al. are globals in the frame) and compile
 * JSX with the CLASSIC runtime (so Babel emits React.createElement, never an
 * `import "react/jsx-runtime"` a classic <script> can't run). A syntax error
 * throws — the approve handler maps it to a 4xx and refuses to approve.
 */
import { transform } from '@babel/core'
import presetReact from '@babel/preset-react'

/** Strip ES module syntax (same regexes as PREVIEW_SHELL); React is a frame global. */
function stripModuleSyntax(code) {
  return String(code)
    .replace(/import\s+[^;]*?from\s*['"][^'"]+['"];?/g, '')
    .replace(/import\s*['"][^'"]+['"];?/g, '')
    .replace(/export\s+default\s+/g, '')
    .replace(/export\s+/g, '')
}

/**
 * Compile a generated JSX source string to plain browser JS (classic React
 * runtime). Throws on invalid syntax (the caller refuses the approval).
 * @param {string} source - the generated JSX (the app's `code.source.src`)
 * @returns {string} compiled JS, ready to wrap in the runner's IIFE
 */
export function compileJsx(source) {
  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new Error('No source to compile.')
  }
  const cleaned = stripModuleSyntax(source)
  const result = transform(cleaned, {
    presets: [[presetReact, { runtime: 'classic' }]],
    // No filename/sourcemaps — this is a one-shot string compile, not a build.
    babelrc: false,
    configFile: false,
  })
  if (!result || typeof result.code !== 'string') {
    throw new Error('Compilation produced no output.')
  }
  return result.code
}
