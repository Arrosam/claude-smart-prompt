export type Mode = 'light' | 'standard' | 'detailed'

/** One version of the draft: index 0 is the person's own; later ones are rewrites. */
export type Version = { text: string; mode?: Mode; source?: string }

/** A refine in progress: what it rewrites, the answers so far, and any open question. */
export type Job = {
  id: number
  kind: 'refine' | 'retry' | 'iterate'
  mode: Mode
  /** The text as given, a leading /command included. */
  raw: string
  /** A leading `/command ` kept as is. */
  prefix: string
  /** The text the model rewrites. */
  source: string
  /** What the composer held before the refine started, put back on cancel. */
  before: string
  rounds: { question: string; answer: string }[]
  question: string | null
  /** Light mode's further questions, asked after `question`, answered before one rewrite. */
  queue: string[]
  isSkipped: boolean
  startedAt: number
  tokens: { input: number; cached: number; output: number }
}

export type SmartPromptSettings = {
  maxQuestions: number
  autoSuggest: boolean
}

export type Suggest = { forReply: number; items: string[]; isOpen: boolean; isLoading: boolean }

declare module 'claude-code' {
  interface PluginState {
    'smart-prompt': {
      settings: SmartPromptSettings
      job: Job | null
      versions: Version[]
      note: string | null
      isDraftEmpty: boolean
      replies: number
      suggest: Suggest
    }
  }
}
