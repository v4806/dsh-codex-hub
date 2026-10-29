/**
 * dsh-codex-fix — host half.
 *
 * 只做一件事：把「Codex 子代理在这台机器上跑不起来 / 看不到过程」的几处已知
 * 坑，做成可检查、可一键修复的面板，通过本机回环接口给客户端半个插件调用。
 *
 * 修复项（全部幂等，改前先备份）：
 *   cli     插件内嵌的 codex.exe 版本过旧（< 0.164 时不认 gpt-6.1-sol 等新模型）
 *   helpers 平台包缺少 codex-windows-sandbox-setup.exe / codex-command-runner.exe
 *           （配了代理后 read-only / workspace-write 会 orchestrator_helper_exit_nonzero）
 *   env     ~/.codex/.env 缺 HTTPS_PROXY（每趟任务先卡 1–2 分钟做 websocket 试探）
 *   mirror  codex.js 包装层缺「把原始流 tee 到文件」的补丁（过程不可见）
 *   viewer  备用窗口脚本缺失（没人把镜像渲染成人能读的东西）
 *
 * 这个文件不依赖 Codex 或 DSH 的内部模块，只动文件系统与子进程。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  copyFileSync,
  readdirSync,
  statSync,
  renameSync,
  unlinkSync,
  openSync,
  readSync,
  writeSync,
  closeSync,
  truncateSync,
  realpathSync,
  createReadStream,
} from 'node:fs'
import { join, basename, dirname, sep } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const TAG = '[dsh-codex-hub]'

/** DSH 数据目录：宿主进程通常已注入 DSH_HOME；兜底用用户目录下的 .dsh（旧版默认位置）。 */
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PROFILE_DIR = process.env.DSH_CODEX_PROFILE || join(DSH_HOME, 'profiles', 'desktop')
const VENDOR_BIN = join(
  PROFILE_DIR,
  'node_modules',
  '@openai',
  'codex-win32-x64',
  'vendor',
  'x86_64-pc-windows-msvc',
  'bin',
)
const WRAPPER = join(PROFILE_DIR, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex')
const ENV_FILE = join(CODEX_HOME, '.env')
/** Codex 主配置（模型等）；插件面板选择模型时写入这里的 model 行。 */
const CONFIG_TOML = join(CODEX_HOME, 'config.toml')
/** Codex 客户端缓存的模型名单（动态读取，跟随客户端最新支持列表）。 */
const MODELS_CACHE_FILE = join(CODEX_HOME, 'models_cache.json')
const CLIENT_BIN_ROOT = join(homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin')
/**
 * 运行目录（日志镜像、按会话切分、视图缓存、备份指针）。
 * 默认放在 DSH 数据目录下，任何机器都成立；需要放别处时设 DSH_CODEX_RUNS。
 */
const RUNS_DIR = process.env.DSH_CODEX_RUNS || join(DSH_HOME, 'codex-runs')
/** 派发标题缓存（按任务文本哈希缓存启发式短标题）。 */
const TITLES_FILE = join(RUNS_DIR, 'titles.json')
/** 备用独立窗口脚本：默认跟随运行目录，可用 DSH_CODEX_VIEWER 覆盖。 */
const VIEWER_PATH = process.env.DSH_CODEX_VIEWER || join(RUNS_DIR, 'codex-raw-view.ps1')
const BACKUP_ROOT = join(DSH_HOME, 'file-backups')
/** 指向「最近一次修复的备份清单」，还原按钮靠它找到要回滚的文件。 */
const POINTER_FILE = join(BACKUP_ROOT, '.latest-codex-fix.json')
const VIEWER_TEMPLATE = fileURLToPath(new URL('./assets/codex-raw-view.ps1', import.meta.url))
/** 实时过程镜像：codex.js 把原始 JSON-RPC 流 tee 到这里，DSH 面板直接读它渲染。 */
const LIVE_LOG = process.env.DSH_CODEX_LIVE_LOG || join(RUNS_DIR, 'codex-raw.log')
/** 按会话切分后的实时日志目录：每个 DSH 会话一份 codex-raw-<sessionId>.log。 */
const LIVE_SESSIONS_DIR = join(RUNS_DIR, 'sessions')
/** 每个会话「已清空」的字节基线；面板只显示基线之后的内容，清空因此是持久的。 */
const LIVE_CLEAR_FILE = join(RUNS_DIR, 'live-clear.json')
/** 全局日志 -> 会话文件的增量同步状态（游标、线程归属）。 */
const LIVE_SYNC_FILE = join(RUNS_DIR, 'live-sync.json')
/** 未完成同步批次（持久化：目标会话 + 内容 + 写入进度），崩溃后可恢复。 */
const LIVE_BATCH_FILE = LIVE_SYNC_FILE + '.batch'
/** 首次启用分文件时只回溯全局日志尾部这么多，避免一次解析几 MB 历史。 */
const LIVE_BOOTSTRAP_BYTES = 4 * 1024 * 1024
/** Codex 线程首事件时间与父会话 subagent 工具调用时间允许的匹配窗口。 */
const SESSION_MATCH_WINDOW_MS = 60 * 1000
/** 首屏回看 / 单次轮询的字节预算，避免一次把大日志读爆。 */
const LIVE_TAIL_BYTES = 8 * 1024 * 1024
const LIVE_READ_CAP = 4 * 1024 * 1024
const LIVE_EVENT_CAP = 50000
const COMMAND_OUTPUT_CAP = 4000

/** 低于这个版本时 gpt-6.1-sol 等新模型会被后端以 model_not_found 拒绝。 */
const MIN_CLI = [0, 164, 0]
/** 走沙箱时必须存在、但 npm 平台包漏带的两个 helper。 */
const REQUIRED_HELPERS = ['codex-windows-sandbox-setup.exe', 'codex-command-runner.exe']

function message(error) {
  return error && error.message ? error.message : String(error)
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 解析版本号成可比较的数字数组；解析不出返回 null。 */
function versionTuple(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''))
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** 解析版本号（支持预发布后缀），返回可比较对象；解析不出返回 null。 */
function versionRank(text) {
  const m = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.\-]+))?/.exec(String(text || ''))
  if (!m) return null
  return { numbers: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4] : null }
}

/** 比较两个版本（正式版高于同基础版本的预发布版）。 */
function compareVersions(left, right) {
  if (!left || !right) return 0
  for (let i = 0; i < 3; i += 1) {
    const a = left.numbers[i] || 0
    const b = right.numbers[i] || 0
    if (a > b) return 1
    if (a < b) return -1
  }
  if (left.pre === null && right.pre !== null) return 1
  if (left.pre !== null && right.pre === null) return -1
  if (left.pre !== null && right.pre !== null) {
    /* SemVer：预发布标识符逐段比较，数字段按数值比较（alpha.2 < alpha.10）。 */
    const leftParts = String(left.pre).split('.')
    const rightParts = String(right.pre).split('.')
    const length = Math.max(leftParts.length, rightParts.length)
    for (let i = 0; i < length; i += 1) {
      const a = leftParts[i]
      const b = rightParts[i]
      if (a === undefined) return -1
      if (b === undefined) return 1
      const aNumeric = /^\d+$/.test(a)
      const bNumeric = /^\d+$/.test(b)
      if (aNumeric && bNumeric) {
        const diff = Number(a) - Number(b)
        if (diff !== 0) return diff > 0 ? 1 : -1
      } else if (a !== b) {
        return a > b ? 1 : -1
      }
    }
  }
  return 0
}

function versionAtLeast(got, want) {
  if (!got) return false
  for (let i = 0; i < want.length; i += 1) {
    const a = got[i] || 0
    const b = want[i] || 0
    if (a > b) return true
    if (a < b) return false
  }
  return true
}

/** 直接问二进制自己是什么版本。 */
function probeVersion(exePath) {
  if (!exePath || !existsSync(exePath)) return null
  try {
    const r = spawnSync(exePath, ['--version'], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    })
    const text = `${r.stdout || ''} ${r.stderr || ''}`
    const m = /codex-cli\s+([0-9][0-9A-Za-z.\-]*)/.exec(text)
    if (m) return m[1]
    const t = versionTuple(text)
    return t ? `${t[0]}.${t[1]}.${t[2]}` : null
  } catch {
    return null
  }
}

/** 客户端自带的 bin 目录里，挑版本最高的那一份当修复源。 */
function findClientPayload() {
  try {
    if (!existsSync(CLIENT_BIN_ROOT)) return null
    let best = null
    for (const name of readdirSync(CLIENT_BIN_ROOT)) {
      const dir = join(CLIENT_BIN_ROOT, name)
      try {
        if (!statSync(dir).isDirectory()) continue
      } catch {
        continue
      }
      const exe = join(dir, 'codex.exe')
      if (!existsSync(exe)) continue
      const version = probeVersion(exe)
      const rank = versionRank(version)
      if (!rank) continue
      if (best === null || compareVersions(rank, versionRank(best.version)) > 0) {
        best = {
          dir,
          exe,
          version,
          helpers: REQUIRED_HELPERS.map((f) => ({ file: f, path: join(dir, f), ok: existsSync(join(dir, f)) })),
        }
      }
    }
    return best
  } catch {
    return null
  }
}

/** 异步探测版本（子进程 + 超时），避免 spawnSync 阻塞 host 事件循环。 */
function probeVersionAsync(exePath, timeoutMs = 15000) {
  return new Promise((resolvePromise) => {
    if (!exePath || !existsSync(exePath)) {
      resolvePromise(null)
      return
    }
    let settled = false
    let child = null
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        if (child !== null) child.kill()
      } catch {
        /* ignore */
      }
      resolvePromise(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    try {
      child = spawn(exePath, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      finish(null)
      return
    }
    let output = ''
    let outputBytes = 0
    const OUTPUT_CAP_BYTES = 64 * 1024
    child.stdout.on('data', (chunk) => {
      const text = String(chunk)
      outputBytes += chunk.length
      if (outputBytes > OUTPUT_CAP_BYTES) {
        finish(null)
        return
      }
      output += text
    })
    child.stderr.on('data', (chunk) => {
      /* stderr 与 stdout 合计按字节计数：异常进程狂写 stderr 也不能吃光内存。 */
      outputBytes += chunk.length
      if (outputBytes > OUTPUT_CAP_BYTES) finish(null)
    })
    child.on('error', () => {
      clearTimeout(timer)
      finish(null)
    })
    child.on('close', () => {
      clearTimeout(timer)
      if (settled) return
      const m = /codex-cli\s+([0-9][0-9A-Za-z.\-]*)/.exec(output)
      if (m) {
        finish(m[1])
        return
      }
      const tuple = versionTuple(output)
      finish(tuple ? `${tuple[0]}.${tuple[1]}.${tuple[2]}` : null)
    })
  })
}

/** 异步挑选客户端最高版本（候选并发探测）；不阻塞 host。 */
async function findClientPayloadAsync() {
  try {
    if (!existsSync(CLIENT_BIN_ROOT)) return null
    const candidates = []
    for (const name of readdirSync(CLIENT_BIN_ROOT)) {
      const dir = join(CLIENT_BIN_ROOT, name)
      try {
        if (!statSync(dir).isDirectory()) continue
      } catch {
        continue
      }
      const exe = join(dir, 'codex.exe')
      if (!existsSync(exe)) continue
      candidates.push({ dir, exe })
    }
    if (candidates.length === 0) return null
    /* 限制并发探测数，避免候选很多时同时拉起大量子进程。 */
    const CONCURRENCY = 4
    let best = null
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
      const batch = candidates.slice(i, i + CONCURRENCY)
      const versions = await Promise.all(batch.map((candidate) => probeVersionAsync(candidate.exe)))
      for (let j = 0; j < batch.length; j += 1) {
        const version = versions[j]
        const rank = versionRank(version)
        if (!rank) continue
        if (best === null || compareVersions(rank, versionRank(best.version)) > 0) {
          best = { dir: batch[j].dir, exe: batch[j].exe, version }
        }
      }
    }
    return best
  } catch {
    return null
  }
}

/**
 * 读取本机 WinINET 代理状态（三态）：
 * enabled=明确开启且地址有效；disabled=明确关闭；unknown=查询/解析失败（不能当关闭处理）。
 */
function detectProxy() {
  try {
    const enabledResult = spawnSync(
      'reg.exe',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable'],
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
    )
    if (enabledResult.error || enabledResult.status !== 0) return { state: 'unknown', url: null }
    const enabledMatch = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(enabledResult.stdout || '')
    if (!enabledMatch) return { state: 'unknown', url: null }
    if (parseInt(enabledMatch[1], 16) !== 1) return { state: 'disabled', url: null }
    const r = spawnSync(
      'reg.exe',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'],
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
    )
    if (r.error || r.status !== 0) return { state: 'unknown', url: null }
    const m = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(r.stdout || '')
    if (!m) return { state: 'unknown', url: null }
    let raw = m[1].trim()
    if (raw.includes('=')) {
      const parts = {}
      for (const piece of raw.split(';')) {
        const [k, v] = piece.split('=')
        if (k && v) parts[k.trim().toLowerCase()] = v.trim()
      }
      raw = parts.https || parts.http || ''
    }
    if (!/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(raw)) return { state: 'unknown', url: null }
    return { state: 'enabled', url: `http://${raw}` }
  } catch {
    return { state: 'unknown', url: null }
  }
}

/** 异步读取注册表某个值（spawn + 超时），不阻塞 host 事件循环。 */
function probeRegValueAsync(valueName, timeoutMs = 8000) {
  return new Promise((resolvePromise) => {
    let child = null
    let settled = false
    let output = ''
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        if (child !== null) child.kill()
      } catch {
        /* ignore */
      }
      resolvePromise(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    try {
      child = spawn(
        'reg.exe',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', valueName],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      )
    } catch {
      finish(null)
      return
    }
    let outputBytes = 0
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length
      if (outputBytes > 16 * 1024) {
        finish(null)
        return
      }
      output += String(chunk)
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => {
      if (settled) return
      finish(code === 0 ? output : null)
    })
  })
}

const proxyProbeCache = { at: 0, state: null }
let proxyProbeInFlight = null

/** 异步检测系统代理（三态 + 30 秒缓存 + 进行中复用），不阻塞 host。 */
function detectProxyAsync(force) {
  const now = Date.now()
  if (force !== true && proxyProbeCache.state && now - proxyProbeCache.at < 30000) {
    return Promise.resolve(proxyProbeCache.state)
  }
  if (proxyProbeInFlight !== null) return proxyProbeInFlight
  proxyProbeInFlight = probeRegValueAsync('ProxyEnable')
    .then((enabledOut) => {
      if (enabledOut === null) return { state: 'unknown', url: null }
      const enabledMatch = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(enabledOut)
      if (!enabledMatch) return { state: 'unknown', url: null }
      if (parseInt(enabledMatch[1], 16) !== 1) return { state: 'disabled', url: null }
      return probeRegValueAsync('ProxyServer').then((serverOut) => {
        if (serverOut === null) return { state: 'unknown', url: null }
        const m = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(serverOut)
        if (!m) return { state: 'unknown', url: null }
        let raw = m[1].trim()
        if (raw.includes('=')) {
          const parts = {}
          for (const piece of raw.split(';')) {
            const [k, v] = piece.split('=')
            if (k && v) parts[k.trim().toLowerCase()] = v.trim()
          }
          raw = parts.https || parts.http || ''
        }
        if (!/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(raw)) return { state: 'unknown', url: null }
        return { state: 'enabled', url: `http://${raw}` }
      })
    })
    .catch(() => ({ state: 'unknown', url: null }))
    .then((state) => {
      proxyProbeCache.at = Date.now()
      proxyProbeCache.state = state
      proxyProbeInFlight = null
      return state
    })
  return proxyProbeInFlight
}

/** 读取 ~/.codex/.env：区分「不存在」「成功」「读取失败」。 */
function readEnvText() {
  try {
    if (!existsSync(ENV_FILE)) return { ok: true, missing: true, text: '' }
    return { ok: true, missing: false, text: readFileSync(ENV_FILE, 'utf8') }
  } catch (error) {
    return { ok: false, missing: false, text: '', error: message(error) }
  }
}

/** .env 里有没有可用的 HTTPS_PROXY（大小写都算）；ok=false 表示读取失败，调用方必须中止维护。 */
function envProxyState() {
  const read = readEnvText()
  const m = /^\s*(https_proxy|HTTPS_PROXY)\s*=\s*(\S+)\s*$/m.exec(read.text)
  return {
    hasFile: !read.missing,
    text: read.text,
    proxy: m ? m[2] : null,
    ok: read.ok,
    error: read.ok ? null : read.error || '读取 .env 失败',
  }
}

/** 代理地址是否是本机回环（Clash/v2rayN 这类本地代理，端口可能变化，可由插件接管跟随）。 */
function isLoopbackProxyUrl(url) {
  try {
    const parsed = new URL(String(url))
    return (
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '::1' ||
      parsed.hostname === '[::1]'
    )
  } catch {
    return false
  }
}

/** 最近一次自动应用系统代理的结果（供状态接口显示）。 */
const proxyAutoState = { at: 0, applied: false, proxy: null, error: null, backup: null }
let proxyAutoBusy = false

/**
 * 自动跟随系统 HTTPS 代理：记录插件写入的值，系统代理变化时跟随、关闭时清理；
 * 用户自定义的代理与 NO_PROXY 不覆盖。
 */
async function ensureEnvProxy() {
  if (proxyAutoBusy) return { ok: true, applied: false, skipped: true }
  proxyAutoBusy = true
  let envLock = null
  try {
    /* 与另一个进程的代理维护互斥（.env 修改与管理记录需要一起生效）。 */
    envLock = acquireFileLock(ENV_FILE + '.lock')
    if (envLock === null) return { ok: false, applied: false, reason: '另一个代理维护正在进行' }
    const proxyResult = await detectProxyAsync()
    const systemProxy = proxyResult.state === 'enabled' ? proxyResult.url : null
    const env = envProxyState()
    /* .env 读取失败时立即停止维护：不能把「读不到」当成「空文件」去清理或覆盖用户配置。 */
    if (!env.ok) {
      proxyAutoState.at = Date.now()
      proxyAutoState.applied = false
      proxyAutoState.proxy = null
      proxyAutoState.error = '读取 .env 失败，未改动代理配置：' + (env.error || '未知错误')
      return Object.assign({ ok: false, applied: false, reason: proxyAutoState.error }, {
        systemProxy,
        envProxy: null,
        hasEnvProxy: false,
        autoProxyPatched: false,
      })
    }
    const settings = loadCatalogSettings()
    /* 设置读取/解析失败时中止维护（不能当首次运行覆盖开关与管理记录）。 */
    if (settings._loadError) {
      proxyAutoState.at = Date.now()
      proxyAutoState.error = settings._loadError
      return Object.assign({ ok: false, applied: false, reason: settings._loadError }, {
        systemProxy,
        envProxy: null,
        hasEnvProxy: false,
        autoProxyPatched: false,
      })
    }
    const managed = settings.managedProxy && typeof settings.managedProxy === 'object' ? settings.managedProxy : null
    const current = env.proxy
    const wrapper = wrapperState()
    const autoProxyPatched = Boolean(
      wrapper.ok && typeof wrapper.text === 'string' && wrapper.text.includes('自动跟随 Windows 系统代理'),
    )
    const stateBase = { systemProxy, envProxy: current, hasEnvProxy: Boolean(current), autoProxyPatched }
    /* 每次维护从干净结果开始：避免旧的 applied/proxy/error 混进本次状态。 */
    proxyAutoState.at = Date.now()
    proxyAutoState.applied = false
    proxyAutoState.proxy = null
    proxyAutoState.error = null
    /* 探测等待期间用户可能关闭自动代理：任何 .env 修改前复查开关，尊重用户选择。 */
    if (!loadCatalogSettings().autoProxy) {
      proxyAutoState.at = Date.now()
      return Object.assign({ ok: true, applied: false, reason: '自动代理已被关闭，未改动 .env' }, stateBase)
    }
    /* 代理状态无法确认：保留现有 .env 配置，不能当成「明确关闭」去清理。 */
    if (proxyResult.state === 'unknown') {
      proxyAutoState.at = Date.now()
      proxyAutoState.error = '系统代理状态无法确认，未改动 .env'
      return Object.assign({ ok: false, applied: false, reason: proxyAutoState.error }, stateBase)
    }
    /* 系统代理关闭：只清理插件自己写过的值，保留用户手工配置。 */
    if (!systemProxy) {
      if (managed && current && current === managed.value) {
        /* .env 与 managedProxy 必须在同一锁事务内一起更新；先拿设置锁并复查开关。 */
        const settingsLock = acquireFileLock(CATALOG_SETTINGS_FILE + '.lock')
        if (settingsLock === null) {
          return Object.assign({ ok: false, applied: false, reason: '设置文件被其它进程占用，请稍后重试' }, stateBase)
        }
        try {
          const latest = loadCatalogSettings()
          if (latest._loadError) throw new Error(latest._loadError)
          if (!latest.autoProxy) throw new Error('自动代理已被关闭，未改动 .env')
          writeEnvProxyValue(null, env)
          latest.managedProxy = null
          saveCatalogSettings(latest)
        } catch (error) {
          proxyAutoState.at = Date.now()
          proxyAutoState.error = message(error)
          return Object.assign({ ok: false, applied: false, reason: message(error) }, stateBase)
        } finally {
          settingsLock()
        }
        proxyAutoState.at = Date.now()
        return Object.assign({ ok: true, applied: true, reason: '系统代理已关闭，已清理插件写入的代理' }, stateBase)
      }
      proxyAutoState.at = Date.now()
      return Object.assign({ ok: true, applied: false, reason: '系统未启用代理' }, stateBase)
    }
    /* .env 已有代理：本机回环代理（Clash/v2rayN 等）视为可接管，跟随系统代理端口变化；
       其它地址视为用户自定义代理，保持不动。 */
    if (current && (!managed || current !== managed.value) && !isLoopbackProxyUrl(current)) {
      proxyAutoState.at = Date.now()
      return Object.assign({ ok: true, applied: false, reason: '已有用户自定义代理，保持不动' }, stateBase)
    }
    if (current && current === systemProxy) {
      proxyAutoState.at = Date.now()
      return Object.assign({ ok: true, applied: false, reason: '已配置' }, stateBase)
    }
    {
      /* 写入 .env 与 managedProxy 在同一设置锁事务内完成；失败时 .env 不落盘。 */
      const settingsLock = acquireFileLock(CATALOG_SETTINGS_FILE + '.lock')
      if (settingsLock === null) {
        return Object.assign({ ok: false, applied: false, reason: '设置文件被其它进程占用，请稍后重试' }, stateBase)
      }
      try {
        const latest = loadCatalogSettings()
        if (latest._loadError) throw new Error(latest._loadError)
        if (!latest.autoProxy) throw new Error('自动代理已被关闭，未改动 .env')
        writeEnvProxyValue(systemProxy, env)
        latest.managedProxy = { value: systemProxy, at: Date.now() }
        saveCatalogSettings(latest)
      } catch (error) {
        proxyAutoState.at = Date.now()
        proxyAutoState.error = message(error)
        return Object.assign({ ok: false, applied: false, reason: message(error) }, stateBase)
      } finally {
        settingsLock()
      }
      proxyAutoState.at = Date.now()
      proxyAutoState.applied = true
      proxyAutoState.proxy = systemProxy
      proxyAutoState.error = null
      return Object.assign({ ok: true, applied: true, reason: '已写入系统代理' }, stateBase, {
        envProxy: systemProxy,
        hasEnvProxy: true,
      })
    }
  } finally {
    if (envLock !== null) envLock()
    proxyAutoBusy = false
  }
}

