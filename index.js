/**
 * dsh-ops-android —— 为 Android 手机端 DSH 打造的「省 token 操作原语」。
 *
 * 设计思路（借用 dsh-ops 的核心理念，按手机特点重造，而非移植）：
 *   1. 减少往返：把「读屏 → 找坐标 → 点击」压成一次调用（ops_ui_find）
 *   2. 压缩输出：控件树只给可交互元素 + 分数坐标 + 单行紧凑格式（ops_ui_digest）
 *   3. 消除轮询：等待条件在插件内部轮询，命中才返回（ops_ui_wait）
 *   4. 批量执行：一串操作一次提交，只回最终状态（ops_ui_seq / ops_shell）
 *
 * 通道：
 *   - 无障碍 App 本地服务：APP_A11Y_PORT，默认 3181（/dump /tap /input /scroll /hold /swipe /screenshot）
 *   - App 特权服务：APP_NOTIFY_PORT，默认 3081（/shell）
 * 鉴权：X-DSH-Token: APP_LOCAL_TOKEN（App 启动引擎时注入）
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { get as httpGet, request as httpRequest } from "node:http";

const name = "ops-android";
const inject = ["tools"];

const a11yPort = () => parseInt(process.env.APP_A11Y_PORT || "3181", 10);
const appPort = () => parseInt(process.env.APP_NOTIFY_PORT || "3081", 10);
const token = () => process.env.APP_LOCAL_TOKEN || "";

const GUIDE = "无障碍服务不可用：请到 设置 → 无障碍 → 开启「DeepSeek Harness 屏幕助手」";

/** 统一的本地 HTTP 调用（自动带鉴权头、JSON 解析、超时兜底）。 */
function call(method, port, path, opts = {}) {
  const { params, body, timeoutMs } = opts;
  return new Promise((resolve) => {
    const qs = params
      ? "?" + Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== null && v !== "")
          .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&")
      : "";
    const payload = body ? JSON.stringify(body) : null;
    const headers = { "X-DSH-Token": token() };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const fn = method === "POST" ? httpRequest : httpGet;
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let r;
    try {
      r = fn({ host: "127.0.0.1", port, path: path + qs, method, headers, timeout: timeoutMs || 8000 }, (res) => {
        let d = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { d += c; if (d.length > 524288) { try { r.destroy(); } catch (_) {} } });
        res.on("end", () => {
          try { done(d ? JSON.parse(d) : { ok: false, error: "空响应" }); }
          catch (e) { done({ ok: false, error: "响应解析失败: " + String(d).slice(0, 120) }); }
        });
      });
    } catch (e) { done({ ok: false, error: String(e && e.message || e) }); return; }
    r.on("error", (e) => done({ ok: false, error: "本地服务不可用: " + String(e && e.message || e) }));
    r.on("timeout", () => { try { r.destroy(); } catch (_) {} done({ ok: false, error: "本地服务超时" }); });
    if (payload) r.write(payload);
    r.end();
  });
}

