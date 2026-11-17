// Smart Prompt: a Claude Code port of dsh-smart-prompt v1.3.0.
// ✦ Refine rewrites the prompt box into a clearer, agent-ready prompt; the mode (Detailed / Standard /
// Light) follows the session's model, and the latest Opus at low effort does the rewriting,
// with Revert / Retry / Iterate, one-at-a-time follow-up questions and next-step suggestions.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Job, Mode, SmartPromptSettings, Suggest, Version } from '../types'
import { extractAnchors, missingAnchors, reinjectionBlock, repairClause } from './anchors'
import {
  asksOneAtATime,
  lightCeiling,
  nextStepsPrompt,
  parseRewrite,
  parseSuggestions,
  systemPrompt,
  userMessage,
} from './build'

const NAME = 'smart-prompt'
const LABEL: Record<Mode, string> = { detailed: 'Detailed', standard: 'Standard', light: 'Light' }
// The alias resolves to the latest Opus; every refine and suggestion runs on it at low effort.
const REFINER = { model: 'opus', effort: 'low' } as const
const CONTEXT_MESSAGES = 8
const CONTEXT_CHARS = 2000
const SUGGESTION_COUNT = 2
const DEFAULTS: SmartPromptSettings = { maxQuestions: 5, autoSuggest: false }
const NO_SUGGEST: Suggest = { forReply: -1, items: [], isOpen: false, isLoading: false }

const settings = atom({ plugin: 'smart-prompt', key: 'settings' } as const, DEFAULTS)
const job = atom({ plugin: 'smart-prompt', key: 'job' } as const, null as Job | null)
const versions = atom({ plugin: 'smart-prompt', key: 'versions' } as const, [] as Version[])
const note = atom({ plugin: 'smart-prompt', key: 'note' } as const, null as string | null)
const isDraftEmpty = atom({ plugin: 'smart-prompt', key: 'isDraftEmpty' } as const, true)
const replies = atom({ plugin: 'smart-prompt', key: 'replies' } as const, 0)
const suggest = atom({ plugin: 'smart-prompt', key: 'suggest' } as const, NO_SUGGEST)

type $ = EngineInterface
type Reply = { ok: true; text: string; input: number; cached: number; output: number } | { ok: false; why: string }

let nextJobId = 1

// ---- model calls -----------------------------------------------------------------------------

/** The mode follows the session's model: Fable/Opus → Light, Sonnet → Standard, Haiku → Detailed. */
const modeFor = (model: string): Mode =>
  /fable|opus/i.test(model) ? 'light' : /haiku/i.test(model) ? 'detailed' : 'standard'

const modelName = (model: string) =>
  /fable/i.test(model) ? 'Fable' : /opus/i.test(model) ? 'Opus' : /sonnet/i.test(model) ? 'Sonnet' : /haiku/i.test(model) ? 'Haiku' : model

/** The latest turns as plain text, newest last, for the model to resolve what the draft leaves implicit. */
const recentConversation = async ($: $, count: number): Promise<string> => {
  const messages = (await $.session.messages()).filter(m => m.text.trim() !== '').slice(-count)
  return messages
    .map(m => `${m.role === 'user' ? 'USER' : 'AGENT'}: ${m.text.length > CONTEXT_CHARS ? m.text.slice(0, CONTEXT_CHARS) + ' …' : m.text}`)
    .join('\n\n')
}

const contextBlock = (conversation: string) =>
  conversation === ''
    ? ''
    : [
        '<conversation_context>',
        'The latest turns of the conversation the draft belongs to.',
        'Use it ONLY to resolve what the draft leaves implicit. The draft always wins on conflict.',
        '',
        conversation.replace(/<\/?conversation_context\b[^>]*>/gi, ''),
        '</conversation_context>',
        '',
      ].join('\n')

/** One model call on the refiner model. */
const callModel = async ($: $, system: string, user: string): Promise<Reply> => {
  const r = await $.model.complete({ ...REFINER, system, prompt: user, maxTokens: 16000, timeoutMs: 180000 })
  return r.isAnswered ? { ok: true, text: r.text, ...usage(r.usage) } : { ok: false, why: r.reason }
}