/** 读取 Windows 系统代理（注册表）并生成环境变量补丁；用于每次 codex 派发前同步。 */
function readSystemProxyEnvPatch() {
  const env = {}
  const remove = []
  let enabled = false
  let httpsUrl = ''
  let httpUrl = ''
  let bypass = ''
  try {
    const result = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    })
    const output = String(result.stdout || '')
    const enableMatch = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(output)
    const serverMatch = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(output)
    const overrideMatch = /ProxyOverride\s+REG_SZ\s+([^\r\n]*)/i.exec(output)
    enabled = enableMatch ? parseInt(enableMatch[1], 16) === 1 : false
    if (enabled && serverMatch) {
      const raw = serverMatch[1].trim()
      if (raw.includes('=')) {
        for (const part of raw.split(';')) {
          const kv = part.split('=')
          const key = String(kv[0] || '').trim().toLowerCase()
          const value = String(kv[1] || '').trim()
          if (key === 'http') httpUrl = value
          else if (key === 'https') httpsUrl = value
        }
        httpsUrl = httpsUrl || httpUrl
      } else {
        httpUrl = /^[a-z]+:\/\//i.test(raw) ? raw : 'http://' + raw
        httpsUrl = httpUrl
      }
      bypass = overrideMatch ? overrideMatch[1].trim() : ''
    }
  } catch {
    /* 读不到系统代理时不动环境变量 */
    return { ok: false, env: {}, remove: [], enabled: false, httpsUrl: null }
  }
  if (enabled && httpsUrl) {
    env.HTTPS_PROXY = httpsUrl
    env.https_proxy = httpsUrl
    if (httpUrl) {
      env.HTTP_PROXY = httpUrl
      env.http_proxy = httpUrl
    }
    const noProxy = bypass
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => (item.charAt(0) === '*' ? item.slice(1) : item))
      .join(',')
    if (noProxy) {
      env.NO_PROXY = noProxy
      env.no_proxy = noProxy
    }
  } else {
    remove.push('HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy')
  }
  return { ok: true, env, remove, enabled, httpsUrl: httpsUrl || null }
}

/** 把系统代理写进 ~/.codex/.env（每次 codex 派发前调用；无系统代理时只清理插件写入的回环代理行）。 */
function syncEnvFileProxyForSpawn(proxy) {
  if (!proxy || !proxy.ok) return
  const lock = acquireFileLock(ENV_FILE + '.lock')
  if (lock === null) return
  try {
    const envState = envProxyState()
    if (!envState.ok) return
    const desired = proxy.enabled && proxy.httpsUrl ? proxy.httpsUrl : null
    if (desired === null) {
      /* 系统代理关闭：只清理本机回环代理行，避免误删用户自定义代理。 */
      if (envState.proxy && isLoopbackProxyUrl(envState.proxy)) writeEnvProxyValue(null, envState)
      return
    }
    if (envState.proxy === desired) return
    /* 已有非回环自定义代理：不覆盖。 */
    if (envState.proxy && !isLoopbackProxyUrl(envState.proxy)) return
    writeEnvProxyValue(desired, envState)
  } catch (error) {
    console.warn(TAG + ' 派发前写入 .env 代理失败：' + message(error))
  } finally {
    lock()
  }
}

/** 包装 subprocess.spawn：每次 codex app-server 派发前用当前系统代理覆盖环境变量并同步 .env。 */
function installSpawnProxyPatch(ctx) {
  let subprocess = null
  try {
    subprocess = ctx.get('subprocess')
  } catch {
    subprocess = null
  }
  if (!subprocess || typeof subprocess.spawn !== 'function') return
  if (subprocess.__dshCodexCatalogProxyPatched) return
  subprocess.__dshCodexCatalogProxyPatched = true
  const originalSpawn = subprocess.spawn
  subprocess.spawn = function (spec) {
    try {
      const argv = spec && Array.isArray(spec.argv) ? spec.argv : []
      const isCodexAppServer = argv.some((arg) => String(arg) === 'app-server')
      if (isCodexAppServer) {
        const proxy = readSystemProxyEnvPatch()
        if (proxy.ok) {
          const nextEnv = Object.assign({}, (spec && spec.env) || {})
          Object.assign(nextEnv, proxy.env)
          for (const key of proxy.remove) delete nextEnv[key]
          if (spec && typeof spec === 'object') spec.env = nextEnv
          syncEnvFileProxyForSpawn(proxy)
        }
      }
    } catch (error) {
      console.warn(TAG + ' 派发前同步系统代理失败：' + message(error))
    }
    return originalSpawn.call(this, spec)
  }
}

/** 写入或清理 .env 里的代理行：先备份，保留用户自定义的 NO_PROXY 与其它内容。 */
function writeEnvProxyValue(proxyUrl, env) {
  /* 写入前核对磁盘原文：读取失败或维护期间被外部修改时中止，避免覆盖用户配置。 */
  const currentRead = readEnvText()
  if (!currentRead.ok) throw new Error('读取 .env 失败，已中止：' + (currentRead.error || '未知错误'))
  if (currentRead.text !== String(env.text || '')) {
    throw new Error('.env 在维护期间被外部修改，已中止本次写入')
  }
  const lines = String(env.text || '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .filter((line) => !/^\s*(https_proxy|HTTPS_PROXY)\s*=/.test(line))
  if (proxyUrl) {
    lines.push('HTTPS_PROXY=' + proxyUrl)
    lines.push('https_proxy=' + proxyUrl)
    const joined = lines.join('\n')
    if (!/^\s*(no_proxy|NO_PROXY)\s*=/m.test(joined)) {
      lines.push('NO_PROXY=localhost,127.0.0.1,::1')
      lines.push('no_proxy=localhost,127.0.0.1,::1')
    }
  }
  const next = lines.join('\n') + (lines.length ? '\n' : '')
  const stampText = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(BACKUP_ROOT, stampText + '-codex-env-proxy')
  mkdirSync(backupDir, { recursive: true })
  if (env.hasFile) {
    try {
      copyFileSync(ENV_FILE, join(backupDir, '.env'))
    } catch (error) {
      throw new Error('备份 .env 失败，已中止：' + message(error))
    }
  }
  const tmp = ENV_FILE + '.tmp-' + process.pid + '-' + Date.now()
  writeFileSync(tmp, next, 'utf8')
  renameSync(tmp, ENV_FILE)
}

function wrapperState() {
  try {
    if (!existsSync(WRAPPER)) return { ok: false, patched: false, v2: false, legacy: false, text: '', detail: 'codex.js 不存在' }
    const text = readFileSync(WRAPPER, 'utf8')
    const patched = text.includes('DSH_CODEX_LIVE_LOG')
    /* 记录补丁的真实版本：v4 才支持按运行目录解析日志路径，v2/v3 需要重打。 */
    let patchVersion = null
    if (/dsh-codex-fix v4/.test(text)) patchVersion = 'v4'
    else if (/dsh-codex-fix v3/.test(text)) patchVersion = 'v3'
    else if (/dsh-codex-fix v2/.test(text)) patchVersion = 'v2'
    const v2 = patchVersion !== null
    /* 补丁里写死的默认镜像路径；和当前运行目录不一致说明是别的机器/旧版本留下的补丁。 */
    let livePath = null
    const m = /process\.env\.DSH_CODEX_LIVE_LOG\s*\|\|\s*("(?:[^"\\]|\\.)*")/.exec(text)
    if (m) {
      try {
        livePath = JSON.parse(m[1])
      } catch {
        livePath = null
      }
    }
    const pathKnown = livePath !== null
    const expectedPath = join(RUNS_DIR, 'codex-raw.log')
    const envOverride = Boolean(process.env.DSH_CODEX_LIVE_LOG)
    /* 无法解析路径时不能当作正常；只有显式环境变量覆盖时才放宽（依赖子进程继承同一环境）。 */
    const upToDate =
      v2 && patchVersion === 'v4' && (pathKnown ? livePath === expectedPath || envOverride : envOverride)
    return {
      ok: patched,
      patched,
      v2,
      legacy: patched && !v2,
      patchVersion,
      text,
      size: text.length,
      livePath,
      pathKnown,
      upToDate,
    }
  } catch (error) {
    return { ok: false, patched: false, v2: false, legacy: false, text: '', detail: message(error) }
  }
}

/** 用给定版本信息组装完整状态（只读，不动任何文件）。 */
function buildStatus(vendorVersion, client, proxyInfo) {
  const env = envProxyState()
  const wrapper = wrapperState()
  const autoProxyPatched = Boolean(wrapper.ok && typeof wrapper.text === 'string' && wrapper.text.includes('自动跟随 Windows 系统代理'))
  const helpers = REQUIRED_HELPERS.map((f) => ({ file: f, ok: existsSync(join(VENDOR_BIN, f)) }))
  const proxyState = proxyInfo && typeof proxyInfo.state === 'string' ? proxyInfo.state : 'unknown'
  const proxy = proxyInfo && typeof proxyInfo.url === 'string' ? proxyInfo.url : null

  const checks = [
    {
      id: 'cli',
      title: '子代理 CLI 版本',
      ok: versionAtLeast(versionTuple(vendorVersion), MIN_CLI),
      detail: vendorVersion
        ? `当前 ${vendorVersion}` + (versionAtLeast(versionTuple(vendorVersion), MIN_CLI) ? '' : `，需要 ≥ ${MIN_CLI.join('.')}`)
        : '读不到版本（文件可能不存在）',
      fix: client && (!vendorVersion || !versionAtLeast(versionTuple(vendorVersion), MIN_CLI))
        ? `从客户端 ${client.version} 复制 codex.exe`
        : null,
    },
    {
      id: 'helpers',
      title: '沙箱 helper',
      ok: helpers.every((h) => h.ok),
      detail: helpers.map((h) => `${h.ok ? '✓' : '✗'} ${h.file}`).join('  '),
      fix: client ? '从客户端目录补齐缺失的 helper' : null,
    },
    {
      id: 'env',
      title: '网络代理',
      ok:
        proxyState === 'enabled'
          ? Boolean(autoProxyPatched) || Boolean(env.proxy)
          : proxyState === 'disabled'
            ? Boolean(env.proxy)
            : false,
      detail:
        proxyState === 'unknown'
          ? '系统代理状态无法确认（注册表查询失败），请检查系统代理设置'
          : proxy
            ? autoProxyPatched
              ? `系统代理 ${proxy}：codex.js 每次启动自动读取，不需要 .env`
              : `系统代理 ${proxy}：但 codex.js 还没有自动读取补丁`
            : env.proxy
              ? `系统代理未启用，用 .env 兜底：HTTPS_PROXY=${env.proxy}`
              : '系统代理未启用，也没有 ~/.codex/.env（每趟会先卡 1–2 分钟做 websocket 试探）',
      fix:
        proxyState === 'unknown'
          ? '检查系统代理设置后重试'
          : autoProxyPatched
            ? null
            : proxy
              ? '给 codex.js 打补丁：启动时自动跟随 Windows 系统代理'
              : '开启系统代理，或写 ~/.codex/.env',
    },
    {
      id: 'mirror',
      title: '过程镜像补丁',
      ok: wrapper.v2 && wrapper.upToDate,
      detail: wrapper.v2 && wrapper.upToDate
        ? `codex.js 已带 ${wrapper.patchVersion || 'v4'} tee 补丁（原始流写进 ${LIVE_LOG}）`
        : wrapper.v2
          ? !wrapper.pathKnown
            ? `codex.js 补丁为 ${wrapper.patchVersion || '旧版本'}，但读不出日志路径，无法确认是否指向当前运行目录`
            : wrapper.livePath !== join(RUNS_DIR, 'codex-raw.log')
              ? `codex.js 补丁为 ${wrapper.patchVersion || '旧版本'}，日志路径是 ${wrapper.livePath || '旧路径'}，与当前运行目录 ${RUNS_DIR} 不一致`
              : `codex.js 补丁为 ${wrapper.patchVersion || '旧版本'}，日志路径正确但补丁版本过旧（需要 v4）`
          : wrapper.ok
            ? 'codex.js 带的是旧补丁：每次派活还会弹独立控制台窗口'
            : 'codex.js 是原版，过程不可见',
      fix: wrapper.v2 && wrapper.upToDate
        ? null
        : wrapper.v2
          ? '把补丁里的日志路径更新为当前运行目录'
          : wrapper.ok
            ? '升级补丁：过程改在 DSH 面板显示，不再弹窗口'
            : '给 codex.js 打 tee 补丁',
    },
    {
      id: 'live',
      title: 'DSH 实时视图',
      ok: wrapper.v2 && wrapper.upToDate,
      detail: wrapper.v2 && wrapper.upToDate
        ? `过程直接显示在 DSH：插件页下方「实时过程」，或会话顶栏「Codex 实时」标签（全局镜像 ${LIVE_LOG}，按会话拆到 ${LIVE_SESSIONS_DIR}）`
        : wrapper.v2
          ? `补丁为 ${wrapper.patchVersion || '旧版本'}，日志路径与当前运行目录不一致或无法确认，实时面板读不到新过程`
          : '补丁版本过低，过程不会进 DSH 面板',
      fix: wrapper.v2 && wrapper.upToDate ? null : '先点「一键修复」升级补丁',
    },
  ]

  const latest = latestManifest()

  return {
    ok: checks.every((c) => c.ok),
    restorable: latest
      ? {
          available: true,
          createdAt: latest.manifest.createdAt || null,
          count: Array.isArray(latest.manifest.entries) ? latest.manifest.entries.length : 0,
          manifest: latest.manifestPath,
        }
      : { available: false },
    checks,
    context: {
      dshHome: DSH_HOME,
      profileDir: PROFILE_DIR,
      vendorBin: VENDOR_BIN,
      vendorVersion,
      clientVersion: client ? client.version : null,
      clientDir: client ? client.dir : null,
      wrapperPath: WRAPPER,
      envFile: ENV_FILE,
      viewerPath: VIEWER_PATH,
      runsDir: RUNS_DIR,
      liveLog: LIVE_LOG,
      liveSessionsDir: LIVE_SESSIONS_DIR,
      livePatch: wrapper.v2,
      legacyPatch: wrapper.legacy,
      detectedProxy: proxy,
    },
  }
}

/** 同步状态检查（遗留修复流程内部使用）。 */
function checkStatus() {
  return buildStatus(probeVersion(join(VENDOR_BIN, 'codex.exe')), findClientPayload(), detectProxy())
}

/** 异步版状态检查：版本探测与代理查询都不阻塞 host 事件循环（/status 路由使用）。 */
async function checkStatusAsync() {
  const vendorVersion = await probeVersionAsync(join(VENDOR_BIN, 'codex.exe'))
  const client = await findClientPayloadAsync()
  const proxyInfo = await detectProxyAsync()
  return buildStatus(vendorVersion, client, proxyInfo)
}

/** 备份一个文件到本次修复的备份目录；不存在就跳过。 */
function backupFile(file, backupDir) {
  try {
    if (!existsSync(file)) return null
    mkdirSync(backupDir, { recursive: true })
    const target = join(backupDir, basename(file))
    copyFileSync(file, target)
    return target
  } catch {
    return null
  }
}

/** 记录「改动前备份」，返回备份路径。 */
function recordBackup(entries, file, backupDir, label) {
  const backup = backupFile(file, backupDir)
  if (backup) entries.push({ label, path: file, backup, existed: true })
  return backup
}

/** 记录「本次新建的文件」，还原时把它删掉。 */
function recordCreate(entries, file, label) {
  entries.push({ label, path: file, backup: null, existed: false })
}

/** 把本次修复的备份清单落盘，并更新「最近一次」指针。 */
function writeManifest(backupDir, entries) {
  if (!entries.length) return null
  try {
    mkdirSync(backupDir, { recursive: true })
    const manifestPath = join(backupDir, 'manifest.json')
    const manifest = { createdAt: new Date().toISOString(), entries }
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    mkdirSync(BACKUP_ROOT, { recursive: true })
    writeFileSync(
      POINTER_FILE,
      JSON.stringify({ manifestPath, backupDir, createdAt: manifest.createdAt, count: entries.length }, null, 2),
      'utf8',
    )
    return manifestPath
  } catch {
    return null
  }
}

/** 读「最近一次修复」的清单；没有就返回 null。 */
function latestManifest() {
  try {
    if (!existsSync(POINTER_FILE)) return null
    const pointer = JSON.parse(readFileSync(POINTER_FILE, 'utf8'))
    if (!pointer || !pointer.manifestPath || !existsSync(pointer.manifestPath)) return null
    const manifest = JSON.parse(readFileSync(pointer.manifestPath, 'utf8'))
    return { pointer, manifest, manifestPath: pointer.manifestPath }
  } catch {
    return null
  }
}

/**
 * 从当前 wrapper 文本反推「未打补丁的原始文本」：
 * 移除镜像补丁块并恢复原始 spawn 锚点。失败返回 null。
 */
function reconstructWrapperOriginal(wrapperText) {
  if (typeof wrapperText !== 'string' || wrapperText.length === 0) return null
  const begin = wrapperText.indexOf('// --- DSH live-mirror patch')
  if (begin < 0) {
    if (wrapperText.includes(LIVE_PATCH_ANCHOR) && !wrapperText.includes('DSH_CODEX_LIVE_LOG')) return wrapperText
    return null
  }
  const endAnchor = wrapperText.indexOf(LIVE_PATCH_V1_END, begin)
  if (endAnchor < 0) return null
  /* LIVE_PATCH_V1_END 本身已包含补丁块末尾的闭合大括号，直接从这里拼回原始锚点即可，
     不能再吞掉后面的 `}`（原始代码在 spawn 语句后可能正好紧跟一个闭合括号）。 */
  const after = endAnchor + LIVE_PATCH_V1_END.length
  return wrapperText.slice(0, begin) + LIVE_PATCH_ANCHOR + wrapperText.slice(after)
}

/**
 * 从历史修复备份里找回 codex.js 的「原始文本」。
 * 只有「能从当前 wrapper 精确反推出同一份原始文本」的备份才会被采用：
 * 内容比对同时确认了备份身份与版本，避免无关/不同版本的 codex.js 覆盖当前安装。
 */
function latestWrapperBackup(wrapperText) {
  const expected = reconstructWrapperOriginal(wrapperText)
  if (expected === null) return null
  let dirs = []
  try {
    dirs = readdirSync(BACKUP_ROOT)
      .filter((name) => name.endsWith('-codex-fix'))
      .map((name) => join(BACKUP_ROOT, name))
  } catch {
    return null
  }
  dirs.sort((left, right) => right.localeCompare(left))
  /* 严格按路径组件识别 @openai/codex/bin/codex.js，不再用 includes('codex') 这种宽松匹配。 */
  const isCodexWrapperPath = (value) => {
    const parts = String(value || '')
      .toLowerCase()
      .split(/[\\/]+/)
      .filter(Boolean)
    if (parts.length < 3 || parts[parts.length - 1] !== 'codex.js') return false
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i] === '@openai' && parts[i + 1] === 'codex') return true
    }
    return false
  }
  for (const dir of dirs) {
    let manifest = null
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
    } catch {
      manifest = null
    }
    const entries = manifest && Array.isArray(manifest.entries) ? manifest.entries : []
    const candidates = []
    let sawWrapperEntry = false
    for (const entry of entries) {
      if (!entry || !isCodexWrapperPath(entry.path)) continue
      sawWrapperEntry = true
      if (entry.backup) candidates.push(String(entry.backup))
      /* 换机器/换盘符时清单里的绝对路径失效：退回「当前备份目录 + 文件名」，来源仍是可信条目。 */
      candidates.push(join(dir, basename(String(entry.path))))
    }
    /* 清单缺失或没有 wrapper 条目时才直接看备份目录下的 codex.js；内容必须与当前 wrapper 精确匹配。 */
    if (!sawWrapperEntry) candidates.push(join(dir, 'codex.js'))
    for (const candidate of candidates) {
      if (!candidate || !existsSync(candidate)) continue
      try {
        if (readFileSync(candidate, 'utf8') === expected) return candidate
      } catch {
        /* 读不出来的备份跳过 */
      }
    }
  }
  return null
}

/** 还原最近一次修复：备份过的文件拷回去，本次新建的文件删掉。 */
function restoreLatest() {
  const found = latestManifest()
  if (!found) return { ok: false, error: '没有找到可还原的修复记录（可能还没点过一键修复）' }
  const { manifest, manifestPath } = found
  const results = []
  for (const entry of manifest.entries) {
    try {
      if (entry.existed) {
        if (!entry.backup || !existsSync(entry.backup)) throw new Error('备份文件已丢失')
        mkdirSync(dirname(entry.path), { recursive: true })
        copyFileSync(entry.backup, entry.path)
        results.push({ label: entry.label, path: entry.path, ok: true, action: 'restored' })
      } else {
        if (existsSync(entry.path)) unlinkSync(entry.path)
        results.push({ label: entry.label, path: entry.path, ok: true, action: 'removed' })
      }
    } catch (error) {
      results.push({ label: entry.label, path: entry.path, ok: false, action: 'failed', error: message(error) })
    }
  }
  // 指针改名，避免重复还原；备份目录保留，随时可人工回查
  let consumed = false
  try {
    renameSync(POINTER_FILE, `${manifestPath}.restored.json`)
    consumed = true
  } catch {
    consumed = false
  }
  return {
    ok: results.every((r) => r.ok),
    manifest: manifestPath,
    restoredAt: new Date().toISOString(),
    consumed,
    results,
    status: checkStatus(),
  }
}

