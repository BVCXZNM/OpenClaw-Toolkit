// Proxy Guard — 代理守护
//
// 背景：所有出站流量强制走本地代理（Clash / mihomo 之类）。代理一挂，整条链跟着遭殃：
//   代理挂 → 通道取 token 失败 → 反复重连 → 累积 unclean boot
//        → 触发网关 crash-loop breaker → 抑制所有通道自启
// 代理是整条链的【源头单点】。本脚本把这个单点也变成自愈：
//   端口不通 → 拉起/重启代理客户端（或只重启核心）→ 等待端口恢复 → 通知
//
// ⚠️ 关键设计（踩过的坑）：代理挂掉时，通知通道本身往往也发不出去。
//   所以发送失败时改写【本地告警文件】，等代理恢复或下一轮体检读到再补报。
//   ⚠️ "发送失败" 与 "静默时段未发" 必须分开记录，否则日志会说谎。
//
// 平时静默（输出 NO_REPLY）。停用：同目录建 .proxy-guard-disabled。
//
// 用法：
//   node proxy-guard.mjs             # 正常巡检
//   node proxy-guard.mjs --dry-run   # 演练：走故障分支但不真杀/真启
//   node proxy-guard.mjs --selftest  # 同上
//
// 配置（环境变量，全部可选）：
//   PROXY_HOST / PROXY_PORT   代理地址，默认 127.0.0.1:7897
//   PROXY_APP_EXE             代理客户端主程序路径（缺失则跳过拉起）
//   PROXY_CORE_EXE            代理核心进程名（缺失则只重启客户端）
//   TG_CHAT_ID + botToken     通知目标；botToken 从 openclaw.json 读
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execSync } from 'node:child_process';

const HOME = os.homedir();
const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const STATE_FILE = join(SCRIPT_DIR, '.proxy-guard-state.json');
const DISABLE_FILE = join(SCRIPT_DIR, '.proxy-guard-disabled');
const ALERT_FILE = join(process.env.LOCALAPPDATA || join(HOME, 'AppData', 'Local'), 'OpenClawWatchdog', 'proxy-alert.txt');
const CFG_PATH = join(HOME, '.openclaw', 'openclaw.json');

const PROXY_HOST = process.env.PROXY_HOST || '127.0.0.1';
const PROXY_PORT = Number(process.env.PROXY_PORT || 7897);
const PROXY_URL = `http://${PROXY_HOST}:${PROXY_PORT}`;
const PROXY_APP_EXE = process.env.PROXY_APP_EXE || '';
const PROXY_APP_NAME = process.env.PROXY_APP_NAME || PROXY_APP_NAME;
const PROXY_CORE_NAME = process.env.PROXY_CORE_NAME || PROXY_CORE_NAME;
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_RESTARTS_PER_WINDOW = 3;
const WINDOW_MS = 10 * 60 * 1000;
const LOG_MAX_BYTES = 512 * 1024;

function log(msg) {
  try {
    const f = join(SCRIPT_DIR, '.proxy-guard.log');
    try { if (existsSync(f) && readFileSync(f).length > LOG_MAX_BYTES) writeFileSync(f, ''); } catch {}
    writeFileSync(f, `${new Date().toISOString()} ${msg}\n`, { flag: 'a' });
  } catch {}
}

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(s) {
  try { mkdirSync(SCRIPT_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8'); } catch {}
}

function tcpCheck(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(PROXY_PORT, PROXY_HOST); } catch { finish(false); }
  });
}

function isProcessRunning(name) {
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${name}" /NH`, { encoding: 'utf8', timeout: 15000, windowsHide: true });
    return out.toLowerCase().includes(name.toLowerCase());
  } catch { return false; }
}

function taskkill(imageName) {
  try { execSync(`taskkill /IM ${imageName} /F /T`, { encoding: 'utf8', timeout: 20000, windowsHide: true }); return true; }
  catch { return false; }
}

function launchVerge() {
  try {
    const p = spawn(PROXY_APP_EXE, [], { detached: true, stdio: 'ignore', windowsHide: true });
    p.unref();
    return true;
  } catch (e) { log(`launchVerge failed: ${e.message}`); return false; }
}

function tgNotify(text) {
  let token = '';
  try { const cfg = JSON.parse(readFileSync(CFG_PATH, 'utf8')); token = cfg?.channels?.telegram?.botToken || ''; } catch {}
  if (!token) return false;
  const tmp = join(os.tmpdir(), `tg-proxy-${Date.now()}.json`);
  try { writeFileSync(tmp, JSON.stringify({ chat_id: TG_CHAT_ID, text }), 'utf8'); } catch { return false; }
  for (let i = 0; i < 2; i++) {
    try {
      const out = execSync(
        `curl.exe -s --ssl-no-revoke --proxy ${PROXY_URL} -X POST -H "Content-Type: application/json" -d @${tmp} "https://api.telegram.org/bot${token}/sendMessage"`,
        { encoding: 'utf8', timeout: 20000, windowsHide: true }
      );
      if (out.includes('"ok":true')) { try { execSync(`del ${tmp}`, { windowsHide: true }); } catch {} return true; }
    } catch {}
  }
  try { execSync(`del ${tmp}`, { windowsHide: true }); } catch {}
  return false;
}

