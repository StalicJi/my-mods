import { describe, expect, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const

const wait = () => new Promise(done => (globalThis as any).setTimeout(done, 10))

const BAND = {
  plugin: 'next-steps',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// 模擬引擎：記下送給 fork 的指示與填進輸入框的文字，並回傳固定的建議
function engine(on: any, reply: string) {
  const sent = { prompt: '', filled: '' }
  on('turn.complete', () => ({ text: '' }))
  on('command.list', () => ({ value: [] }))
  on('model.fork', (_$: any, e: any) => {
    sent.prompt = e.prompt
    return { value: { isAnswered: true, text: reply, usage: USAGE } }
  })
  on('prompt.suggest', () => ({ isShown: true }))
  on('prompt.fill', (_$: any, e: any) => {
    sent.filled = e.text
    return { isFilled: true }
  })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  return sent
}

const ACTIVE = { plugin: 'next-steps', key: 'active' } as const

// 代替 host 保存 next-steps 的 active（where-am-i 讀的就是它）；writes 依序記下每次寫入的值
function activeState(on: any, leftover?: boolean) {
  const held = { value: leftover, version: leftover === undefined ? 0 : 1, writes: [] as unknown[] }
  on('state.get', ACTIVE, () => ({ value: { value: held.value, version: held.version } }))
  on('state.set', ACTIVE, (_$: any, e: any) => {
    held.value = e.value
    held.version += 1
    held.writes.push(e.value)
    return { value: { isSet: true, version: held.version } }
  })
  return held
}

const TWO_SUGGESTIONS = '[{"label":"跑測試","prompt":"跑 next-steps 的測試"},{"label":"提交","prompt":"幫我 commit"}]'

function finishTurn($: any) {
  return $.turn.complete({ reason: 'answer', answer: '已完成修改。'.repeat(20), durationMs: 1, isAborted: false, turnId: 't1' })
}

describe('next-steps（繁中版）', () => {
  test('送給模型的指示要求用繁體中文，並保留檔名與指令原文', async ($, on) => {
    const sent = engine(on, '[]')
    await finishTurn($)
    await wait()

    expect(sent.prompt).toContain('Traditional Chinese as used in Taiwan')
    expect(sent.prompt).toContain('繁體中文，台灣用語')
    expect(sent.prompt).toContain('Keep file names, commands, code identifiers')
    // 語言要求要放在輸出格式說明之前，模型讀到 JSON 格式時語言要求還在眼前
    expect(sent.prompt.indexOf('繁體中文')).toBeLessThan(sent.prompt.indexOf('Answer with ONLY a JSON array'))
  })

  test('模型回傳的中文建議畫成 1、2 按鈕', async ($, on) => {
    engine(on, '[{"label":"幫 issue 補上重現步驟","prompt":"幫 issue 草稿補上重現步驟"},{"label":"記錄今天的工作","prompt":"/company:work-report"}]')
    await finishTurn($)
    await wait()

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface } as any)
      expect(await ui.find({ type: 'Button', text: /幫 issue 補上重現步驟/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', text: /dismiss/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('回答太短時不產生建議', async ($, on) => {
    const sent = engine(on, '[]')
    await $.turn.complete({ reason: 'answer', answer: '好', durationMs: 1, isAborted: false, turnId: 't1' } as any)
    await wait()
    expect(sent.prompt).toBe('')
  })
})

describe('active：清單顯示中才是 true，where-am-i 據此讓出 Next:', () => {
  test('建議出現時寫成 true，只寫一次', async ($, on) => {
    engine(on, TWO_SUGGESTIONS)
    const active = activeState(on)
    await finishTurn($)
    await wait()

    expect(active.value).toBe(true)
    expect(active.writes).toEqual([true])
  })

  test('按 dismiss 或選了一項後設回 false', async ($, on) => {
    const sent = engine(on, TWO_SUGGESTIONS)
    const active = activeState(on)

    for (const key of ['dismiss', 'pick1']) {
      await finishTurn($)
      await wait()
      expect(active.value).toBe(true)

      const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
      await ui.press({ key })
      await wait()
      expect(active.value).toBe(false)
      await ui.unmount()
    }
    expect(sent.filled).toBe('跑 next-steps 的測試')
  })

  test('新回合開始時設回 false', async ($, on) => {
    engine(on, TWO_SUGGESTIONS)
    const active = activeState(on)
    on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
    await finishTurn($)
    await wait()

    await $.turn.start({ text: '下一步', turnId: 't2' } as any)
    await wait()
    expect(active.value).toBe(false)
  })

  test('沒有建議時完全不寫入', async ($, on) => {
    engine(on, '[]')
    const active = activeState(on)
    await finishTurn($)
    await wait()

    expect(active.writes).toEqual([])
  })

  test('session 開始時把熱重載前留下的 true 清掉', async ($, on) => {
    const active = activeState(on, true)
    on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/tmp', surface: 'terminal' } as any)
    await wait()

    expect(active.value).toBe(false)
  })
})