/** 原子替换：先写临时文件再 rename，顺带断开 pnpm 的硬链接，避免污染 store。 */
function replaceFile(file, content) {
  const tmp = `${file}.codexfix-${process.pid}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

const LIVE_PATCH_ANCHOR = `const child = spawn(binaryPath, process.argv.slice(2), {
  stdio: "inherit",
  env,
});`

const LIVE_PATCH = String.raw`// --- DSH live-mirror patch (dsh-codex-fix v4) ---
// 把 app-server 的原始 JSON-RPC 流同时写一份到文件；DSH 插件面板实时读取它，
// 在插件页和会话标签里渲染。独立控制台窗口默认不再弹出（设 DSH_CODEX_OPEN_VIEWER=1
// 可恢复旧行为）。没有设置 DSH_CODEX_LIVE_LOG 时行为与原版完全一致。
// v3：日志路径来自插件解析出的运行目录（DSH 数据目录下），不再写死某台机器的路径。
// v4：运行时路径同时用于备用窗口与 PID 文件；自动创建自定义日志目录；修正 PowerShell 路径转义。
const { createWriteStream } = await import("node:fs");
// --- 自动跟随 Windows 系统代理（dsh-codex-fix） ---
// 每次启动读注册表里的系统代理，写进子进程 env；系统代理关闭时清掉继承值，
// 因此不需要手工维护 .env，端口/开关变化后下一次派活自动生效。
try {
  const cpMod = await import("node:child_process");
  const regKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  const regOut = String(
    cpMod.spawnSync("reg", ["query", regKey], { encoding: "utf8", windowsHide: true }).stdout || "",
  );
  const enM = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(regOut);
  const svM = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(regOut);
  const ovM = /ProxyOverride\s+REG_SZ\s+([^\r\n]*)/i.exec(regOut);
  const proxyEnabled = enM ? parseInt(enM[1], 16) === 1 : false;
  if (proxyEnabled && svM) {
    const rawSpec = svM[1].trim();
    let httpUrl = "";
    let httpsUrl = "";
    if (rawSpec.indexOf("=") >= 0) {
      for (const part of rawSpec.split(";")) {
        const kv = part.split("=");
        const k = String(kv[0] || "").trim().toLowerCase();
        const v = String(kv[1] || "").trim();
        if (k === "http") httpUrl = v;
        else if (k === "https") httpsUrl = v;
      }
      httpsUrl = httpsUrl || httpUrl;
    } else {
      httpUrl = /^[a-z]+:\/\//i.test(rawSpec) ? rawSpec : "http://" + rawSpec;
      httpsUrl = httpUrl;
    }
    if (httpsUrl) {
      env.HTTPS_PROXY = httpsUrl;
      env.https_proxy = httpsUrl;
    }
    if (httpUrl) {
      env.HTTP_PROXY = httpUrl;
      env.http_proxy = httpUrl;
    }
    const bypassRaw = (ovM ? ovM[1] : "").trim();
    if (bypassRaw) {
      const noProxy = bypassRaw
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => (s.charAt(0) === "*" ? s.slice(1) : s))
        .join(",");
      if (noProxy) {
        env.NO_PROXY = noProxy;
        env.no_proxy = noProxy;
      }
    }
  } else {
    delete env.HTTPS_PROXY;
    delete env.https_proxy;
    delete env.HTTP_PROXY;
    delete env.http_proxy;
  }
} catch {}
const liveMirrorPath = process.env.DSH_CODEX_LIVE_LOG || ${JSON.stringify(join(RUNS_DIR, 'codex-raw.log'))};
let liveMirror = null;
if (liveMirrorPath) {
  try {
    const fsSync = await import("node:fs");
    const pathModSync = await import("node:path");
    try {
      fsSync.mkdirSync(pathModSync.dirname(liveMirrorPath), { recursive: true });
    } catch {}
    try {
      const st = fsSync.statSync(liveMirrorPath);
      if (st.size > 32 * 1024 * 1024) fsSync.renameSync(liveMirrorPath, liveMirrorPath + ".old");
    } catch {}
    liveMirror = createWriteStream(liveMirrorPath, { flags: "a" });
    liveMirror.on("error", () => {
      liveMirror = null;
    });
  } catch {
    liveMirror = null;
  }
}
// --- 备用独立窗口（仅 Windows，仅 app-server 场景；默认关闭） ---
// v2 起过程由 DSH 面板显示，不再默认弹窗；需要旧行为时设 DSH_CODEX_OPEN_VIEWER=1。
async function maybeOpenLiveViewer() {
  if (process.platform !== "win32") return;
  if (process.env.DSH_CODEX_NO_VIEWER) return;
  if (!process.argv.slice(2).includes("app-server")) return;
  try {
    const fsMod = await import("node:fs");
    const pathMod = await import("node:path");
    const runsDir = liveMirrorPath ? pathMod.dirname(liveMirrorPath) : ${JSON.stringify(RUNS_DIR)};
    fsMod.mkdirSync(runsDir, { recursive: true });
    const pidFile = pathMod.join(runsDir, "viewer.pid");
    try {
      const pid = Number(fsMod.readFileSync(pidFile, "utf8").trim());
      if (Number.isFinite(pid) && pid > 0) {
        const cpMod = await import("node:child_process");
        const q = cpMod.spawnSync("tasklist", ["/FI", "PID eq " + pid, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
        const line = String((q && q.stdout) || "").toLowerCase();
        if (line.includes("pwsh.exe") || line.includes("powershell.exe")) return;
      }
      try { fsMod.unlinkSync(pidFile); } catch {}
    } catch {}
    const pwshCandidates = [
      process.env.DSH_PWSH,
      process.env.PWSH_PATH,
      (process.env.ProgramFiles || "C:\\Program Files") + "\\PowerShell\\7\\pwsh.exe",
      (process.env.ProgramW6432 || process.env.ProgramFiles || "C:\\Program Files") + "\\PowerShell\\7\\pwsh.exe",
    ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
    let pwsh = "";
    for (const candidate of pwshCandidates) {
      if (fsMod.existsSync(candidate)) {
        pwsh = candidate;
        break;
      }
    }
    if (!pwsh) return;
    const viewScript = ${JSON.stringify(VIEWER_PATH)};
    if (!fsMod.existsSync(viewScript)) return;
    const cmdLine =
      '/c start "Codex Live" "' + pwsh + '" -NoProfile -ExecutionPolicy Bypass -File "' + viewScript +
      '" -LogPath "' + liveMirrorPath + '"';
    const launcher = spawn("cmd.exe", [cmdLine], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      windowsVerbatimArguments: true,
    });
    launcher.unref();
  } catch {}
}
if (process.env.DSH_CODEX_OPEN_VIEWER === "1") maybeOpenLiveViewer();
const child = spawn(binaryPath, process.argv.slice(2), {
  stdio: liveMirror ? ["pipe", "pipe", "pipe"] : "inherit",
  env,
  windowsHide: true,
});
if (liveMirror) {
  try {
    process.stdin.pipe(child.stdin);
  } catch {}
  child.stdout.on("data", (chunk) => {
    try {
      liveMirror.write(chunk);
    } catch {}
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    try {
      liveMirror.write(chunk);
    } catch {}
    process.stderr.write(chunk);
  });
  child.on("exit", () => {
    try {
      liveMirror.end();
    } catch {}
  });
}`

/** v1 补丁块的结束标记：升级时用它定位旧补丁边界，不碰后面的原版代码。 */
const LIVE_PATCH_V1_END = `  child.on("exit", () => {
    try {
      liveMirror.end();
    } catch {}
  });
}`

/**
 * 把 codex.js 的内容补成 v4 补丁（幂等）：
 * current=已是 v2/v3/v4 补丁，upgraded=从 v1 升级，patched=原版打补丁，unknown=结构不符不动。
 */
function patchWrapperText(text) {
  if (/dsh-codex-fix v[234]/.test(text)) return { text, action: 'current' }
  const marker = text.indexOf('// --- DSH live-mirror patch (dsh-codex-fix)')
  if (marker >= 0) {
    const end = text.indexOf(LIVE_PATCH_V1_END, marker)
    if (end < 0) return { text, action: 'unknown' }
    return { text: text.slice(0, marker) + LIVE_PATCH + text.slice(end + LIVE_PATCH_V1_END.length), action: 'upgraded' }
  }
  if (!text.includes(LIVE_PATCH_ANCHOR)) return { text, action: 'unknown' }
  return { text: text.replace(LIVE_PATCH_ANCHOR, LIVE_PATCH), action: 'patched' }
}

/** 一键修复：按 cli → helpers → env → mirror → viewer 顺序，每步独立成败。 */
function applyAll() {
  const startedAt = new Date().toISOString()
  const backupDir = join(BACKUP_ROOT, `${stamp()}-codex-fix`)
  const steps = []
  const entries = []

  const push = (id, ok, detail, extra) => {
    steps.push({ id, ok, detail, ...(extra || {}) })
  }

  // 1) CLI 版本
  try {
    const vendorExe = join(VENDOR_BIN, 'codex.exe')
    const vendorVersion = probeVersion(vendorExe)
    if (versionAtLeast(versionTuple(vendorVersion), MIN_CLI)) {
      push('cli', true, `已是 ${vendorVersion}，无需更换`)
    } else {
      const client = findClientPayload()
      if (!client) {
        push('cli', false, '没找到 Codex 客户端自带的 CLI，无法升级')
      } else {
        mkdirSync(VENDOR_BIN, { recursive: true })
        recordBackup(entries, vendorExe, backupDir, '子代理 CLI (codex.exe)')
        copyFileSync(client.exe, vendorExe)
        const after = probeVersion(vendorExe)
        push(
          'cli',
          versionAtLeast(versionTuple(after), MIN_CLI),
          `已用客户端 ${client.version} 覆盖 → 现在 ${after || '未知'}`,
          { backup: backupDir },
        )
      }
    }
  } catch (error) {
    push('cli', false, message(error))
  }

  // 2) 沙箱 helper
  try {
    const client = findClientPayload()
    if (!client) {
      push('helpers', false, '没找到 Codex 客户端目录，无法补齐 helper')
    } else {
      const copied = []
      const missing = []
      for (const file of REQUIRED_HELPERS) {
        const target = join(VENDOR_BIN, file)
        if (existsSync(target)) continue
        const source = join(client.dir, file)
        if (!existsSync(source)) {
          missing.push(file)
          continue
        }
        recordCreate(entries, target, `沙箱 helper ${file}`)
        copyFileSync(source, target)
        copied.push(file)
      }
      const stillMissing = REQUIRED_HELPERS.filter((f) => !existsSync(join(VENDOR_BIN, f)))
      push(
        'helpers',
        stillMissing.length === 0,
        stillMissing.length === 0
          ? copied.length > 0
            ? `已补齐 ${copied.join('、')}`
            : '两个 helper 本来就在'
          : `仍缺 ${stillMissing.join('、')}${missing.length ? `（客户端里也没有：${missing.join('、')}）` : ''}`,
      )
    }
  } catch (error) {
    push('helpers', false, message(error))
  }

  // 3) 网络代理（优先跟随系统代理，只有系统代理不可用才退回 .env）
  try {
    const current = envProxyState()
    const proxyState = detectProxy()
    const sysProxy = proxyState.state === 'enabled' ? proxyState.url : null
    if (proxyState.state === 'unknown') {
      push('env', false, '系统代理状态无法确认（注册表查询失败），请检查系统代理设置')
    } else if (sysProxy) {
      push('env', true, `系统代理 ${sysProxy}：由 codex.js 启动时自动读取（下一步打补丁），不写 .env`)
    } else if (current.proxy) {
      push('env', true, `系统代理未启用，沿用 .env：HTTPS_PROXY=${current.proxy}`)
    } else {
      push('env', false, '系统代理未启用，也没有 ~/.codex/.env')
    }
  } catch (error) {
    push('env', false, message(error))
  }

  // 4) codex.js 镜像补丁（v4：过程由 DSH 面板显示，不再自动弹独立窗口）
  try {
    const state = wrapperState()
    if (state.v2 && state.upToDate) {
      push('mirror', true, '已带当前补丁：过程写进运行目录的 codex-raw.log，由 DSH 面板实时显示')
    } else if (!existsSync(WRAPPER)) {
      push('mirror', false, '找不到 codex.js')
    } else if (state.v2 && !state.upToDate) {
      /* 补丁版本旧或日志路径属于别的机器/旧目录：从历史备份找原始 codex.js 内容，按当前路径重打。
         全程不在目标文件上做半成品写入：备份成功后才用原子替换一次性换成新补丁。 */
      const original = latestWrapperBackup(state.text)
      if (!original) {
        /* 按 status 页同样的规则说明真实原因，不再一律说"路径不一致"。 */
        const reason = !state.pathKnown
          ? `codex.js 补丁为 ${state.patchVersion || '旧版本'}，但读不出日志路径`
          : state.livePath !== join(RUNS_DIR, 'codex-raw.log')
            ? `codex.js 补丁为 ${state.patchVersion || '旧版本'}，日志路径 ${state.livePath || '旧路径'} 与当前运行目录 ${RUNS_DIR} 不一致`
            : `codex.js 补丁为 ${state.patchVersion || '旧版本'}，日志路径正确但需要升级到 v4`
        push(
          'mirror',
          false,
          `${reason}；没有找到能确认与当前 codex.js 对应的原始备份，无法自动重打（可手动还原 codex.js 后点「一键修复」）`,
        )
      } else {
        const backup = recordBackup(entries, WRAPPER, backupDir, 'codex.js 包装层（重打补丁前）')
        if (!backup) {
          push('mirror', false, '备份当前 codex.js 失败，为安全起见没有重打补丁')
        } else {
          let originalText = ''
          try {
            originalText = readFileSync(original, 'utf8')
          } catch {
            originalText = ''
          }
          const patched = originalText ? patchWrapperText(originalText) : { text: '', action: 'unknown' }
          if (patched.action === 'unknown') {
            push('mirror', false, '备份里的原始 codex.js 结构和预期不一样，没有强行打补丁')
          } else {
            replaceFile(WRAPPER, patched.text)
            push('mirror', true, `已把补丁更新为 v4，日志路径 ${LIVE_LOG}`)
          }
        }
      }
    } else {
      const patched = patchWrapperText(readFileSync(WRAPPER, 'utf8'))
      if (patched.action === 'unknown') {
        push('mirror', false, 'codex.js 的 spawn 代码和预期不一样（可能被别的改动覆盖），没有强行打补丁')
      } else if (patched.action === 'current') {
        push('mirror', true, '已是当前补丁')
      } else {
        const backup = recordBackup(entries, WRAPPER, backupDir, 'codex.js 包装层')
        if (!backup) {
          push('mirror', false, '备份当前 codex.js 失败，为安全起见没有打补丁')
        } else {
          replaceFile(WRAPPER, patched.text)
          push(
            'mirror',
            true,
            patched.action === 'upgraded'
              ? '已把旧补丁升级为 v4（不再自动弹独立窗口）'
              : '已打 v4 补丁（过程写进当前运行目录，DSH 面板实时显示）',
          )
        }
      }
    }
  } catch (error) {
    push('mirror', false, message(error))
  }

  // 5) 备用独立窗口脚本（可选；v2 默认不再弹窗，只有设 DSH_CODEX_OPEN_VIEWER=1 时才用）
  try {
    if (existsSync(VIEWER_PATH)) {
      push('viewer', true, '备用窗口脚本已存在（默认不弹）')
    } else if (!existsSync(VIEWER_TEMPLATE)) {
      push('viewer', false, '插件自带的备用窗口脚本模板缺失')
    } else {
      mkdirSync(dirname(VIEWER_PATH), { recursive: true })
      recordCreate(entries, VIEWER_PATH, '备用窗口脚本')
      copyFileSync(VIEWER_TEMPLATE, VIEWER_PATH)
      push('viewer', true, `已部署备用窗口脚本到 ${VIEWER_PATH}`)
    }
  } catch (error) {
    push('viewer', false, message(error))
  }

  // 顺手建好运行目录，避免首次派活因目录不存在而丢镜像（含自定义日志/脚本路径的父目录）
  try {
    mkdirSync(RUNS_DIR, { recursive: true })
    mkdirSync(dirname(LIVE_LOG), { recursive: true })
    mkdirSync(dirname(VIEWER_PATH), { recursive: true })
  } catch {
    /* 非致命 */
  }

  const manifestPath = writeManifest(backupDir, entries)

  return {
    ok: steps.every((s) => s.ok),
    startedAt,
    finishedAt: new Date().toISOString(),
    backupDir: existsSync(backupDir) ? backupDir : null,
    manifest: manifestPath,
    restorable: Boolean(manifestPath),
    steps,
    status: checkStatus(),
  }
}

/** 启动时自动确保过程镜像补丁 / 沙箱 helper / 代理跟随 / 备用窗口脚本已就位（幂等，失败不影响其它功能）。 */
function ensureRepairApplied() {
  try {
    const state = wrapperState()
    if (state.v2 && state.upToDate) return
    const result = applyAll()
    const summary = (result.steps || [])
      .map((step) => step.id + '=' + (step.ok ? 'ok' : 'fail'))
      .join(', ')
    console.log(TAG + ' 启动自动修复：' + summary)
  } catch (error) {
    console.warn(TAG + ' 启动自动修复失败：' + message(error))
  }
}

/** 把一行原始 JSON-RPC 翻译成面板事件；不认识的行返回 null。 */
function liveEventFromLine(line) {
  let o = null
  try {
    o = JSON.parse(line)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null
  const method = typeof o.method === 'string' ? o.method : ''
  const p = o.params && typeof o.params === 'object' ? o.params : {}
  if (!method) {
    const e = o.error && typeof o.error === 'object' ? o.error : null
    return e && typeof e.message === 'string' ? { kind: 'rpc_error', message: e.message } : null
  }
  switch (method) {
    case 'thread/started': {
      const thread = p.thread && typeof p.thread === 'object' ? p.thread : {}
      return { kind: 'thread', threadId: thread.id ? String(thread.id) : '' }
    }
    case 'turn/started':
      return { kind: 'turn_started' }
    case 'turn/completed': {
      const turn = p.turn && typeof p.turn === 'object' ? p.turn : {}
      const err = turn.error && typeof turn.error === 'object' ? turn.error : null
      return {
        kind: 'turn_done',
        status: turn.status ? String(turn.status) : 'unknown',
        error: err && typeof err.message === 'string' ? err.message : null,
      }
    }
    case 'item/completed': {
      const item = p.item && typeof p.item === 'object' ? p.item : {}
      if (item.type === 'userMessage') {
        const text = Array.isArray(item.content)
          ? item.content
              .filter((c) => c && c.type === 'text')
              .map((c) => String(c.text || ''))
              .join('\n')
          : ''
        return text ? { kind: 'task', text } : null
      }
      if (item.type === 'agentMessage') {
        const text = typeof item.text === 'string' ? item.text : ''
        return text ? { kind: 'answer', phase: item.phase ? String(item.phase) : '', text } : null
      }
      if (item.type === 'commandExecution') {
        let output =
          item.aggregatedOutput === undefined || item.aggregatedOutput === null ? '' : String(item.aggregatedOutput)
        if (output.length > COMMAND_OUTPUT_CAP) output = output.slice(output.length - COMMAND_OUTPUT_CAP)
        return {
          kind: 'command',
          command: String(item.command || ''),
          exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
          output,
        }
      }
      return null
    }
    case 'item/agentMessage/delta':
      return typeof p.delta === 'string' && p.delta.length > 0 ? { kind: 'delta', text: p.delta } : null
    case 'error': {
      const e = p.error && typeof p.error === 'object' ? p.error : {}
      return {
        kind: 'error',
        message: typeof e.message === 'string' ? e.message : 'unknown error',
        retry: Boolean(p.willRetry),
      }
    }
    case 'thread/tokenUsage/updated': {
      const total =
        p.tokenUsage && p.tokenUsage.total && typeof p.tokenUsage.total === 'object' ? p.tokenUsage.total : null
      if (!total) return null
      return {
        kind: 'tokens',
        input: typeof total.inputTokens === 'number' ? total.inputTokens : null,
        cached: typeof total.cachedInputTokens === 'number' ? total.cachedInputTokens : null,
        output: typeof total.outputTokens === 'number' ? total.outputTokens : null,
      }
    }
    case 'account/rateLimits/updated': {
      const rl = p.rateLimits && typeof p.rateLimits === 'object' ? p.rateLimits : null
      if (!rl || !rl.primary || typeof rl.primary !== 'object') return null
      const secondary = rl.secondary && typeof rl.secondary === 'object' ? rl.secondary : null
      return {
        kind: 'rate',
        primary: typeof rl.primary.usedPercent === 'number' ? rl.primary.usedPercent : null,
        secondary: secondary && typeof secondary.usedPercent === 'number' ? secondary.usedPercent : null,
      }
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// 按会话切分实时过程
//
// codex.js 只有一个全局 codex-raw.log，所有会话的 Codex 子代理都往里写。
// 这里在 host 端把全局日志增量拆成「每个 DSH 会话一个文件」：
//   1. 每个 Codex 线程（thread/started 的 threadId）对应一次子代理运行；
//   2. 每次派发在父会话事件流里都有一条 subagent_codex 工具调用，带准确时间；
//   3. 用线程首事件时间与工具调用时间的接近程度把线程归到父会话；
//   4. 解析出的事件 JSON 追加到 codex-raw-<父会话 id>.log。
// 面板用 ?session= 读写自己那份文件；「清空」只推进该文件的字节基线，因此持久有效。
// ---------------------------------------------------------------------------

const liveSync = {
  offset: 0,
  threadOwner: {},
  claimedCalls: {},
  pendingThreads: {},
  logGeneration: '',
  logBirthtimeMs: 0,
  offsetFingerprint: '',
  committedSeqs: {},
  pendingReset: false,
  busy: false,
  loaded: false,
}

/**
 * 从原始 Buffer 中切出完整行：
 * - 行边界按原始字节（0x0a）定位，nextCursor 与每行 startByte 都是字节位置；
 * - 只对已确定字节边界的行解码，避免非法 UTF-8 导致的替换字符改变字节长度；
 * - 起点不在行首时丢弃首个不完整行。
 */
function completeLinesFrom(buffer, read, start, skipPartial) {
  let offset = 0
  if (skipPartial && start > 0) {
    const nl = buffer.subarray(0, read).indexOf(0x0a)
    if (nl < 0) return { text: '', lines: [], nextCursor: start }
    offset = nl + 1
  }
  const view = buffer.subarray(offset, read)
  const lastNl = view.lastIndexOf(0x0a)
  if (lastNl < 0) return { text: '', lines: [], nextCursor: start + offset }
  const completeBytes = view.subarray(0, lastNl + 1)
  const baseCursor = start + offset
  const lines = []
  let from = 0
  for (let i = 0; i < completeBytes.length; i += 1) {
    if (completeBytes[i] === 0x0a) {
      lines.push({ text: completeBytes.toString('utf8', from, i), startByte: baseCursor + from })
      from = i + 1
    }
  }
  return { text: completeBytes.toString('utf8'), lines, nextCursor: baseCursor + lastNl + 1 }
}

/**
 * 判断某个字节偏移是否落在行首：返回 { ok: true, atLineStart }；
 * ok=false 表示探测读取失败（调用方必须按「无法确认」处理，不能当作「位于行中」）。
 */
function isLineStart(fd, offset) {
  if (offset <= 0) return { ok: true, atLineStart: true }
  const probe = Buffer.alloc(1)
  try {
    if (readSync(fd, probe, 0, 1, offset - 1) !== 1) return { ok: false, atLineStart: false }
  } catch {
    return { ok: false, atLineStart: false }
  }
  return { ok: true, atLineStart: probe[0] === 0x0a }
}

/** 对一段字节计算 sha1 指纹（用于证明读取过的区间内容未被改写）。 */
function hashBytes(buffer) {
  try {
    return createHash('sha1').update(buffer).digest('hex')
  } catch {
    return ''
  }
}

/**
 * 读取 offset 前最多 64 字节的 sha1 指纹：日志截断/替换后 offset 附近内容变化可检出。
 * 返回 '' 表示 offset 为 0；返回 null 表示读取失败（调用方必须按「无法确认」处理，不能当不匹配）。
 */
function fingerprintAt(file, offset) {
  try {
    if (offset <= 0) return ''
    const start = Math.max(0, offset - 64)
    const length = offset - start
    if (length <= 0) return ''
    const buffer = Buffer.alloc(length)
    const fd = openSync(file, 'r')
    let read = 0
    try {
      while (read < length) {
        const n = readSync(fd, buffer, read, length - read, start + read)
        if (n <= 0) break
        read += n
      }
    } finally {
      closeSync(fd)
    }
    /* 短读（文件在区间内提前结束）不能作为完整指纹证据。 */
    if (read !== length) return null
    return createHash('sha1').update(buffer.subarray(0, read)).digest('hex')
  } catch {
    return null
  }
}

/** 跨实例同步锁：同一时刻只允许一个 writer 推进共享 offset 与会话文件。 */
/** 通用文件锁（令牌 + 陈旧锁清理；遇到活锁立即返回 null，不排队等待），返回释放函数。 */
function acquireFileLock(lockFile) {
  try {
    mkdirSync(dirname(lockFile), { recursive: true })
  } catch {
    /* 父目录创建失败时仍尝试直接获取锁 */
  }
  const token = String(process.pid) + '-' + Math.random().toString(36).slice(2)
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockFile, 'wx')
      try {
        writeSync(fd, token)
      } catch {
        /* 锁内容非必需 */
      }
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
      return () => {
        try {
          if (readFileSync(lockFile, 'utf8') === token) unlinkSync(lockFile)
        } catch {
          /* 锁可能已清理 */
        }
      }
    } catch {
      try {
        const st = statSync(lockFile)
        let stale = Date.now() - st.mtimeMs > 180000
        try {
          const content = String(readFileSync(lockFile, 'utf8') || '')
          const pid = Number(content.split('-')[0])
          if (Number.isFinite(pid) && pid > 0) {
            try {
              process.kill(pid, 0)
              /* 持有者进程仍存活：不按时间误删活锁。 */
              stale = false
            } catch {
              stale = true
            }
          }
        } catch {
          /* 读不到锁内容时按时间阈值判断 */
        }
        if (stale) {
          try {
            unlinkSync(lockFile)
          } catch {
            /* ignore */
          }
          continue
        }
      } catch {
        continue
      }
      return null
    }
  }
  return null
}

function acquireLiveSyncLock() {
  /* 与其它维护操作共用同一锁实现：进程存活检查 + 180 秒兜底，避免误删长任务活锁。 */
  return acquireFileLock(LIVE_SYNC_FILE + '.lock')
}

function readJsonSafe(file, fallback) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return value && typeof value === 'object' ? value : fallback
  } catch {
    return fallback
  }
}

function writeJsonSafe(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(value), 'utf8')
  } catch {
    /* 缓存写失败不影响实时显示 */
  }
}

function loadLiveSync(force) {
  if (liveSync.loaded && force !== true) return
  liveSync.loaded = true
  /* 强制重载时先重置为默认状态，避免实例残留旧值写回（文件缺失/损坏同样回到默认）。 */
  if (force === true) {
    liveSync.offset = 0
    liveSync.threadOwner = {}
    liveSync.claimedCalls = {}
    liveSync.pendingThreads = {}
    liveSync.logGeneration = ''
    liveSync.logBirthtimeMs = 0
    liveSync.offsetFingerprint = ''
    liveSync.committedSeqs = {}
    liveSync.pendingReset = false
  }
  const saved = readJsonSafe(LIVE_SYNC_FILE, null)
  if (saved === null) return
  if (Number.isFinite(Number(saved.offset)) && Number(saved.offset) >= 0) {
    liveSync.offset = Math.floor(Number(saved.offset))
  }
  if (saved.threadOwner && typeof saved.threadOwner === 'object') liveSync.threadOwner = saved.threadOwner
  if (saved.claimedCalls && typeof saved.claimedCalls === 'object') liveSync.claimedCalls = saved.claimedCalls
  if (saved.pendingThreads && typeof saved.pendingThreads === 'object') liveSync.pendingThreads = saved.pendingThreads
  if (typeof saved.logGeneration === 'string') liveSync.logGeneration = saved.logGeneration
  if (Number.isFinite(Number(saved.logBirthtimeMs))) liveSync.logBirthtimeMs = Number(saved.logBirthtimeMs)
  if (typeof saved.offsetFingerprint === 'string') liveSync.offsetFingerprint = saved.offsetFingerprint
  if (saved.committedSeqs && typeof saved.committedSeqs === 'object') liveSync.committedSeqs = saved.committedSeqs
  /* 强制重载时以磁盘状态为准（含 false），避免旧实例残留 true 再写回。 */
  liveSync.pendingReset = saved.pendingReset === true
}

function saveLiveSync() {
  const payload = JSON.stringify({
    offset: liveSync.offset,
    threadOwner: liveSync.threadOwner,
    claimedCalls: liveSync.claimedCalls,
    pendingThreads: liveSync.pendingThreads,
    logGeneration: liveSync.logGeneration,
    logBirthtimeMs: liveSync.logBirthtimeMs,
    offsetFingerprint: liveSync.offsetFingerprint,
    committedSeqs: liveSync.committedSeqs,
    pendingReset: liveSync.pendingReset,
  })
  const tmp = LIVE_SYNC_FILE + '.tmp-' + process.pid + '-' + Date.now()
  writeFileSync(tmp, payload, 'utf8')
  renameSync(tmp, LIVE_SYNC_FILE)
}

function loadClearState() {
  return readJsonSafe(LIVE_CLEAR_FILE, {})
}

function saveClearState(state) {
  writeJsonSafe(LIVE_CLEAR_FILE, state)
}

function sanitizeSessionId(id) {
  return String(id || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'unknown'
}

function sessionLogPath(sessionId) {
  return join(LIVE_SESSIONS_DIR, `codex-raw-${sanitizeSessionId(sessionId)}.log`)
}

/**
 * 从会话文件尾部往前解压最近若干帧。
 * 派发时的 tool/call 事件就在文件末尾附近，没必要全量解压几 MB 历史。
 */
async function decodeSessionTail(file, maxFrames = 900, maxBytes = 1024 * 1024) {
  let zlib = undefined
  try {
    zlib = await import('node:zlib')
  } catch {
    return ''
  }
  if (typeof zlib.zstdDecompressSync !== 'function') return ''
  let buffer = null
  try {
    const stat = statSync(file)
    if (stat.size > 24 * 1024 * 1024) return ''
    buffer = readFileSync(file)
  } catch {
    return ''
  }
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const positions = []
  let index = 0
  while (true) {
    index = buffer.indexOf(magic, index)
    if (index < 0) break
    positions.push(index)
    index += 4
  }
  if (positions.length === 0) return ''
  const parts = []
  let decoded = 0
  for (let i = positions.length - 1; i >= 0; i--) {
    if (positions.length - i > maxFrames || decoded > maxBytes) break
    const start = positions[i]
    const end = i + 1 < positions.length ? positions[i + 1] : buffer.length
    try {
      const chunk = zlib.zstdDecompressSync(buffer.subarray(start, end))
      parts.push(chunk.toString('utf8'))
      decoded += chunk.length
    } catch {
      /* 帧边界误判时跳过 */
    }
  }
  parts.reverse()
  return parts.join('')
}

/** 最近 8 小时改动过的会话文件（sessionId + 文件路径），缓存 60 秒。 */
const sessionFileCache = { at: 0, files: [] }

function listRecentSessionFiles() {
  const now = Date.now()
  if (now - sessionFileCache.at < 60 * 1000) return sessionFileCache.files
  const root = join(DSH_HOME, 'sessions')
  const files = []
  let workspaces = []
  try {
    workspaces = readdirSync(root)
  } catch {
    sessionFileCache.at = now
    return sessionFileCache.files
  }
  for (const workspace of workspaces) {
    const workspaceDir = join(root, workspace)
    let entries = []
    try {
      entries = readdirSync(workspaceDir)
    } catch {
      continue
    }
    for (const name of entries) {
      const dir = join(workspaceDir, name)
      let candidates = []
      try {
        candidates = readdirSync(dir).filter((entry) => entry.endsWith('.zstd'))
      } catch {
        continue
      }
      if (candidates.length === 0) continue
      const file = join(dir, candidates[0])
      let stat = null
      try {
        stat = statSync(file)
      } catch {
        continue
      }
      if (now - stat.mtimeMs > 8 * 3600 * 1000) continue
      files.push({ sessionId: name, file, mtimeMs: stat.mtimeMs })
    }
  }
  sessionFileCache.files = files
  sessionFileCache.at = now
  return files
}

/** 解析一个会话文件里的 subagent 工具调用（按文件 mtime 缓存）。 */
const sessionCallCache = new Map()

async function readSessionSubagentCalls(entry) {
  const cached = sessionCallCache.get(entry.file)
  if (cached !== undefined && cached.mtimeMs === entry.mtimeMs) return cached.calls
  const text = await decodeSessionTail(entry.file)
  const calls = []
  if (text) {
    for (const line of text.split('\n')) {
      if (!line.includes('tool/call')) continue
      let parsed = null
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (!parsed || parsed.type !== 'tool/call') continue
      const data = parsed.data && typeof parsed.data === 'object' ? parsed.data : {}
      if (String(data.name || '') !== 'subagent_codex') continue
      const time = Number(parsed.time)
      if (!Number.isFinite(time)) continue
      calls.push({ time, sessionId: entry.sessionId })
    }
  }
  if (sessionCallCache.size > 400) sessionCallCache.clear()
  sessionCallCache.set(entry.file, { mtimeMs: entry.mtimeMs, calls })
  return calls
}

/**
 * 把新出现的 Codex 线程归到发起派发的 DSH 会话。
 * 找不到候选或候选过近时返回 unattributed，不写死归属（后续轮次会重试）。
 */
async function attributeThread(threadId, startedAt) {
  const known = liveSync.threadOwner[threadId]
  if (typeof known === 'string' && known.length > 0) return known
  const candidates = []
  for (const entry of listRecentSessionFiles()) {
    /* 派发时 tool/call 会立即刷新会话文件 mtime，所以只看线程时间附近半小时的文件。 */
    if (Math.abs(entry.mtimeMs - startedAt) > 30 * 60 * 1000) continue
    const calls = await readSessionSubagentCalls(entry)
    for (const call of calls) {
      const delta = Math.abs(call.time - startedAt)
      if (delta > SESSION_MATCH_WINDOW_MS) continue
      const key = `${call.sessionId}@${call.time}`
      if (liveSync.claimedCalls[key]) continue
      candidates.push({ delta, sessionId: call.sessionId, key })
    }
  }
  candidates.sort((left, right) => left.delta - right.delta)
  if (candidates.length === 0) return 'unattributed'
  /* 两个派发时间几乎相同（10 秒内）时无法可靠区分，保持待确认等后续轮次重试。 */
  const ambiguous = candidates.length > 1 && candidates[1].delta - candidates[0].delta < 10 * 1000
  if (ambiguous) {
    console.warn(TAG + ' thread ' + threadId + ' 归属待确认：' + candidates.length + ' 个候选时间过于接近')
    return 'unattributed'
  }
  liveSync.threadOwner[threadId] = candidates[0].sessionId
  liveSync.claimedCalls[candidates[0].key] = threadId
  return candidates[0].sessionId
}

/** 读取会话日志尾部，返回已出现过的 seq 集合（用于重试时幂等去重）。 */
function readRecentSeqs(file, maxBytes = 16 * 1024 * 1024) {
  try {
    const st = statSync(file)
    const start = Math.max(0, st.size - maxBytes)
    const length = st.size - start
    if (length <= 0) return new Set()
    const buffer = Buffer.alloc(length)
    const fd = openSync(file, 'r')
    let read = 0
    try {
      while (read < length) {
        const n = readSync(fd, buffer, read, length - read, start + read)
        if (n <= 0) break
        read += n
      }
    } finally {
      closeSync(fd)
    }
    const text = buffer.toString('utf8', 0, read)
    const seqs = new Set()
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && parsed.seq !== undefined && parsed.seq !== null) seqs.add(String(parsed.seq))
      } catch {
        /* 跳过非 JSON 行 */
      }
    }
    return seqs
  } catch (error) {
    /* 文件不存在视为空集合；其他读取错误必须向上抛出，不能当作空文件导致重复追加。 */
    if (error && error.code === 'ENOENT') return new Set()
    throw error
  }
}

/** 修复会话日志尾部残行（崩溃遗留半行）：截断到最后完整换行，避免后续追加拼成非法 JSON。 */
function repairSessionTail(file) {
  try {
    const st = statSync(file)
    if (st.size === 0) return
    const chunkSize = Math.min(st.size, 64 * 1024)
    const info = readFileRangeBufferInfo(file, st.size - chunkSize, chunkSize)
    const buf = info.buffer
    if (buf.length === 0 || buf[buf.length - 1] === 0x0a) return
    const lastNl = buf.lastIndexOf(0x0a)
    const base = st.size - buf.length
    const cut = base + (lastNl < 0 ? 0 : lastNl + 1)
    truncateSync(file, cut)
    console.warn(TAG + ' 修复会话日志尾部残行：截断到 ' + cut + ' 字节')
  } catch {
    /* 修复失败不阻断追加 */
  }
}

/** 幂等追加：跳过目标文件尾部已存在的 seq 与调用方已知的 committed seq，避免同步重试把同一事件写入两次。 */
function appendUniqueLines(file, lines, knownSeqs) {
  if (!Array.isArray(lines) || lines.length === 0) return 0
  /* 先修复可能的残行（崩溃遗留）：否则新行会拼在残行后面变成非法 JSON。 */
  repairSessionTail(file)
  const recentSeqs = readRecentSeqs(file)
  const known = knownSeqs instanceof Set ? knownSeqs : new Set()
  const missing = lines.filter((line) => {
    try {
      const parsed = JSON.parse(line)
      if (!parsed || parsed.seq === undefined || parsed.seq === null) return true
      const key = String(parsed.seq)
      return !(recentSeqs.has(key) || known.has(key))
    } catch {
      return true
    }
  })
  if (missing.length === 0) return 0
  mkdirSync(LIVE_SESSIONS_DIR, { recursive: true })
  appendFileSync(file, `${missing.join('\n')}\n`, 'utf8')
  return missing.length
}

/** 读取某文件指定区间：返回 { buffer, complete }；complete=false 表示短读（不能作为完整内容证据）。 */
function readFileRangeBufferInfo(file, start, length) {
  if (length <= 0) return { buffer: Buffer.alloc(0), complete: true }
  const buffer = Buffer.alloc(length)
  const fd = openSync(file, 'r')
  let read = 0
  try {
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, start + read)
      if (n <= 0) break
      read += n
    }
  } finally {
    closeSync(fd)
  }
  return { buffer: buffer.subarray(0, read), complete: read === length }
}

/** 读取某文件指定区间，返回实际读到的原始字节（内容校验必须对原始字节哈希，不能先解码）。 */
function readFileRangeBuffer(file, start, length) {
  return readFileRangeBufferInfo(file, start, length).buffer
}

/** 读取某文件的指定区间内容（文本用途；内容校验请用 readFileRangeBufferInfo）。 */
function readFileRange(file, start, length) {
  return readFileRangeBuffer(file, start, length).toString('utf8')
}

/** 读取未完成的同步批次。 */
function loadPendingBatch() {
  return readJsonSafe(LIVE_BATCH_FILE, null)
}

/** 原子保存同步批次。 */
function savePendingBatch(batch) {
  const tmp = LIVE_BATCH_FILE + '.tmp-' + process.pid + '-' + Date.now()
  writeFileSync(tmp, JSON.stringify(batch), 'utf8')
  renameSync(tmp, LIVE_BATCH_FILE)
}

/** 清理已完成的批次文件。 */
function clearPendingBatch() {
  try {
    if (existsSync(LIVE_BATCH_FILE)) unlinkSync(LIVE_BATCH_FILE)
  } catch {
    /* ignore */
  }
}

/** 从批次条目中解析 seq 列表。 */
function batchEntrySeqs(entry) {
  if (!entry || !Array.isArray(entry.lines)) return []
  const seqs = []
  for (const line of entry.lines) {
    try {
      const parsed = JSON.parse(line)
      if (parsed && parsed.seq !== undefined && parsed.seq !== null) seqs.push(String(parsed.seq))
    } catch {
      /* ignore */
    }
  }
  return seqs
}

/**
 * 恢复未完成的同步批次：按会话确认是否已写入（文件从 startSize 起已含本批全部 seq），
 * 未写入的重新追加；全部完成后清理批次文件。
 */
function retryPendingBatch() {
  const batch = loadPendingBatch()
  if (!batch || !batch.sessions || typeof batch.sessions !== 'object') {
    /* 无批次视为已恢复。 */
    return true
  }
  for (const [sessionId, entry] of Object.entries(batch.sessions)) {
    if (!entry || !Array.isArray(entry.lines) || entry.lines.length === 0 || entry.written) continue
    const file = sessionLogPath(sessionId)
    const expected = batchEntrySeqs(entry)
    if (expected.length > 0 && Number.isFinite(Number(entry.startSize))) {
      try {
        const st = statSync(file)
        if (st.size > Number(entry.startSize)) {
          const added = readFileRange(
            file,
            Number(entry.startSize),
            Math.min(st.size - Number(entry.startSize), 64 * 1024 * 1024),
          )
          const present = new Set()
          for (const line of added.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed) continue
            try {
              const parsed = JSON.parse(trimmed)
              if (parsed && parsed.seq !== undefined && parsed.seq !== null) present.add(String(parsed.seq))
            } catch {
              /* ignore */
            }
          }
          if (expected.every((seq) => present.has(seq))) {
            entry.written = true
            savePendingBatch(batch)
            continue
          }
        }
      } catch {
        /* 无法确认时退回 appendUniqueLines 去重 */
      }
    }
    try {
      appendUniqueLines(file, entry.lines)
      entry.written = true
      savePendingBatch(batch)
    } catch (error) {
      console.warn(TAG + ' 恢复未完成同步批次失败：' + message(error))
      return false
    }
  }
  /* 所有写入已确认：先恢复批次携带的归属/待归属状态，再按目标同步状态原子提交。 */
  if (batch.state && typeof batch.state === 'object') {
    if (batch.state.pendingThreads && typeof batch.state.pendingThreads === 'object') {
      liveSync.pendingThreads = batch.state.pendingThreads
    }
    if (batch.state.threadOwner && typeof batch.state.threadOwner === 'object') {
      liveSync.threadOwner = batch.state.threadOwner
    }
    if (batch.state.claimedCalls && typeof batch.state.claimedCalls === 'object') {
      liveSync.claimedCalls = batch.state.claimedCalls
    }
    if (batch.state.pendingReset === true) liveSync.pendingReset = true
  }
  if (Array.isArray(batch.pendingThreadIds)) {
    for (const threadId of batch.pendingThreadIds) delete liveSync.pendingThreads[threadId]
  }
  const target = batch.target && typeof batch.target === 'object' ? batch.target : null
  if (target && Number.isFinite(Number(target.nextCursor)) && Number(target.nextCursor) >= 0) {
    const sameGeneration = target.generation === liveSync.logGeneration
    let currentStat = null
    try {
      currentStat = statSync(LIVE_LOG)
    } catch {
      currentStat = null
    }
    /* 内容证据：重新读取批次记录的原区间（原始字节），比较读取时算出的 sha1（证明切片未被改写）。 */
    const hasContentEvidence =
      Number.isFinite(Number(target.startCursor)) &&
      Number.isFinite(Number(target.readLength)) &&
      typeof target.readHash === 'string' &&
      target.readHash !== ''
    let contentSame = false
    let contentReadable = true
    let contentError = null
    if (hasContentEvidence) {
      try {
        const rangeInfo = readFileRangeBufferInfo(LIVE_LOG, Number(target.startCursor), Number(target.readLength))
        /* 短读不能作为完整内容证据：视为内容已变化。 */
        contentSame = rangeInfo.complete && hashBytes(rangeInfo.buffer) === target.readHash
      } catch (error) {
        contentReadable = false
        contentError = error
      }
    } else {
      contentSame = sameGeneration
    }
    const birthOk =
      Number(target.readBirthtime) === 0 ||
      currentStat === null ||
      Math.abs(Number(currentStat.birthtimeMs) - Number(target.readBirthtime)) <= 1
    const fingerprint = typeof target.fingerprint === 'string' ? target.fingerprint : ''
    const currentFingerprint = fingerprintAt(LIVE_LOG, Number(target.nextCursor))
    if (fingerprint !== null && fingerprint !== '' && currentFingerprint === null) {
      /* 指纹读取失败：已确认截断（当前大小 < 目标游标）则按换代继续，否则保留批次重试。 */
      const definitelyTruncated = currentStat !== null && currentStat.size < Number(target.nextCursor)
      if (!definitelyTruncated) return false
    }
    const identityOk =
      sameGeneration &&
      contentSame &&
      currentStat !== null &&
      Number(currentStat.size) >= Number(target.nextCursor) &&
      birthOk &&
      (fingerprint === null || fingerprint === '' || currentFingerprint === fingerprint)
    if (identityOk) {
      /* 必须先取得新游标的完整指纹：读不到就不推进游标、保留批次，下一轮重试。 */
      const restoredFingerprint =
        fingerprint === null || fingerprint === '' ? fingerprintAt(LIVE_LOG, Number(target.nextCursor)) : fingerprint
      if (restoredFingerprint === null) return false
      liveSync.offset = Number(target.nextCursor)
      liveSync.offsetFingerprint = restoredFingerprint
      liveSync.committedSeqs = {}
      saveLiveSync()
    } else if (!contentReadable) {
      if (contentError !== null && contentError.code === 'ENOENT') {
        /* 日志缺失：确认换代，等待重建后从头读。 */
        liveSync.logGeneration = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
        liveSync.logBirthtimeMs = 0
        liveSync.offset = 0
        liveSync.pendingReset = true
        liveSync.offsetFingerprint = ''
        saveLiveSync()
      } else {
        /* 暂时不可读（权限/临时 I/O）：保留批次，下一轮重试。 */
        return false
      }
    } else {
      /* 内容/世代/大小任一变化：确认换代，持久化新世代后从零读取（旧事件 seq 带旧世代，不会重复）。 */
      liveSync.logGeneration = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
      liveSync.logBirthtimeMs = currentStat ? Number(currentStat.birthtimeMs) || 0 : 0
      liveSync.offset = 0
      liveSync.pendingReset = true
      liveSync.offsetFingerprint = ''
      saveLiveSync()
    }
  } else {
    /* 补写批次没有目标游标：归属状态与 pending 删除已在上方恢复，持久化后清理。 */
    saveLiveSync()
  }
  clearPendingBatch()
  return !existsSync(LIVE_BATCH_FILE)
}

/** 补写 pending 事件：先持久化批次（含待删除的 pending 线程），写入后清理（崩溃后可恢复）。 */
function appendPendingEvents(sessionId, events, threadId) {
  if (!Array.isArray(events) || events.length === 0) return
  /* 存在未完成的旧批次时不得覆盖：让调用方保留 pending 等下一轮。 */
  if (existsSync(LIVE_BATCH_FILE)) throw new Error('存在未完成的同步批次，暂缓补写')
  const file = sessionLogPath(sessionId)
  let startSize = 0
  try {
    startSize = statSync(file).size
  } catch {
    startSize = 0
  }
  savePendingBatch({
    at: Date.now(),
    pendingThreadIds: typeof threadId === 'string' && threadId ? [threadId] : [],
    /* 归属状态随补写一起提交：恢复时先还原，避免重复归属或丢归属。 */
    state: {
      threadOwner: Object.assign({}, liveSync.threadOwner),
      claimedCalls: Object.assign({}, liveSync.claimedCalls),
    },
    sessions: { [sessionId]: { lines: events, written: false, startSize } },
  })
  appendUniqueLines(file, events)
  /* 批次保留到调用方完成「删除 pending + 保存状态」；调用方成功后清理。 */
}

/** 重试待归属线程：拿到调用记录后把暂存事件补写到正确会话；超时 10 分钟归 unattributed。 */
async function retryPendingThreads() {
  const now = Date.now()
  let changed = false
  for (const [threadId, pending] of Object.entries(liveSync.pendingThreads)) {
    const startedAt = Number(pending.startedAt) || now
    const events = Array.isArray(pending.events) ? pending.events : []
    if (now - startedAt > 10 * 60 * 1000) {
      /* 超时后仍先尝试可靠归属；无法归属才写 unattributed。 */
      const lateOwner = await attributeThread(threadId, startedAt)
      try {
        appendPendingEvents(lateOwner !== 'unattributed' ? lateOwner : 'unattributed', events, threadId)
      } catch (error) {
        console.warn(TAG + ' 补写超时事件失败，保留待下轮重试：' + message(error))
        continue
      }
      delete liveSync.pendingThreads[threadId]
      saveLiveSync()
      clearPendingBatch()
      changed = true
      continue
    }
    const owner = await attributeThread(threadId, startedAt)
    if (owner !== 'unattributed') {
      try {
        appendPendingEvents(owner, events, threadId)
      } catch (error) {
        console.warn(TAG + ' 补写归属事件失败，保留待下轮重试：' + message(error))
        continue
      }
      delete liveSync.pendingThreads[threadId]
      saveLiveSync()
      clearPendingBatch()
      changed = true
    }
  }
  /* pending/归属/claimed 变化必须落盘，否则下一轮会从磁盘恢复旧 pending 重复补写。 */
  if (changed) saveLiveSync()
}

/** 增量解析全局镜像日志，把事件按会话追加到各自文件。 */
async function syncLiveLogs() {
  if (liveSync.busy) return
  const releaseLock = acquireLiveSyncLock()
  if (releaseLock === null) return
  liveSync.busy = true
  try {
    /* 每次都重新读取共享同步状态：另一个实例/进程可能已推进 offset。 */
    liveSync.loaded = false
    loadLiveSync(true)
    /* 先恢复上次未完成的写入批次；未恢复成功则中止本轮，避免覆盖旧批次。 */
    if (!retryPendingBatch()) return
    let stat = null
    try {
      stat = statSync(LIVE_LOG)
    } catch {
      await retryPendingThreads()
      return
    }
    if (!stat.isFile() || stat.size === 0) {
      await retryPendingThreads()
      return
    }
    /* 日志世代：截断、替换或 offset 附近内容变化时生成新世代并重置读取位置，避免漏读/seq 复用。 */
    const birthtime = Number(stat.birthtimeMs) || 0
    const truncated = liveSync.offset > stat.size
    const replaced =
      liveSync.logBirthtimeMs > 0 && birthtime > 0 && Math.abs(birthtime - liveSync.logBirthtimeMs) > 1
    const currentOffsetFingerprint = fingerprintAt(LIVE_LOG, liveSync.offset)
    if (liveSync.offsetFingerprint && currentOffsetFingerprint === null && !truncated && !replaced) {
      /* 指纹读取失败且未确认截断/替换：保留游标与旧证据，下一轮重试。 */
      await retryPendingThreads()
      return
    }
    const fingerprintBroken = Boolean(
      !truncated &&
        !replaced &&
        liveSync.offsetFingerprint &&
        currentOffsetFingerprint !== null &&
        currentOffsetFingerprint !== liveSync.offsetFingerprint,
    )
    if (!liveSync.logGeneration || truncated || replaced || fingerprintBroken) {
      liveSync.logGeneration = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
      liveSync.logBirthtimeMs = birthtime
      if (truncated || replaced || fingerprintBroken) {
        liveSync.offset = 0
        /* 世代重置：新日志从头顺序读取（不应用首次启用的尾部回溯），避免漏掉开头事件。 */
        liveSync.pendingReset = true
      }
      liveSync.offsetFingerprint = ''
      saveLiveSync()
    }
    if (liveSync.offset > stat.size) liveSync.offset = 0
    if (liveSync.offset === 0 && !liveSync.pendingReset) {
      /* 首次启用：只回溯最近一段；积压超过上限时按 8MB 分批处理，不跳过。 */
      liveSync.offset = Math.max(0, stat.size - LIVE_BOOTSTRAP_BYTES)
    }
    if (stat.size <= liveSync.offset) {
      if (liveSync.pendingReset) {
        liveSync.pendingReset = false
        saveLiveSync()
      }
      await retryPendingThreads()
      return
    }
    const start = liveSync.offset
    /* 积压时按 8MB 分批顺序处理，不跳过积压内容。 */
    const length = Math.min(stat.size - start, 8 * 1024 * 1024)
    const buffer = Buffer.alloc(length)
    const fd = openSync(LIVE_LOG, 'r')
    let read = 0
    try {
      while (read < length) {
        const n = readSync(fd, buffer, read, length - read, start + read)
        if (n <= 0) break
        read += n
      }
    } finally {
      closeSync(fd)
    }
    /* 记录实际读取区间的 sha1：提交/恢复时用它证明这份切片内容未被改写。 */
    const readHash = hashBytes(buffer.subarray(0, read))
    let lineStart = true
    if (start > 0) {
      let probeFd = null
      try {
        probeFd = openSync(LIVE_LOG, 'r')
        const probe = isLineStart(probeFd, start)
        if (!probe.ok) {
          /* 行首探测失败：保留游标中止本轮，不能把「无法确认」当作「位于行中」丢弃首行。 */
          await retryPendingThreads()
          return
        }
        lineStart = probe.atLineStart
      } catch {
        await retryPendingThreads()
        return
      } finally {
        if (probeFd !== null) {
          try {
            closeSync(probeFd)
          } catch {
            /* ignore */
          }
        }
      }
    }
    const slice = completeLinesFrom(buffer, read, start, !lineStart)
    const lines = slice.lines
    /* 先重试待归属线程：即使本轮没有新日志，也要让 pending 事件有机会归属。 */
    await retryPendingThreads()
    if (lines.length === 0 && slice.nextCursor === start) {
      /* 超长单行（读取已到上限仍无换行）：跳过该行避免反复读取；否则等下一轮。 */
      if (read >= 8 * 1024 * 1024) {
        liveSync.offset = start + read
        const skipFingerprint = fingerprintAt(LIVE_LOG, liveSync.offset)
        if (skipFingerprint !== null) liveSync.offsetFingerprint = skipFingerprint
        saveLiveSync()
        console.warn(TAG + ' 镜像日志存在超过读取上限的单行，已跳过')
      }
      return
    }
    const perSession = new Map()
    const appendLine = (sessionId, line) => {
      if (!perSession.has(sessionId)) perSession.set(sessionId, [])
      perSession.get(sessionId).push(line)
    }
    for (const lineEntry of lines) {
      const lineOffset = lineEntry.startByte
      const line = lineEntry.text.trim()
      if (!line) continue
      const event = liveEventFromLine(line)
      if (event === null) continue
      let parsed = null
      try {
        parsed = JSON.parse(line)
      } catch {
        parsed = null
      }
      let threadId = ''
      let emittedAt = 0
      if (parsed && typeof parsed === 'object') {
        const params = parsed.params && typeof parsed.params === 'object' ? parsed.params : null
        if (params && typeof params.threadId === 'string') threadId = params.threadId
        else if (params && params.thread && typeof params.thread.id === 'string') threadId = params.thread.id
        else if (typeof parsed.threadId === 'string') threadId = parsed.threadId
        if (typeof parsed.emittedAtMs === 'number' && parsed.emittedAtMs > 0) emittedAt = parsed.emittedAtMs
      }
      const t = emittedAt || Date.now()
      const record = Object.assign({ t, seq: `${String(liveSync.logGeneration || 'g')}:${lineOffset}` }, event)
      if (threadId) record.threadId = threadId
      const lineJson = JSON.stringify(record)
      if (!threadId) {
        /* 没有线程标识的事件不猜归属，放进 unattributed（不显示）。 */
        appendLine('unattributed', lineJson)
        continue
      }
      const owner = await attributeThread(threadId, t)
      if (owner === 'unattributed') {
        if (!liveSync.pendingThreads[threadId]) liveSync.pendingThreads[threadId] = { startedAt: t, events: [] }
        liveSync.pendingThreads[threadId].events.push(lineJson)
        continue
      }
      appendLine(owner, lineJson)
    }
    if (perSession.size > 0) {
      /* 旧批次未清理时绝不覆盖：先恢复旧批次。 */
      if (existsSync(LIVE_BATCH_FILE)) return
      /* 持久化本批（目标会话 + 内容 + 起始大小），逐会话写入并更新进度；崩溃后 retryPendingBatch 恢复。 */
      const batch = {
        at: Date.now(),
        target: {
          generation: liveSync.logGeneration,
          nextCursor: slice.nextCursor,
          startCursor: start,
          readLength: read,
          readHash,
          size: stat.size,
          readBirthtime: stat.birthtimeMs,
          fingerprint: fingerprintAt(LIVE_LOG, slice.nextCursor),
        },
        /* 同批可能新增归属/待归属状态：快照随游标一起提交，避免恢复时丢事件。 */
        state: {
          pendingThreads: JSON.parse(JSON.stringify(liveSync.pendingThreads)),
          threadOwner: Object.assign({}, liveSync.threadOwner),
          claimedCalls: Object.assign({}, liveSync.claimedCalls),
          pendingReset: liveSync.pendingReset,
        },
        sessions: {},
      }
      for (const [sessionId, lines] of perSession) {
        let startSize = 0
        try {
          startSize = statSync(sessionLogPath(sessionId)).size
        } catch {
          startSize = 0
        }
        batch.sessions[sessionId] = { lines, written: false, startSize }
      }
      savePendingBatch(batch)
      for (const [sessionId, entry] of Object.entries(batch.sessions)) {
        appendUniqueLines(sessionLogPath(sessionId), entry.lines)
        entry.written = true
        savePendingBatch(batch)
      }
    }
    /* 读取/归属期间日志可能被截断或替换：提交前用原始字节核对已读区间。 */
    let currentStat = null
    let statError = null
    try {
      currentStat = statSync(LIVE_LOG)
    } catch (error) {
      currentStat = null
      statError = error
    }
    let contentSame = false
    let recheckError = null
    try {
      const rangeInfo = readFileRangeBufferInfo(LIVE_LOG, start, read)
      contentSame = rangeInfo.complete && hashBytes(rangeInfo.buffer) === readHash
    } catch (error) {
      recheckError = error
    }
    if (statError !== null || recheckError !== null) {
      /* 无法确认（权限/临时 I/O 等）：保留批次与游标，下一轮重试；确认日志缺失才换代。 */
      const missing =
        (statError !== null && statError.code === 'ENOENT') ||
        (recheckError !== null && recheckError.code === 'ENOENT')
      if (!missing) return
      liveSync.logGeneration = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
      liveSync.logBirthtimeMs = 0
      liveSync.offset = 0
      liveSync.pendingReset = true
      liveSync.offsetFingerprint = ''
      liveSync.committedSeqs = {}
      saveLiveSync()
    } else {
      const logChanged =
        currentStat === null ||
        !contentSame ||
        currentStat.size < slice.nextCursor ||
        (Number(currentStat.birthtimeMs) > 0 &&
          Number(stat.birthtimeMs) > 0 &&
          Math.abs(Number(currentStat.birthtimeMs) - Number(stat.birthtimeMs)) > 1)
      if (logChanged) {
        /* 日志已换代：不提交旧游标，按新世代从起点读（已写事件带旧世代 seq，不会重复显示）。 */
        liveSync.logGeneration = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
        liveSync.logBirthtimeMs = currentStat ? Number(currentStat.birthtimeMs) || 0 : 0
        liveSync.offset = 0
        liveSync.pendingReset = true
        liveSync.offsetFingerprint = ''
        liveSync.committedSeqs = {}
        saveLiveSync()
      } else {
        /* 只有会话文件全部写入成功后才推进全局 offset；失败时下一轮重试该批次。 */
        const newOffsetFingerprint = fingerprintAt(LIVE_LOG, slice.nextCursor)
        if (newOffsetFingerprint === null) {
          /* 新游标指纹读取失败：保留旧游标与批次，下一轮恢复。 */
          return
        }
        liveSync.offset = slice.nextCursor
        liveSync.offsetFingerprint = newOffsetFingerprint
        liveSync.committedSeqs = {}
        if (liveSync.pendingReset && liveSync.offset >= stat.size) liveSync.pendingReset = false
        saveLiveSync()
      }
    }
    /* 状态落盘完成后再清理批次：先清理再保存的窗口会让重启重复处理旧游标。 */
    if (perSession.size > 0) clearPendingBatch()
  } catch (error) {
    /* 读取/追加失败：不推进 offset，下一轮重试（appendUniqueLines 保证幂等）。 */
    console.warn(TAG + ' 同步日志失败，保留游标待下轮重试：' + message(error))
  } finally {
    liveSync.busy = false
    releaseLock()
  }
}

/** 读取某个会话的实时过程：cursor 为空时从「清空基线」之后开始。 */
function readSessionSlice(options) {
  const opts = options && typeof options === 'object' ? options : {}
  const sessionId = String(opts.sessionId || '')
  const file = sessionLogPath(sessionId)
  const cleared = Math.max(0, Number(loadClearState()[sessionId]) || 0)
  const base = { path: file, cleared }
  let stat = null
  try {
    stat = statSync(file)
  } catch {
    return Object.assign({ ok: true, exists: false, size: 0, cursor: cleared, reset: true, events: [] }, base)
  }
  if (!stat.isFile()) {
    return Object.assign({ ok: true, exists: false, size: 0, cursor: cleared, reset: true, events: [] }, base)
  }
  const size = stat.size
  const cursor =
    typeof opts.cursor === 'number' && Number.isFinite(opts.cursor) && opts.cursor >= 0 ? Math.floor(opts.cursor) : null
  const floor = Math.min(cleared, size)
  let reset = false
  let start = floor
  if (cursor === null || cursor > size) {
    reset = true
    start = floor
  } else {
    start = Math.max(cursor, floor)
  }
  if (size - start > LIVE_READ_CAP) {
    reset = true
    start = Math.max(floor, size - LIVE_TAIL_BYTES)
  }
  const length = Math.max(0, size - start)
  const buffer = Buffer.alloc(length)
  let fd = null
  let read = 0
  try {
    fd = openSync(file, 'r')
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, start + read)
      if (n <= 0) break
      read += n
    }
  } catch (error) {
    return Object.assign(
      { ok: false, error: message(error), exists: false, size: 0, cursor: cleared, reset: true, events: [] },
      base,
    )
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
  let lineStart = true
  if (start > 0) {
    let probeFd = null
    try {
      probeFd = openSync(file, 'r')
      const probe = isLineStart(probeFd, start)
      if (!probe.ok) {
        return Object.assign(
          { ok: false, error: '无法确认日志行边界（读取失败）', exists: false, size: 0, cursor: cleared, reset: true, events: [] },
          base,
        )
      }
      lineStart = probe.atLineStart
    } catch (error) {
      return Object.assign(
        { ok: false, error: message(error), exists: false, size: 0, cursor: cleared, reset: true, events: [] },
        base,
      )
    } finally {
      if (probeFd !== null) {
        try {
          closeSync(probeFd)
        } catch {
          /* ignore */
        }
      }
    }
  }
  const slice = completeLinesFrom(buffer, read, start, !lineStart)
  const complete = slice.text
  const nextCursor = slice.nextCursor
  const events = []
  for (const rawLine of complete.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      /* 残行跳过 */
    }
    if (events.length > LIVE_EVENT_CAP) events.splice(0, events.length - LIVE_EVENT_CAP)
  }
  return Object.assign({ ok: true, exists: true, size, cursor: nextCursor, reset, events }, base)
}

/** 清空某个会话（sessionId 为空则清空全部）的实时过程：只推进字节基线，不删日志。 */
async function clearLiveLogs(sessionId) {
  await syncLiveLogs()
  const state = loadClearState()
  if (sessionId) {
    const file = sessionLogPath(sessionId)
    let size = 0
    try {
      size = statSync(file).size
    } catch {
      size = 0
    }
    state[sessionId] = size
    saveClearState(state)
    return { ok: true, session: sessionId, cursor: size, cleared: size }
  }
  let globalSize = 0
  try {
    globalSize = statSync(LIVE_LOG).size
  } catch {
    globalSize = 0
  }
  state.__global__ = globalSize
  let files = []
  try {
    files = readdirSync(LIVE_SESSIONS_DIR)
  } catch {
    files = []
  }
  for (const name of files) {
    if (!name.startsWith('codex-raw-') || !name.endsWith('.log')) continue
    let size = 0
    try {
      size = statSync(join(LIVE_SESSIONS_DIR, name)).size
    } catch {
      continue
    }
    state[name.slice('codex-raw-'.length, -'.log'.length)] = size
  }
  saveClearState(state)
  return { ok: true, session: null, cursor: globalSize, cleared: globalSize }
}

/**
 * 增量读取镜像日志：cursor 是「下一条待读行的字节偏移」。
 * cursor 为空或越界（首次打开、日志轮转/截断）时从尾部回看 tail 字节并置 reset。
 */
function readLiveSlice(options) {
  const opts = options && typeof options === 'object' ? options : {}
  const globalCleared = Math.max(0, Number(loadClearState().__global__) || 0)
  const cursor =
    typeof opts.cursor === 'number' && Number.isFinite(opts.cursor) && opts.cursor >= 0
      ? Math.floor(opts.cursor)
      : null
  const tail =
    typeof opts.tail === 'number' && Number.isFinite(opts.tail) && opts.tail > 0
      ? Math.min(Math.floor(opts.tail), LIVE_TAIL_BYTES)
      : LIVE_TAIL_BYTES
  let fd = null
  try {
    let stat = null
    try {
      stat = statSync(LIVE_LOG)
    } catch {
      return { ok: true, exists: false, path: LIVE_LOG, size: 0, cursor: 0, reset: true, events: [] }
    }
    if (!stat.isFile()) {
      return { ok: true, exists: false, path: LIVE_LOG, size: 0, cursor: 0, reset: true, events: [] }
    }
    const size = stat.size
    let reset = cursor === null || cursor > size
    let start = reset ? Math.max(0, size - tail) : cursor
    if (start < globalCleared) {
      reset = true
      start = Math.min(globalCleared, size)
    }
    if (size - start > LIVE_READ_CAP) {
      reset = true
      start = Math.max(0, size - tail)
    }
    const length = Math.max(0, size - start)
    const buf = Buffer.alloc(length)
    fd = openSync(LIVE_LOG, 'r')
    let read = 0
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read)
      if (n <= 0) break
      read += n
    }
    let lineStart = true
    if (start > 0) {
      const probe = isLineStart(fd, start)
      if (!probe.ok) {
        return {
          ok: false,
          error: '无法确认日志行边界（读取失败）',
          exists: false,
          path: LIVE_LOG,
          size: 0,
          cursor: 0,
          reset: true,
          events: [],
        }
      }
      lineStart = probe.atLineStart
    }
    const slice = completeLinesFrom(buf, read, start, !lineStart)
    const complete = slice.text
    const nextCursor = slice.nextCursor
    const events = []
    for (const rawLine of complete.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      const ev = liveEventFromLine(line)
      if (!ev) continue
      events.push(ev)
      if (events.length > LIVE_EVENT_CAP) events.splice(0, events.length - LIVE_EVENT_CAP)
    }
    return { ok: true, exists: true, path: LIVE_LOG, size, cursor: nextCursor, reset, events }
  } catch (error) {
    return { ok: false, error: message(error), exists: false, path: LIVE_LOG, size: 0, cursor: 0, reset: true, events: [] }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

export default {
  name: 'dsh-codex-hub',
  inject: ['webServer'],
  apply(ctx) {
    try {
      registerRoutes(ctx)
    } catch (error) {
      console.warn(`${TAG} host apply failed (repair API unavailable): ${message(error)}`)
    }
    /* 全新安装即自动确保过程镜像补丁就位，否则插件窗口读不到派发过程。 */
    try {
      ensureRepairApplied()
    } catch (error) {
      console.warn(`${TAG} auto repair failed: ${message(error)}`)
    }
    /* 每次 codex 派发前同步系统代理（包装子进程 spawn，不依赖定时任务）。 */
    try {
      installSpawnProxyPatch(ctx)
    } catch (error) {
      console.warn(`${TAG} proxy spawn patch failed: ${message(error)}`)
    }
    /* 自动维护：按开关执行「自动网络代理」与「自动更新 CLI」；启动后 3 秒一次，之后每分钟一次。 */
    const runAutoMaintenance = async () => {
      try {
        /* 先恢复上次中断的 CLI 更新事务（指针已发布但替换未完成）。 */
        await recoverPendingCliUpdate()
        const settings = loadCatalogSettings()
        if (settings.autoProxy) await ensureEnvProxy()
        if (settings.autoUpdateCli) await ensureCliUpdated()
      } catch {
        /* 自动任务失败不影响插件其它功能 */
      }
    }
    const startMaintenance = () => {
      const timer = setTimeout(runAutoMaintenance, 3000)
      const interval = setInterval(runAutoMaintenance, 60000)
      return () => {
        clearTimeout(timer)
        clearInterval(interval)
      }
    }
    try {
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => startMaintenance())
      } else {
        void startMaintenance()
      }
    } catch (error) {
      console.warn(TAG + ' 自动维护启动失败：' + message(error))
    }
  },
}


/* ===== 沙箱开关（插件详情页）：读写 profile 里 subagent-codex 的 permissionMode ===== */

const PROFILE_PATCH = join(PROFILE_DIR, 'cordis.patch.yml')
const SANDBOX_PERMISSION_ON = 'never'
const SANDBOX_PERMISSION_OFF = 'dangerously-bypass-approvals-and-sandbox'

/* ===== Codex CLI 自动更新 + 开关（插件详情页） ===== */

const CATALOG_SETTINGS_FILE = join(RUNS_DIR, 'catalog-settings.json')
const CLI_POINTER_FILE = join(BACKUP_ROOT, '.latest-catalog-cli.json')
const DEFAULT_CATALOG_SETTINGS = {
  autoUpdateCli: true,
  autoProxy: true,
  model: null,
  modelBeforeOverride: null,
  modelApplied: null,
  reasoning: null,
  reasoningBefore: null,
  reasoningApplied: null,
}

function loadCatalogSettings() {
  const settings = Object.assign({}, DEFAULT_CATALOG_SETTINGS)
  let saved = null
  let loadError = null
  try {
    if (existsSync(CATALOG_SETTINGS_FILE)) {
      const raw = readFileSync(CATALOG_SETTINGS_FILE, 'utf8')
      try {
        saved = JSON.parse(raw)
      } catch (error) {
        loadError = '设置文件解析失败：' + message(error)
      }
    }
  } catch (error) {
    loadError = '读取设置文件失败：' + message(error)
  }
  if (loadError !== null) {
    /* 读取/解析失败不能当「首次运行」：标记错误，写入路径必须中止，避免覆盖用户开关。 */
    settings._loadError = loadError
    return settings
  }
  if (saved && typeof saved === 'object') {
    if (typeof saved.autoUpdateCli === 'boolean') settings.autoUpdateCli = saved.autoUpdateCli
    if (typeof saved.autoProxy === 'boolean') settings.autoProxy = saved.autoProxy
    if (saved.lastCliUpdate && typeof saved.lastCliUpdate === 'object') settings.lastCliUpdate = saved.lastCliUpdate
    if (saved.managedProxy && typeof saved.managedProxy === 'object' && typeof saved.managedProxy.value === 'string') {
      settings.managedProxy = { value: saved.managedProxy.value, at: Number(saved.managedProxy.at) || 0 }
    }
    if (saved.lastCliRestore && typeof saved.lastCliRestore === 'object') settings.lastCliRestore = saved.lastCliRestore
    /* 插件选择的模型：null/缺省 = 跟随客户端当前配置。 */
    if (typeof saved.model === 'string' && saved.model.length > 0) settings.model = saved.model
    if (saved.model === null) settings.model = null
    if (typeof saved.modelBeforeOverride === 'string' && saved.modelBeforeOverride.length > 0) {
      settings.modelBeforeOverride = saved.modelBeforeOverride
    }
    if (saved.modelBeforeOverride === null) settings.modelBeforeOverride = null
    if (typeof saved.modelApplied === 'string' && saved.modelApplied.length > 0) settings.modelApplied = saved.modelApplied
    if (saved.modelApplied === null) settings.modelApplied = null
    /* 插件选择的推理深度：null/缺省 = 跟随客户端/config.toml 当前值。 */
    if (typeof saved.reasoning === 'string' && saved.reasoning.length > 0) settings.reasoning = saved.reasoning
    if (saved.reasoning === null) settings.reasoning = null
    if (typeof saved.reasoningBefore === 'string' && saved.reasoningBefore.length > 0) settings.reasoningBefore = saved.reasoningBefore
    if (saved.reasoningBefore === null) settings.reasoningBefore = null
    if (typeof saved.reasoningApplied === 'string' && saved.reasoningApplied.length > 0) settings.reasoningApplied = saved.reasoningApplied
    if (saved.reasoningApplied === null) settings.reasoningApplied = null
  }
  return settings
}

function saveCatalogSettings(settings) {
  mkdirSync(RUNS_DIR, { recursive: true })
  const payloadObject = Object.assign({}, settings)
  delete payloadObject._loadError
  const payload = JSON.stringify(payloadObject)
  const tmp = CATALOG_SETTINGS_FILE + '.tmp-' + process.pid + '-' + Date.now()
  writeFileSync(tmp, payload, 'utf8')
  renameSync(tmp, CATALOG_SETTINGS_FILE)
}

/* ===== 派发标题：按任务内容生成简短标题（启发式，本地缓存） ===== */

let titleCache = null

function loadTitleCache() {
  if (titleCache !== null) return titleCache
  const saved = readJsonSafe(TITLES_FILE, null)
  /* 数组/损坏内容不能作为缓存对象使用。 */
  titleCache = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
  return titleCache
}

function saveTitleCache() {
  try {
    mkdirSync(RUNS_DIR, { recursive: true })
    const tmp = TITLES_FILE + '.tmp-' + process.pid + '-' + Date.now()
    writeFileSync(tmp, JSON.stringify(loadTitleCache()), 'utf8')
    renameSync(tmp, TITLES_FILE)
  } catch {
    /* 缓存写失败不影响标题返回 */
  }
}

/** 标题用的本地摘要：取首句、去掉明确的指令短语、按字素截断。 */
function summarizeTaskTitle(task) {
  const raw = String(task || '')
  /* 先确定首句（换行/中文标点/英文句点），再压缩空白。 */
  let firstSentence = raw.split(/[。！？!?\n]/)[0] || raw
  const dotIndex = firstSentence.indexOf('. ')
  if (dotIndex > 0) firstSentence = firstSentence.slice(0, dotIndex)
  let text = firstSentence.replace(/\s+/g, ' ').trim()
  text = text
    /* 只去掉明确的指令短语；不删「请对/请把/请先」这类会误伤正文的短规则（如「请对比」→「比」）。 */
    .replace(/^(?:请帮我|请帮|麻烦你|麻烦帮我|请根据|please\b[\s,，:：]*)/i, '')
    .replace(/^(?:你是[^。！？!?]{0,40}[。！？!?]\s*)/, '')
    .replace(/^(?:用户让|用户要求|用户希望)\s*/, '')
  text = text.replace(/[「」“”"'`]/g, '')
  /* 按字素截断，避免切断 emoji/代理对。 */
  const title = sliceGraphemesHost(text, 24).trim()
  if (title) return title
  return sliceGraphemesHost(raw.replace(/\s+/g, ' ').trim(), 24) || '（无任务描述）'
}

