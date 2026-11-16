// Model Health Guard — 模型健康守护
//
// 规则：对主模型发最小请求 → 连续 N 次失败 → 自动切换到 fallback 并推告警。
//
// ⚠️ 为什么需要这个脚本（最重要的一条）：
//   模型会「半死」—— HTTP 200 但不吐任何内容，SSE 流空转直到超时。
//   对客户端来说这是「成功响应」→ 不触发 fallback；对监控来说这是「有响应」→ 可能判 OK。
//   结果：AI 完全失联，日志里却没有任何错误。
//   所以健康检查必须校验【内容非空】，不能只看 HTTP 状态码。
//
// ⚠️ 第二个坑：用来测健康的请求 max_tokens 不能太小。
//   推理模型会把小预算全烧在 reasoning 上，content 返回空 → 健康时误判为故障。
//
// 用法：
//   node model-health-check.mjs            # 巡检
//   MH_TEST_TG=1 node model-health-check.mjs   # 只测告警通道，不切换模型
//
// 配置：从 openclaw.json 读取 primary 与 fallbacks（不硬编码模型名）
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const HOME = os.homedir();
const OCHOME = process.env.OCHOME || join(HOME, '.openclaw');
const CFG = JSON.parse(readFileSync(join(OCHOME, 'openclaw.json'), 'utf8'));
const STATE_DIR = join(process.env.LOCALAPPDATA || join(HOME, '.openclaw'), 'OpenClawWatchdog');
const STATE_FILE = join(STATE_DIR, 'model-health.json');
const LOG_FILE = join(STATE_DIR, 'model-health.log');
const OPENCLAW_MJS = process.env.OPENCLAW_MJS || 'openclaw';
// 2026-11-17 修：原为硬编码 'deepseek/deepseek-v4-flash'（当时唯一可用），
//   但后来主模型改成了 flash → `primary === BACKUP_MODEL` 恒成立 → 永远走「已是唯一模型
//   无法切换」分支，备胎（pro）一次都没被用上。现改为从 config 的 fallbacks 读。
const BACKUP_MODEL = (() => {
  const fb = CFG.agents?.defaults?.model?.fallbacks;
  if (Array.isArray(fb) && fb.length) return fb[0];
  const alt = process.env.MH_BACKUP_MODEL;
  if (alt) return alt;
  return null; // 无备胎 → 走「无备份可用」告警分支
})();
const TIMEOUT_MS = 30000;      // 单次检测超时：30s（正常模型 1-2s 返回）
const MAX_FAILS = 3;           // 连续 3 次失败触发（第 1、2 次计数，第 3 次执行切换）
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
// 2026-09-15：告警冷却——长时间中断时（实测 09-15 凌晨持续 2.5h）原先每 ~15min 重发一次，
// 一晚共发 7 条；改为 1h 内最多 1 条（状态里记 lastAlertAt）
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

const primary = CFG.agents?.defaults?.model?.primary;

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try { writeFileSync(LOG_FILE, line, { flag: 'a' }); } catch {}
}

if (!primary) { log('[model-health] no primary model configured'); console.log('NO_REPLY'); process.exit(0); }
const [provider, model] = primary.split('/');
if (!provider || !model) { log('[model-health] bad primary ref: ' + primary); console.log('NO_REPLY'); process.exit(0); }
log(`[model-health] primary=${primary} backup=${BACKUP_MODEL || '(none)'}`);

const provCfg = CFG.models?.providers?.[provider];
if (!provCfg?.baseUrl) { log('[model-health] provider config missing: ' + provider); console.log('NO_REPLY'); process.exit(0); }

// 取 API key：deepseek 用环境变量；wechat 用 ~/.openclaw/.env
let apiKey = null;
if (provider === 'deepseek') apiKey = process.env.DEEPSEEK_API_KEY;
else if (provider === 'wechat') {
  const envFile = join(OCHOME, '.env');
  if (existsSync(envFile)) {
    const m = readFileSync(envFile, 'utf8').match(/^WECHAT_API_KEY=(.+)$/m);
    if (m) apiKey = m[1].trim();
  }
}
if (!apiKey) { log('[model-health] no api key for provider ' + provider); console.log('NO_REPLY'); process.exit(0); }

async function checkHealth() {
  const url = provCfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const body = { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 512 };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    return { ok: !!content && content.length > 0, detail: content ? 'ok' : 'empty content' };
  } catch (e) {
    return { ok: false, detail: e.name === 'AbortError' ? `timeout>${TIMEOUT_MS}ms` : e.message };
  } finally { clearTimeout(t); }
}

