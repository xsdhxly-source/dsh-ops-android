/**
 * dsh-ops-android v2.0.0 —— 为 Android 手机端 DSH 打造的「省 token 操作原语」。
 *
 * 设计思路（借用 dsh-ops 的核心理念，按手机特点重造）：
 *   1. 减少往返：把「读屏 → 找坐标 → 点击」压成一次调用（ops_ui_find）
 *   2. 压缩输出：控件树只给可交互元素 + 分数坐标 + 单行紧凑格式（ops_ui_digest）
 *   3. 消除轮询：等待条件在插件内部轮询，命中才返回（ops_ui_wait）
 *   4. 批量执行：一串操作一次提交（ops_ui_seq / ops_shell）
 *
 * v2.0.0 两大核心变化：
 *   - 双状态特权通道：
 *       root 态（越狱）：直接走自定义 su 命令，不依赖 Shizuku
 *       shizuku 态（坐牢）：走 App 内 /shell 通道（3081）
 *     mode 可强制指定，auto 模式按「root 优先 → Shizuku 兜底」探测。
 *   - 屏幕尺寸：自动检测（wm size）+ 手动覆盖，手动值永远优先；
 *     自动检测失败时明确要求填手动值，不再拿 1440x3200 蒙混。
 *
 * 通道：
 *   - 无障碍 App 本地服务：APP_A11Y_PORT，默认 3181
 *   - App 特权服务：APP_NOTIFY_PORT，默认 3081（/shell，uid=shell）
 * 鉴权：X-DSH-Token: APP_LOCAL_TOKEN（App 启动引擎时注入）
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { get as httpGet, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export const name = "ops-android";
export const inject = ["tools"];

/* ────────────────────────── 配置 ────────────────────────── */
export const Config = z.object({
  mode: z.string().default("auto"),
  suCommand: z.string().default("su -c"),
  screenWidth: z.number().default(0),
  screenHeight: z.number().default(0),
  a11yAutoHeal: z.boolean().default(false),
  commandTimeoutMs: z.number().default(30000),
});

const MODES = new Set(["auto", "root", "shizuku"]);

let CFG = {
  mode: "auto",
  suCommand: "su -c",
  screenWidth: 0,
  screenHeight: 0,
  a11yAutoHeal: false,
  commandTimeoutMs: 30000,
};

function resolveConfig(config) {
  const c = config && typeof config === "object" ? config : {};
  const mode = MODES.has(String(c.mode)) ? String(c.mode) : "auto";
  return {
    mode,
    suCommand: String(c.suCommand || "su -c"),
    screenWidth: Math.max(0, Number(c.screenWidth) || 0),
    screenHeight: Math.max(0, Number(c.screenHeight) || 0),
    a11yAutoHeal: c.a11yAutoHeal === true,
    commandTimeoutMs: Math.max(1000, Number(c.commandTimeoutMs) || 30000),
  };
}

const a11yPort = () => parseInt(process.env.APP_A11Y_PORT || "3181", 10);
const appPort = () => parseInt(process.env.APP_NOTIFY_PORT || "3081", 10);
const token = () => process.env.APP_LOCAL_TOKEN || "";

const GUIDE = "无障碍服务不可用：请到 设置 → 无障碍 → 开启「DeepSeek Harness 屏幕助手」";

/* ────────────────────────── 本地 HTTP ────────────────────────── */
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ────────────────────────── 进程执行（root 通道） ────────────────────────── */
function runProc(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", settled = false, timer = null;
    let p;
    try { p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { return resolve({ ok: false, error: "spawn 失败: " + String(e && e.message || e) }); }
    const finish = (v) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve(v); } };
    timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch (_) {} finish({ ok: false, error: "命令超时（" + timeoutMs + "ms）" }); }, timeoutMs);
    p.stdout.on("data", (d) => { stdout += d; if (stdout.length > 1048576) stdout = stdout.slice(0, 1048576); });
    p.stderr.on("data", (d) => { stderr += d; if (stderr.length > 262144) stderr = stderr.slice(0, 262144); });
    p.on("error", (e) => finish({ ok: false, error: "执行失败: " + String(e && e.message || e), stdout, stderr }));
    p.on("close", (code) => finish({ ok: true, exit_code: typeof code === "number" ? code : -1, stdout, stderr }));
  });
}