/** host 侧按字素截断（不支持 Intl.Segmenter 时回退码点）。 */
function sliceGraphemesHost(text, limit) {
  const value = String(text || '')
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      return Array.from(new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(value))
        .slice(0, limit)
        .map((item) => item.segment)
        .join('')
    }
  } catch {
    /* 回退 */
  }
  return Array.from(value).slice(0, limit).join('')
}

/** 生成并缓存派发标题；返回 { title, source }。 */
function generateRunTitle(task) {
  const cache = loadTitleCache()
  /* v3：摘要算法变更（前缀规则/截断），旧缓存键不再命中。 */
  const key = 'v3:' + createHash('sha1').update(String(task)).digest('hex')
  if (typeof cache[key] === 'string' && cache[key].length > 0) {
    return { title: cache[key], source: 'cache' }
  }
  const title = summarizeTaskTitle(task)
  cache[key] = title
  saveTitleCache()
  return { title, source: 'heuristic' }
}

/** 读取 Codex 客户端缓存的模型名单（动态，跟随客户端支持列表）。 */
function readModelsCache() {
  try {
    const raw = JSON.parse(readFileSync(MODELS_CACHE_FILE, 'utf8'))
    const list = Array.isArray(raw.models) ? raw.models : []
    const models = list
      .filter((item) => item && typeof item.slug === 'string' && item.slug.length > 0)
      /* 只列客户端可见模型：缓存里还有 visibility:hide 的内部模型（如 codex-auto-review、gpt-reserve）。 */
      .filter((item) => item.visibility !== 'hide' && item.visibility !== 'hidden' && item.hidden !== true)
      .map((item) => ({
        id: item.slug,
        label: typeof item.display_name === 'string' && item.display_name ? item.display_name : item.slug,
        description: typeof item.description === 'string' ? item.description : '',
        defaultReasoning: typeof item.default_reasoning_level === 'string' ? item.default_reasoning_level : null,
        reasoningLevels: Array.isArray(item.supported_reasoning_levels)
          ? item.supported_reasoning_levels
              .filter((level) => level && typeof level.effort === 'string')
              .map((level) => ({
                effort: level.effort,
                description: typeof level.description === 'string' ? level.description : '',
              }))
          : [],
      }))
    const fetchedAtRaw = raw.fetched_at
    const fetchedAt =
      typeof fetchedAtRaw === 'number'
        ? fetchedAtRaw
        : typeof fetchedAtRaw === 'string'
          ? Date.parse(fetchedAtRaw) || 0
          : 0
    return {
      ok: models.length > 0,
      models,
      fetchedAt,
      clientVersion: typeof raw.client_version === 'string' ? raw.client_version : null,
      error: models.length > 0 ? null : '模型缓存里没有可用模型',
    }
  } catch (error) {
    return { ok: false, models: [], fetchedAt: 0, clientVersion: null, error: message(error) }
  }
}

