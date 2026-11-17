// Fidelity gate, ported from dsh-smart-prompt lib/anchors.js + lib/fidelity.js.
// Hard facts (paths, identifiers, numbers, URLs, `code`, @refs) must survive the rewrite.

export type Anchor = { text: string; kind: string }

const MAX_ANCHORS = 200
const MIN_LENGTH = 2
const MAX_CODE_LENGTH = 120
const FILE_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'd', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'swift', 'm', 'mm', 'scala', 'sh', 'bash', 'zsh',
  'ps1', 'bat', 'sql', 'md', 'mdx', 'txt', 'log', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini',
  'cfg', 'conf', 'env', 'lock', 'gradle', 'properties', 'xml', 'html', 'htm', 'css', 'scss',
  'less', 'vue', 'svelte', 'astro', 'proto', 'tf', 'dockerfile', 'makefile', 'ipynb', 'csv',
].join('|')

// Earlier matchers claim their spans first; fenced blocks are claimed but not recorded.
const MATCHERS: { kind: string; pattern: RegExp; claimOnly?: boolean }[] = [
  { kind: 'code', pattern: /```[\s\S]*?```/g, claimOnly: true },
  { kind: 'code', pattern: /`[^`\n]+`/g },
  { kind: 'url', pattern: /https?:\/\/[^\s<>()[\]"'`]+/g },
  { kind: 'ref', pattern: /(?:^|[\s(\[{,，。；;])@([A-Za-z0-9_][A-Za-z0-9_./-]{1,})/g },
  { kind: 'path', pattern: /(?:[A-Za-z]:)?(?:\/|\.{1,2}\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@*-]+)+/g },
  { kind: 'path', pattern: new RegExp('\\b[A-Za-z0-9_@-][A-Za-z0-9_.@-]*\\.(?:' + FILE_EXTENSIONS + ')\\b', 'gi') },
  { kind: 'version', pattern: /\bv?\d+(?:\.\d+){1,3}(?:-rc\.?\d*)?\b/gi },
  { kind: 'number', pattern: /\b\d+(?:\.\d+)?\s?(?:%|px|em|rem|ms|s|m|h|kb|mb|gb|tb|k|w|次|个|秒|分钟|小时|天|行|条|页)\b/gi },
  { kind: 'identifier', pattern: /\b[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*){1,4}\b/g },
  { kind: 'identifier', pattern: /\b[a-z][a-zA-Z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b/g },
  { kind: 'identifier', pattern: /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g },
  { kind: 'identifier', pattern: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g },
]

const unwrap = (kind: string, raw: string): string => {
  let text = raw
  if (kind === 'code') text = text.replace(/^`|`$/g, '')
  if (kind === 'ref') text = text.slice(Math.max(0, text.indexOf('@')))
  return text.trim()
}

export const extractAnchors = (draft: string): Anchor[] => {
  const claimed = new Array<boolean>(draft.length).fill(false)
  const seen = new Set<string>()
  const out: Anchor[] = []
  for (const { kind, pattern, claimOnly } of MATCHERS) {
    const re = new RegExp(pattern.source, pattern.flags)
    let match: RegExpExecArray | null
    while ((match = re.exec(draft)) !== null) {
      if (match[0] === '') { re.lastIndex += 1; continue }
      const start = match.index
      const end = start + match[0].length
      if (claimed.slice(start, end).some(Boolean)) continue
      claimed.fill(true, start, end)
      if (claimOnly) continue
      const text = unwrap(kind, match[0])
      if (text.length < MIN_LENGTH || text.length > MAX_CODE_LENGTH) continue
      const key = kind + '\u0000' + text
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ text, kind })
      if (out.length >= MAX_ANCHORS) return out
    }
  }
  return out
}

const collapse = (t: string) => t.replace(/\s+/g, ' ')
const strip = (t: string) => t.replace(/\s+/g, '')

export const missingAnchors = (anchors: Anchor[], rewrite: string): Anchor[] => {
  const collapsed = collapse(rewrite)
  const stripped = strip(rewrite)
  return anchors.filter(
    a => !rewrite.includes(a.text) && !collapsed.includes(collapse(a.text)) && !stripped.includes(strip(a.text)),
  )
}

export const repairClause = (missing: Anchor[]): string =>
  [
    '',
    'Your previous rewrite DROPPED content that must be preserved. Produce the rewrite again,',
    'keeping everything you already had, and place each of these EXACT strings back into it',
    'naturally (do not append them as a list at the end, and do not translate or reformat them):',
    ...missing.map(a => '- ' + a.text),
  ].join('\n')

export const reinjectionBlock = (missing: Anchor[]): string =>
  missing.length === 0
    ? ''
    : '\n\n保留原始细节 / Preserved original details:\n' + missing.map(a => '- ' + a.text).join('\n')