const usage = (u: { input_tokens: number; cache_read_input_tokens: number; output_tokens: number }) => ({
  input: u.input_tokens,
  cached: u.cache_read_input_tokens,
  output: u.output_tokens,
})

// ---- the refine flow ---------------------------------------------------------------------------

const fill = async ($: $, text: string) => {
  await $.prompt.fill({ text, mode: 'replace' })
}

/** Starts a refine of `source`, or continues `current` after an answer or a skip. */
const start = async ($: $, kind: Job['kind'], raw: string, mode: Mode) => {
  const before = (await $.prompt.read()).text
  // A slash command keeps its name; only its text is rewritten.
  const cmd = /^(\/\S+\s+)([\s\S]+)$/.exec(raw)
  const fresh: Job = {
    id: nextJobId++, kind, mode, raw, prefix: cmd?.[1] ?? '', source: cmd?.[2] ?? raw, before, rounds: [], question: null, queue: [],
    isSkipped: false, startedAt: await $.clock.now(), tokens: { input: 0, cached: 0, output: 0 },
  }
  await update($, job, () => fresh)
  await update($, note, () => null)
  void round($, fresh.id)
}

/** One model round of the job with this id; drops its result when the job was cancelled. */
const round = async ($: $, id: number) => {
  const s = await read($, settings)
  const j = await read($, job)
  if (!j || j.id !== id) return
  const system = systemPrompt(j.mode, s.maxQuestions)
  const maxQ = asksOneAtATime(j.mode) ? s.maxQuestions : j.rounds.length > 0 || j.isSkipped ? 0 : s.maxQuestions

  const context = contextBlock(await recentConversation($, CONTEXT_MESSAGES))
  const first = await callModel($, system, context + userMessage(j, maxQ))
  if (!(await isLive($, id))) return
  if (!first.ok) return fail($, id, `model call failed (${first.why})`)
  await addTokens($, first)

  const parsed = parseRewrite(first.text)
  const questions = parsed.question ? [parsed.question, ...extraQuestions(first.text)] : []
  const mayAsk = !j.isSkipped && (asksOneAtATime(j.mode) ? j.rounds.length < s.maxQuestions : j.rounds.length === 0)
  if (questions.length > 0 && mayAsk) {
    const queue = asksOneAtATime(j.mode) ? [] : questions.slice(1, s.maxQuestions)
    await update($, job, cur => (cur && cur.id === id ? { ...cur, question: questions[0] ?? null, queue } : cur))
    await fill($, '')
    return
  }
  await finish($, id, parsed.text, system, maxQ)
}

/** Light mode lists every question in one block; the first is in `parseRewrite`'s answer. */
const extraQuestions = (reply: string): string[] =>
  [...reply.matchAll(/<question>([\s\S]*?)<\/question>/gi)].slice(1).map(m => (m[1] ?? '').trim()).filter(Boolean)

const isLive = async ($: $, id: number) => (await read($, job))?.id === id

const addTokens = ($: $, r: { input: number; cached: number; output: number }) =>
  update($, job, cur =>
    cur
      ? { ...cur, tokens: { input: cur.tokens.input + r.input, cached: cur.tokens.cached + r.cached, output: cur.tokens.output + r.output } }
      : cur,
  )

