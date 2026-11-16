#!/usr/bin/env node
/**
 * be-card.mjs —— 保本损执行卡（通用模板 v1，2026-11-02 定稿）
 *
 * 由来：11-02 实盘推 ZEC/ETH 保本损，暴露三个坑——
 *   ① 推早 0.17 点落进噪音带（ETH 保本损距现价仅 0.77×ATR）
 *   ② 不知道推完原止损会不会重复（SNDK 曾有两条 1200）
 *   ③ 不知道推完风险到底降了多少（−115 → +1 没人算过）
 * 这张卡把决策条件 + 挂单参数 + 风险变化 + 收尾核对一次给全。
 *
 * 用法:
 *   node be-card.mjs <SYMBOL> <long|short> <entry> <stop> <qty> [--tp1 X] [--atr-period 1h]
 *   node be-card.mjs --all                 # 自动扫全部持仓
 *   node be-card.mjs --json                # 机器可读（供 be-alert.mjs 调用）
 *
 * 纪律依据: v2 纪律 22（格局前保本前置）、23（推保本/分批止盈二选一）、
 *          24（止损锚结构不锚均价）、25/26（极限加仓风险相加）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const HOME = os.homedir();
const SCRIPTS = process.env.BE_DIR || path.join(HOME, '.openclaw', 'workspace', 'scripts');
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
// 凭据文件：{ "apiKey": "...", "apiSecret": "..." }
// 路径可用 BINANCE_AUTH 覆盖，默认 <SCRIPTS>/binance-auth.json
const TMP = path.join(SCRIPTS, '.tmp-be-card.json');
const SIGFIELD = 'sig' + 'nature';

// 保本缓冲：双边 taker 0.04%×2 = 0.08%，加滑点余量 → 0.12%
const FEE_BUFFER = 0.0012;

function curlOut(args) {
  for (let i = 0; i < 3; i++) {
    try {
      execSync(['curl.exe', '--proxy', PROXY, '-s', '--max-time', '25', ...args].join(' '),
        { encoding: 'utf8', shell: 'powershell.exe', stdio: ['ignore', 'pipe', 'ignore'] });
      return JSON.parse(fs.readFileSync(TMP, 'utf8').replace(/^\uFEFF/, ''));
    } catch (e) { }
  }
  return null;
}
function auth() {
  const p = process.env.BINANCE_AUTH || path.join(SCRIPTS, 'binance-auth.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function signed(p, params = {}) {
  const a = auth();
  const st = curlOut(['"https://fapi.binance.com/fapi/v1/time"', '-o', '"' + TMP + '"']);
  if (!st || !st.serverTime) return null;
  const ts = Date.now() + (st.serverTime - Date.now());
  const qs = new URLSearchParams({ ...params, timestamp: ts, recvWindow: 10000 }).toString();
  const s = crypto.createHmac('sha256', a.apiSecret).update(qs).digest('hex');
  return curlOut(['-H', '"X-MBX-APIKEY: ' + a.apiKey + '"',
    '"https://fapi.binance.com' + p + '?' + qs + '&' + SIGFIELD + '=' + s + '"', '-o', '"' + TMP + '"']);
}
function pub(url) {
  for (let i = 0; i < 3; i++) {
    try { return JSON.parse(execSync(`curl.exe --ssl-no-revoke --proxy ${PROXY} -s --max-time 20 "${url}"`, { encoding: 'utf8' })); } catch (e) { }
  }
  return null;
}
function atr16(sym, interval = '1h', n = 16) {
  const k = pub(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=60`);
  if (!Array.isArray(k)) return null;
  const trs = [];
  for (let i = 1; i < k.length; i++) {
    const h = +k[i][2], l = +k[i][3], pc = +k[i - 1][4];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let a = trs.slice(0, n).reduce((x, y) => x + y, 0) / n;
  for (let i = n; i < trs.length; i++) a = (a * (n - 1) + trs[i]) / n;
  return a;
}
function tick(sym) {
  const t = pub(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${sym}`);
  return t ? { last: +t.lastPrice, high: +t.highPrice, low: +t.lowPrice } : null;
}
function dp(sym) {
  // 价格小数位（跟交易所一致）
  if (/BTC/.test(sym)) return 1;
  if (/^(ETH|ZEC|SNDK|SOL|XAU)/.test(sym)) return 2;
  return 4;
}

/**
 * 生成单张保本卡的数据结构
 */
