# OpenClaw Toolkit

王琥斓曦（小琥）的 OpenClaw 工作流脚本集。

这些脚本都是从真实运维里长出来的，每一个都带着踩坑记录——**不是演示代码，是实际天天在跑的东西**。所以每个脚本头部都会写明：为什么写它、踩过哪些坑、参数是怎么校准的。

---

## 收录内容

### `monthly-cleanup.mjs` — 月度大扫除

清理工作区里堆积的一次性产物：脚本残骸、tmp 文件、旧日志、会话备份。

**设计要点：**
- **默认 dry-run**，加 `--apply` 才真正执行
- **先移动后删除**，回收站满 14 天才永久删（留反悔期）
- **个人材料无条件保留**：证件、简历、成绩单、体检报告等命中关键词一律不动，不看年龄不看大小
- 关键词从外部文件加载（`cleanup-keep.txt`），默认内置一组通用中文证件类词

**来历（重要）：** 第一版只保护「>1MB 的 pdf/docx/zip」，dry-run 清单里出现了 0.3MB 的成绩单，差点被清掉。**这个 bug 教会我一件事：凡是批量清理，先看 dry-run 清单里有没有人名、证件类文件，而不是靠大小或类型猜。**

### `usage-ledger.mjs` — Token 花费账本

解析会话 jsonl 里的 usage 字段，统计 token 消耗与花费。

**⚠️ 两个必须读的坑：**

1. **`.usage-cost-cache.json` 会停止更新**（本项目里停在某个时间点之后再没动过）。不能拿它当数据源，必须直接解析 jsonl。
2. **按配置单价推算会严重高估，实测高估 4.16 倍。** 原因是 98% 的 token 是**缓存读**，而实际缓存单价远低于配置里写的值。
   → **账本必须先拿「账户余额实际变化」校验一遍再用。** 我第一版差点得出「一个月 300 块」的错误结论，实际是 50 块。

价格表是 2026-11 的快照，用前请核对官方定价。

### `be-card.mjs` — 保本损执行卡

当持仓有浮盈、考虑推保本止损时，这张卡把该算的东西一次给全：门槛判定、保本价算法（含手续费缓冲）、挂单参数、风险变化、二选一检查、推完后的三项核对、被扫后怎么处置。

**为什么不只是「把止损挪到成本价」这么简单：**

推保本有三个实测坑——
1. **推太早**：保本价落进噪音带（距现价 < 1×ATR），必被扫
2. **不知道会不会重复**：同一价位挂了两条止损
3. **不知道风险降了多少**：没算过从 −115 到 +1 到底变了什么

**核心门槛：** 当前价距成本必须 ≥ 1×ATR，否则应该「减半锁利 + 推保本」而不是直接推。半仓的钱先落袋，剩半仓才敢给贴身止损。

### `be-ledger.mjs` — 反事实台账

**这个脚本解决的是一个方法论问题：保本损的结果永远是「可接受的勉强好」，没法用结果反推改进。**

所以不能看结果，要看**过程指标**：
- 假扫率（被扫之后价格又回来了 = 扫错了）
- 存活时长
- k 曲线（实际保本距离 ÷ ATR）

记录两条线：实际线（真的推了保本）和反事实线（假设没推会怎样）。这样一次推保本是对是错，事后可以算出来。

---

## 配置

所有脚本都通过环境变量配置，不硬编码个人路径：

| 变量 | 作用 | 默认 |
|---|---|---|
| `OCHOME` | OpenClaw 根目录 | `~/.openclaw` |
| `WORKSPACE` | 工作区路径 | `$OCHOME/workspace` |
| `KEEP_FILE` | 个人材料关键词文件 | `$WORKSPACE/cleanup-keep.txt` |
| `SESS_DIR` | 会话记录目录 | `~/.openclaw/agents/main/sessions` |
| `HTTP_PROXY` / `HTTPS_PROXY` | 代理（访问交易所 API 用） | 空 |
| `BINANCE_AUTH` | 币安凭据文件路径 | `<scripts>/binance-auth.json` |
| `BE_DIR` | be-card 的状态文件目录 | `~/.openclaw/workspace/scripts` |

凭据文件格式（`binance-auth.json`，**不要提交到仓库**）：

```json
{ "apiKey": "your-key", "apiSecret": "your-secret" }
```

---

## 一个通用的技术坑：Node fetch 不读代理

**Node 原生 `fetch`（undici）不读 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量，而 `curl` 会读。**

后果很隐蔽：同一个 URL，curl 能通、Node fetch 报 `fetch failed`，而且**如果是告警脚本，失败是静默的**——你以为在盯着，其实全哑了。

三种解法，按场景选：
1. **curl + 显式 `--proxy`**（最稳，但 Windows 下有引号地狱）
2. **Node 22+ 加 `NODE_USE_ENV_PROXY=1`**（最省事，原生 fetch 就读代理了）
3. **手写 HTTP CONNECT 隧道**（只用 `net`/`tls`/`zlib`，零依赖、无 shell 调用面）

⚠️ 若手写隧道：**OKX 的响应同时是 `chunked` + `gzip`，必须先 dechunk 再 gunzip。** 顺序反了会报 `incorrect header check`，而且很难看出是顺序问题。

---

## 用法

```bash
# 大扫除（先试运行看清单）
node scripts/monthly-cleanup.mjs
node scripts/monthly-cleanup.mjs --apply

# token 账本
node scripts/usage-ledger.mjs --days 7 --by day

# 保本损卡
node scripts/be-card.mjs ETH long 2400 2350 1
node scripts/be-card.mjs --all

# 反事实台账
node scripts/be-ledger.mjs add ETH long 2400 2350 1 2380
node scripts/be-ledger.mjs stat
```

---

## 说明

这些脚本面向的是「自己用」的场景，不追求通用性——比如保本损的逻辑深度依赖个人的交易纪律，大扫除的 KEEP 规则也是按实际文件命名习惯写的。**拿去用之前请先 dry-run 看一眼，别直接跑 `--apply`。**

## License

MIT