/** Fidelity gate, Light's length gate, then the rewrite goes into the prompt box. */
const finish = async ($: $, id: number, draftRewrite: string, system: string, maxQ: number) => {
  const s = await read($, settings)
  const j = await read($, job)
  if (!j || j.id !== id) return
  const anchors = extractAnchors(j.source)
  let text = draftRewrite

  let missing = missingAnchors(anchors, text)
  if (missing.length > 0) {
    const r = await callModel($, system, userMessage({ ...j, isSkipped: true }, maxQ, repairClause(missing)))
    if (!(await isLive($, id))) return
    if (r.ok) {
      await addTokens($, r)
      const again = parseRewrite(r.text).text
      if (again) text = again
    }
    missing = missingAnchors(anchors, text)
    text += reinjectionBlock(missing)
  }

  if (j.mode === 'light' && text.length > lightCeiling(j.source)) {
    const cap = lightCeiling(j.source)
    const shorten = `Your rewrite is ${text.length} characters, over the ${cap}-character limit. Rewrite it again in at most ${cap} characters, keeping every hard fact.`
    const r = await callModel($, system, userMessage({ ...j, isSkipped: true }, 0, shorten))
    if (!(await isLive($, id))) return
    const short = r.ok ? parseRewrite(r.text).text : ''
    if (r.ok) await addTokens($, r)
    if (!short || short.length > cap) return fail($, id, 'the Light rewrite stayed too long, so your draft was kept')
    text = short
  }

  if (!text) return fail($, id, 'the model returned an empty rewrite')

  const done = (await read($, job))!
  const seconds = ((await $.clock.now()) - done.startedAt) / 1000
  const kept = anchors.length - missingAnchors(anchors, draftRewrite).length
  const grow = j.source.length ? Math.round(((text.length - j.source.length) / j.source.length) * 100) : 0
  const t = done.tokens
  const parts = [
    `✦ ${LABEL[j.mode]}`,
    anchors.length ? `${kept}/${anchors.length} facts kept${missing.length ? `, ${missing.length} re-added` : ''}` : null,
    `${grow >= 0 ? '+' : ''}${grow}% length`,
    `${seconds.toFixed(1)}s`,
    t.input + t.cached + t.output > 0 ? `tokens ${t.input}(${t.cached}) - ${t.output}` : null,
  ]

  await update($, versions, list => {
    const base = list.length > 0 ? list : [{ text: j.raw }]
    const next: Version = { text: j.prefix + text, mode: j.mode, source: j.raw }
    return j.kind === 'retry' ? [...base.slice(0, -1), next] : [...base, next]
  })
  await update($, job, () => null)
  await update($, note, () => parts.filter(Boolean).join(' · '))
  await fill($, j.prefix + text)
}

const fail = async ($: $, id: number, why: string) => {
  const j = await read($, job)
  if (!j || j.id !== id) return
  await update($, job, () => null)
  await update($, note, () => `✦ Not refined: ${why}.`)
  if (j.question !== null || (await $.prompt.read()).text === '') await fill($, j.before)
}

const cancel = async ($: $) => {
  const j = await read($, job)
  if (!j) return
  await update($, job, () => null)
  await update($, note, () => '✦ Cancelled; your draft is unchanged.')
  await fill($, j.before)
}

/** Records the answer (or "I don't know") to the open question, then asks the next or rewrites. */
const answer = async ($: $, given: string | null) => {
  const j = await read($, job)
  if (!j || j.question === null) return
  const text = given ?? (await $.prompt.read()).text.trim()
  const reply = text === '' ? "I don't know" : text
  const rounds = [...j.rounds, { question: j.question, answer: reply }]
  const [nextQ, ...rest] = j.queue
  await update($, job, () => ({ ...j, rounds, question: nextQ ?? null, queue: rest }))
  if (nextQ) return fill($, '')
  await fill($, j.before)
  void round($, j.id)
}

const skip = async ($: $) => {
  const j = await read($, job)
  if (!j || j.question === null) return
  await update($, job, () => ({ ...j, question: null, queue: [], isSkipped: true }))
  await fill($, j.before)
  // Light keeps its first rewrite's TBD notes; Standard and Detailed guess and list the guesses.
  void round($, j.id)
}

// ---- revert / retry / iterate --------------------------------------------------------------

const revert = async ($: $) => {
  const list = await read($, versions)
  if (list.length < 2) return
  const rest = list.slice(0, -1)
  await update($, versions, () => (rest.length > 1 ? rest : []))
  await update($, note, () => (rest.length > 1 ? '✦ Back one version.' : '✦ Back to your original draft.'))
  await fill($, rest.at(-1)?.text ?? "")
}

const retry = async ($: $) => {
  const top = (await read($, versions)).at(-1)
  if (top?.source !== undefined && top.mode) await start($, 'retry', top.source, top.mode)
}