/** 在 TOML 文本中定位顶层标量键：返回 { value, lineIndex, error }；error 表示格式无法可靠处理。 */
function findTopLevelScalar(text, keyName) {
  const lines = String(text || '').split('\n')
  let section = ''
  let multiline = null
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    /* 多行字符串内部：跳过，直到遇到闭合标记。 */
    if (multiline !== null) {
      if (raw.includes(multiline)) multiline = null
      continue
    }
    /* 剔除行尾注释（字符串外的 #）。 */
    let line = raw
    let inString = null
    for (let c = 0; c < line.length; c += 1) {
      const ch = line[c]
      if (inString === '"') {
        if (ch === '\\') {
          c += 1
          continue
        }
        if (ch === '"') inString = null
        continue
      }
      if (inString === "'") {
        if (ch === "'") inString = null
        continue
      }
      if (ch === '#') {
        line = line.slice(0, c)
        break
      }
      if (ch === '"') {
        inString = '"'
        continue
      }
      if (ch === "'") {
        inString = "'"
        continue
      }
    }
    const trimmed = line.trim()
    if (!trimmed) continue
    /* 表头（可能带尾注释，已剔除）：进入 section。 */
    const sectionMatch = /^\[(.*)\]$/.exec(trimmed)
    if (sectionMatch) {
      section = sectionMatch[1].trim()
      continue
    }
    /* 非目标键行：跟踪多行字符串开启状态，避免把字符串里的键行当成真实键。 */
    const keyPattern = new RegExp('^(?:"' + keyName + '"|\'' + keyName + '\'|' + keyName + ')\\s*=\\s*(.*)$')
    const keyMatch = keyPattern.exec(trimmed)
    if (!keyMatch) {
      const opensMultiline = /^(?:"""[^"]*$|'''[^']*$)/.test(trimmed)
      if (opensMultiline) multiline = trimmed.startsWith('"""') ? '"""' : "'''"
      continue
    }
    if (section !== '') continue
    const valueText = keyMatch[1].trim()
    if (valueText.startsWith('"""') || valueText.startsWith("'''")) {
      const marker = valueText.startsWith('"""') ? '"""' : "'''"
      const rest = valueText.slice(3)
      const closeIndex = rest.indexOf(marker)
      if (closeIndex < 0) {
        return { value: null, lineIndex: i, error: '顶层 ' + keyName + ' 是多行字符串，暂不支持自动修改' }
      }
      return { value: rest.slice(0, closeIndex), lineIndex: i, error: null }
    }
    const doubleQuoted = /^"((?:[^"\\]|\\.)*)"$/.exec(valueText)
    if (doubleQuoted) {
      try {
        return { value: JSON.parse('"' + doubleQuoted[1] + '"'), lineIndex: i, error: null }
      } catch {
        return { value: null, lineIndex: i, error: '顶层 ' + keyName + ' 字符串转义无法解析' }
      }
    }
    const singleQuoted = /^'([^']*)'$/.exec(valueText)
    if (singleQuoted) return { value: singleQuoted[1], lineIndex: i, error: null }
    return { value: null, lineIndex: i, error: '顶层 ' + keyName + ' 值格式无法识别' }
  }
  return { value: null, lineIndex: -1, error: null }
}

