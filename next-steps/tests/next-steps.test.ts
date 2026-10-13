import { describe, expect, test } from 'claude-code/testing'

import { findKeyed, hasRoomForFrames, replaceKeyed } from '../hooks/register'

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

const bandWith = (maxRows: number) => ({ ...BAND, surface: 'terminal', props: { ...BAND.props, maxRows, scroll: { offset: 0, bodyRows: maxRows } } })

// 畫出來的樹裡，next 清單那個 Box（第一個子元素是「next:」或「next steps…」）
function listBox(node: any): any {
  if (!node || typeof node !== 'object') return null
  const first = node.children?.[0]
  if (node.type === 'Box' && first?.type === 'Text' && /^next/.test(String(first.children?.[0] ?? ''))) return node
  for (const child of node.children ?? []) {
    const found = listBox(child)
    if (found !== null) return found
  }
  return null
}

// 代替串接在裡面的 gitlab-sync 與 Claude Code：其他內容在上、gitlab-sync 那一段（key gitlab-band，有框）在最後
function engineWithGitlabLine(on: any, reply: string) {
  const sent = { filled: '' }
  on('turn.complete', () => ({ text: '' }))
  on('command.list', () => ({ value: [] }))
  on('model.fork', () => ({ value: { isAnswered: true, text: reply, usage: USAGE } }))
  on('prompt.suggest', () => ({ isShown: true }))
  on('prompt.fill', (_$: any, e: any) => {
    sent.filled = e.text
    return { isFilled: true }
  })
  on('ui.render', ($: any, e: any) => {
    const { Box, Text } = $.ui.resolve(e)
    return Box({
      flexDirection: 'column',
      children: [
        Text({ children: 'engine draws' }),
        Box({ key: 'gitlab-band', borderStyle: 'round', borderColor: 'subtle', paddingX: 1, children: [Text({ children: 'GitLab line' })] }),
      ],
    })
  })
  return sent
}

describe('band 的每一段各一個框，放不下時一起拿掉', () => {
  test('清單加框線上下兩列，再加 gitlab-sync 那一段有框時的 3 列，放得下才加框', () => {
    // 兩個建議：next:、兩個選項、dismiss 共 4 列
    expect(hasRoomForFrames(9, 4, true)).toBe(true)
    expect(hasRoomForFrames(8, 4, true)).toBe(false)
    // 沒有 gitlab-sync 那一段時只算清單
    expect(hasRoomForFrames(6, 4, false)).toBe(true)
    expect(hasRoomForFrames(5, 4, false)).toBe(false)
  })

  test('放得下時清單有圓角框，gitlab-sync 那一段的框照留', async ($, on) => {
    engineWithGitlabLine(on, TWO_SUGGESTIONS)
    await finishTurn($)
    await wait()

    const ui = await $.ui.mount(bandWith(9) as any)
    const drawn = await ui.drawn()
    expect(listBox(drawn).props).toMatchObject({ borderStyle: 'round', borderColor: 'subtle', paddingX: 1 })
    expect((findKeyed(drawn as any, 'gitlab-band') as any).props).toMatchObject({ borderStyle: 'round', paddingX: 1 })
    await ui.unmount()
  })

  test('放不下時清單與 gitlab-sync 那一段的框一起拿掉，改兩格內距讓文字留在同一欄，選項照樣都在', async ($, on) => {
    engineWithGitlabLine(on, TWO_SUGGESTIONS)
    await finishTurn($)
    await wait()

    const ui = await $.ui.mount(bandWith(8) as any)
    const drawn = await ui.drawn()
    const list = listBox(drawn)
    expect(list.props.borderStyle).toBeUndefined()
    expect(list.props.paddingX).toBe(2)
    const gitlab = findKeyed(drawn as any, 'gitlab-band') as any
    expect(gitlab.props.borderStyle).toBeUndefined()
    expect(gitlab.props.borderColor).toBeUndefined()
    expect(gitlab.props.paddingX).toBe(2)
    expect(await ui.find({ type: 'Button', text: /提交/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /dismiss/ })).toBeDefined()
    await ui.unmount()
  })

  test('裡面的 mod 已經拿掉 gitlab-sync 那一段的框時，清單也不加框', async ($, on) => {
    on('turn.complete', () => ({ text: '' }))
    on('command.list', () => ({ value: [] }))
    on('model.fork', () => ({ value: { isAnswered: true, text: TWO_SUGGESTIONS, usage: USAGE } }))
    on('prompt.suggest', () => ({ isShown: true }))
    on('ui.render', ($: any, e: any) => {
      const { Box, Text } = $.ui.resolve(e)
      return Box({ flexDirection: 'column', children: [Box({ key: 'gitlab-band', paddingX: 2, children: [Text({ children: 'GitLab line' })] })] })
    })
    await finishTurn($)
    await wait()

    const ui = await $.ui.mount(bandWith(30) as any)
    expect(listBox(await ui.drawn()).props.borderStyle).toBeUndefined()
    await ui.unmount()
  })

  test('產生建議時的「next steps…」也有框', async ($, on) => {
    // 跟 engine() 一樣，只是建議一直還沒回來，畫面停在產生中
    on('turn.complete', () => ({ text: '' }))
    on('command.list', () => ({ value: [] }))
    on('model.fork', () => new Promise(() => {}))
    on('ui.render', () => ({ type: 'engine', ref: 0 }))
    void finishTurn($)
    await wait()

    const roomy = await $.ui.mount(bandWith(3) as any)
    expect(await roomy.find({ type: 'Text', text: /next steps…/ })).toBeDefined()
    expect(listBox(await roomy.drawn()).props.borderStyle).toBe('round')
    await roomy.unmount()

    const tight = await $.ui.mount(bandWith(2) as any)
    expect(listBox(await tight.drawn()).props.borderStyle).toBeUndefined()
    await tight.unmount()
  })
})