const iterate = async ($: $) => {
  const top = (await read($, versions)).at(-1)
  if (top?.mode) await start($, 'iterate', top.text, top.mode)
}

const refine = async ($: $, text?: string) => {
  const draft = (text ?? (await $.prompt.read()).text).trim()
  if (!draft) return
  await update($, versions, () => [])
  await start($, 'refine', draft, modeFor(await $.session.model()))
}

// ---- next-step suggestions ---------------------------------------------------------------------

const loadSuggestions = async ($: $, more: boolean) => {
  const now = await read($, replies)
  const cur = await read($, suggest)
  if (cur.isLoading) return
  const kept = cur.forReply === now ? cur.items : []
  if (kept.length > 0 && !more) return update($, suggest, () => ({ ...cur, isOpen: true }))
  await update($, suggest, () => ({ forReply: now, items: kept, isOpen: true, isLoading: true }))
  const conversation = await recentConversation($, CONTEXT_MESSAGES * 2)
  const r = await $.model.complete({ ...REFINER, prompt: nextStepsPrompt(SUGGESTION_COUNT, kept, conversation), maxTokens: 2000 })
  const items = r.isAnswered ? parseSuggestions(r.text).slice(0, SUGGESTION_COUNT) : []
  await update($, suggest, s => (s.forReply === now ? { ...s, items: [...s.items, ...items], isLoading: false } : s))
  if (!r.isAnswered && r.reason !== 'aborted') $.ui.toast(`Smart Prompt: no suggestions (${r.reason})`)
}

const closeSuggestions = ($: $) => update($, suggest, s => ({ ...s, isOpen: false }))

// ---- settings ------------------------------------------------------------------------------------

const setSettings = async ($: $, change: Partial<SmartPromptSettings>) => {
  const next = { ...(await read($, settings)), ...change }
  await update($, settings, () => next)
  await $.store.set('settings', next)
}

const describe = (s: SmartPromptSettings) =>
  [
    `Smart Prompt — follow-up questions ${s.maxQuestions}, auto-suggest ${s.autoSuggest ? 'on' : 'off'}.`,
    'The mode follows the session model: Fable/Opus → Light, Sonnet → Standard, Haiku → Detailed. Refining runs on the latest Opus at low effort.',
    'Change with /smart-prompt questions <0-10> · auto <on|off>',
  ].join('\n')

// Editing or sending the draft ends Revert / Retry / Iterate; an empty box may offer next steps.
const draftChanged = async ($: $, text: string) => {
  const isEmpty = text.trim() === ''
  if ((await read($, isDraftEmpty)) !== isEmpty) await update($, isDraftEmpty, () => isEmpty)
  if (await read($, job)) return // the person is typing an answer
  if ((await read($, versions)).length > 0) await update($, versions, () => [])
  if (await read($, note)) await update($, note, () => null)
  if (!isEmpty && (await read($, suggest)).isOpen) await closeSuggestions($)
}