/** 顶层 model 键定位（兼容旧调用）。 */
function findTopLevelModelValue(text) {
  return findTopLevelScalar(text, 'model')
}

/** 读取 ~/.codex/config.toml 的顶层标量键；区分「缺失」「读取/解析失败」。 */
function readConfigScalar(keyName) {
  try {
    if (!existsSync(CONFIG_TOML)) return { value: null, missing: true, error: null }
    const text = readFileSync(CONFIG_TOML, 'utf8')
    const found = findTopLevelScalar(text, keyName)
    if (found.error) return { value: null, missing: false, error: found.error }
    return { value: found.value, missing: found.lineIndex < 0, error: null }
  } catch (error) {
    return { value: null, missing: false, error: message(error) }
  }
}

/** 写入/删除 ~/.codex/config.toml 的顶层标量键（备份 + 原子替换，保留其它内容）。 */
function writeConfigScalar(keyName, value, expectedText) {
  const text = existsSync(CONFIG_TOML) ? readFileSync(CONFIG_TOML, 'utf8') : ''
  /* 写入前核对原文：读取与写入之间被外部（客户端 GUI/手改）修改时中止，避免覆盖。 */
  if (expectedText !== undefined && text !== expectedText) {
    throw new Error('config.toml 在维护期间被外部修改，已中止本次写入')
  }
  const found = findTopLevelScalar(text, keyName)
  if (found.error) throw new Error(found.error)
  const lines = text.split('\n')
  if (value === null) {
    if (found.lineIndex >= 0) lines.splice(found.lineIndex, 1)
  } else {
    const line = keyName + ' = ' + JSON.stringify(String(value))
    if (found.lineIndex >= 0) lines[found.lineIndex] = line
    else lines.unshift(line)
  }
  const next = lines.join('\n')
  const stampText = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(
    BACKUP_ROOT,
    stampText + '-codex-config-' + process.pid + '-' + Math.random().toString(36).slice(2, 8),
  )
  mkdirSync(backupDir, { recursive: true })
  if (existsSync(CONFIG_TOML)) copyFileSync(CONFIG_TOML, join(backupDir, 'config.toml'))
  const tmp = CONFIG_TOML + '.tmp-' + process.pid + '-' + Date.now()
  writeFileSync(tmp, next, 'utf8')
  renameSync(tmp, CONFIG_TOML)
}

/** 读取 ~/.codex/config.toml 当前顶层 model。 */
function readConfigModel() {
  return readConfigScalar('model')
}

/** 写入/删除 ~/.codex/config.toml 的顶层 model 行。 */
function writeConfigModel(model, expectedText) {
  writeConfigScalar('model', model, expectedText)
}

/** 校验模型 id：只允许字母数字与 . _ : -；防止 TOML 注入。 */
function normalizeModelId(value) {
  if (value === null) return null
  const text = String(value)
  if (text.length === 0 || text.length > 120) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) return null
  return text
}

/**
 * 模型选择事务：统一跨进程锁；记录「原值/最后写入值」，清除时仅在配置仍为插件写入值时恢复。
 * desired=null 表示跟随客户端（恢复或删除插件写入的键）。
 */
function applyModelTransaction(desired) {
  const release = acquireFileLock(CATALOG_SETTINGS_FILE + '.lock')
  if (release === null) throw new Error('设置文件被其它进程占用，请稍后重试')
  try {
    const settings = loadCatalogSettings()
    if (settings._loadError) throw new Error(settings._loadError)
    const configState = readConfigModel()
    if (configState.error) throw new Error('读取 config.toml 失败：' + configState.error)
    /* 记录配置原文：写入前核对未被外部修改。 */
    const configTextBefore = existsSync(CONFIG_TOML) ? readFileSync(CONFIG_TOML, 'utf8') : ''
    const current = configState.value
    const lastApplied = typeof settings.modelApplied === 'string' ? settings.modelApplied : null
    const previousCurrent = current
    if (desired !== null) {
      if (lastApplied === null) {
        /* 首次接管：记录原值（null = 原本没有顶层 model 键）。 */
        settings.modelBeforeOverride = current
      } else if (current !== lastApplied) {
        /* 外部（客户端 GUI/手改）已改过：以当前值为新的恢复目标。 */
        settings.modelBeforeOverride = current
      }
      writeConfigModel(desired, configTextBefore)
      settings.model = desired
      settings.modelApplied = desired
    } else {
      if (lastApplied !== null && current === lastApplied) {
        /* 仍为插件写入值：恢复到接管前的状态（原始缺省则删除该键）。 */
        writeConfigModel(
          typeof settings.modelBeforeOverride === 'string' ? settings.modelBeforeOverride : null,
          configTextBefore,
        )
      }
      settings.model = null
      settings.modelApplied = null
      settings.modelBeforeOverride = null
    }
    try {
      saveCatalogSettings(settings)
    } catch (error) {
      /* 配置已写但状态保存失败：仅在配置仍等于本次写入值时才回滚，避免覆盖外部新值。 */
      let rollbackInfo = ''
      try {
        const currentAfter = readConfigModel().value
        const written = desired !== null ? desired : null
        if (currentAfter === written) {
          writeConfigModel(previousCurrent)
          rollbackInfo = '（已回滚配置）'
        } else {
          rollbackInfo = '（配置已被外部修改，保留外部值）'
        }
      } catch (rollbackError) {
        rollbackInfo = '（回滚配置失败：' + message(rollbackError) + '）'
      }
      throw new Error('保存模型设置失败：' + message(error) + rollbackInfo)
    }
    return { configModel: readConfigModel().value, applied: desired !== null }
  } finally {
    release()
  }
}

/**
 * 通用标量配置事务：统一跨进程锁；记录原值/最后写入值，清除时仅在配置仍为插件写入值时恢复。
 * 保存失败回滚仅在配置仍等于本次写入值时执行，避免覆盖外部修改。
 */
