# dsh-ops-android

**为 Android 手机端 DSH 打造的「省 token 操作原语」** —— 把 dsh-ops 的理念按手机特点重造，而不是移植 Windows 组件。

> 灵感来自 [T-Auto/dsh-ops](https://github.com/T-Auto/dsh-ops)（Windows x64 性能工具插件）。
> dsh-ops 依赖 Rust 原生 worker + Windows bash/pwsh 载荷（`-win32-x64`）、MSYS、
> `opsipc.dll`、DACL，这些在 arm64 Android 上**没有一行能跑**。
> 本项目用**纯 Node + App 已有的本地通道**实现同一批理念：减少往返、压缩输出、
> 消除轮询、批量执行。

---

## 手机端最烧 token 的是什么？

UI 自动化。具体表现：

| 痛点 | 旧做法 | 代价 |
|---|---|---|
| 读一次屏幕 | `android_screen` 吐出 40~110 个节点，每节点带 4 个像素数字 + 大量无文字容器 | 输出冗长 |
| 点一个按钮 | 先读屏（1 轮）→ 分析找坐标 → 再点击（1 轮） | 2 次往返 |
| 等界面出现 | 外面反复调读屏轮询 | N 次往返 |
| 连做几步操作 | 每步一次工具调用 | 5~10 次往返 |
| 跑几条命令 | 每条一次调用 | N 次往返 |

**每省一轮往返，就少重发一次完整上下文** —— 在长会话里这才是 token 消耗的大头。

---

## 六个工具

| 工具 | 作用 | 省在哪 |
|---|---|---|
| `ops_ui_digest` | 紧凑读屏：只列「可交互或有文字」的元素，0~1 分数坐标，单行一个，默认分页 | 输出 ↓约 50%，界面越大越明显 |
| `ops_ui_find` | 按文字/正则查找元素并**直接执行动作**（tap/input/hold/none） | 把「读屏→定位→动作」压成 1 轮 |
| `ops_ui_wait` | 等待文字出现/消失，**插件内部轮询**，命中即返回 | N 轮 → 1 轮（实测 258ms 命中） |
| `ops_ui_seq` | 一次提交一串 UI 步骤（tap/input/back/home/scroll/wait/sleep） | 5~10 轮 → 1 轮 |
| `ops_shell` | 一次执行一批特权 shell 命令 | N 轮 → 1 轮 |
| `ops_a11y_ensure` | 检查无障碍服务是否真的活着，不活就自动重新绑定 | 免去人工救场 |

紧凑读屏示例（真实输出）：

```
com.deepseek.harness 25/41 (+16 未显示)
0 MT论坛反编译教程搜索 — DeepSeek Harness @.50,.51
1 写入 dsh-ops-android/cordis.patch.yml  @.49,.05 T
2 展开侧边栏 @.06,.07 T
8 对话 @.18,.12 T*
...
```

标志位：`T`=可点击 `I`=可输入 `S`=可滚动 `*`=已选中 `+`=已勾选

---

## 设计理念（借自 dsh-ops）

1. **减少往返** —— `ops_ui_find` / `ops_ui_seq` / `ops_shell`
2. **压缩输出** —— `ops_ui_digest`：分数坐标、标志位、去重、视觉排序、分页
3. **消除报错循环** —— `ops_ui_wait` 内置轮询；失败时**附当前界面摘要**，一眼看出卡在哪
4. **渐进式披露** —— 只注册 6 个工具而非 20 个，减少 system prompt 占用；digest 默认只给 25 条

---

## 无障碍服务保活（自愈）

ColorOS / MIUI 等激进省电系统会**杀掉无障碍服务进程，但保留开关状态**。
此时 `enabled_accessibility_services` 里仍写着该服务，系统却不再绑定它，
表现为所有 `ops_ui_*` 报 `connect ECONNREFUSED 127.0.0.1:3181`。

插件内置两种自愈：

- **后台定时器**：每 30 秒探测一次 `/status`；**连续 2 次失败**才动手，
  重新绑定后 **60 秒冷却**，避免抖动与惊群。定时器 `unref()`，
  随插件 dispose 清理。
- **手动触发**：`ops_a11y_ensure`，立即检查并修复。

重新绑定的做法是把该服务从 `enabled_accessibility_services` 里**移除再写回**
（toggle），只有这样才能触发系统重新绑定：

```sh
CUR=$(settings get secure enabled_accessibility_services)
W=$(echo "$CUR" | tr ':' '\n' | grep -v "com.deepseek.harness" | tr '\n' ':' | sed 's/:$//')
settings put secure enabled_accessibility_services "$W"
sleep 1
settings put secure enabled_accessibility_services "$CUR"
settings put secure accessibility_enabled 1
```

> ⚠️ 这条命令必须由 **uid=shell** 执行（本插件走 `APP_NOTIFY_PORT` 的 `/shell` 通道，
> 实测 `uid=2000(shell)`）。从 App 自身 uid 直接跑 `settings put` 会报
> `SecurityException: requires android.permission.INTERACT_ACROSS_USERS`。

也可以额外用 [Service-Keeper](https://github.com/sklndev/Service-Keeper) 双保险，
但它需要你在 Shizuku 里手动授权后才能枚举无障碍服务。

---

## 通道依赖

本项目**不引入原生依赖**，复用 App 已有的两条本地 HTTP 通道：

| 通道 | 环境变量 | 默认 | 用途 |
|---|---|---|---|
| 无障碍服务 | `APP_A11Y_PORT` | `3181` | `/status` `/dump` `/tap` `/input` `/scroll` `/hold` `/swipe` `/screenshot` |
| App 特权服务 | `APP_NOTIFY_PORT` | `3081` | `/shell`（uid=shell） |

鉴权：请求头 `X-DSH-Token: $APP_LOCAL_TOKEN`（App 启动引擎时注入）。

---

## 安装

作为 DSH profile bundle 安装（`patchReload: live`，装完热加载，无需重启引擎）：

```js
// 用 DSH 的 plugin_manager 工具，target 传包目录的绝对路径
plugin_manager({ action: "install_bundle", target: "/绝对路径/dsh-ops-android" })
```

包内需要能解析 harness 自带的 `@deepseek-ai/dsh-tools`：

```bash
mkdir -p <pkg>/node_modules/@deepseek-ai
ln -sfn <dsh>/node_modules/@deepseek-ai/dsh-tools <pkg>/node_modules/@deepseek-ai/dsh-tools
```

### 前提

- 无障碍服务已开启（设置 → 无障碍 → DeepSeek Harness 屏幕助手）
- 若系统会杀无障碍进程，插件自身会自愈（见上节），无需人工介入

---

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `connect ECONNREFUSED 127.0.0.1:3181` | 无障碍进程被杀（开关还在但没绑定） | 调 `ops_a11y_ensure`；插件也会在 30s 内自愈 |
| `本地服务不可用 ...:3081` | App 引擎未运行 | 启动 DSH |
| `settings put` 报 `INTERACT_ACROSS_USERS` | 用了 App uid 而不是 shell uid | 走 `/shell` 通道（`ops_shell` 或 `appShell`） |
| 新加的工具在本会话看不到 | 工具列表在会话内是冻结的 | 新建会话，或重启引擎 |

---

## 兼容性

- 目标宿主：DSH Android 版（内核 `0.2.0-rc.2` 及以上）
- 纯 ESM、Node `>=18`、无原生依赖、无需 root

## License

MIT
