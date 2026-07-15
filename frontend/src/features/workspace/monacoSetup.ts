/**
 * Bundle Monaco locally instead of loading it from a CDN.
 *
 * `@monaco-editor/react` defaults to fetching the editor from jsdelivr at
 * runtime; that breaks offline and under a strict CSP. Here we point its loader
 * at the bundled `monaco-editor` package and wire the language web-workers via
 * Vite's `?worker` imports, so everything ships from our own origin.
 *
 * Imported once for its side effects (see CodeEditor.tsx) before any <Editor>.
 */
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import type { Environment } from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

const env: Environment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  },
}

;(globalThis as typeof globalThis & { MonacoEnvironment?: Environment }).MonacoEnvironment = env

// Use the bundled monaco instance rather than the CDN loader.
loader.config({ monaco })