// ---- hooks ------------------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const stored = (await $.store.get('settings')) as Partial<SmartPromptSettings> | undefined
    await update($, settings, () => ({ ...DEFAULTS, ...(stored ?? {}) }))
    const box = await $.prompt.read()
    await update($, isDraftEmpty, () => box.text.trim() === '')
    await $.command.register({
      name: 'refine',
      description: 'Rewrite text into a clearer, agent-ready prompt (Smart Prompt)',
      argumentHint: '<draft>',
    })
    await $.command.register({
      name: 'smart-prompt',
      description: 'Show or change Smart Prompt settings',
      argumentHint: 'questions|auto <value>',
    })
    return next(e)
  })

  on('command.run', { command: 'refine' }, async ($, e) => {
    if (!e.args.trim()) return { text: 'Type a draft, then press ✦ Refine above the prompt — or run /refine <draft>.' }
    void refine($, e.args)
    return { text: 'Refining… the rewrite lands in the prompt box.' }
  })

  on('command.run', { command: 'smart-prompt' }, async ($, e) => {
    const [key, value = ''] = e.args.trim().split(/\s+/)
    const v = value.toLowerCase()
    if (key === 'questions' && /^\d+$/.test(v)) await setSettings($, { maxQuestions: Math.min(10, Number(v)) })
    else if (key === 'auto' && (v === 'on' || v === 'off')) await setSettings($, { autoSuggest: v === 'on' })
    else if (key) return { text: `Unknown setting "${e.args.trim()}".\n` + describe(await read($, settings)) }
    return { text: describe(await read($, settings)) }
  })

  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    await draftChanged($, box.text)
    return box
  })

  on('prompt.submit', async ($, e, next) => {
    const sent = await next(e)
    await draftChanged($, '')
    return sent
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const n = (await read($, replies)) + 1
    await update($, replies, () => n)
    await update($, suggest, () => NO_SUGGEST)
    if ((await read($, settings)).autoSuggest) void loadSuggestions($, false)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const model = await $.session.model()
    const j = await read($, job)
    const list = await read($, versions)
    const msg = await read($, note)
    const empty = await read($, isDraftEmpty)
    const sug = await read($, suggest)
    const turns = await read($, replies)

    if (j?.question) {
      const asked = j.rounds.length + 1
      return (
        <Box flexDirection="column">
          <Text>
            <Text bold>✦ Question {asked}</Text>
            <Text dimColor> ({LABEL[j.mode]}) </Text>
            {j.question}
          </Text>
          <Text dimColor>Type your answer in the prompt box, then press Answer. Your draft comes back afterwards.</Text>
          <Box flexDirection="row" gap={1}>
            <Button key="sp-answer" variant="primary" label="Answer" onPress={() => void answer($, null)} />
            <Button key="sp-dunno" label="I don't know" onPress={() => void answer($, "I don't know")} />
            <Button key="sp-skip" label="Skip" onPress={() => void skip($)} />
            <Button key="sp-close" role="dismiss" label="×" onPress={() => void cancel($)} />
          </Box>
        </Box>
      )
    }

    if (j) {
      return (
        <Box flexDirection="row" gap={1}>
          <Text dimColor>✦ {j.kind === 'iterate' ? 'Iterating' : 'Refining'} ({LABEL[j.mode]})…</Text>
          <Button key="sp-cancel" role="dismiss" label="Cancel" onPress={() => void cancel($)} />
        </Box>
      )
    }

    if (empty && sug.isOpen) {
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text bold>✦ What to ask next</Text>
            <Button key="sp-sug-close" role="dismiss" label="×" onPress={() => void closeSuggestions($)} />
          </Box>
          {sug.items.map((item, i) => (
            <Button
              key={`sp-sug-${i}`}
              hotkey={String(i + 1)}
              onPress={async () => {
                await closeSuggestions($)
                await fill($, item)
              }}
            >
              {`${i + 1}. ${item}`}
            </Button>
          ))}
          {sug.isLoading ? (
            <Text dimColor>Thinking about what you'll ask…</Text>
          ) : (
            <Button key="sp-sug-more" label={`✦ ${SUGGESTION_COUNT} more`} onPress={() => void loadSuggestions($, true)} />
          )}
        </Box>
      )
    }

    if (empty) {
      if (turns === 0 && !msg) return next(e)
      return (
        <Box flexDirection="row" gap={1}>
          {turns > 0 && <Button key="sp-next" label="✦ What to ask next" onPress={() => void loadSuggestions($, false)} />}
          {msg && <Text dimColor>{msg}</Text>}
        </Box>
      )
    }

    const canStep = list.length > 1
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="sp-refine" variant="primary" label="✦ Refine" onPress={() => void refine($)} />
          <Text dimColor>
            {LABEL[modeFor(model)]} for {modelName(model)}
          </Text>
          {canStep && <Text dimColor>│</Text>}
          {canStep && <Button key="sp-revert" label="Revert" onPress={() => void revert($)} />}
          {canStep && <Button key="sp-retry" label="Retry" onPress={() => void retry($)} />}
          {canStep && <Button key="sp-iterate" label="Iterate" onPress={() => void iterate($)} />}
        </Box>
        {msg && <Text dimColor>{msg}</Text>}
      </Box>
    )
  })
}