describe('清單插在 gitlab-sync 那一段上面，讓那一段緊貼輸入框', () => {
  // 畫出來的文字依序排成一串
  function textsOf(node: any): string[] {
    if (typeof node === 'string') return [node]
    if (!node || typeof node !== 'object') return []
    return ((node.children ?? []) as unknown[]).flatMap(textsOf)
  }

  test('清單在 gitlab-sync 那一段上面，那一段仍是最後一段', async ($, on) => {
    engineWithGitlabLine(on, TWO_SUGGESTIONS)
    await finishTurn($)
    await wait()

    const ui = await $.ui.mount(bandWith(11) as any)
    const texts = textsOf(await ui.drawn())
    expect(texts[texts.length - 1]).toBe('GitLab line')
    expect(texts.indexOf('engine draws')).toBeLessThan(texts.indexOf('next:'))
    expect(texts.indexOf('next:')).toBeLessThan(texts.indexOf('GitLab line'))
    await ui.unmount()
  })

  test('插進去之後按鈕照樣能按', async ($, on) => {
    const sent = engineWithGitlabLine(on, TWO_SUGGESTIONS)
    await finishTurn($)
    await wait()

    const ui = await $.ui.mount(bandWith(11) as any)
    await ui.press({ key: 'pick2' })
    await wait()
    expect(sent.filled).toBe('幫我 commit')
    await ui.unmount()
  })

  test('沒有 gitlab-sync 那一段時照舊接在最後', async ($, on) => {
    engine(on, TWO_SUGGESTIONS)
    await finishTurn($)
    await wait()

    const ui = await $.ui.mount(bandWith(11) as any)
    const drawn: any = await ui.drawn()
    expect(drawn.children[0]).toMatchObject({ type: 'engine' })
    expect(JSON.stringify(drawn.children[1])).toContain('next:')
    await ui.unmount()
  })

  test('replaceKeyed 往下層找、換成幾個元素，沿路換成新的物件，原本的 tree 不動；找不到回傳 null', () => {
    const line = { type: 'Box', props: { key: 'gitlab-band' }, children: ['GitLab line'] }
    const inner = { type: 'Box', props: { flexDirection: 'column' }, children: ['rest', line] }
    const tree = Object.freeze({ type: 'Box', props: { flexDirection: 'column' }, children: ['box', inner] })
    const block = { type: 'Text', children: ['next:'] }

    const placed: any = replaceKeyed(tree as any, 'gitlab-band', found => [block as any, found])
    expect(placed.children[1].children).toEqual(['rest', block, line])
    expect(inner.children).toEqual(['rest', line])
    expect(findKeyed(tree as any, 'gitlab-band')).toBe(line)
    expect(replaceKeyed(tree as any, 'missing', found => [found])).toBeNull()
    expect(findKeyed(tree as any, 'missing')).toBeNull()
    expect(replaceKeyed('text' as any, 'gitlab-band', found => [found])).toBeNull()
  })
})