function applyConfigScalarTransaction(keyName, desired, fieldNames) {
  const release = acquireFileLock(CATALOG_SETTINGS_FILE + '.lock')
  if (release === null) throw new Error('设置文件被其它进程占用，请稍后重试')
  try {
    const settings = loadCatalogSettings()
    if (settings._loadError) throw new Error(settings._loadError)
    const configState = readConfigScalar(keyName)
    if (configState.error) throw new Error('读取 config.toml 失败：' + configState.error)
    const configTextBefore = existsSync(CONFIG_TOML) ? readFileSync(CONFIG_TOML, 'utf8') : ''
    const current = configState.value
    const lastApplied = typeof settings[fieldNames.applied] === 'string' ? settings[fieldNames.applied] : null
    const previousCurrent = current
    let expectedAfter
    if (desired !== null) {
      if (lastApplied === null || current !== lastApplied) {
        /* 首次接管或外部已改过：记录当前值为恢复目标。 */
        settings[fieldNames.before] = current
      }
      writeConfigScalar(keyName, desired, configTextBefore)
      settings[fieldNames.value] = desired
      settings[fieldNames.applied] = desired
      expectedAfter = desired
    } else {
      if (lastApplied !== null && current === lastApplied) {
        const beforeValue = typeof settings[fieldNames.before] === 'string' ? settings[fieldNames.before] : null
        writeConfigScalar(keyName, beforeValue, configTextBefore)
        expectedAfter = beforeValue
      }
      settings[fieldNames.value] = null
      settings[fieldNames.applied] = null
      settings[fieldNames.before] = null
    }
    try {
      saveCatalogSettings(settings)
    } catch (error) {
      let rollbackInfo = ''
      try {
        const currentAfter = readConfigScalar(keyName).value
        if (expectedAfter !== undefined && currentAfter === expectedAfter) {
          writeConfigScalar(keyName, previousCurrent)
          rollbackInfo = '（已回滚配置）'
        } else if (expectedAfter !== undefined) {
          rollbackInfo = '（配置已被外部修改，保留外部值）'
        }
      } catch (rollbackError) {
        rollbackInfo = '（回滚配置失败：' + message(rollbackError) + '）'
      }
      throw new Error('保存设置失败：' + message(error) + rollbackInfo)
    }
    return { value: readConfigScalar(keyName).value, applied: desired !== null }
  } finally {
    release()
  }
}

/** 校验推理深度档位：小写字母开头，允许字母数字与 _ -。 */
function normalizeReasoningEffort(value) {
  if (value === null) return null
  const text = String(value)
  if (text.length === 0 || text.length > 32) return null
  if (!/^[a-z][a-z0-9_-]*$/.test(text)) return null
  return text
}

/** 推理深度事务：写 config.toml 的 model_reasoning_effort；清除时恢复原值。 */
function applyReasoningTransaction(desired) {
  return applyConfigScalarTransaction('model_reasoning_effort', desired, {
    value: 'reasoning',
    before: 'reasoningBefore',
    applied: 'reasoningApplied',
  })
}


/** 跨进程安全地更新设置：加锁后重读最新值，交给 mutator 合并，再原子保存。 */
function updateCatalogSettings(mutator) {
  const release = acquireFileLock(CATALOG_SETTINGS_FILE + '.lock')
  if (release === null) throw new Error('设置文件被其它进程占用，请稍后重试')
  try {
    const settings = loadCatalogSettings()
    /* 读取/解析失败时禁止写入：否则会用默认值覆盖用户的开关与管理记录。 */
    if (settings._loadError) throw new Error(settings._loadError)
    const next = mutator(settings) || settings
    saveCatalogSettings(next)
    return next
  } finally {
    release()
  }
}

const cliProbeCache = { at: 0, state: null }
let cliStateInFlight = null

/** 当前 vendor CLI 与 DSH 客户端自带 CLI 的版本对比（缓存 60 秒，进行中请求复用同一个 Promise）。 */
async function cliState(force) {
  const now = Date.now()
  if (force !== true && cliProbeCache.state && now - cliProbeCache.at < 60000) return cliProbeCache.state
  if (cliStateInFlight !== null) return cliStateInFlight
  cliStateInFlight = (async () => {
    const client = await findClientPayloadAsync()
    const vendorVersion = await probeVersionAsync(join(VENDOR_BIN, 'codex.exe'))
    const clientVersion = client ? client.version : null
    const vendorRank = versionRank(vendorVersion)
    const clientRank = versionRank(clientVersion)
    const upToDate = Boolean(vendorRank && clientRank && compareVersions(vendorRank, clientRank) >= 0)
    const state = {
      vendorVersion,
      clientVersion,
      upToDate,
      clientExe: client ? client.exe : null,
    }
    cliProbeCache.at = Date.now()
    cliProbeCache.state = state
    return state
  })()
  try {
    return await cliStateInFlight
  } finally {
    cliStateInFlight = null
  }
}

/** 解析真实路径（不存在或无法解析时返回 null）。 */
function resolvePathSafe(target) {
  try {
    return realpathSync(String(target || ''))
  } catch {
    return null
  }
}

/** target 是否位于 base 目录内（含子目录本身）；用于拒绝指针被篡改指向备份目录外。 */
function isInsideDir(base, target) {
  try {
    const basePath = realpathSync(String(base || ''))
    const targetPath = realpathSync(String(target || ''))
    const normalizedBase = basePath.endsWith(sep) ? basePath : basePath + sep
    return targetPath === basePath || targetPath.startsWith(normalizedBase)
  } catch {
    return false
  }
}

/** vendor CLI 落后于客户端版本时，备份后复制客户端那份过来（跨实例锁 + 先备份后覆盖 + 独立指针）。 */
async function ensureCliUpdated() {
  const settings = loadCatalogSettings()
  if (settings._loadError) return { ok: false, updated: false, reason: settings._loadError }
  if (!settings.autoUpdateCli) return { ok: true, updated: false, reason: '自动更新已关闭' }
  const release = acquireFileLock(VENDOR_BIN + '.cli.lock')
  if (release === null) return { ok: false, updated: false, reason: '另一个维护任务正在进行，请稍后重试' }
  try {
    /* 先处理未完成事务；未解决时不允许启动新更新（否则会覆盖恢复标记）。 */
    await recoverPendingCliUpdateLocked()
    if (existsSync(CLI_POINTER_FILE + '.pending')) {
      return { ok: false, updated: false, reason: '存在未完成的 CLI 更新事务，已跳过本次更新' }
    }
    const client = await findClientPayloadAsync()
    if (!client) return { ok: false, updated: false, reason: '找不到 DSH 客户端自带的 codex' }
    const clientRank = versionRank(client.version)
    if (!clientRank) return { ok: false, updated: false, reason: '客户端 codex 版本无法解析' }
    const vendorExe = join(VENDOR_BIN, 'codex.exe')
    const vendorVersion = await probeVersionAsync(vendorExe)
    if (existsSync(vendorExe) && !vendorVersion) {
      return { ok: false, updated: false, reason: 'vendor codex.exe 存在但版本探测失败，已跳过更新' }
    }
    if (vendorVersion) {
      const vendorRank = versionRank(vendorVersion)
      if (vendorRank && compareVersions(vendorRank, clientRank) >= 0) {
        return { ok: true, updated: false, reason: '已是最新', vendorVersion, clientVersion: client.version }
      }
    }
    const stampText = new Date().toISOString().replace(/[:.]/g, '-')
    const backupDir = join(BACKUP_ROOT, stampText + '-catalog-cli')
    mkdirSync(backupDir, { recursive: true })
    /* 覆盖前必须先成功落盘：备份文件、独立 manifest、独立指针，任何一步失败都中止。 */
    let backupPath = null
    if (existsSync(vendorExe)) {
      try {
        backupPath = join(backupDir, 'codex.exe')
        copyFileSync(vendorExe, backupPath)
      } catch (error) {
        return { ok: false, updated: false, reason: '备份 vendor codex.exe 失败，已中止更新：' + message(error) }
      }
    }
    const entries = backupPath
      ? [{ label: 'vendor codex.exe（自动更新前）', path: vendorExe, backup: backupPath, existed: true }]
      : [{ label: 'vendor codex.exe（本次新建，还原时删除）', path: vendorExe, backup: null, existed: false }]
    const manifestPath = join(backupDir, 'manifest.json')
    try {
      writeFileSync(manifestPath, JSON.stringify({ createdAt: new Date().toISOString(), entries }, null, 2), 'utf8')
    } catch (error) {
      return { ok: false, updated: false, reason: '写入 CLI 备份清单失败，已中止更新：' + message(error) }
    }
    const pointer = { backupDir, manifestPath, at: Date.now(), from: vendorVersion || null, to: client.version, clientExe: client.exe }
    let previousPointerText = null
    try {
      previousPointerText = existsSync(CLI_POINTER_FILE) ? readFileSync(CLI_POINTER_FILE, 'utf8') : null
    } catch (error) {
      /* 旧指针存在但读取失败：不能当作「不存在」，中止更新以免丢失还原入口。 */
      return { ok: false, updated: false, reason: '读取旧 CLI 还原指针失败，已中止更新：' + message(error) }
    }
    /* 版本探测/备份期间用户可能已关闭自动更新：发布新指针前复查，尊重用户选择。 */
    if (!loadCatalogSettings().autoUpdateCli) {
      return { ok: true, updated: false, reason: '自动更新已被关闭，已中止本次更新' }
    }
    /* 先写「未完成更新」标记：指针发布后若进程中断/替换失败，下次维护可据此恢复旧指针。 */
    const pendingMarker = CLI_POINTER_FILE + '.pending'
    const pendingTmp = pendingMarker + '.tmp-' + process.pid + '-' + Date.now()
    try {
      writeFileSync(
        pendingTmp,
        JSON.stringify({ previousPointerText, pointer, targetVersion: client.version, existed: existsSync(vendorExe) }, null, 2),
        'utf8',
      )
      renameSync(pendingTmp, pendingMarker)
    } catch (error) {
      try {
        if (existsSync(pendingTmp)) unlinkSync(pendingTmp)
      } catch {
        /* ignore */
      }
      /* 标记落盘失败即中止：否则更新中断后无法恢复旧指针。 */
      return { ok: false, updated: false, reason: '写入未完成更新标记失败，已中止更新：' + message(error) }
    }
    const pointerTmp = CLI_POINTER_FILE + '.tmp-' + process.pid + '-' + Date.now()
    try {
      mkdirSync(BACKUP_ROOT, { recursive: true })
      writeFileSync(pointerTmp, JSON.stringify(pointer, null, 2), 'utf8')
      renameSync(pointerTmp, CLI_POINTER_FILE)
    } catch (error) {
      try {
        if (existsSync(pointerTmp)) unlinkSync(pointerTmp)
      } catch {
        /* ignore */
      }
      /* 指针未变：清理标记后再中止。 */
      try {
        if (existsSync(pendingMarker)) unlinkSync(pendingMarker)
      } catch {
        /* ignore */
      }
      return { ok: false, updated: false, reason: '写入 CLI 还原指针失败，已中止更新：' + message(error) }
    }
    /* 原子替换 vendor 文件（目录创建也纳入回滚保护）。 */
    const tmp = vendorExe + '.tmp-' + process.pid + '-' + Date.now()
    try {
      mkdirSync(VENDOR_BIN, { recursive: true })
      copyFileSync(client.exe, tmp)
      renameSync(tmp, vendorExe)
    } catch (error) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        /* ignore */
      }
      /* 恢复旧指针，保证此前可用的还原入口不丢；恢复失败要在返回里报告。 */
      let pointerRollbackError = null
      try {
        if (previousPointerText === null) {
          if (existsSync(CLI_POINTER_FILE)) unlinkSync(CLI_POINTER_FILE)
        } else {
          const restoreTmp = CLI_POINTER_FILE + '.restore-' + process.pid + '-' + Date.now()
          writeFileSync(restoreTmp, previousPointerText, 'utf8')
          renameSync(restoreTmp, CLI_POINTER_FILE)
        }
      } catch (rollbackError) {
        pointerRollbackError = message(rollbackError)
      }
      /* 仅在回滚成功时清理标记；回滚失败保留标记供下次维护恢复。 */
      if (pointerRollbackError === null) {
        try {
          if (existsSync(pendingMarker)) unlinkSync(pendingMarker)
        } catch {
          /* ignore */
        }
      }
      const rollbackText =
        pointerRollbackError === null ? '' : '；恢复旧还原指针失败：' + pointerRollbackError
      return { ok: false, updated: false, reason: '替换 vendor codex.exe 失败：' + message(error) + rollbackText }
    }
    cliProbeCache.at = 0
    cliProbeCache.state = null
    /* 替换成功：删除未完成更新标记。 */
    try {
      if (existsSync(pendingMarker)) unlinkSync(pendingMarker)
    } catch {
      /* ignore */
    }
    /* 覆盖已完成：记录更新结果时重新读取最新设置，只合并 lastCliUpdate，避免覆盖用户刚改的开关/代理记录。 */
    try {
      updateCatalogSettings((latest) => {
        latest.lastCliUpdate = pointer
      })
    } catch (error) {
      console.warn(TAG + ' CLI 已更新，但保存设置失败：' + message(error))
    }
    return { ok: true, updated: true, from: vendorVersion || null, to: client.version, backupDir, manifestPath }
  } finally {
    release()
  }
}

/** 恢复未完成的 CLI 更新事务（调用方必须已持 CLI 锁）；返回是否仍有未解决标记。 */
async function recoverPendingCliUpdateLocked() {
  const marker = CLI_POINTER_FILE + '.pending'
  if (!existsSync(marker)) return { recovered: false, reason: '没有待恢复事务' }
  try {
    const pending = JSON.parse(readFileSync(marker, 'utf8'))
    const vendorExe = join(VENDOR_BIN, 'codex.exe')
    /* 首次安装（原先没有 vendor 文件）且文件仍未创建：回滚指针并清理标记，避免永久卡住。 */
    if (pending && pending.existed === false && !existsSync(vendorExe)) {
      const previous = typeof pending.previousPointerText === 'string' ? pending.previousPointerText : null
      if (previous === null) {
        if (existsSync(CLI_POINTER_FILE)) unlinkSync(CLI_POINTER_FILE)
      } else {
        const restoreTmp = CLI_POINTER_FILE + '.recover-' + process.pid + '-' + Date.now()
        writeFileSync(restoreTmp, previous, 'utf8')
        renameSync(restoreTmp, CLI_POINTER_FILE)
      }
      unlinkSync(marker)
      return { recovered: true, completed: false }
    }
    const actualVersion = await probeVersionAsync(vendorExe)
    if (actualVersion === null) {
      /* 版本探测不确定：保留标记，下次维护再判断，避免误恢复。 */
      return { recovered: false, reason: '版本探测失败，保留标记待重试' }
    }
    const target = pending && typeof pending.targetVersion === 'string' ? pending.targetVersion : null
    const actualRank = versionRank(actualVersion)
    const targetRank = versionRank(target)
    const completed = Boolean(actualRank && targetRank && compareVersions(actualRank, targetRank) >= 0)
    if (completed) {
      unlinkSync(marker)
      return { recovered: true, completed: true }
    }
    /* 未完成：恢复旧指针（保留此前可用的还原入口）。 */
    const previous = pending && typeof pending.previousPointerText === 'string' ? pending.previousPointerText : null
    if (previous === null) {
      if (existsSync(CLI_POINTER_FILE)) unlinkSync(CLI_POINTER_FILE)
    } else {
      const restoreTmp = CLI_POINTER_FILE + '.recover-' + process.pid + '-' + Date.now()
      writeFileSync(restoreTmp, previous, 'utf8')
      renameSync(restoreTmp, CLI_POINTER_FILE)
    }
    unlinkSync(marker)
    return { recovered: true, completed: false }
  } catch (error) {
    console.warn(TAG + ' 恢复未完成的 CLI 更新失败：' + message(error))
    return null
  }
}

/** 启动/维护时恢复未完成的 CLI 更新事务（自行加锁，与更新/还原互斥）。 */
async function recoverPendingCliUpdate() {
  const marker = CLI_POINTER_FILE + '.pending'
  if (!existsSync(marker)) return null
  const release = acquireFileLock(VENDOR_BIN + '.cli.lock')
  if (release === null) return { recovered: false, reason: '另一个维护任务正在进行' }
  try {
    return await recoverPendingCliUpdateLocked()
  } finally {
    release()
  }
}

/** 卸载更新：恢复最近一次自动更新前的 vendor codex.exe，并暂停自动更新以免再次被覆盖。 */
async function restoreCli() {
  const release = acquireFileLock(VENDOR_BIN + '.cli.lock')
  if (release === null) return { ok: false, restored: false, reason: '另一个维护任务正在进行，请稍后重试' }
  try {
    /* 先处理未完成事务；未解决时不允许执行还原（避免与恢复交错）。 */
    await recoverPendingCliUpdateLocked()
    if (existsSync(CLI_POINTER_FILE + '.pending')) {
      return { ok: false, restored: false, reason: '存在未完成的 CLI 更新事务，请稍后重试' }
    }
    let pointer = null
    try {
      if (existsSync(CLI_POINTER_FILE)) pointer = JSON.parse(readFileSync(CLI_POINTER_FILE, 'utf8'))
    } catch {
      pointer = null
    }
    if (!pointer || !pointer.manifestPath || !existsSync(pointer.manifestPath)) {
      return { ok: false, restored: false, reason: '没有可还原的 CLI 备份' }
    }
    const manifest = JSON.parse(readFileSync(pointer.manifestPath, 'utf8'))
    const entries = Array.isArray(manifest.entries) ? manifest.entries : []
    const vendorExe = join(VENDOR_BIN, 'codex.exe')
    const entry = entries.find((item) => String(item.path || '').toLowerCase() === vendorExe.toLowerCase())
    if (!entry) return { ok: false, restored: false, reason: '备份清单里没有 vendor codex.exe' }
    /* 首次安装（原先没有 vendor 文件）还原 = 删除本次新建的文件，不需要备份路径校验。 */
    const isNewInstall = entry.existed === false && !entry.backup
    let backupTarget = null
    if (!isNewInstall) {
      backupTarget = resolvePathSafe(entry.backup)
      if (backupTarget === null || !isInsideDir(BACKUP_ROOT, backupTarget)) {
        return { ok: false, restored: false, reason: '备份路径无效或不在备份目录内，拒绝还原' }
      }
    }
    /* 备份校验通过后再暂停自动更新；失败则不动文件。 */
    let previousAutoUpdate = null
    try {
      updateCatalogSettings((latest) => {
        previousAutoUpdate = latest.autoUpdateCli
        latest.autoUpdateCli = false
      })
    } catch (error) {
      return { ok: false, restored: false, reason: '暂停自动更新失败，未执行还原：' + message(error) }
    }
    /* 安全目录创建/备份/替换统一失败处理：失败时恢复自动更新开关并报告回滚结果。 */
    const stampText = new Date().toISOString().replace(/[:.]/g, '-')
    const safetyDir = join(BACKUP_ROOT, stampText + '-catalog-cli-restore')
    const tmp = vendorExe + '.restore-' + process.pid + '-' + Date.now()
    try {
      mkdirSync(safetyDir, { recursive: true })
      if (existsSync(vendorExe)) copyFileSync(vendorExe, join(safetyDir, 'codex.exe'))
      if (isNewInstall) {
        /* 原先没有 vendor 文件：还原为「不存在」。 */
        if (existsSync(vendorExe)) unlinkSync(vendorExe)
      } else {
        copyFileSync(backupTarget, tmp)
        renameSync(tmp, vendorExe)
      }
    } catch (error) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        /* ignore */
      }
      let rollbackError = null
      try {
        updateCatalogSettings((latest) => {
          /* 仅在仍为本次暂停产生的「关闭」状态时恢复，避免覆盖用户期间重新打开的选择。 */
          if (latest.autoUpdateCli === false) latest.autoUpdateCli = previousAutoUpdate
        })
      } catch (saveError) {
        rollbackError = message(saveError)
      }
      const rollbackText =
        rollbackError === null ? '' : '；回滚自动更新开关失败（当前仍为关闭）：' + rollbackError
      return { ok: false, restored: false, reason: '还原失败：' + message(error) + rollbackText }
    }
    cliProbeCache.at = 0
    cliProbeCache.state = null
    /* 暂停设置已在还原前持久化；这里只补充还原记录（基于最新设置合并），失败仅告警。 */
    try {
      updateCatalogSettings((latest) => {
        latest.lastCliRestore = { at: Date.now(), safetyBackup: safetyDir, restoredFrom: pointer.to || null }
      })
    } catch (error) {
      console.warn(TAG + ' CLI 已还原，但保存还原记录失败：' + message(error))
    }
    return { ok: true, restored: true, version: await probeVersionAsync(vendorExe), safetyBackup: safetyDir, autoUpdateCli: false }
  } finally {
    release()
  }
}

/** 在 profile patch 里定位 subagent-codex 配置块；唯一块或错误。 */
function findSubagentCodexBlock(source) {
  const lines = String(source || '').split(/\r?\n/)
  const starts = []
  for (let i = 0; i < lines.length; i++) {
    if (/^-\s+id:\s*subagent-codex\s*(#.*)?$/.test(lines[i])) starts.push(i)
  }
  if (starts.length === 0) return { error: 'profile 配置里找不到 subagent-codex 配置块' }
  if (starts.length > 1) return { error: 'profile 配置里存在多个 subagent-codex 配置块，拒绝操作' }
  const start = starts[0]
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^-\s+id:\s*\S+/.test(lines[i])) {
      end = i
      break
    }
  }
  return { start, end }
}

/** 取块内唯一的 config: 行，返回 { index, indent } 或错误。 */
function findBlockConfig(lines, block) {
  const found = []
  for (let i = block.start + 1; i < block.end; i++) {
    const match = /^(\s*)config:\s*(#.*)?$/.exec(lines[i])
    if (match) found.push({ index: i, indent: match[1].length })
  }
  if (found.length === 0) return { error: 'subagent-codex 配置块里找不到 config 行' }
  if (found.length > 1) return { error: 'subagent-codex 配置块里存在多个 config 行，拒绝操作' }
  return found[0]
}

/**
 * 在 config 的 mapping 范围内找 permissionMode 行：
 * 范围到「缩进 <= config 缩进」的行结束，只认 config 下一层的字段，跳过注释行。
 */
function findPermissionModeLine(lines, block, config) {
  const targetIndent = config.indent + 2
  const found = []
  const deeper = []
  for (let i = config.index + 1; i < block.end; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    /* 注释/空行不改变 mapping 层级：先跳过，再判断缩进边界（避免低缩进注释误判块结束）。 */
    if (!trimmed || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (indent <= config.indent) break
    const match = /^permissionMode:\s*(.*)$/.exec(trimmed)
    if (!match) continue
    if (indent === targetIndent) found.push({ index: i, rawValue: match[1] })
    else deeper.push({ index: i, indent })
  }
  if (found.length > 1) return { error: 'subagent-codex.config 里存在多个 permissionMode，拒绝操作' }
  if (found.length === 0 && deeper.length > 0) {
    return { error: 'permissionMode 位于更深的嵌套层级，无法可靠判断沙箱状态' }
  }
  return { found: found[0] || null, targetIndent }
}

/** 解析 permissionMode 的标量值；空值 / null / ~ 视为未知。 */
function parsePermissionMode(rawValue) {
  let value = String(rawValue || '').trim()
  const hash = value.indexOf('#')
  if (hash >= 0) value = value.slice(0, hash).trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1)
  }
  value = value.trim()
  if (value === '' || value === 'null' || value === '~' || value === 'Null' || value === 'NULL') {
    return { value: '', valid: false }
  }
  return { value, valid: true }
}