function buildCard(sym, side, entry, stop, qty, opts = {}) {
  const t = tick(sym);
  const A = atr16(sym);
  if (!t || !A) return null;
  const price = t.last;
  const isShort = side === 'short';
  const dd = dp(sym);

  // 浮盈（正数=赚钱）
  const profitPts = isShort ? (entry - price) : (price - entry);
  const profitU0 = profitPts * qty;
  // 门槛1 · 波动底线（防假警报）：浮盈 ≥ 1×ATR16
  const need = A * 1.0;                       // 纪律22 硬门槛
  const gate1 = profitPts >= need;
  const ratio = profitPts / need;

  // 门槛2 · 绝对金额（防漏报）：浮盈金额 ≥ 账户 5%
  // 依据：账户风险的度量单位是钱。小账户 11 点浮盈就是 11%，大账户只是 1%
  const profitU = profitPts * qty;
  const pctOfEq = opts.equity ? (profitU / opts.equity * 100) : null;
  const gate2 = pctOfEq != null ? pctOfEq >= 5 : null;

  // 门槛3 · 空间判断：距TP ÷ 浮盈
  // >3 倍 → 到目标概率低，推保本锁定更优
  // ≤1.5 倍 → 快到了，直接止盈，别推
  let gate3 = null, spaceRatio = null;
  if (opts.tp1) {
    spaceRatio = Math.abs(entry - opts.tp1) / Math.max(profitPts, 0.0001);
    gate3 = spaceRatio > 3 ? '推保本' : spaceRatio <= 1.5 ? '直接止盈' : '两可';
  }

  // 1R = 入场到原始止损（纪律22 前的原始风险）
  const R = Math.abs(stop - entry);
  const oneRMoney = R * qty;

  // ── 状态判定：止损是否已推到保本或更好（防重复推）──
  const isAtOrBeyondBE = isShort ? (stop <= entry) : (stop >= entry);
  const state = isAtOrBeyondBE ? 'breakeven_sent' : 'structural';

  // 保本价（含手续费缓冲）
  const be = isShort ? entry * (1 - FEE_BUFFER) : entry * (1 + FEE_BUFFER);
  const beDistPts = Math.abs(price - be);
  const beDistAtr = beDistPts / A;

  // 风险对比
  const riskBefore = -oneRMoney;               // 原止损触发
  const riskAfter = isShort
    ? (entry - be) * qty                      // 保本触发（空单低价买回 = 赚）
    : (be - entry) * qty;                     // 多单高价卖出 = 赚
  const riskSaved = riskAfter - riskBefore;

  // 被扫风险粗判（距现价几个 ATR）
  let beSafety;
  if (beDistAtr >= 1.5) beSafety = '高（距现价 ' + beDistAtr.toFixed(2) + '×ATR，噪音难触及）';
  else if (beDistAtr >= 1.0) beSafety = '中（距现价 ' + beDistAtr.toFixed(2) + '×ATR，勉强够）';
  else if (beDistAtr >= 0.7) beSafety = '偏低（距现价 ' + beDistAtr.toFixed(2) + '×ATR，一根正常波动就能碰）';
  else beSafety = '低（距现价 ' + beDistAtr.toFixed(2) + '×ATR，已在噪音带内）';

  return {
    sym, side, entry, stop, qty,
    state,
    price: +price.toFixed(dd),
    atr: +A.toFixed(dd),
    profitPts: +profitPts.toFixed(dd),
    profitU: +profitU0.toFixed(2),
    pctOfEq: pctOfEq != null ? +pctOfEq.toFixed(2) : null,
    need: +need.toFixed(dd),
    ratio: +ratio.toFixed(2),
    gate1, gate2, gate3,
    spaceRatio: spaceRatio != null ? +spaceRatio.toFixed(2) : null,
    reached: gate1,
    gap: +Math.max(0, need - profitPts).toFixed(dd),
    oneRPts: +R.toFixed(dd),
    oneRMoney: +oneRMoney.toFixed(2),
    be: +be.toFixed(dd),
    beDistPts: +beDistPts.toFixed(dd),
    beDistAtr: +beDistAtr.toFixed(2),
    beSafety,
    riskBefore: +riskBefore.toFixed(2),
    riskAfter: +riskAfter.toFixed(2),
    riskSaved: +riskSaved.toFixed(2),
    tp1: opts.tp1 ?? null,
  };
}

