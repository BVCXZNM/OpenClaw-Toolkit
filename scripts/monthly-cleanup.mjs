#!/usr/bin/env node
/**
 * monthly-cleanup.mjs — 月度大扫除（OpenClaw 工作区）
 *
 * 安全原则：
 *  1) 默认 dry-run，只报告不删；加 --apply 才真正执行
 *  2) 破坏性操作一律「先移动后删除」，并有 KEEP 列表兜底
 *  3) 永不触碰：语义检索模型、上传材料、照片、cron 引用脚本
 *  4) 个人材料（证件/简历/成绩单等）无条件保留，不看年龄不看大小
 *
 * 用法：
 *   node monthly-cleanup.mjs                    # 试运行，只报告
 *   node monthly-cleanup.mjs --apply            # 真正执行
 *   node monthly-cleanup.mjs --apply --purge-trajectory   # 额外清理会话轨迹
 *
 * 配置（环境变量，均可选）：
 *   WORKSPACE  工作区路径，默认 ~/.openclaw/workspace
 *   OCHOME     OpenClaw 根目录，默认 ~/.openclaw
 *   KEEP_FILE  个人材料关键词文件（每行一个正则），默认 <workspace>/cleanup-keep.txt
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const APPLY = process.argv.includes("--apply");
const PURGE_TRAJ = process.argv.includes("--purge-trajectory");
const STAMP = new Date().toISOString().slice(0, 10);
const NOW = Date.now();
const DAY = 86400000;

const HOME = process.env.OCHOME || path.join(os.homedir(), ".openclaw");
const WS = process.env.WORKSPACE || path.join(HOME, "workspace");
const SCRIPT_DIR = path.join(WS, "scripts");
const KEEP_FILE = process.env.KEEP_FILE || path.join(WS, "cleanup-keep.txt");

const log = [];
const say = (s) => { log.push(s); console.log(s); };
const mb = (n) => (n / 1024 / 1024).toFixed(1) + " MB";

function walk(dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else {
      try { const st = fs.statSync(p); out.push({ p, size: st.size, mtime: st.mtimeMs }); } catch {}
    }
  }
  return out;
}

function ageDays(ms) { return (NOW - ms) / DAY; }

function rmSafe(p) {
  if (!APPLY) return true;
  try { fs.unlinkSync(p); return true; } catch { return false; }
}

function moveTo(src, dstDir) {
  if (!APPLY) return true;
  try {
    fs.mkdirSync(dstDir, { recursive: true });
    fs.renameSync(src, path.join(dstDir, path.basename(src)));
    return true;
  } catch { return false; }
}

// ─────────────────────────────────────────────
// 个人材料保护：从外部文件加载关键词（每行一个正则）
// 默认内置一组通用中文证件类关键词，可按需覆盖
// ─────────────────────────────────────────────
const DEFAULT_PATTERNS = [
  "身份证", "户口", "护照", "驾驶证", "毕业证", "学位", "学历",
  "成绩单", "简历", "推荐信", "证书", "准考证", "报名", "政审",
  "体检", "缴费", "回执", "offer", "contract",
  "\\bresume\\b", "\\btranscript\\b", "\\bcertificate\\b", "\\bpassport\\b",
];

let keepSrc = DEFAULT_PATTERNS;
if (fs.existsSync(KEEP_FILE)) {
  const lines = fs.readFileSync(KEEP_FILE, "utf8")
    .split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#"));
  if (lines.length) { keepSrc = lines; say(`◆ 个人材料关键词：从 ${KEEP_FILE} 载入 ${lines.length} 条`); }
}
const KEEP_PATTERNS = keepSrc.map(s => { try { return new RegExp(s, "i"); } catch { return null; } }).filter(Boolean);
const isPersonal = (name) => KEEP_PATTERNS.some(re => re.test(name));

say("══════ 月度大扫除 " + STAMP + (APPLY ? " 【执行】" : " 【试运行】") + " ══════");
say(`工作区：${WS}`);
say("");

// ─────────────────────────────────────────────
// ① scripts/_trash：回收站满 14 天 → 永久删除
// ─────────────────────────────────────────────
const trashRoot = path.join(SCRIPT_DIR, "_trash");
let trashFreed = 0, trashCount = 0;
if (fs.existsSync(trashRoot)) {
  for (const d of fs.readdirSync(trashRoot, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join(trashRoot, d.name);
    const st = fs.statSync(dir);
    if (ageDays(st.mtimeMs) < 14) {
      say(`① 回收站 ${d.name}：距今 ${ageDays(st.mtimeMs).toFixed(0)} 天，未满 14 天，保留`);
      continue;
    }
    const files = walk(dir);
    const sz = files.reduce((a, b) => a + b.size, 0);
    files.forEach(f => rmSafe(f.p));
    if (APPLY) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
    trashFreed += sz; trashCount += files.length;
    say(`① 回收站 ${d.name}：${files.length} 个 / ${mb(sz)} → 已永久删除`);
  }
}
if (!trashCount) say("① 回收站：无可清理项");

// ─────────────────────────────────────────────
// ② workspace/tmp：30 天以上一次性产物 → 移到 tmp/_trash
//     KEEP：gguf(模型) / upload(材料) / photos
// ─────────────────────────────────────────────
const TMP = path.join(WS, "tmp");
const KEEP_DIRS = new Set(["gguf", "upload", "photos", "_trash"]);
const TMP_TRASH = path.join(TMP, "_trash", STAMP);
let tmpFreed = 0, tmpCount = 0;

if (fs.existsSync(TMP)) {
  const entries = fs.readdirSync(TMP, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(TMP, e.name);
    if (e.isDirectory()) {
      if (KEEP_DIRS.has(e.name)) continue;
      if (isPersonal(e.name)) { say(`② tmp/${e.name}/：🔒 个人材料目录，保留`); continue; }
      const st = fs.statSync(p);
      let newest = st.mtimeMs;
      const files = walk(p);
      for (const f of files) if (f.mtime > newest) newest = f.mtime;
      if (ageDays(newest) < 30) continue;
      const sz = files.reduce((a, b) => a + b.size, 0);
      if (APPLY) {
        try {
          fs.mkdirSync(TMP_TRASH, { recursive: true });
          fs.renameSync(p, path.join(TMP_TRASH, e.name));
        } catch {}
      }
      tmpFreed += sz; tmpCount += files.length;
      say(`② tmp/${e.name}/：${files.length} 个 / ${mb(sz)} → 移入回收站`);
    } else {
      const st = fs.statSync(p);
      // ★ 个人材料：无条件保留，不看年龄、不看大小
      if (isPersonal(e.name)) {
        say(`② tmp/${e.name}：${mb(st.size)} → 🔒 个人材料，保留`);
        continue;
      }
      if (ageDays(st.mtimeMs) < 30) continue;
      // 单个文件：保护文档/压缩包
      if (/\.(pdf|docx?|xlsx?|xls|pptx?|rar|7z|zip)$/i.test(e.name)) {
        say(`② tmp/${e.name}：${mb(st.size)} → 文档/压缩包，保留（请人工确认）`);
        continue;
      }
      moveTo(p, TMP_TRASH);
      tmpFreed += st.size; tmpCount++;
      say(`② tmp/${e.name}：${mb(st.size)} → 移入回收站`);
    }
  }
}
if (!tmpCount) say("② tmp/：无可清理项");

// ─────────────────────────────────────────────
// ③ 日志：30 天以上
// ─────────────────────────────────────────────
let logFreed = 0, logCount = 0;
const LOGDIRS = [path.join(os.tmpdir(), "openclaw"), path.join(HOME, "logs")];
for (const dir of LOGDIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const p = path.join(dir, e.name);
    const st = fs.statSync(p);
    if (ageDays(st.mtimeMs) < 30) continue;
    if (rmSafe(p)) { logFreed += st.size; logCount++; }
  }
}
say(`③ 日志：${logCount} 个 / ${mb(logFreed)} ${APPLY ? "已删除" : "可删除"}`);

// ─────────────────────────────────────────────
// ④ 会话：`.reset.*` 备份(>30天) 与 `.trajectory.jsonl`(>60天)
//     轨迹文件是调试留痕，非对话正文 → 默认不动，需 --purge-trajectory
// ─────────────────────────────────────────────
const SESS = path.join(HOME, "agents", "main", "sessions");
let sessFreed = 0, sessCount = 0, trajBytes = 0, trajCount = 0;
if (fs.existsSync(SESS)) {
  for (const e of fs.readdirSync(SESS, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const p = path.join(SESS, e.name);
    const st = fs.statSync(p);
    const a = ageDays(st.mtimeMs);
    if (/\.trajectory\.jsonl$/.test(e.name)) {
      trajBytes += st.size; trajCount++;
      if (PURGE_TRAJ && a > 60) {
        if (rmSafe(p)) { sessFreed += st.size; sessCount++; }
      }
      continue;
    }
    if (/\.reset\./.test(e.name) && a > 30) {
      if (rmSafe(p)) { sessFreed += st.size; sessCount++; }
    }
  }
}
say(`④ 会话：${sessCount} 个 / ${mb(sessFreed)} ${APPLY ? "已删除" : "可删除"}（reset 备份 >30 天）`);
say(`   · 轨迹文件共 ${trajCount} 个 / ${mb(trajBytes)}（调试留痕）` +
  (PURGE_TRAJ ? " → 已清理 >60 天部分" : " → 未清理，需 --purge-trajectory"));

// ─────────────────────────────────────────────
// 汇总
// ─────────────────────────────────────────────
const totalFreed = trashFreed + tmpFreed + logFreed + sessFreed;
say("");
say("══════ 汇总 ══════");
say(`脚本残骸 ${trashCount} 个 / ${mb(trashFreed)}`);
say(`tmp 产物 ${tmpCount} 个 / ${mb(tmpFreed)}`);
say(`日志     ${logCount} 个 / ${mb(logFreed)}`);
say(`会话备份 ${sessCount} 个 / ${mb(sessFreed)}`);
say(`合计可释放：${mb(totalFreed)}`);
if (!APPLY) say("\n⚠️ 这是试运行。加 --apply 才真正执行。");

// 存报告
try {
  fs.mkdirSync(path.join(WS, "memory"), { recursive: true });
  fs.writeFileSync(
    path.join(WS, "memory", `cleanup-${STAMP}.md`),
    "# 月度大扫除报告 " + STAMP + "\n\n" + log.join("\n") + "\n"
  );
} catch {}
