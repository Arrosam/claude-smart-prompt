// Prompt assembly and reply parsing, ported from dsh-smart-prompt lib/prompts.js.
import type { Job, Mode } from '../types'
import { PROMPTS } from './prompts'

const TAGS = 'raw_prompt|conversation_context|user_answers|follow_up_status|recent_conversation|already_suggested'
const escapeTags = (text: string) =>
  text.replace(new RegExp('<\\/?(' + TAGS + ')\\b[^>]*>', 'gi'), '<\\/$1>')

const GUESS =
  'Ask no more questions and output no <missing_info> block. Fill every remaining gap that only the user could decide with your best guess, written where it applies, and list every guess in the guessed-details section at the end of the rewrite.'

// Stardea (星念) is not part of this port: the model must not point the person at it.
const NO_STARDEA = 'There is no Stardea (星念) button here: never mention Stardea or point the user to it.'

export const asksOneAtATime = (mode: Mode) => mode !== 'light'

export const systemPrompt = (mode: Mode, maxQuestions: number): string =>
  [
    PROMPTS.discipline,
    PROMPTS[mode],
    PROMPTS.questions.split('{{maxQuestions}}').join(String(asksOneAtATime(mode) ? 1 : maxQuestions)),
    PROMPTS.answers,
    NO_STARDEA,
  ].join('\n\n')

const followUpStatus = (job: Job, maxQuestions: number): string => {
  const left = maxQuestions - job.rounds.length
  const body = job.isSkipped
    ? 'The user skipped the follow-up questions. ' + GUESS
    : left <= 0
      ? (maxQuestions === 0 ? 'Follow-up questions cannot be asked for this request. ' : 'The follow-up question limit is reached. ') + GUESS
      : 'You may ask follow-up questions: ' + String(left) + ' left in total. Ask at most one question in this reply, and only if a gap only the user can decide remains. Do not guess.'
  return '<follow_up_status>\n' + body + '\n</follow_up_status>'
}

export const userMessage = (job: Job, maxQuestions: number, extra = ''): string => {
  const answers =
    job.rounds.length === 0
      ? ''
      : '\n<user_answers>\n' +
        job.rounds.map((r, i) => `Q${i + 1}: ${escapeTags(r.question)}\nA${i + 1}: ${escapeTags(r.answer)}`).join('\n') +
        '\n</user_answers>\nThe user answered your follow-up questions. Rewrite the draft again with these answers included.'
  const status = asksOneAtATime(job.mode) ? '\n' + followUpStatus(job, maxQuestions) : ''
  return 'Rewrite the following prompt:\n<raw_prompt>\n' + escapeTags(job.source) + '\n</raw_prompt>' + answers + status + (extra ? '\n' + extra : '')
}

/** Splits a reply into the rewrite and its one follow-up question, if any. */
export const parseRewrite = (reply: string): { text: string; question: string | null } => {
  const block = /<missing_info>([\s\S]*?)(?:<\/missing_info>|$)/i.exec(reply)
  const question = block ? (/<question>([\s\S]*?)<\/question>/i.exec(block[1] ?? '')?.[1]?.trim() ?? null) : null
  const text = (block ? reply.slice(0, block.index) : reply)
    .replace(/^\s*```[a-z]*\n([\s\S]*?)\n```\s*$/i, '$1')
    .trim()
  return { text, question: question || null }
}

export const nextStepsPrompt = (count: number, already: string[], conversation: string): string =>
  [
    PROMPTS['next-steps'].split('{{count}}').join(String(count)),
    '<recent_conversation>\n' + escapeTags(conversation) + '\n</recent_conversation>',
    already.length ? '<already_suggested>\n' + already.map(escapeTags).join('\n') + '\n</already_suggested>' : '',
  ].filter(Boolean).join('\n\n')

export const parseSuggestions = (reply: string): string[] =>
  [...reply.matchAll(/<suggestion>([\s\S]*?)<\/suggestion>/gi)].map(m => (m[1] ?? '').trim()).filter(Boolean)

/** Light mode's ceiling: 2x the draft, at least 600 characters. */
export const lightCeiling = (draft: string) => Math.max(600, draft.length * 2)