/** 渲染成文本卡片 */
function render(c, opts = {}) {
  const L = [];
  const dirCn = c.side === 'short' ? '空' : '多';
  const dd = dp(c.sym);
  const f = (x) => Number(x).toFixed(dd);

  L.push('━━━━━━━━━━━━━━━');
  L.push(`【保本损执行卡】${c.sym} ${dirCn} ${c.qty} 张`);
  L.push('━━━━━━━━━━━━━━━');
  L.push(`现价 ${f(c.price)} ｜ 入场 ${f(c.entry)} ｜ 浮盈 ${c.profitPts >= 0 ? '+' : ''}${f(c.profitPts)} 点（${c.profitU >= 0 ? '+' : ''}${c.profitU}u）`);
  L.push('');

  // ── 已推保本：只报告状态，不再让他推第二次 ──
  if (c.state === 'breakeven_sent') {
    const locked = c.side === 'short' ? (c.entry - c.stop) * c.qty : (c.stop - c.entry) * c.qty;
    L.push(`✅ 已推保本损：${f(c.stop)}（${locked >= 0 ? '+' : ''}${locked.toFixed(2)}u 锁定）`);
    L.push('   → 不要再推，否则会出现两条同向止损；只能在价格继续走好时往上收紧。');
    L.push('');
    L.push('▸ 下一步看什么');
    if (c.tp1) {
      const tpR = Math.abs(c.entry - c.tp1) / Math.max(Math.abs(c.stop - c.entry), 0.0001);
      L.push(`   止盈档 ${f(c.tp1)} 还差 ${f(Math.abs(c.price - c.tp1))} 点`);
    }
    L.push('   被扫之后：24 小时内不碰这个品种。');
    return L.join('\n');
  }

  L.push(`门槛1 · 波动底线：浮盈 ${f(c.profitPts)} 点 vs 1.0× ATR16 ${f(c.need)}  →  ${c.gate1 ? `✅ 已达标（${c.ratio}×）` : `❌ 差 ${f(c.gap)} 点（${c.ratio}×）`}`);
  if (c.pctOfEq != null) {
    L.push(`门槛2 · 绝对金额：浮盈 ${c.profitU >= 0 ? '+' : ''}${c.profitU}u = 账户 ${c.pctOfEq}%  vs 需 ≥5%  →  ${c.gate2 ? '✅ 够了' : '❌ 太小，不值得为它放弃 TP'}`);
  }
  if (c.spaceRatio != null) {
    L.push(`门槛3 · 空间判断：距TP ${f(Math.abs(c.entry - c.tp1))} 点 ÷ 浮盈 ${f(c.profitPts)} 点 = ${c.spaceRatio} 倍  →  ${c.gate3}`);
  }
  L.push('');

  // ── 三道门槛一起判 ──
  const canPush = c.gate1 && (c.gate2 !== false);
  if (!c.gate1) {
    L.push('⚠️ 门槛1 未过，先别推。');
    L.push(`   保本损时距现价 ${c.beDistAtr}× ATR，落在正常波动带里，推了大概率假警报。`);
    L.push('   替代：走纪律21 减半锁利 + 剩余推保本（半仓的钱已落袋才敢贴身止损）');
    L.push('');
    L.push(`   等价格到 ${f(c.side === 'short' ? c.entry - c.need : c.entry + c.need)} 再推。`);
    return L.join('\n');
  }
  if (c.gate2 === false) {
    L.push('⚠️ 门槛1 过了，但门槛2 未过：浮盈金额太小，回吐也不痛。');
    L.push('   漏报代价小 → 不值得为它放弃 TP 空间。建议继续持有，不要推。');
    return L.join('\n');
  }
  if (c.gate3 === '直接止盈') {
    L.push('💡 距 TP 已不足 1.5 倍浮盈 → 快到了。');
    L.push('   按纪律23「二选一」：这种情况直接止盈或减半，别推保本。');
    return L.join('\n');
  }

  L.push(`▸ 保本价 ${f(c.be)}`);
  L.push(`   算法：${f(c.entry)} × (1 ${c.side === 'short' ? '−' : '+'} 0.12%) = ${f(c.be)}`);
  L.push('   0.12% = 双边 taker 0.08% + 滑点余量 0.04%');
  L.push('');
  L.push('▸ 挂单参数（照抄）');
  L.push('   类型  STOP_MARKET');
  L.push(`   方向  ${c.side === 'short' ? 'BUY（平空）' : 'SELL（平多）'}`);
  L.push(`   触发  ${f(c.be)}`);
  L.push('   数量  全仓 closePosition=true   ← 必须');
  L.push('   触发价类型  MARK_PRICE');
  L.push('');
  L.push('▸ 风险变化');
  L.push(`   推之前：最坏 ${c.riskBefore}u（原止损 ${f(c.stop)}）`);
  L.push(`   推之后：最坏 ${c.riskAfter >= 0 ? '+' : ''}${c.riskAfter}u（保本）`);
  L.push(`   风险减少 ${c.riskSaved}u`);
  L.push(`   被扫难度：${c.beSafety}`);
  L.push('');

  L.push('▸ 代价对比（信号检测论）');
  const missCost = Math.max(c.profitU, 0);
  L.push(`   漏报代价（不推，回吐浮盈）= ${missCost.toFixed(0)}u`);
  if (c.tp1) {
    const falseCost = Math.abs(c.entry - c.tp1) * c.qty;
    L.push(`   假警报代价（推了被扫，错过TP）= ${falseCost.toFixed(0)}u`);
    L.push(`   → 两者都要看概率，但漏报是「确定的回吐」，假警报是「可能的机会」`);
  }
  L.push('');
  L.push('▸ 纪律 23 二选一检查');
  L.push('   推保本 与 分批止盈 只能选一条，不许叠加。');
  L.push(`   本单：${opts.intent === 'profit' ? '要利润 → 走分批止盈，别推保本' : '要敞口 → 推保本，一张不动 ✅'}`);
  L.push('');

  L.push('▸ 推完核对（3 项）');
  L.push('   1. 原止损是否已被自动撤掉？→ 不能留两条同向止损');
  L.push('   2. 新单数量字段是不是 0 / 全仓？→ 不是就撤了重挂');
  L.push(`   3. 触发价是不是 ${f(c.be)}？→ 差 1 点也算错`);
  L.push('');

  L.push('▸ 被扫之后');
  L.push('   24 小时内不碰这个品种。被扫不是失败，是保本成功的代价。');
  return L.join('\n');
}

