#!/usr/bin/env node
// usage-ledger.mjs — 本地 token / 花费账本 (v2: 直接解析会话 jsonl, 自算费用)
//
// 数据源:
//   ~/.openclaw/agents/main/sessions/*.jsonl          原始会话记录 (含 usage)
//   ~/.openclaw/agents/main/sessions/sessions.json    会话归属映射
//   ~/.openclaw/agents/main/sessions/.usage-cost-cache.json  历史定价指纹
//
// 用法:
//   node usage-ledger.mjs                  # 最近 7 天
//   node usage-ledger.mjs --days 30
//   node usage-ledger.mjs --all
//   node usage-ledger.mjs --today
//   node usage-ledger.mjs --by model|day|session|hour|all
//   node usage-ledger.mjs --json

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const SESS_DIR = process.env.SESS_DIR || path.join(HOME, '.openclaw', 'agents', 'main', 'sessions');
const SESS = path.join(SESS_DIR, 'sessions.json');

// ---------- 定价表 (USD / 1M tokens) ----------
// 来源: 配置 pricingFingerprint + MEMORY 记录的 deepseek-v4-flash 实际单价
// ⚠️ 价格单位：美元 / 百万 token。这是 2026-11 的快照，用前请核对官方定价。
// ⚠️ 重要教训：凭配置单价推算会严重高估（实测高估 4.16 倍），
//    因为 98% 的 token 是缓存读，实际缓存单价远低于配置值。
//    必须拿「账户余额实际变化」校验一遍再用。
const PRICING = {
  'deepseek-v4-flash':            { input: 0.14,  output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
  'deepseek/deepseek-v4-flash':   { input: 0.14,  output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
  'deepseek-v4-flash-vision-exp': { input: 0.14,  output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
  'deepseek-v4-pro':              { input: 1.74,  output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
  'deepseek/deepseek-v4-pro':     { input: 1.74,  output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
  'deepseek-chat':                { input: 0.28,  output: 0.42, cacheRead: 0.028, cacheWrite: 0 },
  'deepseek-reasoner':            { input: 0.28,  output: 0.42, cacheRead: 0.028, cacheWrite: 0 },
  'GLM-5.2':                      { input: 0.14,  output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
};

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const wantJson = has('--json');
const byWhat = val('--by', 'all');
let days = has('--all') ? null : (has('--today') ? 1 : (Number(val('--days', '7')) || 7));

// ---------- 会话名映射 ----------
let sessMap = {};
try { sessMap = JSON.parse(fs.readFileSync(SESS, 'utf8')); } catch { sessMap = {}; }
const idToLabel = new Map();
for (const [key, rec] of Object.entries(sessMap)) {
  if (!rec || typeof rec !== 'object') continue;
  for (const id of [rec.sessionId, ...(rec.usageFamilySessionIds || [])].filter(Boolean)) {
    idToLabel.set(id, key);
  }
}

// ---------- 扫描 jsonl ----------
const files = fs.readdirSync(SESS_DIR).filter(f => f.endsWith('.jsonl') || /\.jsonl\.reset\./.test(f));
const rows = [];
let parseErrors = 0, noUsage = 0, noPrice = 0;

for (const file of files) {
  const full = path.join(SESS_DIR, file);
  let stat;
  try { stat = fs.statSync(full); } catch { continue; }
  if (stat.size === 0) continue;

  const baseId = file.replace(/\.jsonl.*$/, '');
  const label = idToLabel.get(baseId) || baseId.slice(0, 8);
  let text;
  try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }

  for (const line of text.split('\n')) {
    if (!line || line.length < 20) continue;
    let o;
    try { o = JSON.parse(line); } catch { parseErrors++; continue; }
    let msg = o.message;
    if (Array.isArray(msg)) msg = msg[0];
    if (!msg || typeof msg !== 'object') continue;
    const u = msg.usage;
    if (!u || typeof u !== 'object') { continue; }
    if (typeof u.input !== 'number' && typeof u.totalTokens !== 'number') { noUsage++; continue; }

    const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp)
             : (typeof o.timestamp === 'number' ? o.timestamp : (typeof u.timestamp === 'number' ? u.timestamp : null));
    if (!ts || Number.isNaN(ts)) continue;

    const model = msg.model || '?';
    const price = PRICING[model];
    if (!price) noPrice++;

    const input = u.input || 0;
    const output = u.output || 0;
    const cacheRead = u.cacheRead || 0;
    const cacheWrite = u.cacheWrite || 0;

    // 优先用记录里自带的 cost；若为 0 则自算
    let cost = u.cost && typeof u.cost === 'object' ? Number(u.cost.total) || 0 : 0;
    let costSource = 'record';
    if (cost === 0 && price) {
      cost = (input * price.input + output * price.output + cacheRead * price.cacheRead + cacheWrite * price.cacheWrite) / 1e6;
      costSource = 'computed';
    }

    const d = new Date(ts + 8 * 3600e3);
    rows.push({
      ts,
      day: d.toISOString().slice(0, 10),
      hour: d.toISOString().slice(11, 13),
      provider: msg.provider || '?',
      model,
      session: label,
      input, output, cacheRead, cacheWrite,
      tokens: u.totalTokens || (input + output + cacheRead + cacheWrite),
      cost,
      costSource,
    });
  }
}

rows.sort((a, b) => a.ts - b.ts);

if (!rows.length) {
  console.log(`没扫到任何 usage 记录（文件 ${files.length} 个）。`);
  process.exit(0);
}

// ---------- 时间过滤 ----------
let filtered = rows;
if (days !== null) {
  // "今天" 用北京日的 00:00 作为起点
  if (days === 1) {
    const nowBj = new Date(Date.now() + 8 * 3600e3);
    const startBj = Date.UTC(nowBj.getUTCFullYear(), nowBj.getUTCMonth(), nowBj.getUTCDate()) - 8 * 3600e3;
    filtered = rows.filter(r => r.ts >= startBj);
  } else {
    const cutoff = Date.now() - days * 86400e3;
    filtered = rows.filter(r => r.ts >= cutoff);
  }
}
if (!filtered.length) {
  console.log(`所选区间内没有用量记录（历史共 ${rows.length} 条，最早 ${new Date(rows[0].ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）。`);
  process.exit(0);
}

// ---------- 聚合 ----------
const sum = (arr, k) => arr.reduce((s, r) => s + r[k], 0);
const agg = (arr, keyFn) => {
  const m = new Map();
  for (const r of arr) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, { key: k, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0 });
    const o = m.get(k);
    o.calls++;
    o.input += r.input; o.output += r.output;
    o.cacheRead += r.cacheRead; o.cacheWrite += r.cacheWrite;
    o.tokens += r.tokens; o.cost += r.cost;
  }
  return [...m.values()];
};

const fmtCost = (c) => !c ? '0' : (c < 0.0001 ? c.toExponential(2) : (c < 1 ? c.toFixed(4) : c.toFixed(2)));
const fmtTok = (t) => {
  if (t >= 1e9) return (t / 1e9).toFixed(2) + 'B';
  if (t >= 1e6) return (t / 1e6).toFixed(2) + 'M';
  if (t >= 1e3) return (t / 1e3).toFixed(1) + 'k';
  return String(t);
};
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

const totalCost = sum(filtered, 'cost');
const totalTok = sum(filtered, 'tokens');
const totalCalls = filtered.length;
const daysCount = new Set(filtered.map(r => r.day)).size;

const byDay = agg(filtered, r => r.day).sort((a, b) => b.key.localeCompare(a.key));
const byModel = agg(filtered, r => r.model).sort((a, b) => b.cost - a.cost);
const bySession = agg(filtered, r => r.session).sort((a, b) => b.cost - a.cost);
const byHour = agg(filtered, r => r.hour).sort((a, b) => a.key.localeCompare(b.key));

if (wantJson) {
  console.log(JSON.stringify({
    range: { days: days ?? 'all', daysCount, from: new Date(filtered[0].ts).toISOString(), to: new Date(filtered.at(-1).ts).toISOString() },
    totals: { calls: totalCalls, tokens: totalTok, cost: totalCost, dailyAvg: totalCost / daysCount },
    byDay, byModel, bySession, byHour,
    warnings: { parseErrors, noUsage, noPrice },
  }, null, 2));
  process.exit(0);
}

const rangeLabel = days === null ? '全部历史' : (days === 1 ? '今天' : `最近 ${days} 天`);
const fmtDT = (ts) => new Date(ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

console.log(`\n📒 Token 花费账本 · ${rangeLabel}`);
console.log(`   ${fmtDT(filtered[0].ts)}  →  ${fmtDT(filtered.at(-1).ts)}   (${daysCount} 天有记录)`);
console.log(`\n   调用 ${totalCalls.toLocaleString()} 次 ｜ Token ${fmtTok(totalTok)} ｜ 花费 $${totalCost.toFixed(4)}`);
if (totalCalls) {
  console.log(`   平均每次 $${(totalCost / totalCalls).toFixed(6)} ／ ${fmtTok(Math.round(totalTok / totalCalls))} tokens`);
  console.log(`   日均 $${(totalCost / daysCount).toFixed(4)}`);
}

const showTable = (title, data, nameHeader, width = 26) => {
  if (!data.length) return;
  console.log(`\n━━ ${title} ━━`);
  console.log(`  ${pad(nameHeader, width)} ${padL('调用', 6)} ${padL('输入', 8)} ${padL('输出', 8)} ${padL('缓存读', 9)} ${padL('花费$', 10)}  占比`);
  for (const d of data) {
    const pct = totalCost > 0 ? (d.cost / totalCost * 100) : 0;
    const bar = '█'.repeat(Math.max(0, Math.round(pct / 4)));
    console.log(`  ${pad(d.key, width)} ${padL(d.calls, 6)} ${padL(fmtTok(d.input), 8)} ${padL(fmtTok(d.output), 8)} ${padL(fmtTok(d.cacheRead), 9)} ${padL(fmtCost(d.cost), 10)}  ${pct.toFixed(1).padStart(5)}% ${bar}`);
  }
};

if (byWhat === 'all' || byWhat === 'day') showTable('按天', byDay, '日期', 12);
if (byWhat === 'all' || byWhat === 'model') showTable('按模型', byModel, '模型');
if (byWhat === 'all' || byWhat === 'session') showTable('按会话', bySession, '会话', 42);
if (byWhat === 'hour' || (byWhat === 'all' && daysCount <= 3)) showTable('按小时(北京)', byHour, '小时', 8);

// ---------- 健康度 ----------
const totalInputSide = sum(filtered, 'input') + sum(filtered, 'cacheRead') + sum(filtered, 'cacheWrite');
const cacheHit = totalInputSide > 0 ? (sum(filtered, 'cacheRead') / totalInputSide * 100) : 0;
const cacheReadShare = totalTok > 0 ? (sum(filtered, 'cacheRead') / totalTok * 100) : 0;
const computedShare = filtered.filter(r => r.costSource === 'computed').length / totalCalls * 100;

console.log(`\n━━ 健康度 ━━`);
console.log(`  缓存命中率 ${cacheHit.toFixed(1)}%  (缓存读单价仅为输入的 ${((PRICING['deepseek-v4-flash'].cacheRead / PRICING['deepseek-v4-flash'].input) * 100).toFixed(0)}%，命中越高越省)`);
console.log(`  缓存读 token 占总量 ${cacheReadShare.toFixed(1)}%`);
console.log(`  费用来源: 记录自带 ${(100 - computedShare).toFixed(0)}% ／ 本地计算 ${computedShare.toFixed(0)}%`);
if (noPrice > 0) console.log(`  ⚠️ ${noPrice} 条记录的模型不在定价表内，费用可能被低估`);
if (computedShare > 0) console.log(`  ℹ️ 记录自带 cost 为 0 的条目已按官方单价本地推算`);
console.log('');
