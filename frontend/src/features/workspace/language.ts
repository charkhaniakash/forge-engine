/** Map a file path to a Monaco language id from its extension. */
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  go: 'go',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cs: 'csharp',
  php: 'php',
  swift: 'swift',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  dockerfile: 'dockerfile',
  xml: 'xml',
  graphql: 'graphql',
}

export function languageForPath(path: string): string {
  const name = path.split('/').pop() ?? ''
  if (name.toLowerCase() === 'dockerfile') return 'dockerfile'
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  return EXT_TO_LANG[ext] ?? 'plaintext'
}