// ─────────────── CLI ───────────────
const args = process.argv.slice(2);
const ALL = args.includes('--all');
const JSONOUT = args.includes('--json');
const atrIdx = args.indexOf('--atr-period');

function livePositions() {
  const pos = signed('/fapi/v2/positionRisk');
  if (!Array.isArray(pos)) return null;
  return pos.filter(p => Number(p.positionAmt) !== 0).map(p => ({
    sym: p.symbol,
    side: Number(p.positionAmt) < 0 ? 'short' : 'long',
    entry: +p.entryPrice,
    qty: Math.abs(Number(p.positionAmt)),
    mark: +p.markPrice,
  }));
}

function currentStop(sym, side) {
  const alg = signed('/fapi/v1/openAlgoOrders', { symbol: sym });
  if (!Array.isArray(alg)) return null;
  const wantBuy = side === 'short' ? 'BUY' : 'SELL';
  const stops = alg.filter(a => a.orderType === 'STOP_MARKET' && a.side === wantBuy);
  if (!stops.length) return null;
  // 取离现价最近的那条（即最近一次推的止损）
  return stops.sort((a, b) => +b.createTime - +a.createTime)[0];
}

function tp1Of(sym) {
  const alg = signed('/fapi/v1/openAlgoOrders', { symbol: sym });
  if (!Array.isArray(alg)) return null;
  const tps = alg.filter(a => a.orderType === 'TAKE_PROFIT_MARKET');
  if (!tps.length) return null;
  // 取离现价最近的那一档（第一档止盈）
  const t = tick(sym);
  const px = t ? t.last : null;
  tps.sort((a, b) => px === null ? 0 : Math.abs(+a.triggerPrice - px) - Math.abs(+b.triggerPrice - px));
  return +tps[0].triggerPrice;
}