/** 当前沙箱状态；结构异常/未知值/读取失败一律返回 unknown，不伪装成已开启。 */
function readSandboxState() {
  let source = ''
  try {
    source = readFileSync(PROFILE_PATCH, 'utf8')
  } catch (error) {
    return { state: 'unknown', mode: '', error: '读取 profile 配置失败：' + message(error) }
  }
  const block = findSubagentCodexBlock(source)
  if (block.error) {
    /* 全新安装的 profile patch 通常没有 subagent-codex 块（它由官方 bundle 层插入）。
       缺省 permissionMode = never，与「沙箱开启（默认）」一致；首次切换开关时自动补块。 */
    if (block.error === 'profile 配置里找不到 subagent-codex 配置块') {
      return { state: 'on', mode: 'never', defaulted: true, implicit: true }
    }
    return { state: 'unknown', mode: '', error: block.error }
  }
  const lines = source.split(/\r?\n/)
  const config = findBlockConfig(lines, block)
  if (config.error) return { state: 'unknown', mode: '', error: config.error }
  const found = findPermissionModeLine(lines, block, config)
  if (found.error) return { state: 'unknown', mode: '', error: found.error }
  if (!found.found) {
    /* 字段缺省时插件默认 permissionMode = never（沙箱开启）。 */
    return { state: 'on', mode: 'never', defaulted: true }
  }
  const parsed = parsePermissionMode(found.found.rawValue)
  if (!parsed.valid) {
    return { state: 'unknown', mode: '', error: 'permissionMode 值为空或 null，无法确认沙箱状态' }
  }
  if (parsed.value === SANDBOX_PERMISSION_ON || parsed.value === 'approve-for-me') {
    return { state: 'on', mode: parsed.value }
  }
  if (parsed.value === SANDBOX_PERMISSION_OFF) return { state: 'off', mode: parsed.value }
  return { state: 'unknown', mode: parsed.value, error: 'permissionMode 取值未知：' + parsed.value }
}

/** 写入沙箱开关：严格定位唯一目标，备份后原子替换，写后重读验证；失败恢复备份。 */
/** 同一时刻只允许一个写入者修改 profile 配置（锁带令牌，只删自己的锁）。 */
function acquireProfileLock() {
  const lockFile = PROFILE_PATCH + '.lock'
  const token = String(process.pid) + '-' + Math.random().toString(36).slice(2)
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockFile, 'wx')
      try {
        writeSync(fd, token)
      } catch {
        /* 锁内容非必需 */
      }
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
      return () => {
        try {
          if (readFileSync(lockFile, 'utf8') === token) unlinkSync(lockFile)
        } catch {
          /* 锁可能已清理 */
        }
      }
    } catch {
      try {
        const st = statSync(lockFile)
        if (Date.now() - st.mtimeMs > 15000) {
          try {
            unlinkSync(lockFile)
          } catch {
            /* ignore */
          }
          continue
        }
      } catch {
        continue
      }
      return null
    }
  }
  return null
}

function writeSandboxEnabled(enabled) {
  const releaseProfileLock = acquireProfileLock()
  if (releaseProfileLock === null) throw new Error('profile 配置正被其它写入者占用，请稍后重试')
  try {
  const mode = enabled ? SANDBOX_PERMISSION_ON : SANDBOX_PERMISSION_OFF
  const original = readFileSync(PROFILE_PATCH, 'utf8')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(DSH_HOME, 'file-backups', stamp + '-cordis-patch-sandbox')
  mkdirSync(backupDir, { recursive: true })
  const backupFile = join(backupDir, 'cordis.patch.yml')
  copyFileSync(PROFILE_PATCH, backupFile)
  const lines = original.split(/\r?\n/)
  let next
  const block = findSubagentCodexBlock(original)
  if (block.error === 'profile 配置里找不到 subagent-codex 配置块') {
    /* 全新安装的 profile patch 没有该块：追加一个标准覆盖块，之后开关即可正常读写。 */
    const suffix =
      (original.endsWith('\n') || original === '' ? '' : '\n') +
      '- id: subagent-codex\n' +
      '  name: "@deepseek-ai/dsh-subagent-codex"\n' +
      '  config:\n' +
      '    permissionMode: "' + mode + '"\n'
    next = original + suffix
  } else {
    if (block.error) throw new Error(block.error)
    const config = findBlockConfig(lines, block)
    if (config.error) throw new Error(config.error)
    const found = findPermissionModeLine(lines, block, config)
    if (found.error) throw new Error(found.error)
    const nextLines = lines.slice()
    if (found.found) {
      nextLines[found.found.index] = ' '.repeat(found.targetIndent) + 'permissionMode: "' + mode + '"'
    } else {
      nextLines.splice(config.index + 1, 0, ' '.repeat(found.targetIndent) + 'permissionMode: "' + mode + '"')
    }
    next = nextLines.join('\n')
  }
  const tmp = PROFILE_PATCH + '.tmp-' + process.pid + '-' + Date.now()
  let replaced = false
  try {
    writeFileSync(tmp, next, 'utf8')
    /* 并发保护：rename 前确认原文件没有被其它写入修改。 */
    if (readFileSync(PROFILE_PATCH, 'utf8') !== original) {
      throw new Error('profile 配置在写入期间被外部修改，已放弃本次修改，请重试')
    }
    renameSync(tmp, PROFILE_PATCH)
    replaced = true
    /* 写后验证：重新读取必须与目标一致，否则从备份恢复。 */
    const after = readSandboxState()
    const expected = enabled ? 'on' : 'off'
    if (after.state !== expected) {
      throw new Error('写入后状态校验失败（期望 ' + expected + '，实际 ' + after.state + '）')
    }
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      /* 临时文件可能已不存在 */
    }
    /* 只在本次确实完成替换后才回滚；回滚前确认目标仍是本次内容，避免覆盖外部修改。 */
    if (replaced) {
      try {
        if (readFileSync(PROFILE_PATCH, 'utf8') === next) {
          copyFileSync(backupFile, PROFILE_PATCH)
        } else {
          console.warn(TAG + ' 沙箱配置已被外部修改，跳过回滚，备份保存在 ' + backupFile)
        }
      } catch (restoreError) {
        console.warn(TAG + ' 沙箱配置回滚失败：' + message(restoreError) + '，备份保存在 ' + backupFile)
      }
    }
    throw error
  }
  /* 写后独立校验：重读配置确认实际状态（防止重复键/层级问题导致表面成功）。 */
  const verify = readSandboxState()
  if (verify.state === 'unknown') {
    throw new Error('写入后校验失败：' + (verify.error || '无法确认沙箱状态'))
  }
  const expectedOn = mode !== SANDBOX_PERMISSION_OFF
  if ((verify.state === 'on') !== expectedOn) {
    throw new Error('写入后校验失败：期望 ' + (expectedOn ? '开启' : '关闭') + '，实际 ' + verify.state)
  }
  return mode
  } finally {
    releaseProfileLock()
  }
}

function registerRoutes(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') {
    console.warn(`${TAG} webServer unavailable; repair API not registered`)
    return
  }

  const isLoopback = (req) => {
    try {
      const address = req.socket && req.socket.remoteAddress
      return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address === undefined
    } catch {
      return false
    }
  }

  const sendJson = (res, status, value) => {
    try {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(value))
    } catch {
      /* connection gone */
    }
  }

  const guard = (handler) => async (req, res) => {
    if (!isLoopback(req)) {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      sendJson(res, Number(error && error.status) || 500, { ok: false, error: message(error) })
    }
  }

  /**
   * 校验同源 JSON POST：
   * - content-type 必须是 application/json（跨站表单无法伪造，跨站 fetch 会触发预检并失败）；
   * - 有 Origin 时必须与 Host 同源；
   * - 无 Origin 时（同源 fetch 可能不带 Origin）退而校验 Referer：存在则必须同源，缺失则依赖 JSON 预检 + 回环绑定。
   */
  const checkTrustedJsonPost = (req, res) => {
    const contentType = String((req.headers && req.headers['content-type']) || '').toLowerCase()
    if (!contentType.startsWith('application/json')) {
      sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
      return false
    }
    const host = String((req.headers && req.headers.host) || '')
    const origin = String((req.headers && req.headers.origin) || '')
    if (origin === '') {
      const referer = String((req.headers && req.headers.referer) || '')
      if (referer !== '') {
        let refererHost = ''
        try {
          const parsedReferer = new URL(referer)
          if (parsedReferer.protocol !== 'http:' && parsedReferer.protocol !== 'https:') throw new Error('bad protocol')
          refererHost = parsedReferer.host
        } catch {
          sendJson(res, 403, { ok: false, error: 'untrusted referer' })
          return false
        }
        if (refererHost !== host) {
          sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
          return false
        }
      }
      return true
    }
    let originHost = ''
    try {
      const parsedOrigin = new URL(origin)
      if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') throw new Error('bad protocol')
      originHost = parsedOrigin.host
    } catch {
      sendJson(res, 403, { ok: false, error: 'untrusted origin' })
      return false
    }
    if (originHost !== host) {
      sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
      return false
    }
    return true
  }

  /** 读取 JSON 请求体（上限 64KB）。 */
  const readJsonBody = async (req) => {
    const raw = await new Promise((resolveBody, rejectBody) => {
      let value = ''
      req.on('data', (chunk) => {
        value += chunk
        if (value.length > 64 * 1024) {
          rejectBody(Object.assign(new Error('request body too large'), { status: 413 }))
          try {
            req.destroy()
          } catch {
            /* ignore */
          }
        }
      })
      req.on('end', () => resolveBody(value))
      req.on('error', rejectBody)
    })
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      throw Object.assign(new Error('无效的 JSON 请求体'), { status: 400 })
    }
  }

  const routes = [
    {
      kind: 'exact',
      path: '/api/codex-catalog/status',
      handler: guard(async (req, res) => {
        sendJson(res, 200, await checkStatusAsync())
      }),
    },
    {
      kind: 'exact',
      path: '/api/codex-catalog/repair',
      handler: guard(async (req, res) => {
        const method = String((req && req.method) || 'GET').toUpperCase()
        if (method === 'GET') {
          sendJson(res, 200, await checkStatusAsync())
          return
        }
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'use GET or POST' })
          return
        }
        /* CSRF 防护：同源 JSON POST 校验（与 /sandbox、/settings 共用同一规则）。 */
        if (!checkTrustedJsonPost(req, res)) return
        const result = applyAll()
        sendJson(res, 200, {
          ok: result.ok,
          steps: result.steps,
          backupDir: result.backupDir || null,
        })
      }),
    },
    {
      kind: 'exact',
      path: '/api/codex-catalog/live',
      handler: guard(async (req, res) => {
        /* 只读：把镜像日志的增量翻译成面板事件。带 ?session= 时读该会话自己的文件。 */
        const url = new URL(String((req && req.url) || '/'), 'http://127.0.0.1')
        const cursorRaw = url.searchParams.get('cursor')
        const tailRaw = url.searchParams.get('tail')
        const session = url.searchParams.get('session') || ''
        const cursor = cursorRaw === null ? null : Number(cursorRaw)
        const tail = tailRaw === null ? undefined : Number(tailRaw)
        await syncLiveLogs()
        const slice = session
          ? readSessionSlice({ sessionId: session, cursor: Number.isFinite(cursor) ? cursor : null })
          : readLiveSlice({ cursor: Number.isFinite(cursor) ? cursor : null, tail })
        const wrapper = wrapperState()
        sendJson(
          res,
          200,
          Object.assign({}, slice, {
            session: session || null,
            patched: Boolean(wrapper.v2),
            legacyPatch: Boolean(wrapper.legacy),
            viewerScript: existsSync(VIEWER_PATH),
          }),
        )
      }),
    },
    {
      kind: 'exact',
      path: '/api/codex-catalog/proxy',
      handler: guard(async (req, res) => {
        const env = envProxyState()
        const proxyInfo = await detectProxyAsync()
        const wrapper = wrapperState()
        const autoProxyPatched = Boolean(
          wrapper.ok && typeof wrapper.text === 'string' && wrapper.text.includes('自动跟随 Windows 系统代理'),
        )
        sendJson(res, 200, {
          ok: true,
          systemProxy: proxyInfo.url,
          proxyState: proxyInfo.state,
          envProxy: env.proxy,
          hasEnvProxy: Boolean(env.proxy),
          autoProxyPatched,
          lastApply: proxyAutoState,
        })
      }),
    },
    {
      kind: 'exact',
      path: '/api/codex-catalog/settings',
      handler: guard(async (req, res) => {
        const method = String((req && req.method) || 'GET').toUpperCase()
        if (method === 'GET') {
          const settings = loadCatalogSettings()
          const env = envProxyState()
          const proxyInfo = await detectProxyAsync()
          const systemProxy = proxyInfo.url
          const wrapper = wrapperState()
          const autoProxyPatched = Boolean(
            wrapper.ok && typeof wrapper.text === 'string' && wrapper.text.includes('自动跟随 Windows 系统代理'),
          )
          sendJson(res, 200, {
            ok: true,
            autoUpdateCli: settings.autoUpdateCli,
            autoProxy: settings.autoProxy,
            lastCliUpdate: settings.lastCliUpdate || null,
            settingsLoadError: settings._loadError || null,
            model: settings.model || null,
            configModel: readConfigModel().value,
            modelBeforeOverride: settings.modelBeforeOverride || null,
            reasoning: settings.reasoning || null,
            configReasoning: readConfigScalar('model_reasoning_effort').value,
            reasoningBefore: settings.reasoningBefore || null,
            models: readModelsCache(),
            cli: await cliState(),
            proxy: {
              systemProxy,
              proxyState: proxyInfo.state,
              envProxy: env.proxy,
              hasEnvProxy: Boolean(env.proxy),
              autoProxyPatched,
              lastApply: proxyAutoState,
            },
          })
          return
        }
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'use GET or POST' })
          return
        }
        if (!checkTrustedJsonPost(req, res)) return
        const body = await readJsonBody(req)
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          throw Object.assign(new Error('请求体必须是 JSON 对象'), { status: 400 })
        }
        const allowedKeys = ['autoUpdateCli', 'autoProxy', 'model', 'reasoning']
        for (const key of Object.keys(body)) {
          if (!allowedKeys.includes(key)) {
            throw Object.assign(new Error('不支持的字段：' + key), { status: 400 })
          }
          if (key === 'model') {
            if (body.model === null) continue
            const normalized = normalizeModelId(body.model)
            if (normalized === null && body.model !== '') {
              throw Object.assign(new Error('model 必须是合法的模型 id 或 null'), { status: 400 })
            }
            continue
          }
          if (key === 'reasoning') {
            if (body.reasoning === null) continue
            if (normalizeReasoningEffort(body.reasoning) === null && body.reasoning !== '') {
              throw Object.assign(new Error('reasoning 必须是合法的推理深度档位或 null'), { status: 400 })
            }
            continue
          }
          if (typeof body[key] !== 'boolean') {
            throw Object.assign(new Error('字段必须是布尔值：' + key), { status: 400 })
          }
        }
        const hasModel = Object.prototype.hasOwnProperty.call(body, 'model')
        const hasReasoning = Object.prototype.hasOwnProperty.call(body, 'reasoning')
        const hasFlags = allowedKeys.some(
          (key) => key !== 'model' && key !== 'reasoning' && typeof body[key] === 'boolean',
        )
        if (!hasModel && !hasReasoning && !hasFlags) {
          throw Object.assign(new Error('没有可更新的开关'), { status: 400 })
        }
        const modelDesired = hasModel
          ? body.model === null || body.model === ''
            ? null
            : normalizeModelId(body.model)
          : undefined
        const reasoningDesired = hasReasoning
          ? body.reasoning === null || body.reasoning === ''
            ? null
            : normalizeReasoningEffort(body.reasoning)
          : undefined
        /* 推理深度必须属于当前/所选模型支持的档位（名单动态读取）。 */
        if (reasoningDesired !== null && reasoningDesired !== undefined) {
          const cache = readModelsCache()
          const settingsNow = loadCatalogSettings()
          const effectiveModel =
            modelDesired !== undefined && modelDesired !== null ? modelDesired : settingsNow.model || readConfigModel().value
          const modelInfo = cache.models.find((item) => item.id === effectiveModel)
          if (modelInfo && Array.isArray(modelInfo.reasoningLevels) && modelInfo.reasoningLevels.length > 0) {
            const supported = modelInfo.reasoningLevels.some((level) => level && level.effort === reasoningDesired)
            if (!supported) {
              throw Object.assign(new Error('推理深度不在该模型支持的档位内：' + reasoningDesired), { status: 400 })
            }
          }
        }
        /* 模型与推理深度各自走独立事务（跨进程锁 + 备份 + 失败回滚）；布尔开关走设置更新。 */
        let modelApply = null
        let modelApplyError = null
        if (hasModel) {
          try {
            modelApply = applyModelTransaction(modelDesired === undefined ? null : modelDesired)
          } catch (error) {
            modelApplyError = message(error)
          }
        }
        let reasoningApply = null
        let reasoningApplyError = null
        if (hasReasoning) {
          try {
            reasoningApply = applyReasoningTransaction(reasoningDesired === undefined ? null : reasoningDesired)
          } catch (error) {
            reasoningApplyError = message(error)
          }
        }
        if (hasFlags) {
          updateCatalogSettings((latest) => {
            for (const key of allowedKeys) {
              if (key !== 'model' && key !== 'reasoning' && typeof body[key] === 'boolean') latest[key] = body[key]
            }
          })
        }
        const settings = loadCatalogSettings()
        const configState = readConfigModel()
        sendJson(res, 200, {
          ok: true,
          autoUpdateCli: settings.autoUpdateCli,
          autoProxy: settings.autoProxy,
          model: settings.model || null,
          configModel: modelApply && modelApply.configModel !== undefined ? modelApply.configModel : configState.value,
          configModelError: configState.error,
          modelApplied: modelApply,
          modelApplyError,
          reasoning: settings.reasoning || null,
          configReasoning:
            reasoningApply && reasoningApply.value !== undefined
              ? reasoningApply.value
              : readConfigScalar('model_reasoning_effort').value,
          reasoningApplied: reasoningApply,
          reasoningApplyError,
          models: readModelsCache(),
        })
      }),
    },
    {
      kind: 'exact',
      path: '/api/codex-catalog/title',
      handler: guard(async (req, res) => {
        const method = String((req && req.method) || 'GET').toUpperCase()
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'use POST' })
          return
        }
        if (!checkTrustedJsonPost(req, res)) return
        const body = await readJsonBody(req)
        const task = body && typeof body.task === 'string' ? body.task.trim() : ''
        if (!task) {
          sendJson(res, 400, { ok: false, error: 'task is required' })
          return
        }
        sendJson(res, 200, Object.assign({ ok: true }, generateRunTitle(task)))
      }),
    },
    {
      kind: 'exact',
      path: '/api/codex-catalog/cli/restore',
      handler: guard(async (req, res) => {
        const method = String((req && req.method) || 'GET').toUpperCase()
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'use POST' })
          return
        }
        if (!checkTrustedJsonPost(req, res)) return
        sendJson(res, 200, await restoreCli())
      }),
    },
    {
      kind: 'exact',
      path: '/api/codex-catalog/sandbox',
      handler: guard(async (req, res) => {
        const method = String((req && req.method) || 'GET').toUpperCase()
        if (method === 'GET') {
          const state = readSandboxState()
          sendJson(res, 200, {
            ok: true,
            state: state.state,
            enabled: state.state === 'on',
            permissionMode: state.mode,
            error: state.error || null,
          })
          return
        }
        if (method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'use GET or POST' })
          return
        }
        /* CSRF 防护：同源 JSON POST 校验（与 /settings 共用同一规则）。 */
        if (!checkTrustedJsonPost(req, res)) return
        const rawBody = await new Promise((resolveBody, rejectBody) => {
          let raw = ''
          req.on('data', (chunk) => {
            raw += chunk
            if (raw.length > 64 * 1024) {
              rejectBody(Object.assign(new Error('request body too large'), { status: 413 }))
              try {
                req.destroy()
              } catch {
                /* ignore */
              }
            }
          })
          req.on('end', () => resolveBody(raw))
          req.on('error', rejectBody)
        })
        let parsed = null
        try {
          parsed = rawBody ? JSON.parse(rawBody) : null
        } catch {
          throw Object.assign(new Error('无效的 JSON 请求体'), { status: 400 })
        }
        if (parsed === null || typeof parsed !== 'object' || typeof parsed.enabled !== 'boolean') {
          throw Object.assign(new Error('enabled 必须是布尔值'), { status: 400 })
        }
        const mode = writeSandboxEnabled(parsed.enabled)
        const state = readSandboxState()
        sendJson(res, 200, {
          ok: true,
          state: state.state,
          enabled: state.state === 'on',
          permissionMode: mode,
          restartRequired: true,
        })
      }),
    },
  ]

  const disposers = []
  for (const route of routes) {
    try {
      const dispose = webServer.register(route)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      console.warn(`${TAG} route ${route.path} not registered: ${message(error)}`)
    }
  }
  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
  }, 'dsh-codex-fix: routes')

  console.log(`${TAG} ready — status API at /api/codex-catalog/status`)

  /* 后台预热按会话切分，避免用户第一次打开面板时等待历史日志解析。 */
  setTimeout(() => {
    syncLiveLogs().catch(() => {
      /* 预热失败不影响后续请求 */
    })
  }, 300)
}

export {
  checkStatus,
  applyAll,
  readSandboxState,
  writeSandboxEnabled,
  readLiveSlice,
  readSessionSlice,
  syncLiveLogs,
  clearLiveLogs,
  liveEventFromLine,
  patchWrapperText,
  latestWrapperBackup,
  reconstructWrapperOriginal,
  wrapperState,
  LIVE_LOG,
  LIVE_SESSIONS_DIR,
}