function writeLocalAlert(text) {
  try { mkdirSync(dirname(ALERT_FILE), { recursive: true }); writeFileSync(ALERT_FILE, `${new Date().toISOString()} ${text}\n`, 'utf8'); } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DRY_RUN = process.argv.includes('--dry-run');
const SELFTEST = process.argv.includes('--selftest');

// ------------- main -------------
if (existsSync(DISABLE_FILE)) { log('disabled by marker'); console.log('NO_REPLY'); process.exit(0); }

const state = readState();
const now = Date.now();

// selftest/dry-run：强制走 DOWN 分支（不真杀/不真启，只验证检测+通知+状态机）
const probeOk = (SELFTEST || DRY_RUN) ? false : await tcpCheck();

if (probeOk) {
  // 代理正常
  log(`ok (failStreak=${state.failStreak || 0})`);
  if (state.downSince) {
    // 刚从故障恢复
    const downMin = Math.round((now - state.downSince) / 60000);
    log(`proxy recovered after ~${downMin} min`);
    if (!state.notifiedAt || now - state.notifiedAt > NOTIFY_COOLDOWN_MS) {
      const ok = tgNotify(`✅ 代理守护：7897 已恢复（中断约 ${downMin} 分钟）。\n恢复动作：${state.lastAction || 'n/a'}\n通道会随之自愈（channel-supervisor 每 2 分钟巡检）。`);
      state.notifiedAt = now; log(`recovery notified=${ok}`);
    }
    try { if (existsSync(ALERT_FILE)) execSync(`del ${ALERT_FILE}`, { windowsHide: true }); } catch {}
    delete state.downSince; delete state.lastAction;
  }
  state.lastOkAt = now; state.failStreak = 0;
  writeState(state);
  console.log('NO_REPLY');
  process.exit(0);
}

// 代理不通
state.failStreak = (state.failStreak || 0) + 1;
if (!state.downSince) state.downSince = now;
log(`proxy DOWN (streak=${state.failStreak})`);

// 限流：10 分钟内最多重启 3 次，防抖
state.restarts = (state.restarts || []).filter((t) => now - t < WINDOW_MS);
if (state.restarts.length >= MAX_RESTARTS_PER_WINDOW) {
  const msg = `代理 7897 仍不通，且 10 分钟内已重启 ${state.restarts.length} 次（已达上限，停止重启防抖）。需人工检查代理客户端。`;
  log(msg);
  writeLocalAlert(msg);
  if (!state.notifiedAt || now - state.notifiedAt > NOTIFY_COOLDOWN_MS) {
    state.notifiedAt = now;
    const ok = tgNotify(`🚨 代理守护：${msg}\n（本条可能是恢复后补发）`);
    log(`escalation notified=${ok}`);
  }
  writeState(state);
  console.log('NO_REPLY');
  process.exit(0);
}

// 恢复动作
let action = '';
if (DRY_RUN) {
  action = 'DRY-RUN（未执行实际动作）';
  log('DRY-RUN mode: skipping real recovery actions');
} else {
const vergeRunning = isProcessRunning(PROXY_APP_NAME);
const mihomoRunning = isProcessRunning(PROXY_CORE_NAME);

if (!vergeRunning) {
  action = '代理客户端未运行 → 启动';
  log(action);
  launchVerge();
} else if (mihomoRunning) {
  action = '客户端在跑但核心未监听 → 只重启核心';
  log(action);
  taskkill(PROXY_CORE_NAME);
} else {
  action = '客户端在跑但核心不在 → 重启客户端';
  log(action);
  taskkill(PROXY_APP_NAME);
  await sleep(2000);
  launchVerge();
}

state.restarts.push(now);
state.lastAction = action;
}

// 演练模式：到此为止，不动真实网络状态、不发真实告警
if (DRY_RUN || SELFTEST) {
  log(`SIMULATED decision: ${action} (no live change)`);
  state.lastSimulationAt = now;
  state.restarts = [];
  delete state.downSince;
  writeState(state);
  console.log('NO_REPLY');
  process.exit(0);
}

// 等待恢复（最多 60s）
let recovered = false;
for (let i = 0; i < 20; i++) {
  await sleep(3000);
  if (await tcpCheck()) { recovered = true; break; }
}

if (recovered) {
  const downMin = Math.round((now - state.downSince) / 60000) || 0;
  log(`RECOVERED via: ${action}`);
  const ok = tgNotify(`🛠️ 代理守护：7897 曾中断（约 ${downMin} 分钟），已自动恢复。\n动作：${action}\n通道会随代理恢复自愈。`);
  state.notifiedAt = now;
  log(`recovery notified=${ok}`);
  delete state.downSince; delete state.lastAction;
  state.failStreak = 0;
  try { if (existsSync(ALERT_FILE)) execSync(`del ${ALERT_FILE}`, { windowsHide: true }); } catch {}
} else {
  const msg = `代理 7897 自动恢复失败（动作：${action}）。可能代理客户端需要人工介入或需切换节点/订阅。`;
  log(msg);
  writeLocalAlert(msg);
  if (!state.notifiedAt || now - state.notifiedAt > NOTIFY_COOLDOWN_MS) {
    state.notifiedAt = now;
    const ok = tgNotify(`🚨 代理守护：${msg}`);
    log(`fail notified=${ok}`);
  }
}

writeState(state);
console.log('NO_REPLY');