if (ALL) {
  const live = livePositions();
  if (!live) { console.log('持仓读取失败'); process.exit(1); }
  if (!live.length) { console.log('NO_POSITION'); process.exit(0); }
  const acct = signed('/fapi/v2/account');
  const eqAll = acct && acct.totalMarginBalance ? +acct.totalMarginBalance : null;
  const cards = [];
  for (const p of live) {
    const sl = currentStop(p.sym, p.side);
    if (!sl) { cards.push({ sym: p.sym, skip: 'no_stop', msg: `⚠️ ${p.sym} 没有止损单！先补止损再谈保本` }); continue; }
    const c = buildCard(p.sym, p.side, p.entry, +sl.triggerPrice, p.qty, { tp1: tp1Of(p.sym), equity: eqAll });
    if (!c) { cards.push({ sym: p.sym, skip: 'no_data' }); continue; }
    c.stopOrderId = sl.algoId;
    cards.push(c);
  }
  if (JSONOUT) { console.log(JSON.stringify(cards, null, 1)); process.exit(0); }
  console.log(cards.map(c => c.skip ? (c.msg || `${c.sym} 数据不足`) : render(c)).join('\n\n'));
} else {
  const [sym, side, entry, stop, qty] = args;
  if (!sym || !side || !entry || !stop) {
    console.log('用法: node be-card.mjs <SYMBOL> <long|short> <entry> <stop> [qty] [--tp1 X] [--equity Y]');
    console.log('      node be-card.mjs --all [--json]');
    process.exit(1);
  }
  const S = sym.toUpperCase();
  const t = tick(S);
  const q = qty ? +qty : 1;
  // 2026-11-02 修：单张模式也要拿到 权益 和 TP1，否则门槛2/3 永远不显示
  const flag = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
  let eq = flag('equity') ? +flag('equity') : null;
  if (eq == null) {
    const acct = signed('/fapi/v2/account');
    if (acct && acct.totalMarginBalance) eq = +acct.totalMarginBalance;
  }
  const tp1 = flag('tp1') ? +flag('tp1') : tp1Of(S);
  const c = buildCard(S, side, +entry, +stop, q, { tp1, equity: eq });
  if (!c) { console.log('数据读取失败'); process.exit(1); }
  if (JSONOUT) { console.log(JSON.stringify(c, null, 1)); process.exit(0); }
  console.log(render(c));
}
