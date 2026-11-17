import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'smart-prompt',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false },
} as const

const DRAFT = 'can you change maxRatioFor in src/host/config.ts to 2.5'
const REWRITE = 'Change `maxRatioFor` in `src/host/config.ts` to `2.5`.'

test('Refine rewrites the draft, keeps its facts, and Revert puts it back', async ($, on) => {
  let box = DRAFT
  let now = 0
  let model = 'claude-sonnet-5-5'
  const calls: string[] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: (now += 1000) }))
  on('prompt.read', () => ({ value: { text: box, cursor: box.length } }))
  on('prompt.fill', (_, e) => {
    box = e.text
    return { isFilled: true, text: box, cursor: box.length }
  })
  on('prompt.edit', (_, e) => ({ text: DRAFT, cursor: DRAFT.length }))
  on('session.model', () => ({ value: model }))
  on('session.messages', () => ({ value: [] }))
  on('model.complete', (_, e) => {
    calls.push(`${e.model}/${e.effort}/${/Mode: (\w+)/.exec(String(e.system))?.[1]}`)
    return {
    value: {
      isAnswered: true,
      text: REWRITE,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 },
    },
    }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.edit({ text: '', cursor: 0, start: 0, end: 0, inputText: DRAFT } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    box = DRAFT
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'sp-refine' })
    expect(box).toBe(REWRITE)
    const note = await ui.find({ type: 'Text', text: /facts kept/ })
    expect(note?.text).toContain('3/3 facts kept')
    await ui.press({ key: 'sp-revert' })
    expect(box).toBe(DRAFT)
    await ui.unmount()
  }

  // The mode follows the session model; the rewrite always runs on Opus at low effort.
  for (const [id, mode] of [['claude-fable-5-2', 'light'], ['claude-opus-5-5', 'light'], ['claude-sonnet-5-5', 'standard'], ['claude-haiku-5-5', 'detailed']]) {
    model = id!
    box = DRAFT
    calls.length = 0
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(ui.find({ type: 'Button', key: 'sp-mode-light' })).resolves.toBeUndefined()
    await ui.press({ key: 'sp-refine' })
    expect(calls[0]).toBe(`opus/low/${mode}`)
    await ui.unmount()
  }
})