async function tgNotify(text) {
  const token = CFG.channels?.telegram?.botToken;
  if (!token) { log('[model-health] no tg token -> alert skipped'); return { sent: false, reason: 'no-token' }; }
  // 2026-09-15：静默时段（23:00-08:00）不发射模型告警——凌晨叫醒博涵也无人处理；
  // 恢复后由下一轮正常输出（但会受下面 1h 冷却约束）
  const hourCN = Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false, hourCycle: 'h23' }));
  if (hourCN >= 23 || hourCN < 8) {
    log(`[model-health] quiet hours -> alert suppressed: ${String(text).slice(0, 100)}`);
    return { sent: false, reason: 'quiet' };
  }
  // 2026-11-03 修：原先用 Node fetch 直连 api.telegram.org —— Node 的 fetch 不读 HTTP_PROXY
  //   环境变量，实测 10.6s 后 "fetch failed"，所以告警从来没真正发出去过，日志却把原因写成
  //   "(quiet hours?)"。改为 curl 显式走代理 + --ssl-no-revoke（见 TOOLS.md 告警链路 TLS 坑），
  //   并且把「静默」与「发送失败」分开记录，不再混为一谈。
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || CFG?.proxy?.url || '';
  const tmp = join(STATE_DIR, 'tg-payload.json');
  try {
    writeFileSync(tmp, JSON.stringify({ chat_id: TG_CHAT_ID, text }), 'utf8');
    const r = spawnSync('curl.exe', [
      '-s', '--ssl-no-revoke', '--proxy', proxy, '--max-time', '20',
      '-X', 'POST', '-H', 'Content-Type: application/json',
      '-d', '@' + tmp,
      `https://api.telegram.org/bot${token}/sendMessage`
    ], { encoding: 'utf8', timeout: 25000, windowsHide: true });
    let ok = false;
    try { ok = JSON.parse(r.stdout || '{}').ok === true; } catch { }
    if (!ok) log(`[model-health] TG send FAILED: ${String(r.stdout || r.stderr || '').slice(0, 200)}`);
    return { sent: ok, reason: ok ? 'sent' : 'send-failed' };
  } catch (e) {
    log(`[model-health] TG send EXCEPTION: ${e.message}`);
    return { sent: false, reason: 'send-failed' };
  }
}

function switchModel(target) {
  const patchFile = join(STATE_DIR, 'switch-patch.json5');
  writeFileSync(patchFile, `{ agents: { defaults: { model: { primary: "${target}" } } } }`, 'utf8');
  const res = spawnSync(process.execPath, [OPENCLAW_MJS, 'config', 'patch', '--file', patchFile], { encoding: 'utf8', timeout: 60000 });
  return res.status === 0;
}

// 2026-11-03 新增：清理会话级模型覆盖（providerOverride / modelOverride）。
// 背景：某个会话被 /status 或 session_status 手动钉在某个模型上时，全局 primary 改了也带不走它
//   —— 这使自动回滚对那个会话失效（博涵 20:46 问的「切 pro 出问题能不能自己回滚」的实质隐患）。
// 只清理指向「正在故障的那个模型」的覆盖；其他有意钉死的会话不动。
// 2026-11-03 21:25 修：sessions.json 是「对象」（sessionKey -> 记录），不是数组，
//   原先按数组遍历会直接跳过所有会话（静默失效）——实例对比发现：
//   { "agent:main:qqbot:direct:xxx": { modelOverride: "deepseek-v4-pro", ... }, ... }
function clearSessionOverrides(failingModel) {
  const failModelId = String(failingModel || '').split('/').pop();
  const files = [
    join(OCHOME, 'agents', 'main', 'sessions', 'sessions.json'),
  ];
  let cleared = 0;
  const details = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    let data;
    try { data = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
    // 兼容两种形状：对象（当前实现）与数组（早期可能写法）
    const records = Array.isArray(data) ? data : (data && typeof data === 'object' ? Object.values(data) : []);
    const keys = Array.isArray(data) ? null : Object.keys(data || {});
    let dirty = false;
    records.forEach((s, i) => {
      if (!s || typeof s !== 'object') return;
      const mo = s.modelOverride;
      if (!mo) return;
      if (failModelId && mo !== failModelId) return;
      if (!dirty) { try { writeFileSync(f + '.bak-modelhealth', readFileSync(f)); } catch { } }
      delete s.modelOverride;
      delete s.providerOverride;
      delete s.modelOverrideSource;
      cleared++;
      dirty = true;
      details.push((keys ? keys[i] : '#' + i) + ' (was ' + mo + ')');
    });
    if (dirty) {
      try { writeFileSync(f, JSON.stringify(data, null, 2), 'utf8'); } catch (e) { log('[model-health] clearSessionOverrides write fail: ' + e.message); }
    }
  }
  if (cleared) log('[model-health] cleared ' + cleared + ' session override(s): ' + details.join(', '));
  return cleared;
}

