#!/usr/bin/env node
/**
 * be-ledger.mjs —— 保本损反事实台账（v1，2026-11-02 建立）
 *
 * ⚠️ 核心原则（博涵 11-02 16:13 定）：记录 ≠ 定论。所有条目都是「当前参数下的样本」，
 *    随时可以被更大量化推翻。k 值、门槛、判据全部可调，不存在「写下来就不能改」。
 *
 * 为什么需要它：
 *   保本损的结果几乎永远是「可接受的勉强好」（赚一点或被扫亏手续费），
 *   单看结果无法反推决策质量（resulting 陷阱）。所以每条要记两条线：
 *     实际线     —— 推了之后发生了什么
 *     反事实线   —— 假设没推、保留原结构止损，会发生什么
 *
 * 三个不受结果影响的指标：
 *   ① 假扫率    = 被扫后 6h 内价格是否回到原方向（回来了=假扫，止损在噪音里）
 *   ② 存活时长   = 推保本 → 被扫的时间
 *   ③ k 曲线    = 推保本时的「浮盈/ATR」与被扫概率的关系（这才是真正要优化的参数）
 *
 * 用法:
 *   node be-ledger.mjs add <sym> <long|short> <entry> <cfStop> <qty> [--at <ISO>] [--be <price>]
 *   node be-ledger.mjs sweep <id> <sweptPx> [--at <ISO>]
 *   node be-ledger.mjs manual <sym> <long|short> <entry> <cfStop> <qty> <closePx> [--at <ISO>]
 *   node be-ledger.mjs check            # 回填所有未完成的 6h 反事实
 *   node be-ledger.mjs stat
 *   node be-ledger.mjs export
 *   node be-ledger.mjs list
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(DIR, 'be-ledger.json');
const MD = path.join(DIR, 'be-ledger.md');
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
const FEE_BUFFER = 0.0012;
// 2026-11-02 修正：曾用 0.0004（maker 率）估算，实际多为 taker 0.0005
// → ETH 那笔算成 −2.96，实际 −5.25。现改为 0.0005 默认，支持 --fee 覆盖
const TAKER = 0.0005;
const CF_HORIZON_H = 6;     // 反事实观察窗口
const FALSE_SWEEP_H = 6;    // 假扫判定窗口

const load = () => {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!d.entries) d.entries = [];
    return d;
  } catch {
    return { note: '', entries: [], schema: 1 };
  }
};
const save = (d) => { fs.writeFileSync(FILE, JSON.stringify(d, null, 2)); writeMd(d); };
const cn = (ms) => new Date(ms + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 16);
const parseT = (s) => new Date(s.replace(' ', 'T') + (s.length <= 16 ? ':00+08:00' : '')).getTime();

function curl(u) {
  for (let i = 0; i < 4; i++) {
    try {
      return JSON.parse(execSync(`curl.exe --ssl-no-revoke --proxy ${PROXY} -s --max-time 25 "${u}"`, { encoding: 'utf8' }));
    } catch { }
  }
  return null;
}
function klines(sym, interval, startMs, endMs) {
  let out = [];
  let cur = startMs;
  for (let p = 0; p < 12; p++) {
    const u = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${interval}&startTime=${cur}&endTime=${endMs}&limit=1500`;
    const r = curl(u);
    if (!Array.isArray(r) || !r.length) break;
    out = out.concat(r);
    if (r.length < 1500) break;
    cur = +r[r.length - 1][0] + 1;
  }
  return out.map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] }));
}
function atr16(sym, atMs) {
  const k = curl(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=1h&endTime=${atMs}&limit=60`);
  if (!Array.isArray(k)) return null;
  const trs = [];
  for (let i = 1; i < k.length; i++) {
    const h = +k[i][2], l = +k[i][3], pc = +k[i - 1][4];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let a = trs.slice(0, 16).reduce((x, y) => x + y, 0) / 16;
  for (let i = 16; i < trs.length; i++) a = (a * 15 + trs[i]) / 16;
  return a;
}

// ───────── 反事实计算 ─────────
function computeCounterfactual(e) {
  // 2026-11-03 冻结机制：一旦结算过就把值焊死，不再随行情变。
  // 起因：ETH 那条 cfNet 从 −52.72（部分窗口）变成 −18.10（满窗），同一笔记出两个答案。
  if (e.cfFrozen === true) return e;

  const atMs = parseT(e.pushedAt);
  const now = Date.now();
  const horizonMs = atMs + CF_HORIZON_H * 3600e3;
  const windowFull = now >= horizonMs;
  if (now <= atMs + 5 * 60e3) return { ...e, cfStatus: 'waiting', cfNet: null };

  const bars = klines(e.sym, '5m', atMs, horizonMs);
  if (!bars.length) return { ...e, cfStatus: 'no_data' };

  const isShort = e.side === 'short';
  const qty = e.qty;

  // 反事实：若未推保本，止损仍是 cfStop
  let cfStopHit = null, cfStopHitAt = null;
  let cfBest = isShort ? Infinity : -Infinity;    // 有利于持仓方向的极值
  let cfWorst = isShort ? -Infinity : Infinity;   // 不利方向的极值
  for (const b of bars) {
    const fav = isShort ? b.l : b.h;
    const adv = isShort ? b.h : b.l;
    if (isShort) { cfBest = Math.min(cfBest, fav); cfWorst = Math.max(cfWorst, adv); }
    else { cfBest = Math.max(cfBest, fav); cfWorst = Math.min(cfWorst, adv); }
    if (!cfStopHit) {
      const hit = isShort ? b.h >= e.cfStop : b.l <= e.cfStop;
      if (hit) { cfStopHit = true; cfStopHitAt = cn(b.t); }
    }
  }
  const lastPx = bars[bars.length - 1].c;
  // 假设持有到现在的结果（未触止损则按现价浮盈；触了则按 cfStop）
  const cfExitPx = cfStopHit ? e.cfStop : lastPx;
  const cfGross = isShort ? (e.entry - cfExitPx) * qty : (cfExitPx - e.entry) * qty;
  const cfFeeRate = e.feeRate != null ? e.feeRate : TAKER;
  const cfFee = (e.entry + cfExitPx) * qty * cfFeeRate;
  // ⚠️ 只有窗口满了才出数，不满时保持 null，避免把中间态当成终值
  const cfNet = windowFull ? +(cfGross - cfFee).toFixed(2) : null;

  // 假扫判定（仅适用于 be_sweep 类型）
  // 2026-11-02 两次修正：
  //   初版「碰到一次就算假扫」→ 一根 5m 插针就算，太粗糙
  //   二版「连续3根收盘 / 0.5ATR 实体」→ 仍会误判：ETH 16:10-16:20 连续3根回到 2288 下方 → 判假扫，
  //     但之后价格一路涨到 2298，持有到现在亏 54u，保本损实际是「保护」不是「误扫」
  // 三版（当前）：以「观察窗口结束时的状态」为准 —— 假扫 = 扫完方向真的还是原来那个。
  //   对空单：窗口末收盘仍低于保本价 → 假扫；高于保本价 → 真扫（方向真的被破坏了）
  let falseSweep = null, returnAt = null;
  if (e.type === 'be_sweep' && e.sweptAt) {
    const sMs = parseT(e.sweptAt);
    const win = sMs + FALSE_SWEEP_H * 3600e3;
    const fsBars = klines(e.sym, '5m', sMs, Math.min(now, win));
    if (fsBars.length) {
      const lastC = fsBars[fsBars.length - 1].c;
      const lastT = fsBars[fsBars.length - 1].t;
      const stillBeyond = isShort ? lastC < e.bePrice : lastC > e.bePrice;
      if (Date.now() >= win) {
        falseSweep = stillBeyond;
        returnAt = stillBeyond ? cn(lastT) + ' (窗口末仍在原方向)' : null;
      } else {
        // 窗口未满：只给中间态提示，不下定论
        falseSweep = null;
        returnAt = stillBeyond ? cn(lastT) + ' (暂在原方向，待满6h定论)' : null;
      }
    }
  }

  return {
    ...e,
    cfStatus: windowFull ? 'done' : 'partial',
    cfFrozen: windowFull,          // 满窗即冻结，之后 computeCounterfactual 直接返回原值
    cfFrozenAt: windowFull ? cn(now) : null,
    cfLastPx: +lastPx.toFixed(2),
    cfBest: +cfBest.toFixed(2),
    cfWorst: +cfWorst.toFixed(2),
    cfStopHit,
    cfStopHitAt,
    cfNet,
    falseSweep,
    returnAt,
    cfWindowEnd: cn(horizonMs),
  };
}

// ───────── Markdown ─────────
function writeMd(db) {
  const L = [];
  L.push('# 保本损反事实台账\n');
  L.push(`> 更新于 ${cn(Date.now())}（北京）｜源文件 \`be-ledger.json\`｜${db.entries.length} 条\n`);
  L.push('> ⚠️ **记录 ≠ 定论**：所有条目都是当前参数下的样本，可被更大量化推翻。\n');
  L.push('## 明细\n');
  L.push('| # | 类型 | 品种 | 方向 | 入场 | 推保本 | 时点 | 浮盈/ATR | 保本距/ATR | 实际结果 | 反事实(未推) | 假扫 |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const e of db.entries) {
    const dir = e.side === 'short' ? '空' : '多';
    const typeCn = e.type === 'be_push' ? '推保本' : e.type === 'be_sweep' ? '被扫' : '手动平';
    const k = e.kRatio != null ? e.kRatio.toFixed(2) + '×' : '—';
    const d = e.distAtr != null ? e.distAtr.toFixed(2) + '×' : '—';
    const act = e.actualNet != null ? (e.actualNet >= 0 ? '+' : '') + e.actualNet.toFixed(2) : (e.sweptPx ? '待结算' : '持仓中');
    const cf = e.cfNet != null ? (e.cfNet >= 0 ? '+' : '') + e.cfNet.toFixed(2) + (e.cfStopHit ? ' (触原止损)' : '') : '待观察';
    const fs = e.falseSweep === true ? '是' : e.falseSweep === false ? '否' : '—';
    L.push(`| ${e.id} | ${typeCn} | ${e.sym} | ${dir} | ${e.entry} | ${e.bePrice ?? '—'} | ${e.pushedAt?.slice(5)} | ${k} | ${d} | ${act} | ${cf} | ${fs} |`);
  }
  L.push('');

  // 统计
  const done = db.entries.filter(e => e.cfStatus === 'done');
  const swept = db.entries.filter(e => e.type === 'be_sweep');
  const fsKnown = swept.filter(e => e.falseSweep !== null && e.falseSweep !== undefined);
  const fsCount = fsKnown.filter(e => e.falseSweep).length;
  const totalAct = db.entries.reduce((s, e) => s + (e.actualNet || 0), 0);
  const totalCf = done.reduce((s, e) => s + (e.cfNet || 0), 0);

  L.push('## 统计\n');
  L.push(`- 样本数：**${db.entries.length}**（其中完成观察 ${done.length} 条）`);
  const deltaAll = db.entries.filter(e => e.cfNet != null && e.actualNet != null);
  const sumDelta = deltaAll.reduce((s, e) => s + (e.actualNet - e.cfNet), 0);
  const sumAct = db.entries.reduce((s, e) => s + (e.actualNet || 0), 0);
  const sumCf = deltaAll.reduce((s, e) => s + (e.cfNet || 0), 0);

  L.push('');
  L.push('### ⭐ 核心指标：反事实差值（做 vs 不做）\n');
  L.push('> **这是唯一的判决依据。** 不需要看假扫、不需要看价格回没回原方向。');
  L.push('> 差值 = 实际结果 − 反事实结果。**正数 = 这个动作帮了我；负数 = 害了我。**\n');
  L.push('| 品种 | 实际 | 反事实（不做） | **差值** |');
  L.push('|---|---|---|---|');
  for (const e of deltaAll) {
    const d = e.actualNet - e.cfNet;
    L.push(`| ${e.sym} ${e.side === 'short' ? '空' : '多'} | ${e.actualNet >= 0 ? '+' : ''}${e.actualNet.toFixed(2)} | ${e.cfNet >= 0 ? '+' : ''}${e.cfNet.toFixed(2)} | **${d >= 0 ? '+' : ''}${d.toFixed(2)}** |`);
  }
  L.push(`| **合计** | ${sumAct >= 0 ? '+' : ''}${sumAct.toFixed(2)} | ${sumCf >= 0 ? '+' : ''}${sumCf.toFixed(2)} | **${sumDelta >= 0 ? '+' : ''}${sumDelta.toFixed(2)}** |`);
  L.push('');
  L.push(`- 被扫次数：${swept.length}　假扫判定：${swept.filter(e => e.falseSweep === true).length} 真 / ${swept.filter(e => e.falseSweep === false).length} 假 / ${swept.filter(e => e.falseSweep == null).length} 未定（仅作辅助，不参与判决）`);
  L.push('');
  L.push(`> ⚠️ 样本 ${db.entries.length} 条——**单次差值只能看个方向，不具备统计意义**。`);
  L.push('> 真正要的是 20 次以上的**差值均值**。均值持续为正 → 这套保本损纪律成立；持续为负 → 推翻重设。');
  L.push('');
  L.push('## 辅助指标（探索用，不参与判决）\n');
  L.push(`- k 值（推保本时浮盈/ATR）：${deltaAll.map(e => e.kRatio).filter(x => x != null).join(' / ') || '—'}`);
  L.push(`- 保本距/ATR：${deltaAll.map(e => e.distAtr).filter(x => x != null).join(' / ') || '—'}`);
  L.push(`- 存活时长：${swept.map(e => e.hoursAlive != null ? e.hoursAlive + 'h' : '—').join(' / ') || '—'}`);
  L.push('## 优化目标（等数据够了再看）\n');
  L.push('真正的参数是 **k = 推保本时的浮盈 / ATR16**，当前默认 **k = 1.0**（纪律 22）。');
  L.push('需要回答的问题：k 调到多少，假扫率能降到可接受、同时不牺牲太多止盈命中率？');
  L.push('**在样本 < 20 条之前，k 不动。**');
  fs.writeFileSync(MD, L.join('\n'), 'utf8');
}

// ───────── CLI ─────────
const argv = process.argv.slice(2);
const cmd = argv[0];
const db = load();
const flag = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : null; };

if (cmd === 'add') {
  const [sym, side, entry, cfStop, qty] = argv.slice(1);
  if (!sym || !side || !entry || !cfStop) { console.log('用法: add <sym> <long|short> <entry> <cfStop> <qty> [--at ISO] [--be price]'); process.exit(1); }
  const at = flag('at') || cn(Date.now());
  const atMs = parseT(at);
  const A = atr16(sym.toUpperCase(), atMs);
  const e0 = +entry;
  const be = flag('be') ? +flag('be') : (side === 'short' ? e0 * (1 - FEE_BUFFER) : e0 * (1 + FEE_BUFFER));
  const t = curl(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym.toUpperCase()}&interval=1m&endTime=${atMs}&limit=1`);
  const px = t && t.length ? +t[0][4] : null;
  const q = qty ? +qty : 1;
  const profitPts = px ? (side === 'short' ? e0 - px : px - e0) : null;
  const id = (db.entries.at(-1)?.id || 0) + 1;
  db.entries.push({
    id, type: 'be_push', sym: sym.toUpperCase(), side, entry: e0, cfStop: +cfStop, qty: q,
    bePrice: +be.toFixed(2),
    pushedAt: at,
    priceAtPush: px ? +px.toFixed(2) : null,
    atr16: A ? +A.toFixed(2) : null,
    profitPts: profitPts != null ? +profitPts.toFixed(2) : null,
    kRatio: A && profitPts != null ? +(profitPts / A).toFixed(2) : null,
    distAtr: A ? +(Math.abs(px - be) / A).toFixed(2) : null,
    actualNet: null, sweptAt: null, sweptPx: null,
    cfStatus: 'waiting', falseSweep: null, note: ''
  });
  save(db);
  console.log(`已记录 #${id}: ${sym.toUpperCase()} ${side} 推保本 ${be.toFixed(2)} | k=${A && profitPts != null ? (profitPts / A).toFixed(2) : '?'}× ATR | 距 ${A ? (Math.abs(px - be) / A).toFixed(2) : '?'}× ATR`);
} else if (cmd === 'sweep') {
  const [id, px] = argv.slice(1);
  const e = db.entries.find(x => x.id === +id);
  if (!e) { console.log('找不到 #' + id); process.exit(1); }
  const at = flag('at') || cn(Date.now());
  e.type = 'be_sweep';
  e.sweptAt = at;
  e.sweptPx = +px;
  const gross = e.side === 'short' ? (e.entry - +px) * e.qty : (+px - e.entry) * e.qty;
  const feeRate = e.feeRate != null ? e.feeRate : TAKER;
  const fee = (e.entry + +px) * e.qty * feeRate;
  e.actualNet = +(gross - fee).toFixed(2);
  e.hoursAlive = +((parseT(at) - parseT(e.pushedAt)) / 3600e3).toFixed(2);
  save(db);
  console.log(`#${id} 已被扫 @${px} | 存活 ${e.hoursAlive}h | 净 ${e.actualNet >= 0 ? '+' : ''}${e.actualNet}u`);
} else if (cmd === 'manual') {
  const [sym, side, entry, cfStop, qty, closePx] = argv.slice(1);
  if (!closePx) { console.log('用法: manual <sym> <side> <entry> <cfStop> <qty> <closePx> [--at ISO] [--be price]'); process.exit(1); }
  const at = flag('at') || cn(Date.now());
  const e0 = +entry, cpx = +closePx, q = +qty;
  const A = atr16(sym.toUpperCase(), parseT(at));
  const be = flag('be') ? +flag('be') : (side === 'short' ? e0 * (1 - FEE_BUFFER) : e0 * (1 + FEE_BUFFER));
  const id = (db.entries.at(-1)?.id || 0) + 1;
  const gross = side === 'short' ? (e0 - cpx) * q : (cpx - e0) * q;
  const feeRate = flag('fee') ? +flag('fee') : TAKER;
  const fee = (e0 + cpx) * q * feeRate;
  db.entries.push({
    id, type: 'manual_close', sym: sym.toUpperCase(), side, entry: e0, cfStop: +cfStop, qty: q,
    bePrice: +be.toFixed(2), pushedAt: at, priceAtPush: cpx,
    atr16: A ? +A.toFixed(2) : null,
    profitPts: +(side === 'short' ? e0 - cpx : cpx - e0).toFixed(2),
    kRatio: A ? +((side === 'short' ? e0 - cpx : cpx - e0) / A).toFixed(2) : null,
    distAtr: A ? +(Math.abs(cpx - be) / A).toFixed(2) : null,
    actualNet: +(gross - fee).toFixed(2),
    sweptAt: null, sweptPx: cpx,
    cfStatus: 'waiting', falseSweep: null, note: '手动平仓（保本损已挂仍选择主动离场）'
  });
  save(db);
  console.log(`已记录 #${id}: ${sym.toUpperCase()} 手动平 ${cpx} | 净 ${(gross - fee).toFixed(2)}u | k=${A ? ((side === 'short' ? e0 - cpx : cpx - e0) / A).toFixed(2) : '?'}×`);
} else if (cmd === 'check') {
  let n = 0;
  for (let i = 0; i < db.entries.length; i++) {
    const before = JSON.stringify(db.entries[i]);
    db.entries[i] = computeCounterfactual(db.entries[i]);
    if (JSON.stringify(db.entries[i]) !== before) n++;
  }
  save(db);
  console.log(`回填完成，变化 ${n} 条`);
  for (const e of db.entries) {
    const act = e.actualNet != null ? e.actualNet : '?';
    const cf = e.cfNet != null ? e.cfNet : '?';
    console.log(`  #${e.id} ${e.sym} 实际=${act} 反事实=${cf}${e.cfStopHit ? '(触原止损)' : ''} 假扫=${e.falseSweep ?? '待判'}`);
  }
} else if (cmd === 'stat') {
  const deltaAll = db.entries.filter(e => e.cfNet != null && e.actualNet != null);
  console.log('=== 保本损台账 · 核心指标：反事实差值 ===');
  console.log(`样本 ${db.entries.length} | 可算差值 ${deltaAll.length}\n`);
  if (deltaAll.length) {
    console.log('品种        实际     反事实    差值');
    let sd = 0;
    for (const e of deltaAll) {
      const d = e.actualNet - e.cfNet; sd += d;
      const f = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);
      console.log(`${e.sym.padEnd(11)} ${f(e.actualNet).padStart(8)} ${f(e.cfNet).padStart(9)} ${f(d).padStart(8)}`);
    }
    const sa = deltaAll.reduce((s, e) => s + e.actualNet, 0);
    const sc = deltaAll.reduce((s, e) => s + e.cfNet, 0);
    const f = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);
    console.log(`${'合计'.padEnd(11)} ${f(sa).padStart(8)} ${f(sc).padStart(9)} ${f(sd).padStart(8)}`);
    console.log(`\n→ 差值 ${sd >= 0 ? '正：这些动作帮了你' : '负：这些动作害了你'} ${f(sd)}u`);
  }
  console.log(`\n⚠️ 样本 ${deltaAll.length} 条。单次只能看方向；要 20 次以上的差值均值才能定论。`);
} else if (cmd === 'export') {
  writeMd(db);
  console.log('已导出', MD);
} else if (cmd === 'list') {
  for (const e of db.entries) {
    console.log(`#${e.id} ${e.type} ${e.sym} ${e.side} entry=${e.entry} be=${e.bePrice} k=${e.kRatio} dist=${e.distAtr} actual=${e.actualNet} cf=${e.cfNet}`);
  }
} else {
  console.log('用法: add | sweep | manual | check | stat | export | list');
}
