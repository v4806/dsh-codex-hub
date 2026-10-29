# dsh-codex-hub

DSH 本地插件：在 DSH 中查看 Codex 子智能体派发记录、运行状态与对话，统一管理沙箱、模型和推理深度，并支持 CLI 自动更新与 Windows 系统代理同步。

## 功能

- **会话页头「N 个 Codex 派发」**：点击打开目录，列出每次派发的状态、时间、thread、token、耗时；点任一项在弹层里查看该次派发的对话（「简洁」视图渲染 Markdown，「详细」视图显示原始事件流）。
- **插件详情页「Codex 子智能体沙箱」**：开关 `subagent-codex` 的 `permissionMode`（默认开启只读沙箱；关闭为无沙箱全权限），切换后需重启 DSH 生效。全新安装的 profile 里若还没有 `subagent-codex` 配置块，插件按默认值 `never`（沙箱开启）显示，并在首次切换开关时自动向 profile 的 `cordis.patch.yml` 追加标准覆盖块，无需手工编辑。
- **插件详情页「Codex 自动维护」**：自动更新 CLI（vendor codex.exe 落后时从客户端复制，备份可还原）、自动网络代理（跟随系统代理写入 `~/.codex/.env`，可关闭）、GPT 模型选择（名单动态读取 `~/.codex/models_cache.json`，默认「跟随 Codex 客户端」不写配置；选择后写入 `~/.codex/config.toml` 的 `model`，下次 Codex 派发生效，清除选择时恢复原值）、推理深度选择（档位动态读取模型缓存，写入 `model_reasoning_effort`）。
- **插件详情页「维护操作 → 检查并修复」**：一键检查并修复过程镜像补丁（`codex.js` tee）、沙箱 helper、系统代理跟随、备用窗口脚本；修复前自动备份到 `file-backups/`，可还原。插件启动时也会自动执行一次同样的幂等检查，保证全新安装即可看到派发过程。
- **host 接口**：`/api/codex-catalog/status`、`/api/codex-catalog/live`（增量读日志镜像、按会话过滤）、`/api/codex-catalog/sandbox`（GET/POST）、`/api/codex-catalog/settings`（GET 状态与模型名单；POST 开关/模型）、`/api/codex-catalog/proxy`、`/api/codex-catalog/repair`（GET 返回检查状态；POST 执行一键修复）、`/api/codex-catalog/cli/restore`（POST，同源 + application/json 校验）。

## 模型选择行为

- 默认 `model = null`：插件不写 `~/.codex/config.toml`，Codex 派发沿用客户端当前模型（与未安装本插件时一致）。
- 选择模型：先备份 `~/.codex/config.toml`，再原子替换顶层 `model` 行；记录接管前的原值，切换到「跟随客户端」时恢复（仅当配置仍为插件写入值时才覆盖，避免盖掉期间的外部修改）。
- 维护任务不会自动回写模型，避免与 Codex 客户端的模型切换互相覆盖。

## 依赖

- **必须启用官方 host 插件 `@deepseek-ai/dsh-subagent-codex`**：它注册 `subagent_codex` 工具并 spawn Codex 进程，Codex 日志镜像也由它的 wrapper 产生。禁用它后本插件只能查看历史记录，无法显示新派发。

## 数据与限制

- 数据来源：`$DSH_HOME/codex-runs/codex-raw.log`（全局镜像）与 `sessions/codex-raw-<session>.log`（按会话切分）。
- 归属：按父会话里 `subagent_codex` 工具调用的时间匹配线程；同一时间窗口内多个候选无法区分时进入待归属队列重试，超时后归为 unattributed（不显示）。
- 日志里 Codex 命令输出的中文可能因 GBK/UTF-8 编码不匹配而损坏（源头在 Codex 侧），插件只能把已损坏的替换字符显示为 ⚠。
- 容量：单会话最多保留 4000 条事件、最多 80 个派发；超出时界面会提示已截断。超过读取上限的单行会被跳过。
- 沙箱开关修改的是 profile 的 `cordis.patch.yml`（每次修改前备份到 `file-backups/`）；新装 profile 没有 `subagent-codex` 块时按默认 `permissionMode: never`（沙箱开启）显示，并在首次切换时自动追加标准覆盖块。

## 安装

从 GitHub 直接安装到 DSH profile（版本 ≥ 0.2.2）：

```
pnpm add github:v4806/dsh-codex-hub
```

安装后首次启动会自动打好过程镜像补丁并补齐沙箱 helper；也可在插件详情页「维护操作 → 检查并修复」手动重跑。图标 `icon.svg` 与 `README.md` 已包含在发布包内。

## 变更记录

- 0.2.2：`icon.svg` 加入 `files` 白名单（修复安装后包元信息 `ENOENT icon.svg`）；profile 缺 `subagent-codex` 块时沙箱状态按默认值显示、首次切换自动补块（修复「状态未知、开关禁用」）；启动时自动执行幂等修复，新增「检查并修复」按钮与 `/api/codex-catalog/repair` 接口（修复全新安装后过程镜像未打补丁、插件窗口无派发记录的问题）。
