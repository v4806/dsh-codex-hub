/**
 * dsh-codex-catalog — client half.
 *
 * 基于 @deepseek-ai/dsh-client-ui-subagent 的解包源码改造：
 * - 会话页头注册「N 个 Codex 派发」触发器（官方子智能体目录触发器同款位置与交互）；
 * - 点击触发器打开派发目录（状态点 / 任务摘要 / Codex 派发 · 状态 · 时间 · token）；
 * - 点击任一派发，在弹层里打开它的对话窗口（任务 + 简洁/详细输出）。
 *
 * 数据来自本插件 host 的本机接口 /api/codex-catalog/live?session=<id>；
 * 本插件不写任何文件，也不依赖 DSH 的子会话机制（Codex 派发是外部任务）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-codex-catalog',
  factory: (require) => {
    const React = require('react')

    const API = '/api/codex-catalog'
    const LIVE = API + '/live'

    const RUN_EVENTS_CAP = 4000
    const RUNS_CAP = 80
    const STREAM_TEXT_CAP = 20000
    const POLL_INTERVAL = 3000
    /* 每个触发器实例独立的去重集合容量（防同步/重试导致重复投递）。 */
    const SEEN_SEQ_CAP = 200000

    const LIVE_MONO = {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: '12px',
      lineHeight: '1.55',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    }

    /* ===== 数据：把 Codex 日志事件按 threadId 分组成「一次派发」 ===== */

    /** 把一条事件并进列表：连续的文字增量合并成一段，避免一条一行。 */
    function appendLive(list, ev) {
      if (!ev || typeof ev !== 'object') return list
      if (ev.kind === 'delta') {
        const piece = String(ev.text || '')
        const last = list[list.length - 1]
        if (last && last.kind === 'stream') {
          let text = last.text + piece
          if (text.length > STREAM_TEXT_CAP) text = '…（输出过长，已截断）\n' + text.slice(-STREAM_TEXT_CAP)
          list[list.length - 1] = { kind: 'stream', text }
        } else {
          list.push({ kind: 'stream', text: piece.slice(-STREAM_TEXT_CAP) })
        }
        return list
      }
      list.push(ev)
      return list
    }

    /** 纯函数：把事件流按 threadId 分组；入参 { runs, seenSeqs }，返回新对象，不修改入参。 */
    function applyEventsToRuns(prev, events) {
      const prevRuns = prev && Array.isArray(prev.runs) ? prev.runs : []
      const seenSeqs = new Set(prev && prev.seenSeqs instanceof Set ? prev.seenSeqs : undefined)
      const runs = prevRuns.map((run) => Object.assign({}, run, { events: run.events.slice() }))
      const byThread = new Map()
      for (const run of runs) {
        if (run.threadId) byThread.set(run.threadId, run)
      }
      let last = runs.length > 0 ? runs[runs.length - 1] : null
      for (const ev of events) {
        if (!ev || typeof ev !== 'object') continue
        /* 事件带 seq（日志世代 + 字节位置）：重试/重复投递时按 seq 去重（每个实例独立）。 */
        if (seenSeqs && (typeof ev.seq === 'number' || typeof ev.seq === 'string')) {
          const seqKey = String(ev.seq)
          if (seenSeqs.has(seqKey)) continue
          seenSeqs.add(seqKey)
          if (seenSeqs.size > SEEN_SEQ_CAP) seenSeqs.clear()
        }
        const threadId = typeof ev.threadId === 'string' ? ev.threadId : ''
        let run = null
        if (threadId) {
          run = byThread.get(threadId) || null
          if (run === null) {
            run = {
              threadId,
              key: threadId,
              t: ev.t || Date.now(),
              lastT: ev.t || Date.now(),
              endT: 0,
              events: [],
              tokens: null,
              status: '',
              error: null,
              taskText: '',
            }
            runs.push(run)
            byThread.set(threadId, run)
          }
        } else {
          run = last
          if (run === null) {
            run = {
              threadId: '',
              key: 'misc-' + (ev.t || Date.now()),
              t: ev.t || Date.now(),
              lastT: ev.t || Date.now(),
              endT: 0,
              events: [],
              tokens: null,
              status: '',
              error: null,
              taskText: '',
            }
            runs.push(run)
          }
        }
        run.events = appendLive(run.events, ev)
        if (run.events.length > RUN_EVENTS_CAP) run.events.splice(0, run.events.length - RUN_EVENTS_CAP)
        if (ev.kind === 'task' && ev.text && !run.taskText) {
          run.taskText = String(ev.text).replace(/\s+/g, ' ').trim().slice(0, 80) || '（空任务）'
        }
        if (ev.kind === 'tokens') run.tokens = { input: ev.input, cached: ev.cached, output: ev.output }
        if (ev.kind === 'turn_done') {
          run.status = String(ev.status || 'done')
          run.error = ev.error || null
          run.endT = ev.t || run.lastT
        }
        if (ev.t) run.lastT = ev.t
        last = run
      }
      if (runs.length > RUNS_CAP) runs.splice(0, runs.length - RUNS_CAP)
      return { runs, seenSeqs }
    }

    /** 任务摘要：第一条「发送给 Codex 的任务」，压成一行。 */
    function runTaskText(run) {
      if (run.taskText) return run.taskText
      for (const ev of run.events) {
        if (ev && ev.kind === 'task' && ev.text) {
          return String(ev.text).replace(/\s+/g, ' ').trim().slice(0, 80) || '（空任务）'
        }
      }
      return '（等待任务…）'
    }

    /** 状态：运行中 / 完成 / 失败 / 状态未知（长时间无新事件且没有结束标记时，不冒充运行中）。 */
    function runStatusOf(run) {
      if (run.status === 'completed') return { text: '已完成', color: '#2bb673' }
      if (run.status) return { text: run.status === 'failed' ? '失败' : run.status, color: '#ff8a80' }
      const last = Number(run.lastT || run.t || 0)
      const silenceMs = last > 0 ? Date.now() - last : 0
      if (silenceMs > 120 * 1000) {
        return { text: '状态未知（' + Math.round(silenceMs / 1000) + ' 秒无更新）', color: 'var(--dsw-alias-label-tertiary, #8b8f96)' }
      }
      return { text: '运行中', color: '#f0a13c' }
    }

    function formatRunTime(ms) {
      try {
        return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
      } catch {
        return ''
      }
    }

    function runTokenText(run) {
      if (!run.tokens) return ''
      const input = Number(run.tokens.input)
      const output = Number(run.tokens.output)
      if (!Number.isFinite(input) && !Number.isFinite(output)) return ''
      const parts = []
      if (Number.isFinite(input)) parts.push('in ' + input)
      if (Number.isFinite(output)) parts.push('out ' + output)
      return parts.join(' / ')
    }

    function runDurationText(run) {
      const end = run.endT > 0 ? run.endT : 0
      if (!end || !run.t) return ''
      const ms = Math.max(0, end - run.t)
      const seconds = Math.round(ms / 1000)
      if (seconds < 1) return '<1 秒'
      if (seconds < 60) return seconds + ' 秒'
      const minutes = Math.floor(seconds / 60)
      return minutes + ' 分 ' + (seconds % 60) + ' 秒'
    }

    /* ===== 轻量 Markdown 渲染：代码块 / 标题 / 列表 / 引用 / 加粗 / 行内代码 / 链接 ===== */

    function renderInlineMarkdown(text, keyPrefix) {
      const nodes = []
      const source = String(text || '')
      let last = 0
      let count = 0
      const pushText = (value) => {
        if (value) nodes.push(value)
      }
      /* 单次扫描：只在特殊字符位置尝试匹配，避免对每个位置重复扫描后缀（O(n^2)）。 */
      const special = /[`*[]/g
      let match
      while ((match = special.exec(source)) !== null) {
        const at = match.index
        if (at > last) pushText(source.slice(last, at))
        const rest = source.slice(at, at + 4096)
        let inline = /^`([^`\n]+)`/.exec(rest)
        if (inline) {
          nodes.push(
            React.createElement('code', { key: keyPrefix + '-c' + count++, className: 'dsh-codex-catalog-md-code' }, inline[1]),
          )
          last = at + inline[0].length
          special.lastIndex = last
          continue
        }
        inline = /^\*\*([^*\n]+)\*\*/.exec(rest)
        if (inline) {
          nodes.push(React.createElement('strong', { key: keyPrefix + '-b' + count++ }, inline[1]))
          last = at + inline[0].length
          special.lastIndex = last
          continue
        }
        inline = /^\*([^*\n]+)\*/.exec(rest)
        if (inline) {
          nodes.push(React.createElement('em', { key: keyPrefix + '-i' + count++ }, inline[1]))
          last = at + inline[0].length
          special.lastIndex = last
          continue
        }
        inline = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest)
        if (inline) {
          const href = inline[2]
          /* 只允许 http/https 链接；javascript:/data: 等协议按普通文本显示。 */
          if (/^https?:\/\//i.test(href)) {
            nodes.push(
              React.createElement(
                'a',
                {
                  key: keyPrefix + '-a' + count++,
                  href,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  className: 'dsh-codex-catalog-md-link',
                },
                inline[1],
              ),
            )
          } else {
            pushText(inline[0])
          }
          last = at + inline[0].length
          special.lastIndex = last
          continue
        }
        /* 不构成标记的字符：按普通文本保留，继续扫描下一个特殊字符。 */
        pushText(source[at])
        last = at + 1
        special.lastIndex = last
      }
      if (last < source.length) pushText(source.slice(last))
      return nodes
    }

    function renderMarkdown(text, keyPrefix) {
      const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
      const blocks = []
      let i = 0
      let key = 0
      while (i < lines.length) {
        const line = lines[i]
        if (/^```/.test(line)) {
          i += 1
          const code = []
          while (i < lines.length && !/^```/.test(lines[i])) {
            code.push(lines[i])
            i += 1
          }
          i += 1
          blocks.push(
            React.createElement(
              'pre',
              { key: keyPrefix + '-pre' + key++, className: 'dsh-codex-catalog-md-pre' },
              React.createElement('code', null, code.join('\n')),
            ),
          )
          continue
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading) {
          const level = heading[1].length
          blocks.push(
            React.createElement(
              'div',
              { key: keyPrefix + '-h' + key++, className: 'dsh-codex-catalog-md-heading dsh-codex-catalog-md-h' + level },
              renderInlineMarkdown(heading[2], keyPrefix + 'h' + level),
            ),
          )
          i += 1
          continue
        }
        if (/^\s*-{3,}\s*$/.test(line)) {
          blocks.push(React.createElement('div', { key: keyPrefix + '-hr' + key++, className: 'dsh-codex-catalog-md-hr' }))
          i += 1
          continue
        }
        if (/^\s*[-*]\s+/.test(line)) {
          const items = []
          let n = 0
          while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
            items.push(
              React.createElement(
                'li',
                { key: keyPrefix + '-li' + key + '-' + n++, className: 'dsh-codex-catalog-md-li' },
                renderInlineMarkdown(lines[i].replace(/^\s*[-*]\s+/, ''), keyPrefix + 'li' + key + n),
              ),
            )
            i += 1
          }
          blocks.push(React.createElement('ul', { key: keyPrefix + '-ul' + key++, className: 'dsh-codex-catalog-md-ul' }, items))
          continue
        }
        if (/^\s*\d+\.\s+/.test(line)) {
          const items = []
          let n = 0
          const startMatch = /^\s*(\d+)\.\s+/.exec(line)
          const start = startMatch ? Number(startMatch[1]) : 1
          while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
            items.push(
              React.createElement(
                'li',
                { key: keyPrefix + '-oli' + key + '-' + n++, className: 'dsh-codex-catalog-md-li' },
                renderInlineMarkdown(lines[i].replace(/^\s*\d+\.\s+/, ''), keyPrefix + 'oli' + key + n),
              ),
            )
            i += 1
          }
          blocks.push(
            React.createElement('ol', { key: keyPrefix + '-ol' + key++, start, className: 'dsh-codex-catalog-md-ol' }, items),
          )
          continue
        }
        if (/^\s*>\s?/.test(line)) {
          const quote = []
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
            quote.push(lines[i].replace(/^\s*>\s?/, ''))
            i += 1
          }
          blocks.push(
            React.createElement(
              'div',
              { key: keyPrefix + '-q' + key++, className: 'dsh-codex-catalog-md-quote' },
              renderInlineMarkdown(quote.join('\n'), keyPrefix + 'q' + key),
            ),
          )
          continue
        }
        if (/^\s*$/.test(line)) {
          i += 1
          continue
        }
        const para = []
        while (
          i < lines.length &&
          !/^\s*$/.test(lines[i]) &&
          !/^```/.test(lines[i]) &&
          !/^(#{1,6})\s+/.test(lines[i]) &&
          !/^\s*[-*]\s+/.test(lines[i]) &&
          !/^\s*\d+\.\s+/.test(lines[i]) &&
          !/^\s*>\s?/.test(lines[i]) &&
          !/^\s*-{3,}\s*$/.test(lines[i])
        ) {
          para.push(lines[i])
          i += 1
        }
        blocks.push(
          React.createElement(
            'div',
            { key: keyPrefix + '-p' + key++, className: 'dsh-codex-catalog-md-p' },
            renderInlineMarkdown(para.join('\n'), keyPrefix + 'p' + key),
          ),
        )
      }
      return blocks
    }

    /* ===== 渲染：简洁 / 详细两种输出 ===== */

    /** 简洁模式：把事件折叠成「发送 / Codex 输出 / 错误」三类。 */
    function chatTranscript(events) {
      const out = []
      const push = (role, text, extra) => {
        out.push(Object.assign({ role, text }, extra || {}))
      }
      for (const ev of events) {
        if (!ev || typeof ev !== 'object') continue
        if (ev.kind === 'task') {
          push('task', String(ev.text || ''))
        } else if (ev.kind === 'stream' || ev.kind === 'delta') {
          const last = out[out.length - 1]
          const piece = String(ev.text || '')
          if (last && last.role === 'codex' && last.streaming) last.text += piece
          else push('codex', piece, { streaming: true })
        } else if (ev.kind === 'answer') {
          const last = out[out.length - 1]
          const text = String(ev.text || '')
          if (last && last.role === 'codex' && last.streaming) {
            last.text = text
            last.streaming = false
            last.phase = ev.phase
          } else {
            push('codex', text, { streaming: false, phase: ev.phase })
          }
        } else if (ev.kind === 'error') {
          push('error', (ev.retry ? '重试：' : '错误：') + ev.message)
        } else if (ev.kind === 'turn_done' && ev.status !== 'completed') {
          push('error', '回合结束：' + ev.status + (ev.error ? '（' + ev.error + '）' : ''))
        }
      }
      return out
    }

    /** 简洁模式的一行：任务 / Codex 输出 / 错误。 */
    function renderChatEntry(item, key) {
      const base = {
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontSize: '12.5px',
        lineHeight: '1.65',
        margin: '0 0 10px',
      }
      if (item.role === 'task') {
        return React.createElement(
          'div',
          {
            key,
            style: Object.assign({}, base, {
              color: 'var(--dsw-alias-label-primary, #c9d3e0)',
              background: 'rgba(59,110,245,0.10)',
              borderLeft: '2px solid #3b6ef5',
              borderRadius: '6px',
              padding: '8px 10px',
            }),
          },
          React.createElement('div', { style: { fontSize: '11px', color: '#3b6ef5', marginBottom: '2px' } }, '发送'),
          renderMarkdown(item.text, key + '-task'),
        )
      }
      if (item.role === 'error') {
        return React.createElement(
          'div',
          {
            key,
            style: Object.assign({}, base, {
              color: '#d9483b',
              background: 'rgba(255,90,90,0.10)',
              borderRadius: '6px',
              padding: '6px 10px',
            }),
          },
          item.text,
        )
      }
      const label = item.phase === 'commentary' ? 'Codex 旁白' : item.streaming ? 'Codex 输出中…' : 'Codex'
      return React.createElement(
        'div',
        { key, style: Object.assign({}, base, { color: 'var(--dsw-alias-label-primary, #e8eaed)' }) },
        React.createElement('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #8b8f96)', marginBottom: '2px' } }, label),
        renderMarkdown(item.text, key + '-md'),
      )
    }


    /** 日志里可能残留 Codex 输出编码异常产生的替换字符，显示时降级为提示符。 */
    function cleanBrokenText(text) {
      const value = String(text || '')
      if (!value.includes('\uFFFD')) return value
      return value.replace(/\uFFFD+/g, '\u26A0')
    }

    /** 一条原始流事件 → 一行可读内容。 */
    function renderLiveEntry(ev, key) {
      const base = Object.assign({}, LIVE_MONO, { margin: '0 0 2px' })
      switch (ev.kind) {
        case 'thread':
          return React.createElement(
            'div',
            {
              key,
              style: Object.assign({}, base, {
                color: '#2d7fb8',
                marginTop: '10px',
                paddingTop: '6px',
                borderTop: '1px solid rgba(255,255,255,0.08)',
              }),
            },
            '=== thread ' + (ev.threadId || '') + ' ===',
          )
        case 'turn_started':
          return React.createElement(
            'div',
            { key, style: Object.assign({}, base, { color: '#2d7fb8', marginTop: '6px' }) },
            '>>> turn started',
          )
        case 'turn_done': {
          const ok = ev.status === 'completed'
          return React.createElement(
            'div',
            { key, style: Object.assign({}, base, { color: ok ? '#2bb673' : '#ff8a80', marginTop: '6px' }) },
            '<<< turn ' + ev.status + (ev.error ? '\n    reason: ' + ev.error : ''),
          )
        }
        case 'task':
          return React.createElement(
            'div',
            { key, style: Object.assign({}, base, { color: 'var(--dsw-alias-label-tertiary, #9aa0a6)', marginTop: '6px' }) },
            '[任务] ' + cleanBrokenText(ev.text),
          )
        case 'answer': {
          const phase = ev.phase || ''
          const label =
            phase === 'final_answer'
              ? '[最终答案]'
              : phase === 'partial_answer'
                ? '[回答中]'
                : phase === 'commentary'
                  ? '[旁白]'
                  : '[回答]'
          const color = phase === 'final_answer' ? '#2bb673' : phase === 'commentary' ? 'var(--dsw-alias-label-tertiary, #8b8f96)' : 'var(--dsw-alias-label-primary, #e8eaed)'
          return React.createElement(
            'div',
            { key, style: Object.assign({}, base, { color, marginTop: '6px' }) },
            label + ' ' + cleanBrokenText(ev.text),
          )
        }
        case 'command':
          return React.createElement(
            'div',
            { key, style: Object.assign({}, base, { color: '#f0c674', marginTop: '6px' }) },
            '[命令] ' + cleanBrokenText(ev.command),
            ev.exitCode === null || ev.exitCode === undefined
              ? null
              : React.createElement('div', { style: { color: '#b8955a' } }, '        exit=' + ev.exitCode),
            ev.output ? React.createElement('div', { style: { color: 'var(--dsw-alias-label-tertiary, #8b8f96)', marginTop: '2px' } }, cleanBrokenText(ev.output)) : null,
          )
        case 'stream':
          return React.createElement('div', { key, style: Object.assign({}, base, { color: 'var(--dsw-alias-label-primary, #e8eaed)' }) }, cleanBrokenText(ev.text))
        case 'error':
          return React.createElement(
            'div',
            {
              key,
              style: Object.assign({}, base, { color: ev.retry ? '#f0a13c' : '#ff8a80', marginTop: '6px' }),
            },
            (ev.retry ? '[重试] ' : '[错误] ') + cleanBrokenText(ev.message),
          )
        case 'tokens':
          return React.createElement(
            'div',
            { key, style: Object.assign({}, base, { color: '#2d7fb8', marginTop: '6px' }) },
            '[tokens] in=' + ev.input + ' cached=' + ev.cached + ' out=' + ev.output,
          )
        case 'rate':
          return React.createElement(
            'div',
            { key, style: Object.assign({}, base, { color: '#2d7fb8', marginTop: '6px' }) },
            '[额度] 5h=' +
              ev.primary +
              '%' +
              (ev.secondary === null || ev.secondary === undefined ? '' : '  周=' + ev.secondary + '%'),
          )
        case 'rpc_error':
          return React.createElement(
            'div',
            { key, style: Object.assign({}, base, { color: '#f0a13c', marginTop: '6px' }) },
            '[rpc error] ' + cleanBrokenText(ev.message),
          )
        default:
          return null
      }
    }

    /* ===== 样式（照 DSH 子智能体目录 / 对话窗口的视觉） ===== */

    const STYLE_ID = 'dsh-codex-catalog-style'

    const RAIL_CSS = `
.dsh-codex-catalog-trigger{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:12px;cursor:pointer;white-space:nowrap;font-family:inherit}
.dsh-codex-catalog-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,0.06))}
.dsh-codex-catalog-trigger svg{width:12px;height:12px;flex:none}
.dsh-codex-catalog-menu{position:fixed;z-index:60;width:min(336px,calc(100vw - 32px));max-height:min(60vh,480px);overflow-y:auto;padding:6px;color:var(--dsw-alias-label-primary,#e8eaed);background:var(--dsw-specific-menu,#232326);background:color-mix(in srgb, var(--dsw-specific-menu, #232326) 72%, var(--dsw-alias-bg-layer-1, #232326));backdrop-filter:var(--dsw-menu-backdrop-filter, blur(20px));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter, blur(20px));border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,0.2));border-radius:12px;box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,0.35));font-family:inherit}
.dsh-codex-catalog-menu-title{font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0a6);padding:4px 8px 6px;font-weight:600}
.dsh-codex-catalog-row{display:flex;align-items:center;gap:8px;width:100%;min-height:44px;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:inherit;text-align:left;cursor:pointer;font-family:inherit}
.dsh-codex-catalog-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,0.06))}
.dsh-codex-catalog-row.is-current{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,0.08))}
.dsh-codex-catalog-dot{width:8px;height:8px;flex:none;border-radius:50%}
.dsh-codex-catalog-rowtext{display:flex;flex-direction:column;min-width:0;gap:2px;flex:1 1 auto}
.dsh-codex-catalog-rowlabel{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-codex-catalog-rowsub{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-codex-catalog-overlay{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,0.5)}
.dsh-codex-catalog-dialog{display:flex;flex-direction:column;width:min(920px,92vw);max-height:80vh;overflow:hidden;color:var(--dsw-alias-label-primary,#e8eaed);background:var(--dsw-specific-menu,#232326);background:color-mix(in srgb, var(--dsw-specific-menu, #232326) 72%, var(--dsw-alias-bg-layer-1, #232326));backdrop-filter:var(--dsw-menu-backdrop-filter, blur(20px));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter, blur(20px));border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,0.2));border-radius:12px;box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,0.45));font-family:inherit}
.dsh-codex-catalog-dialog-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,0.2))}
.dsh-codex-catalog-dialog-title{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:50%}
.dsh-codex-catalog-dialog-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6)}
.dsh-codex-catalog-dialog-btn{height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,0.3));border-radius:6px;background:transparent;color:inherit;font-size:12px;cursor:pointer;font-family:inherit}
.dsh-codex-catalog-dialog-btn.is-active{border-color:rgba(59,110,245,0.7);color:#8fb3ff}
.dsh-codex-catalog-dialog-close{width:26px;height:26px;border:0;border-radius:6px;background:transparent;color:inherit;font-size:18px;line-height:1;cursor:pointer}
.dsh-codex-catalog-dialog-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,0.08))}
.dsh-codex-catalog-dialog-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:12px 14px}
.dsh-codex-catalog-dialog-error{margin:0 0 10px;padding:8px 10px;border-radius:8px;color:#ffb4ab;background:rgba(255,90,90,0.10);border:1px solid rgba(255,90,90,0.3);font-size:12px;white-space:pre-wrap;word-break:break-word}
.dsh-codex-catalog-empty{color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:12px}
.dsh-codex-catalog-md-p{margin:0 0 8px;white-space:pre-wrap;word-break:break-word}
.dsh-codex-catalog-md-heading{font-weight:600;margin:10px 0 6px;line-height:1.45}
.dsh-codex-catalog-md-h1{font-size:15px}
.dsh-codex-catalog-md-h2{font-size:14px}
.dsh-codex-catalog-md-h3{font-size:13px}
.dsh-codex-catalog-md-h4,.dsh-codex-catalog-md-h5,.dsh-codex-catalog-md-h6{font-size:12.5px;color:var(--dsw-alias-label-primary,#cfd6e0)}
.dsh-codex-catalog-md-ul{margin:0 0 8px;padding-left:18px;list-style:disc}
.dsh-codex-catalog-md-ol{margin:0 0 8px;padding-left:20px;list-style:decimal}
.dsh-codex-catalog-md-li{margin:2px 0;white-space:pre-wrap;word-break:break-word}
.dsh-codex-catalog-md-pre{margin:8px 0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.12));border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,0.2));overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1.55}
.dsh-codex-catalog-md-pre code{font-family:inherit}
.dsh-codex-catalog-md-code{padding:1px 4px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.15));font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.92em;word-break:break-word}
.dsh-codex-catalog-md-link{color:#8fb3ff;text-decoration:none;word-break:break-all}
.dsh-codex-catalog-md-link:hover{text-decoration:underline}
.dsh-codex-catalog-md-quote{margin:0 0 8px;padding-left:8px;border-left:2px solid rgba(128,128,128,0.45);color:var(--dsw-alias-label-tertiary,#b8c0ca);white-space:pre-wrap;word-break:break-word}
.dsh-codex-catalog-md-hr{height:1px;margin:10px 0;background:rgba(255,255,255,0.1)}

.dsh-codex-catalog-sandbox{display:flex;flex-direction:column;gap:10px;padding:4px 2px 18px;color:var(--dsw-alias-label-primary,#e8eaed);font-size:13px;line-height:1.6}
.dsh-codex-catalog-sandbox-title{font-weight:600}
.dsh-codex-catalog-sandbox-row{display:flex;align-items:center;gap:10px}
.dsh-codex-catalog-sandbox-switch{position:relative;width:44px;height:24px;border:0;border-radius:12px;background:rgba(128,128,128,0.35);cursor:pointer;padding:0;transition:background .15s}
.dsh-codex-catalog-sandbox-switch.is-on{background:#3b6ef5}
.dsh-codex-catalog-sandbox-switch:disabled{opacity:.6;cursor:default}
.dsh-codex-catalog-sandbox-knob{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .15s}
.dsh-codex-catalog-sandbox-switch.is-on .dsh-codex-catalog-sandbox-knob{left:23px}
.dsh-codex-catalog-sandbox-label{font-weight:600}
.dsh-codex-catalog-sandbox-desc{color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:12px}
.dsh-codex-catalog-sandbox-note{color:#3ecf8e;font-size:12px}
.dsh-codex-catalog-sandbox-error{color:#ffb4ab;font-size:12px;white-space:pre-wrap;word-break:break-word}
.dsh-codex-catalog-sandbox-meta{color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:11px}
.dsh-codex-catalog-restore-btn{height:26px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,0.3));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#e8eaed);font-size:12px;cursor:pointer}
.dsh-codex-catalog-restore-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.15))}

`

    function installStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = RAIL_CSS
      document.head.appendChild(style)
    }

    function iconChevronDown() {
      return React.createElement(
        'svg',
        {
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        React.createElement('path', { d: 'M6 9l6 6 6-6' }),
      )
    }

    /* ===== 单次派发的对话窗口（弹层） ===== */

    function RunDialog(props) {
      const run = props.run
      const [view, setView] = React.useState('chat')
      const status = runStatusOf(run)
      const chat = view === 'chat' ? chatTranscript(run.events) : []
      const tokens = runTokenText(run)
      const duration = runDurationText(run)
      const meta = [
        formatRunTime(run.t),
        status.text,
        'thread ' + String(run.threadId || '').slice(0, 8),
        tokens ? tokens : '',
        duration ? '耗时 ' + duration : '',
        '该后端不支持续聊',
      ]
        .filter((part) => part !== '')
        .join(' · ')
      React.useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') props.onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [props.onClose])
      return React.createElement(
        'div',
        { className: 'dsh-codex-catalog-overlay', onClick: props.onClose },
        React.createElement(
          'div',
          { className: 'dsh-codex-catalog-dialog', onClick: (event) => event.stopPropagation() },
          React.createElement(
            'div',
            { className: 'dsh-codex-catalog-dialog-head' },
            React.createElement('span', { className: 'dsh-codex-catalog-dialog-title', title: runTaskText(run) }, runTaskText(run)),
            React.createElement('span', { className: 'dsh-codex-catalog-dialog-meta' }, meta),
            React.createElement('span', { style: { flex: '1 1 auto' } }),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dsh-codex-catalog-dialog-btn' + (view === 'chat' ? ' is-active' : ''),
                onClick: () => setView('chat'),
              },
              '简洁',
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dsh-codex-catalog-dialog-btn' + (view === 'full' ? ' is-active' : ''),
                onClick: () => setView('full'),
              },
              '详细',
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dsh-codex-catalog-dialog-close',
                onClick: props.onClose,
                title: '关闭',
                'aria-label': '关闭',
              },
              '×',
            ),
          ),
          React.createElement(
            'div',
            { className: 'dsh-codex-catalog-dialog-body' },
            run.status && run.status !== 'completed' && run.error
              ? React.createElement('div', { className: 'dsh-codex-catalog-dialog-error' }, '失败原因：' + run.error)
              : null,
            run.events.length >= RUN_EVENTS_CAP
              ? React.createElement(
                  'div',
                  { className: 'dsh-codex-catalog-dialog-error' },
                  '输出过长，详细视图仅显示最近 ' + RUN_EVENTS_CAP + ' 条事件',
                )
              : null,
            view === 'chat'
              ? chat.length > 0
                ? chat.map((item, index) => renderChatEntry(item, String(index)))
                : React.createElement('div', { className: 'dsh-codex-catalog-empty' }, '（无可显示内容）')
              : run.events.length > 0
                ? run.events.map((ev, index) => renderLiveEntry(ev, String(index)))
                : React.createElement('div', { className: 'dsh-codex-catalog-empty' }, '（等待事件…）'),
          ),
        ),
      )
    }


    /** 插件详情页：Codex 子智能体沙箱开关（默认开启沙箱）。 */
    function SandboxPanel() {
      const [state, setState] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [saved, setSaved] = React.useState(false)
      const load = async () => {
        try {
          const res = await fetch(API + '/sandbox', { credentials: 'same-origin' })
          const data = await res.json()
          if (data && data.ok !== false) setState(data)
          else throw new Error((data && data.error) || '读取失败')
        } catch (e) {
          setError(String((e && e.message) || e))
        }
      }
      React.useEffect(() => {
        load()
      }, [])
      const stateName = state ? String(state.state || 'unknown') : 'unknown'
      const unknown = stateName === 'unknown' || stateName === 'error'
      const enabled = stateName === 'on'
      const toggle = async () => {
        if (busy || !state || unknown) return
        setBusy(true)
        setError(null)
        setSaved(false)
        try {
          const res = await fetch(API + '/sandbox', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: !enabled }),
          })
          const data = await res.json()
          if (!data || data.ok === false) throw new Error((data && data.error) || '保存失败')
          setState(data)
          setSaved(true)
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }
      const label = busy
        ? '保存中…'
        : unknown
          ? '状态未知（无法确认沙箱是否开启）'
          : enabled
            ? '沙箱开启（默认，只读沙箱）'
            : '沙箱关闭（无沙箱全权限）'
      return React.createElement(
        'div',
        { className: 'dsh-codex-catalog-sandbox' },
        React.createElement('div', { className: 'dsh-codex-catalog-sandbox-title' }, 'Codex 子智能体沙箱'),
        React.createElement(
          'div',
          { className: 'dsh-codex-catalog-sandbox-row' },
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dsh-codex-catalog-sandbox-switch' + (enabled ? ' is-on' : ' is-off'),
              onClick: toggle,
              disabled: busy || !state || unknown,
              'aria-pressed': enabled ? 'true' : 'false',
              title: unknown
                ? '无法确认当前沙箱状态，切换已禁用'
                : enabled
                  ? '当前：沙箱开启（点击关闭）'
                  : '当前：沙箱关闭（点击开启）',
            },
            React.createElement('span', { className: 'dsh-codex-catalog-sandbox-knob' }),
          ),
          React.createElement('span', { className: 'dsh-codex-catalog-sandbox-label' }, label),
        ),
        React.createElement(
          'div',
          { className: 'dsh-codex-catalog-sandbox-desc' },
          unknown
            ? '无法读取当前配置，开关已禁用；请检查 DSH profile 的 cordis.patch.yml。'
            : enabled
              ? '只读沙箱更安全；Codex 子代理只能访问工作区，访问用户目录（如 AppData 里的 node）会被拒绝。'
              : '无沙箱全权限：Codex 子代理可读写任意文件，请确认你知道风险。',
        ),
        state && state.error
          ? React.createElement(
              'div',
              { className: 'dsh-codex-catalog-sandbox-error' },
              '状态读取异常：' + String(state.error),
            )
          : null,
        saved ? React.createElement('div', { className: 'dsh-codex-catalog-sandbox-note' }, '已保存，重启 DSH 后生效。') : null,
        error ? React.createElement('div', { className: 'dsh-codex-catalog-sandbox-error' }, '操作失败：' + error) : null,
        state
          ? React.createElement(
              'div',
              { className: 'dsh-codex-catalog-sandbox-meta' },
              'permissionMode：' + String(state.permissionMode || '未知'),
            )
          : null,
      )
    }



    /** 插件详情页：Codex 自动维护（CLI 自动更新 + 自动网络代理 + 还原 CLI）。 */
    function SettingsPanel() {
      const [state, setState] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const load = async () => {
        setError(null)
        try {
          const res = await fetch(API + '/settings', { credentials: 'same-origin' })
          const data = await res.json()
          if (data && data.ok !== false) setState(data)
          else throw new Error((data && data.error) || '读取失败')
        } catch (e) {
          setState(null)
          setError(String((e && e.message) || e))
        }
      }
      React.useEffect(() => {
        let cancelled = false
        load().then(() => {
          if (cancelled) return
        })
        return () => {
          cancelled = true
        }
      }, [])
      const post = async (url, body) => {
        const res = await fetch(API + url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        })
        const data = await res.json()
        if (!data || data.ok === false) throw new Error((data && data.reason) || (data && data.error) || '请求失败')
        return data
      }
      const toggle = async (key) => {
        if (busy || !state) return
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          const data = await post('/settings', { [key]: !state[key] })
          setState(Object.assign({}, state, data))
          setNotice('已保存')
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }
      const restore = async () => {
        if (busy || !state) return
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          const ok = window.confirm('还原 CLI 会回到更新前的版本，并暂停自动更新。继续？')
          if (!ok) return
        }
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          const data = await post('/cli/restore', {})
          setNotice(
            data.restored
              ? 'CLI 已还原到更新前版本' + (data.version ? '（' + data.version + '）' : '') + '，自动更新已暂停'
              : '还原失败：' + (data.reason || '未知原因'),
          )
          await load()
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }
      const setModel = async (model) => {
        if (busy || !state) return
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          const data = await post('/settings', { model })
          setState(Object.assign({}, state, data))
          if (data.modelApplyError) {
            setError('模型已保存，但写入 Codex 配置失败：' + data.modelApplyError)
          } else {
            setNotice(
              model === null
                ? '已改为跟随 Codex 客户端模型'
                : '已选择模型：' + model + '（写入 ~/.codex/config.toml，下次派发生效）',
            )
          }
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }
      const setReasoning = async (reasoning) => {
        if (busy || !state) return
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          const data = await post('/settings', { reasoning })
          setState(Object.assign({}, state, data))
          if (data.reasoningApplyError) {
            setError('推理深度已保存，但写入 Codex 配置失败：' + data.reasoningApplyError)
          } else {
            setNotice(
              reasoning === null
                ? '已改为跟随模型默认推理深度'
                : '已选择推理深度：' + reasoning + '（写入 ~/.codex/config.toml，下次派发生效）',
            )
          }
        } catch (e) {
          setError(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }
      const cli = state ? state.cli || {} : {}
      const proxy = state ? state.proxy || {} : {}
      /* 推理深度档位：跟随当前生效模型（插件选择 > config.toml 当前值），名单来自 Codex 缓存。 */
      const activeModelId = state ? state.model || state.configModel || null : null
      const modelsList = state && state.models && Array.isArray(state.models.models) ? state.models.models : []
      const activeModel = activeModelId ? modelsList.find((item) => item && item.id === activeModelId) : null
      const reasoningLevels = activeModel && Array.isArray(activeModel.reasoningLevels) ? activeModel.reasoningLevels : []
      const switcher = (key, label) =>
        React.createElement(
          'div',
          { className: 'dsh-codex-catalog-sandbox-row' },
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dsh-codex-catalog-sandbox-switch' + (state && state[key] ? ' is-on' : ' is-off'),
              onClick: () => toggle(key),
              disabled: busy || !state,
              'aria-pressed': state && state[key] ? 'true' : 'false',
              title: label,
            },
            React.createElement('span', { className: 'dsh-codex-catalog-sandbox-knob' }),
          ),
          React.createElement(
            'span',
            { className: 'dsh-codex-catalog-sandbox-label' },
            label + (state && state[key] ? '：开' : '：关'),
          ),
        )
      return React.createElement(
        'div',
        { className: 'dsh-codex-catalog-sandbox' },
        React.createElement('div', { className: 'dsh-codex-catalog-sandbox-title' }, 'Codex 自动维护'),
        switcher('autoUpdateCli', '自动更新 CLI'),
        React.createElement(
          'div',
          { className: 'dsh-codex-catalog-sandbox-desc' },
          '当前 CLI：' +
            (cli.vendorVersion || '未知') +
            '　客户端：' +
            (cli.clientVersion || '未知') +
            (cli.upToDate ? '（已是最新）' : '（可更新）'),
        ),
        React.createElement(
          'div',
          { className: 'dsh-codex-catalog-sandbox-meta' },
          state && state.lastCliUpdate && state.lastCliUpdate.at
            ? '上次更新：' +
                new Date(state.lastCliUpdate.at).toLocaleString('zh-CN', { hour12: false }) +
                '（' +
                (state.lastCliUpdate.from || '?') +
                ' → ' +
                (state.lastCliUpdate.to || '?') +
                '）'
            : '尚未自动更新过',
        ),
        switcher('autoProxy', '自动网络代理'),
        React.createElement(
          'div',
          { className: 'dsh-codex-catalog-sandbox-desc' },
          'GPT 模型（写入 ~/.codex/config.toml，下次 Codex 派发生效）',
        ),
        React.createElement(
          'select',
          {
            className: 'dsh-codex-catalog-model-select',
            value: state && state.model ? state.model : '',
            disabled: busy || !state,
            onChange: (event) => {
              const value = String(event.target.value || '')
              setModel(value === '' ? null : value)
            },
            title: '默认跟随 Codex 客户端当前配置；选择后由插件写入 Codex 配置',
            style: {
              width: '100%',
              padding: '6px 8px',
              borderRadius: '6px',
              border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))',
              background: 'var(--dsw-alias-bg-layer-1, transparent)',
              color: 'var(--dsw-alias-label-primary, inherit)',
              fontSize: '12px',
              marginBottom: '8px',
            },
          },
          React.createElement(
            'option',
            { value: '' },
            '跟随 Codex 客户端（不覆盖）' + (state && state.configModel ? '：' + state.configModel : ''),
          ),
          state &&
          state.model &&
          !(state.models && Array.isArray(state.models.models) && state.models.models.some((item) => item.id === state.model))
            ? React.createElement(
                'option',
                { value: state.model },
                state.model + '（当前已选，名单中不可用）',
              )
            : null,
          state && state.models && Array.isArray(state.models.models)
            ? state.models.models.map((item) =>
                React.createElement('option', { key: item.id, value: item.id }, item.label + '（' + item.id + '）'),
              )
            : null,
        ),
        state && state.configModelError
          ? React.createElement(
              'div',
              { className: 'dsh-codex-catalog-sandbox-meta' },
              '模型配置（config.toml）读取失败：' + state.configModelError,
            )
          : null,
        state && state.models && state.models.ok === false
          ? React.createElement(
              'div',
              { className: 'dsh-codex-catalog-sandbox-meta' },
              '模型名单读取失败：' + (state.models.error || '未知错误'),
            )
          : state && state.models && state.models.clientVersion
            ? React.createElement(
                'div',
                { className: 'dsh-codex-catalog-sandbox-meta' },
                '名单来自 Codex 客户端缓存（' + state.models.clientVersion + '，共 ' + state.models.models.length + ' 个模型）',
              )
            : null,
        React.createElement(
          'div',
          { className: 'dsh-codex-catalog-sandbox-desc' },
          '推理深度（写入 ~/.codex/config.toml 的 model_reasoning_effort，下次派发生效）',
        ),
        React.createElement(
          'select',
          {
            className: 'dsh-codex-catalog-reasoning-select',
            value: state && state.reasoning ? state.reasoning : '',
            disabled: busy || !state || reasoningLevels.length === 0,
            onChange: (event) => {
              const value = String(event.target.value || '')
              setReasoning(value === '' ? null : value)
            },
            title: '推理深度档位动态读取自 Codex 客户端缓存；默认跟随模型默认',
            style: {
              width: '100%',
              padding: '6px 8px',
              borderRadius: '6px',
              border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))',
              background: 'var(--dsw-alias-bg-layer-1, transparent)',
              color: 'var(--dsw-alias-label-primary, inherit)',
              fontSize: '12px',
              marginBottom: '8px',
            },
          },
          React.createElement(
            'option',
            { value: '' },
            reasoningLevels.length === 0
              ? '该模型没有可选推理档位'
              : '跟随模型默认（不覆盖）' + (state && state.configReasoning ? '：' + state.configReasoning : ''),
          ),
          reasoningLevels.map((level) =>
            React.createElement(
              'option',
              { key: level.effort, value: level.effort },
              level.effort + (level.description ? '（' + level.description + '）' : ''),
            ),
          ),
        ),
        React.createElement(
          'div',
          { className: 'dsh-codex-catalog-sandbox-desc' },
          proxy.proxyState === 'unknown' || (proxy.proxyState !== 'disabled' && !proxy.systemProxy)
            ? '系统代理：无法确认'
            : proxy.systemProxy
              ? '系统代理：' + proxy.systemProxy
              : '系统未启用 HTTPS 代理',
        ),
        React.createElement(
          'div',
          { className: 'dsh-codex-catalog-sandbox-desc' },
          proxy.envProxy ? '~/.codex/.env：' + proxy.envProxy : '~/.codex/.env 未配置代理',
        ),
        proxy.autoProxyPatched
          ? React.createElement('div', { className: 'dsh-codex-catalog-sandbox-desc' }, 'wrapper 代理跟随补丁：已启用')
          : null,
        React.createElement(
          'div',
          { className: 'dsh-codex-catalog-sandbox-row' },
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dsh-codex-catalog-restore-btn',
              onClick: restore,
              disabled: busy || !state,
              title: '把 vendor codex.exe 还原到上次自动更新前的版本（会暂停自动更新）',
            },
            '还原 CLI',
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dsh-codex-catalog-restore-btn',
              style: { marginLeft: '8px' },
              onClick: load,
              disabled: busy,
              title: '重新读取 CLI 与代理状态',
            },
            '刷新',
          ),
        ),
        notice ? React.createElement('div', { className: 'dsh-codex-catalog-sandbox-note' }, notice) : null,
        error ? React.createElement('div', { className: 'dsh-codex-catalog-sandbox-error' }, '操作失败：' + error) : null,
      )
    }

    /* ===== 页头触发器 + 派发目录 ===== */

    function CatalogTrigger(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''
      const [liveState, setLiveState] = React.useState({ runs: [], seenSeqs: new Set() })
      const runs = liveState.runs
      const [menuOpen, setMenuOpen] = React.useState(false)
      const [menuPos, setMenuPos] = React.useState(null)
      const [openedKey, setOpenedKey] = React.useState('')
      const [pollError, setPollError] = React.useState(null)
      const cursorRef = React.useRef(null)
      const triggerRef = React.useRef(null)
      const menuRef = React.useRef(null)
      const [, setClock] = React.useState(0)

      /* 定时重渲染：无新事件时，「状态未知（N 秒无更新）」也要继续更新。 */
      React.useEffect(() => {
        const timer = setInterval(() => setClock((value) => value + 1), 15000)
        return () => clearInterval(timer)
      }, [])

      /* 轮询 Codex 实时日志（页头常驻，不依赖 tab 是否打开）。 */
      React.useEffect(() => {
        /* 会话切换时清空旧游标/旧列表与去重集合，避免沿用上一个会话的数据。 */
        cursorRef.current = null
        setLiveState({ runs: [], seenSeqs: new Set() })
        setPollError(null)
        setOpenedKey('')
        let cancelled = false
        let timer = null
        const tick = async () => {
          if (cancelled) return
          const cursor = cursorRef.current
          try {
            const query = cursor === null ? 'tail=8388608' : 'cursor=' + cursor
            const res = await fetch(LIVE + '?' + query + (sessionId ? '&session=' + encodeURIComponent(sessionId) : ''), {
              credentials: 'same-origin',
            })
            if (!res.ok) throw new Error('HTTP ' + res.status)
            const data = await res.json()
            if (cancelled) return
            if (data && data.ok === false) throw new Error(String(data.error || '接口返回错误'))
            if (typeof data.cursor === 'number') cursorRef.current = data.cursor
            const events = Array.isArray(data.events) ? data.events : []
            if (data.reset) {
              /* 日志世代重置（首次读取/截断/清空）：用空状态重建（纯函数，不赌 updater 只执行一次）。 */
              setLiveState(applyEventsToRuns({ runs: [], seenSeqs: new Set() }, events))
            } else if (events.length > 0) {
              setLiveState((prev) => applyEventsToRuns(prev, events))
            }
            setPollError(null)
          } catch (error) {
            /* 日志镜像中断时明确提示，而不是静默当作"没有派发"。 */
            if (!cancelled) setPollError(String((error && error.message) || error))
          }
          if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL)
        }
        tick()
        return () => {
          cancelled = true
          if (timer !== null) clearTimeout(timer)
        }
      }, [sessionId])

      /* 点击外部 / Esc 关闭目录；Esc 关闭弹层。 */
      React.useEffect(() => {
        if (!menuOpen && !openedKey) return undefined
        const onDown = (event) => {
          if (!menuOpen) return
          if (menuRef.current && menuRef.current.contains(event.target)) return
          if (triggerRef.current && triggerRef.current.contains(event.target)) return
          setMenuOpen(false)
        }
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          if (openedKey) setOpenedKey('')
          else setMenuOpen(false)
        }
        window.addEventListener('mousedown', onDown, true)
        window.addEventListener('keydown', onKey)
        return () => {
          window.removeEventListener('mousedown', onDown, true)
          window.removeEventListener('keydown', onKey)
        }
      }, [menuOpen, openedKey])

      /* 打开的派发被淘汰/清空后自动关闭弹层。 */
      React.useEffect(() => {
        if (openedKey && !runs.some((run) => run.key === openedKey)) setOpenedKey('')
      }, [runs, openedKey])

      const openedRun = runs.find((run) => run.key === openedKey) || null
      if (runs.length === 0 && !menuOpen && !openedRun && !pollError) return null
      const runningCount = runs.filter((run) => runStatusOf(run).text === '运行中').length
      const label = pollError
        ? 'Codex 派发（镜像中断）'
        : (runningCount > 0 ? runningCount + ' 个运行中 · ' : '') + runs.length + ' 个 Codex 派发'

      const openMenu = () => {
        const el = triggerRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        const width = Math.min(336, window.innerWidth - 32)
        setMenuPos({
          top: rect.bottom + 5,
          left: Math.min(Math.max(16, rect.left), window.innerWidth - width - 16),
          width,
        })
        setMenuOpen((value) => !value)
      }

      const pickRun = (run) => {
        setOpenedKey(run.key)
        setMenuOpen(false)
      }

      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          'button',
          {
            type: 'button',
            ref: triggerRef,
            className: 'dsh-codex-catalog-trigger',
            'aria-expanded': menuOpen ? 'true' : 'false',
            title: '打开 Codex 派发目录，点击进入某次派发的对话窗口',
            onClick: openMenu,
          },
          label,
          iconChevronDown(),
        ),
        menuOpen && menuPos
          ? React.createElement(
              'div',
              {
                ref: menuRef,
                className: 'dsh-codex-catalog-menu',
                style: { top: menuPos.top, left: menuPos.left, width: menuPos.width },
              },
              React.createElement(
                'div',
                { className: 'dsh-codex-catalog-menu-title' },
                'Codex 派发目录 · ' + runs.length + (runs.length >= RUNS_CAP ? '（已截断，仅显示最近 ' + RUNS_CAP + ' 条）' : '') + (pollError ? ' · 镜像中断' : ''),
              ),
              runs.map((run, index) => {
                const status = runStatusOf(run)
                const tokens = runTokenText(run)
                const duration = runDurationText(run)
                const sub = [
                  'Codex 派发',
                  status.text,
                  formatRunTime(run.t),
                  'thread ' + String(run.threadId || '').slice(0, 8),
                  tokens ? tokens : '',
                  duration ? '耗时 ' + duration : '',
                  run.error ? String(run.error).slice(0, 60) : '',
                ]
                  .filter((part) => part !== '')
                  .join(' · ')
                return React.createElement(
                  'button',
                  {
                    key: run.key,
                    type: 'button',
                    className: 'dsh-codex-catalog-row' + (run.key === openedKey ? ' is-current' : ''),
                    onClick: () => pickRun(run),
                  },
                  React.createElement('span', { className: 'dsh-codex-catalog-dot', style: { background: status.color } }),
                  React.createElement(
                    'span',
                    { className: 'dsh-codex-catalog-rowtext' },
                    React.createElement('span', { className: 'dsh-codex-catalog-rowlabel' }, '#' + (index + 1) + ' · ' + runTaskText(run)),
                    React.createElement('span', { className: 'dsh-codex-catalog-rowsub' }, sub),
                  ),
                )
              }),
            )
          : null,
        openedRun
          ? React.createElement(RunDialog, { run: openedRun, onClose: () => setOpenedKey('') })
          : null,
      )
    }

    /* ===== 注册 ===== */

    function apply(ctx) {
      try {
        installStyles()
        const slots = ctx.get('slots')
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          console.warn('[dsh-codex-catalog] slots service unavailable; trigger not registered')
          return
        }
        try {
          /* plugins.bundle.config：插件详情页的沙箱开关。 */
          slots.inject('plugins.bundle.config', () => {
            const dispose = slots.register(
              {
                name: 'plugins.bundle.config',
                key: 'dsh-codex-catalog',
                locale: 'dsh-codex-catalog',
                registrant: 'dsh-codex-catalog',
              },
              () =>
                React.createElement(
                  'div',
                  null,
                  React.createElement(SandboxPanel),
                  React.createElement(SettingsPanel),
                ),
            )
            console.log('[dsh-codex-catalog] bundle config panel registered')
            return () => {
              try {
                if (typeof dispose === 'function') dispose()
              } catch {
                /* 槽位收起时可能已清理 */
              }
            }
          })
        } catch (e) {
          console.warn('[dsh-codex-catalog] inject plugins.bundle.config failed:', e)
        }
        try {
          slots.inject('conversation.session.header.actions', () => {
            const dispose = slots.register(
              {
                name: 'conversation.session.header.actions',
                id: 'codex-catalog',
                order: 11,
                registrant: 'dsh-codex-catalog',
                inject: (sessionId) => ({ sessionId: sessionId ? String(sessionId) : '' }),
              },
              (props) => React.createElement(CatalogTrigger, props),
            )
            console.log('[dsh-codex-catalog] header catalog trigger registered')
            return () => {
              try {
                if (typeof dispose === 'function') dispose()
              } catch {
                /* 槽位收起时可能已清理 */
              }
            }
          })
        } catch (e) {
          console.warn('[dsh-codex-catalog] inject conversation.session.header.actions failed:', e)
        }
      } catch (e) {
        console.warn('[dsh-codex-catalog] client apply error:', e)
      }
    }

    return { apply }
  },
})