function quoteCmd(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

/** 用配置里的 suCommand 执行；支持 {cmd} 占位符，否则视为二进制前缀（如 "su -c"）。 */
async function runAsRoot(cmd, timeoutMs) {
  const tmpl = String(CFG.suCommand || "su -c").trim();
  const full = tmpl.includes("{cmd}") ? tmpl.replace(/\{cmd\}/g, quoteCmd(cmd)) : tmpl + " " + quoteCmd(cmd);
  return runProc("/system/bin/sh", ["-c", full], timeoutMs);
}

async function runAsShizuku(cmd, timeoutMs) {
  return call("POST", appPort(), "/shell", {
    body: { command: cmd, timeout_ms: timeoutMs, token: token() },
    timeoutMs: (timeoutMs || 30000) + 10000,
  });
}

/* ────────────────────────── 通道状态与选择 ────────────────────────── */
const STATE = { root: null, shizuku: null, probedAt: 0 };

function normRoot(r) {
  if (!r) return { ok: false, error: "root 无响应" };
  if (r.ok && r.exit_code === 0) return { ok: true, exit_code: 0, stdout: r.stdout || "", stderr: r.stderr || "" };
  const err = r.error || r.stderr || ("exit=" + r.exit_code);
  return { ok: false, error: String(err).trim() || "root 执行失败" };
}

function normShizuku(r) {
  if (!r) return { ok: false, error: "Shizuku 无响应" };
  if (typeof r.exit_code === "number") {
    return {
      ok: r.exit_code === 0,
      exit_code: r.exit_code,
      stdout: r.stdout || "",
      stderr: r.stderr || "",
      error: r.exit_code === 0 ? undefined : String(r.stderr || r.error || ("exit=" + r.exit_code)).trim(),
    };
  }
  return { ok: false, error: String(r.error || "Shizuku 不可用") };
}

async function probeRoot() {
  const r = await runAsRoot("id", 8000);
  const ok = !!(r && r.ok && r.exit_code === 0 && /\buid=0\b/.test(String(r.stdout || "")));
  STATE.root = ok;
  STATE.probedAt = Date.now();
  return ok;
}

async function probeShizuku() {
  const r = normShizuku(await runAsShizuku("id", 8000));
  STATE.shizuku = r.ok;
  STATE.probedAt = Date.now();
  return r.ok;
}

/**
 * 统一特权执行：
 *   mode=root     只走 root，失败直接报错
 *   mode=shizuku  只走 /shell
 *   mode=auto     root 优先，失败自动降级 Shizuku，再失败回 root 兜底
 */
async function privileged(cmd, timeoutMs) {
  const tmo = Math.max(1000, Number(timeoutMs) || CFG.commandTimeoutMs);
  const mode = CFG.mode;

  if (mode === "root") return normRoot(await runAsRoot(cmd, tmo));
  if (mode === "shizuku") return normShizuku(await runAsShizuku(cmd, tmo));

  if (STATE.root === null) await probeRoot();
  let rootErr = "";
  if (STATE.root === true) {
    const r = normRoot(await runAsRoot(cmd, tmo));
    if (r.ok) return r;
    rootErr = r.error || "";
    STATE.root = false;
  }
  const s = normShizuku(await runAsShizuku(cmd, tmo));
  if (s.ok) { STATE.shizuku = true; return s; }
  STATE.shizuku = false;
  const r2 = normRoot(await runAsRoot(cmd, tmo));
  if (r2.ok) { STATE.root = true; return r2; }
  return {
    ok: false,
    error: `两条特权通道都不可用。root: ${rootErr || r2.error || "-"}；shizuku: ${s.error || "-"}`,
    hint: "越狱态请先跑 GhostLock；坐牢态请启动 Shizuku。",
  };
}

/* ────────────────────────── 屏幕尺寸（手动 > 自动） ────────────────────────── */
let SCREEN = null;

async function screenSize() {
  if (CFG.screenWidth > 0 && CFG.screenHeight > 0) {
    return { w: CFG.screenWidth, h: CFG.screenHeight, source: "manual" };
  }
  if (SCREEN) return SCREEN;
  const r = await privileged("wm size", 10000);
  if (r.ok) {
    const m = /(\d+)\s*x\s*(\d+)/.exec(String(r.stdout || ""));
    if (m) {
      SCREEN = { w: Number(m[1]), h: Number(m[2]), source: "auto" };
      return SCREEN;
    }
  }
  return null;
}

function screenHint() {
  return "自动检测失败：请在插件配置里手动填写 screenWidth / screenHeight（手动值优先于自动值，填一次永久生效）。";
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
  const src = scr && scr.source === "manual" ? " 手动尺寸" : "";
  const head = `${pkg || "?"} ${shown.length}/${total}${total > shown.length ? " (+" + (total - shown.length) + " 未显示)" : ""}${src}`;
  return { total, shown: shown.length, text: [head, ...lines].join("\n"), nodes: shown };
}

async function digestText(opt) {
  const d = await dump();
  if (!d.ok) return { ok: false, error: d.error };
  const scr = await screenSize();
  if (!scr) return { ok: false, error: screenHint() };
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
  const r = await privileged(`input keyevent ${code}`, 12000);
  return r.ok ? { ok: true } : { ok: false, error: r.error || "按键失败" };
}

const findNode = (nodes, match) => {
  const re = toRe(match);
  const hit = nodes.filter((n) => re.test((n.text || "").trim()) || re.test((n.desc || "").trim()));
  hit.sort((a, b) => (b.clickable ? 1 : 0) - (a.clickable ? 1 : 0));
  return hit[0] || null;
};

/* ────────────────────────── 输出 schema ────────────────────────── */
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

/* ────────────────────────── 无障碍自愈（仅手动，需特权通道） ────────────────────────── */
async function a11yAlive() {
  const r = await a11y("/status", undefined, 4000);
  return !!(r && r.ok === true);
}

/**
 * 重新绑定无障碍服务。前提：必须有可用特权通道（Shizuku 或 root）。
 * 不做开机自启/后台保活 —— 重启后 Shizuku 与临时 root 都会消失，开机保活没有意义。
 */
async function rebindA11y() {
  const route = await privileged("id", 8000);
  if (!route.ok) {
    return { ok: false, error: "自愈需要特权通道（Shizuku 或 root），当前两者都不可用：" + (route.error || "") + "。请先启动 Shizuku，或重新越狱。" };
  }
  const SVC = "com.deepseek.harness/.AccessibilityService";
  const r1 = await privileged("settings get secure enabled_accessibility_services", 15000);
  if (!r1.ok) return { ok: false, error: "读取无障碍列表失败：" + (r1.error || "") };
  const cur = String(r1.stdout || "").trim();
  const keep = cur.split(":").map((s) => s.trim()).filter((s) => s && !s.includes("com.deepseek.harness"));
  const without = keep.join(":");
  const full = (without ? without + ":" : "") + SVC;

  const a = await privileged(`settings put secure enabled_accessibility_services '${without}'`, 15000);
  await sleep(1200);
  const b = await privileged(`settings put secure enabled_accessibility_services '${full}'`, 15000);
  const c = await privileged("settings put secure accessibility_enabled 1", 15000);
  await sleep(2500);
  if (a.ok && b.ok && c.ok) return { ok: true };
  return { ok: false, error: "写入无障碍设置失败：" + [a.error, b.error, c.error].filter(Boolean).join(" / ") };
}

/* ────────────────────────── 环境自检 ────────────────────────── */
let CURRENT_CTX = null;

async function envReport() {
  const lines = [];

  lines.push("【命令行环境】");
  lines.push(`  node=${process.version} platform=${process.platform} arch=${process.arch}`);
  lines.push(`  shell=/system/bin/sh ${existsSync("/system/bin/sh") ? "存在" : "缺失"}`);
  const pathStr = String(process.env.PATH || "");
  lines.push(`  PATH=${pathStr ? pathStr.slice(0, 180) : "(空)"}`);

  lines.push("【权限环境】");
  const rootOk = await probeRoot();
  const shzOk = await probeShizuku();
  lines.push(`  root: ${rootOk ? "可用（越狱态）" : "不可用（坐牢态）"}  suCommand=${CFG.suCommand}`);
  lines.push(`  shizuku: ${shzOk ? "可用（/shell " + appPort() + "）" : "不可用"}`);
  lines.push(`  当前模式: ${CFG.mode}${CFG.mode === "auto" ? "（root 优先，Shizuku 兜底）" : ""}`);

  lines.push("【工具环境】");
  lines.push("  本插件: ops_ui_digest / ops_ui_find / ops_ui_wait / ops_ui_seq / ops_shell / ops_a11y_ensure / ops_env");
  try {
    if (CURRENT_CTX && CURRENT_CTX.tools && typeof CURRENT_CTX.tools.schemas === "function") {
      const s = CURRENT_CTX.tools.schemas();
      const names = Array.isArray(s) ? s.map((x) => x && x.name).filter(Boolean) : Object.keys(s || {});
      if (names.length) lines.push(`  dsh 可见工具（${names.length}）: ${names.join(", ")}`);
    }
  } catch (_) { /* 拿不到工具表时静默 */ }

  lines.push("【系统环境】");
  const sys = await privileged(
    "getprop ro.build.version.release; getprop ro.build.version.sdk; getprop ro.product.model; " +
    "getprop ro.build.security_patch; getenforce", 15000);
  if (sys.ok) {
    const arr = String(sys.stdout || "").split("\n");
    lines.push(`  Android ${(arr[0] || "?").trim()} (SDK ${(arr[1] || "?").trim()}) | ${(arr[2] || "?").trim()}`);
    lines.push(`  安全补丁 ${(arr[3] || "?").trim()} | SELinux ${(arr[4] || "?").trim()}`);
  } else {
    lines.push(`  系统信息不可用：${sys.error || "未知"}`);
  }
  const scr = await screenSize();
  lines.push(`  屏幕: ${scr ? `${scr.w}x${scr.h}（${scr.source === "manual" ? "手动" : "自动"}）` : "自动检测失败，请手动填写 screenWidth/screenHeight"}`);
  const a = await a11y("/status", undefined, 4000);
  lines.push(`  无障碍: ${a && a.ok ? "运行中" : "不可用"}`);
  if (a && a.ok && a.package) lines.push(`  前台应用: ${a.package}`);

  return lines.join("\n");
}

/* ────────────────────────── 插件主体 ────────────────────────── */
function apply(ctx, config) {
  CFG = resolveConfig(config);
  CURRENT_CTX = ctx;
  SCREEN = null;
  STATE.root = null;
  STATE.shizuku = null;

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

  // 2) 找 + 直接动作
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
        if (!scr) return fail(screenHint());
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

  // 3) 等待条件
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
      if (!scr) return fail(screenHint());
      const c = compact((last && last.nodes) || [], (last && last.package) || "", scr, { limit: 12 });
      return fail(`等待「${match}」${absent ? "消失" : "出现"}超时（${timeout}ms）。当前界面：\n${c.text}`);
    }
  }));

  // 4) 批量步骤
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
          if (scr) lines.push("", compact(d.nodes, d.package, scr, { limit: 15 }).text);
        }
      }
      return out(lines.join("\n"));
    }
  }));

  // 5) 批量特权 shell（双状态通道）
  ctx.tools.register(defineTool({
    name: "ops_shell",
    description: "执行特权 shell 命令，按插件 mode 选择通道：root 态走自定义 su 命令（默认 su -c），" +
      "坐牢态走 App 内 /shell（Shizuku，uid=shell），auto 模式 root 优先、Shizuku 兜底。" +
      "多条命令用 ';' 或换行连接。返回 stdout/stderr 与退出码。",
    parameters: {
      command: { type: "string", description: "要执行的命令（可含多条，用 ; 或换行分隔）" },
      timeout_ms: { type: "number", description: "超时毫秒，默认取插件配置 commandTimeoutMs" }
    },
    output: OUTPUT,
    async execute(args) {
      const cmd = String(args.command || "").trim();
      if (!cmd) return fail("ops_shell 需要 command 参数");
      const timeout = Math.max(1000, Math.min(120000, Number(args.timeout_ms) || CFG.commandTimeoutMs));
      const r = await privileged(cmd, timeout);
      if (!r.ok) {
        return fail((r.error || "特权通道不可用") + (r.hint ? "\n提示：" + r.hint : ""));
      }
      const parts = [`exit=${r.exit_code}`];
      if (r.stdout) parts.push(r.stdout.trimEnd());
      if (r.stderr) parts.push("[stderr] " + r.stderr.trimEnd());
      return out(parts.join("\n"));
    }
  }));

  // 6) 无障碍手动自愈（不做开机保活）
  ctx.tools.register(defineTool({
    name: "ops_a11y_ensure",
    description: "检查无障碍服务是否活着；不活就重新绑定。前提是当前有特权通道（Shizuku 或 root）——" +
      "重启后 Shizuku 与临时 root 都会消失，本插件**不做开机自启/后台保活**。" +
      "ColorOS/MIUI 常杀掉无障碍进程但保留开关，此时 ops_ui_* 会报 ECONNREFUSED 127.0.0.1:3181。",
    parameters: {},
    output: OUTPUT,
    async execute() {
      if (await a11yAlive()) return out("无障碍服务正常。");
      const r = await rebindA11y();
      if (r.ok && (await a11yAlive())) return out("无障碍服务原本不可用，已重新绑定并恢复。");
      return fail(r.error || "自动重绑失败。请手动到 设置 → 无障碍 关闭再开启「DeepSeek Harness 屏幕助手」。");
    }
  }));

  // 7) 环境自检
  ctx.tools.register(defineTool({
    name: "ops_env",
    description: "环境自检：一次报告四类环境 —— 命令行环境（node/shell/PATH）、权限环境（root 与 Shizuku 可用性）、" +
      "工具环境（本插件与 dsh 可见工具）、系统环境（Android 版本/型号/安全补丁/SELinux/屏幕/无障碍/前台包名）。" +
      "排查「为什么工具不可用」时先跑这个。",
    parameters: {},
    output: OUTPUT,
    async execute() {
      return out(await envReport());
    }
  }));

  // 说明：v2 移除了 v1 的 30s 后台保活定时器。
  // 开机时 Shizuku 与临时 root 都不在，后台探活只会空转；自愈改为按需手动触发。
}

export { apply };