// 2026-11-03 加：告警通道自测钩子（不触发切换、不改配置）
//   用法：MH_TEST_TG=1 node scripts/model-health-check.mjs
if (process.env.MH_TEST_TG === '1') {
  const r = await tgNotify('[自检] model-health 告警通道测试（21:2x）');
  console.log(JSON.stringify(r));
  process.exit(r.sent ? 0 : 1);
}

let state = { failCount: 0, switched: false, lastCheckAt: null };
try { state = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch {}

const health = await checkHealth();
state.lastCheckAt = new Date().toISOString();

if (health.ok) {
  state.failCount = 0;
  log(`[model-health] ${primary} OK (${health.detail})`);
} else {
  state.failCount += 1;
  log(`[model-health] ${primary} FAIL (${health.detail}) failCount=${state.failCount}`);
  if (state.failCount >= MAX_FAILS && !state.switched) {
    // 2026-09-16 12:40：告警/切换前加一次「确认复检」——empty content 属抖动（实测 4/4 OK，但 5 分钟内可连3次空）
    //   原逻辑连续3次即发「无备胎请人工处理」，会在健康时误报；复检 OK 则视为抖动并归零
    const recheck = await checkHealth();
    log(`[model-health] failCount>=${MAX_FAILS} -> re-probe: ${recheck.ok ? 'OK(' + recheck.detail + ')' : 'FAIL(' + recheck.detail + ')'}`);
    if (recheck.ok) { state.failCount = 0; }
    else {
    const sinceAlert = Date.now() - (state.lastAlertAt || 0);
    const detail = recheck.detail; // 告警文案用复检结果（与触发条件一致）
    if (state.lastAlertAt && sinceAlert < ALERT_COOLDOWN_MS) {
      log(`[model-health] failCount>=${MAX_FAILS} but alert suppressed (cooldown, ${Math.round(sinceAlert / 60000)}min since last)`);
      state.failCount = 0;   // 仍重置计数，避免下轮重复判定
    } else if (!BACKUP_MODEL || primary === BACKUP_MODEL) {
      const why = !BACKUP_MODEL ? '未配置 fallbacks' : '备胎与主模型相同';
      const r = await tgNotify(`⚠️ 模型告警：${primary} 连续 ${MAX_FAILS} 次检测失败（${detail}），${why}，无法切换！请人工处理。`);
      // 2026-11-03：区分「静默没发」与「发送失败」——两者都要保留、下轮重试，但日志不能混
      if (r.sent) { state.lastAlertAt = Date.now(); log('[model-health] ALERT sent (no backup available)'); }
      else { log(`[model-health] ALERT not delivered (${r.reason}) -> will retry next round`); }
      state.failCount = 0;
    } else {
      const ok = switchModel(BACKUP_MODEL);
      if (ok) {
        state.switched = true;
        state.failCount = 0;
        // 2026-11-03：切换后清掉会话级 override（否则某个会话被手动钉在故障模型上，
        //   全局切了它也切不走——这正是「会话改 pro 时自动回滚失效」的根因）
        const cleared = clearSessionOverrides(primary);
        const r = await tgNotify(`⚠️ 模型故障告警：${primary} 连续 ${MAX_FAILS} 次检测失败（${detail}），已自动切换主模型 → ${BACKUP_MODEL}${cleared ? '（已清理会话覆盖）' : ''}`);
        if (r.sent) state.lastAlertAt = Date.now();
        log(`[model-health] switched primary -> ${BACKUP_MODEL} (session overrides cleared: ${cleared})`);
      } else {
        const r = await tgNotify(`⚠️ 模型故障：${primary} 连续 ${MAX_FAILS} 次失败，但自动切换失败（config patch 未成功），请人工处理！`);
        if (r.sent) state.lastAlertAt = Date.now();
        log('[model-health] switch FAILED, alert sent');
      }
    }
    }
  }
}

mkdirSync(STATE_DIR, { recursive: true });
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
console.log('NO_REPLY');