const a11y = (path, params, timeoutMs) => call("GET", a11yPort(), path, { params, timeoutMs });
const a11yPost = (path, body, timeoutMs) => call("POST", a11yPort(), path, { body, timeoutMs });
const appShell = (command, timeoutMs) =>
  call("POST", appPort(), "/shell", { body: { command, timeout_ms: timeoutMs || 30000, token: token() }, timeoutMs: (timeoutMs || 30000) + 10000 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ────────────────────────── 屏幕尺寸（缓存） ────────────────────────── */
let SCREEN = null;
async function screenSize() {
  if (SCREEN) return SCREEN;
  const r = await appShell("wm size", 10000);
  const m = /(\d+)\s*x\s*(\d+)/.exec(String((r && r.stdout) || ""));
  SCREEN = m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1440, h: 3200 };
  return SCREEN;
}

/* ────────────────────────── 读屏 ────────────────────────── */
async function dump() {
  const v = await a11y("/dump", undefined, 9000);
  if (!v || v.ok !== true) return { ok: false, error: (v && v.error) || GUIDE };
  return { ok: true, package: String(v.package || ""), nodes: Array.isArray(v.nodes) ? v.nodes : [] };
}

function toRe(s) {
  const t = String(s || "");
  const m = /^\/(.*)\/([gimsuy]*)$/.exec(t);
  try { return m ? new RegExp(m[1], m[2].replace("g", "")) : new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
  catch (_) { return new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
}

const label = (n) => ((n.text || "").trim() || (n.desc || "").trim() || String(n.cls || "").split(".").pop() || "?").replace(/\s+/g, " ");

/**
 * 紧凑化：过滤 → 去重 → 视觉排序 → 截断。
 * 只输出「可交互或有文字」的节点，坐标换成 0~1 分数（短且免疫截图缩放）。
 */
function compact(nodes, pkg, scr, opt = {}) {
  const { match, all = false, limit = 25 } = opt;
  const re = match ? toRe(match) : null;
  let list = nodes.filter((n) => {
    const t = (n.text || "").trim(), d = (n.desc || "").trim();
    const informative = n.clickable || n.input || n.scrollable || t || d;
    if (!informative && !all) return false;
    if (!t && !d && !n.clickable && !n.input && !n.scrollable) return false;
    if (re && !re.test(t) && !re.test(d)) return false;
    return true;
  });
  const seen = new Set();
  list = list.filter((n) => {
    const k = [label(n).slice(0, 48), n.x, n.y, n.w, n.h].join("|");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  list.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const total = list.length;
  const shown = list.slice(0, limit);
  const W = (scr && scr.w) || 1440, H = (scr && scr.h) || 3200;
  const lines = shown.map((n, i) => {
    const fx = ((n.x + n.w / 2) / W).toFixed(2).replace(/^0\./, ".");
    const fy = ((n.y + n.h / 2) / H).toFixed(2).replace(/^0\./, ".");
    const f = (n.clickable ? "T" : "") + (n.input ? "I" : "") + (n.scrollable ? "S" : "")
      + (n.selected ? "*" : "") + (n.checked ? "+" : "");
    return `${i} ${label(n).slice(0, 36)} @${fx},${fy}${f ? " " + f : ""}`;
  });
  const head = `${pkg || "?"} ${shown.length}/${total}${total > shown.length ? " (+" + (total - shown.length) + " 未显示)" : ""}`;
  return { total, shown: shown.length, text: [head, ...lines].join("\n"), nodes: shown };
}

async function digestText(opt) {
  const d = await dump();
  if (!d.ok) return { ok: false, error: d.error };
  const scr = await screenSize();
  const c = compact(d.nodes, d.package, scr, opt);
  if (!c.total) return { ok: true, text: `${d.package || "?"} 0/? —— 没有匹配的可交互元素` };
  return { ok: true, text: c.text };
}

/* ────────────────────────── 动作 ────────────────────────── */
async function doTap(n) {
  const params = {};
  if (n.text) params.text = n.text;
  else if (n.desc) params.desc = n.desc;
  else { params.x = String(n.x + n.w / 2); params.y = String(n.y + n.h / 2); }
  const r = await a11y("/tap", params, 9000);
  return r && r.ok === true ? { ok: true } : { ok: false, error: (r && r.error) || "点击失败" };
}

async function doInput(text, paste) {
  const r = await a11y("/input", { text: String(text), ...(paste ? { paste: "true" } : {}) }, 12000);
  return r && r.ok === true ? { ok: true } : { ok: false, error: (r && r.error) || "输入失败" };
}

async function doKey(code) {
  const r = await appShell(`input keyevent ${code}`, 12000);
  return r && typeof r.exit_code === "number" && r.exit_code === 0 ? { ok: true } : { ok: false, error: (r && (r.error || r.stderr)) || "按键失败" };
}

const findNode = (nodes, match) => {
  const re = toRe(match);
  const hit = nodes.filter((n) => re.test((n.text || "").trim()) || re.test((n.desc || "").trim()));
  hit.sort((a, b) => (b.clickable ? 1 : 0) - (a.clickable ? 1 : 0));
  return hit[0] || null;
};

/* ────────────────────────── 输出 schema（所有工具共用） ────────────────────────── */
const OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      ok: { type: "boolean", required: true },
      error: { type: "string" },
      text: { type: "string" }
    }
  },
  render: (_a, v) => {
    const r = v && typeof v === "object" ? v : { ok: false, error: "无结果" };
    return [{ type: "text", text: r.ok ? (r.text || "操作成功。") : "执行失败：" + (r.error || "未知错误") }];
  }
};
const out = (text) => ({ ok: true, text });
const fail = (error) => ({ ok: false, error });

/* ────────────────────────── 插件主体 ────────────────────────── */
function apply(ctx) {
  // 1) 紧凑读屏
  ctx.tools.register(defineTool({
    name: "ops_ui_digest",
    description: "紧凑读取当前屏幕：只列出「可交互或有文字」的元素，用 0~1 分数坐标，单行一个，" +
      "默认最多 25 条（分页提示还剩多少）。相比 android_screen 能省大量 token。" +
      "标志位：T=可点击 I=可输入 S=可滚动 *=已选中 +=已勾选。用 match 过滤、all=true 看全部。",
    parameters: {
      match: { type: "string", description: "只显示文字/描述匹配的元素（支持 /正则/）" },
      all: { type: "boolean", description: "true=连不可交互的元素也列出（默认 false）" },
      limit: { type: "number", description: "最多显示多少条，默认 25" }
    },
    output: OUTPUT,
    async execute(args) {
      return digestText({
        match: args.match,
        all: args.all === true,
        limit: Math.max(1, Math.min(200, Number(args.limit) || 25))
      });
    }
  }));

  // 2) 找 + 直接动作（省掉一轮往返）
  ctx.tools.register(defineTool({
    name: "ops_ui_find",
    description: "在屏幕上按文字/描述查找元素，并可**直接执行动作**（tap/input/hold/none），一步完成" +
      "「读屏→定位→操作」，省掉中间那次读屏往返。找到后会回报命中的文字与动作结果。",
    parameters: {
      match: { type: "string", description: "要查找的文字或 /正则/（必填）" },
      action: { type: "string", description: "tap(默认) / input / hold / none(只查找)" },
      value: { type: "string", description: "action=input 时要输入的文本" },
      paste: { type: "boolean", description: "输入时用剪贴板粘贴（网页/WebView 建议 true）" },
      durationMs: { type: "number", description: "action=hold 时的按住毫秒数，默认 600" }
    },
    output: OUTPUT,
    async execute(args) {
      const match = String(args.match || "").trim();
      if (!match) return fail("ops_ui_find 需要 match 参数");
      const d = await dump();
      if (!d.ok) return fail(d.error);
      const n = findNode(d.nodes, match);
      if (!n) {
        const scr = await screenSize();
        const c = compact(d.nodes, d.package, scr, { limit: 12 });
        return fail(`没找到「${match}」。当前界面：\n${c.text}`);
      }
      const action = String(args.action || "tap").toLowerCase();
      let res = { ok: true }, what = "命中";
      if (action === "tap") { res = await doTap(n); what = "点击"; }
      else if (action === "input") {
        const t = args.value === undefined ? "" : String(args.value);
        const r1 = await doTap(n); if (!r1.ok) { res = r1; what = "聚焦失败"; }
        else { res = await doInput(t, args.paste === true); what = `输入「${t}」`; }
      } else if (action === "hold") {
        const r = await a11y("/hold", { x: String(n.x + n.w / 2), y: String(n.y + n.h / 2), durationMs: String(Math.max(100, Number(args.durationMs) || 600)) }, 12000);
        res = r && r.ok === true ? { ok: true } : { ok: false, error: (r && r.error) || "长按失败" };
        what = "长按";
      }
      if (!res.ok) return fail(`${what}「${label(n)}」失败：${res.error}`);
      return out(`${what}「${label(n)}」成功`);
    }
  }));

  // 3) 等待条件（插件内轮询，外面只等一次）
  ctx.tools.register(defineTool({
    name: "ops_ui_wait",
    description: "等待某个文字出现（或消失），在插件内部轮询，命中即返回，省掉反复读屏的往返。" +
      "默认 15 秒超时、700ms 轮询。返回命中耗时；超时会附上当前界面摘要帮你判断卡在哪。",
    parameters: {
      match: { type: "string", description: "要等待的文字或 /正则/（必填）" },
      absent: { type: "boolean", description: "true=等它消失（默认等它出现）" },
      timeout_ms: { type: "number", description: "超时毫秒，默认 15000" },
      interval_ms: { type: "number", description: "轮询间隔毫秒，默认 700" }
    },
    output: OUTPUT,
    async execute(args) {
      const match = String(args.match || "").trim();
      if (!match) return fail("ops_ui_wait 需要 match 参数");
      const absent = args.absent === true;
      const timeout = Math.max(500, Math.min(120000, Number(args.timeout_ms) || 15000));
      const interval = Math.max(200, Math.min(5000, Number(args.interval_ms) || 700));
      const t0 = Date.now();
      let last = null;
      while (Date.now() - t0 < timeout) {
        const d = await dump();
        if (!d.ok) return fail(d.error);
        last = d;
        const n = findNode(d.nodes, match);
        if (absent ? !n : !!n) {
          return out(`${absent ? "已消失" : "已出现"}「${match}」（${Date.now() - t0}ms）`);
        }
        await sleep(interval);
      }
      const scr = await screenSize();
      const c = compact((last && last.nodes) || [], (last && last.package) || "", scr, { limit: 12 });
      return fail(`等待「${match}」${absent ? "消失" : "出现"}超时（${timeout}ms）。当前界面：\n${c.text}`);
    }
  }));

  // 4) 批量步骤（把 N 轮压成 1 轮）
  ctx.tools.register(defineTool({
    name: "ops_ui_seq",
    description: "一次提交一串 UI 操作并按序执行，只回最终状态，把 5~10 轮工具往返压成 1 轮。" +
      "steps 里每步是一个 {action,...}：tap(text|fx|fy) / input(text,paste) / back / home / " +
      "scroll(direction) / wait(match,absent,timeout_ms) / sleep(ms)。默认执行完附一张紧凑界面摘要。",
    parameters: {
      steps: { type: "array", description: "步骤数组，例：[{\"action\":\"tap\",\"text\":\"搜索\"},{\"action\":\"input\",\"text\":\"耳机\",\"paste\":true},{\"action\":\"wait\",\"match\":\"销量\"}]" },
      final_digest: { type: "boolean", description: "结束时是否附紧凑界面摘要，默认 true" },
      stop_on_error: { type: "boolean", description: "出错是否停止，默认 true" }
    },
    output: OUTPUT,
    async execute(args) {
      const steps = Array.isArray(args.steps) ? args.steps : [];
      if (!steps.length) return fail("ops_ui_seq 需要 steps 数组");
      const stopOnError = args.stop_on_error !== false;
      const log = [];
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i] && typeof steps[i] === "object" ? steps[i] : {};
        const a = String(s.action || "").toLowerCase();
        let r = { ok: true }, note = a;
        if (a === "tap") {
          if (s.text !== undefined || s.desc !== undefined) {
            const d = await dump();
            if (!d.ok) { r = { ok: false, error: d.error }; }
            else {
              const n = findNode(d.nodes, s.text !== undefined ? s.text : s.desc);
              if (!n) r = { ok: false, error: `没找到「${s.text !== undefined ? s.text : s.desc}」` };
              else { r = await doTap(n); note = `tap ${label(n)}`; }
            }
          } else {
            const p = {};
            if (s.fx !== undefined) p.fx = String(Number(s.fx));
            if (s.fy !== undefined) p.fy = String(Number(s.fy));
            if (s.x !== undefined) p.x = String(Number(s.x));
            if (s.y !== undefined) p.y = String(Number(s.y));
            const rr = await a11y("/tap", p, 9000);
            r = rr && rr.ok === true ? { ok: true } : { ok: false, error: (rr && rr.error) || "点击失败" };
            note = `tap ${p.fx !== undefined ? p.fx + "," + p.fy : p.x + "," + p.y}`;
          }
        } else if (a === "input") {
          r = await doInput(s.text === undefined ? "" : s.text, s.paste === true);
          note = `input ${String(s.text || "").slice(0, 20)}`;
        } else if (a === "back") { r = await doKey(4); note = "back"; }
        else if (a === "home") { r = await doKey(3); note = "home"; }
        else if (a === "scroll") {
          const rr = await a11y("/scroll", { direction: String(s.direction || "down") }, 9000);
          r = rr && rr.ok === true ? { ok: true } : { ok: false, error: (rr && rr.error) || "滚动失败" };
          note = `scroll ${s.direction || "down"}`;
        } else if (a === "wait") {
          const match = String(s.match || "").trim();
          const timeout = Math.max(500, Math.min(60000, Number(s.timeout_ms) || 8000));
          const t0 = Date.now();
          let hit = false;
          while (Date.now() - t0 < timeout) {
            const d = await dump();
            if (!d.ok) { r = { ok: false, error: d.error }; break; }
            const n = findNode(d.nodes, match);
            if (s.absent === true ? !n : !!n) { hit = true; break; }
            await sleep(600);
          }
          if (r.ok === false) { /* 保留错误 */ }
          else if (!hit) r = { ok: false, error: `等待「${match}」超时` };
          note = `wait ${match}`;
        } else if (a === "sleep") {
          await sleep(Math.max(0, Math.min(30000, Number(s.ms) || 500)));
          note = `sleep ${Number(s.ms) || 500}ms`;
        } else {
          r = { ok: false, error: `不认识的 action：${a}` };
        }
        log.push(`${i + 1}. ${note} → ${r.ok ? "ok" : "FAIL: " + r.error}`);
        if (!r.ok && stopOnError) {
          return fail(`第 ${i + 1} 步失败（${note}）：${r.error}\n已完成：\n${log.join("\n")}`);
        }
      }
      const lines = [`完成 ${steps.length} 步：`, ...log];
      if (args.final_digest !== false) {
        const d = await dump();
        if (d.ok) {
          const scr = await screenSize();
          lines.push("", compact(d.nodes, d.package, scr, { limit: 15 }).text);
        }
      }
      return out(lines.join("\n"));
    }
  }));

  // 5) 批量 shell（一次多条命令，只回必要输出）
  ctx.tools.register(defineTool({
    name: "ops_shell",
    description: "一次执行一批特权 shell 命令（走 App 内 /shell 通道，uid=shell），多条命令用 ';' 或换行连接，" +
      "只回 stdout/stderr 与退出码。用于把多次 shizuku_shell 往返压成一次。",
    parameters: {
      command: { type: "string", description: "要执行的命令（可含多条，用 ; 或换行分隔）" },
      timeout_ms: { type: "number", description: "超时毫秒，默认 30000" }
    },
    output: OUTPUT,
    async execute(args) {
      const cmd = String(args.command || "").trim();
      if (!cmd) return fail("ops_shell 需要 command 参数");
      const r = await appShell(cmd, Math.max(1000, Math.min(120000, Number(args.timeout_ms) || 30000)));
      if (!r || typeof r.exit_code !== "number") return fail((r && r.error) || "特权通道不可用");
      const parts = [`exit=${r.exit_code}`];
      if (r.stdout) parts.push(r.stdout.trimEnd());
      if (r.stderr) parts.push("[stderr] " + r.stderr.trimEnd());
      if (r.error) parts.push("[error] " + r.error);
      return out(parts.join("\n"));
    }
  }));
}

export { name, inject, apply };
