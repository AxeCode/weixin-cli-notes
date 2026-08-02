---
title: "02 架构：六个模块，两个运行时"
description: 从 Rust module tree、运行时边界和数据依赖理解 wx-cli。
tags: [wx-cli, Rust, 架构]
---

# 02 架构：六个模块，两个运行时

## 先看模块树

```text
src/
├── main.rs                 # 运行时二态分流
├── config.rs               # 配置、路径、平台目录探测
├── ipc.rs                  # Request/Response wire schema
├── crypto/
│   ├── mod.rs              # SQLCipher 页解密、full_decrypt
│   └── wal.rs              # 解密 WAL 帧并覆盖缓存页
├── scanner/
│   ├── mod.rs              # KeyEntry、DB salt 收集、平台分发
│   ├── macos.rs            # Mach VM API
│   ├── linux.rs            # /proc/<pid>/maps + mem
│   └── windows.rs          # ToolHelp + VirtualQueryEx
├── daemon/
│   ├── mod.rs              # daemon 启动、密钥加载、信号清理
│   ├── cache.rs            # DbCache 与 mtime/WAL tier
│   ├── meta.rs             # freshness 元数据和 shard 发现
│   ├── query.rs            # Names、SQL 查询、XML/压缩解析
│   └── server.rs           # socket/pipe accept + dispatch
├── attachment/             # 附件 ID、dat decoder、图片 key、路径解析
└── cli/                    # clap 命令、transport、输出、导出
```

依赖方向大致是：

```text
cli → ipc → daemon/server → daemon/query → daemon/cache → crypto
  │                  └──────→ attachment
  └──────────────→ config / transport

cli/init → config → scanner
```

`main.rs` 通过 `mod` 把所有代码放进一个 binary crate，而不是拆成多个 Cargo package。这样做减少了发布复杂度：npm、shell 和 PowerShell 最终都只需要找到一个 `wx` 二进制。

## 两个运行时，而不是两个程序

普通调用和后台服务使用同一个执行文件：

```text
wx sessions
  └─ WX_DAEMON_MODE 未设置 → cli::run()

wx-daemon（由 transport spawn）
  └─ WX_DAEMON_MODE=1     → daemon::run()
```

这不是简单的“同一个程序有两个命令”。daemon 模式不会经过 clap，而是直接初始化 Tokio runtime，读取配置、加载 keys、构造 cache、监听 IPC。好处是发布只维护一个平台二进制，CLI 与 daemon 使用完全相同的 `config.rs` 和 `ipc.rs` 定义。

代价是进程身份、权限和日志必须被处理得很仔细：daemon 不能继承一次 `sudo wx init` 留下的 root 文件属主，否则普通用户后续无法创建 socket 和 log。

## 三条关键边界

### scanner 与 crypto：key 是字符串，解密只收 32 字节

scanner 负责平台 API 和候选识别，统一产出：

```rust
pub struct KeyEntry {
    pub db_name: String,
    pub enc_key: String,
    pub salt: String,
}
```

crypto 不知道“微信进程”是什么，只接收已经匹配好的 `[u8; 32]` key 和数据库文件路径。这个边界让 SQLCipher 页解密可以用纯文件测试，而不用启动微信。

### cache 与 query：路径解析 vs 数据语义

`DbCache` 只回答：“给定 `message/message_0.db`，当前能否得到一份解密 SQLite 文件？走了哪条缓存路径？”

`query.rs` 才回答：“这个文件里的哪个 `Msg_<md5>` 表对应 Alice？哪一列是 zstd？如何把 appmsg XML 格式化成文件或引用消息？”

### IPC 与输出：wire schema 不等于终端格式

`ipc::Request` / `Response` 是 CLI 与 daemon 之间的 JSON line 协议；用户看到的 YAML/JSON 由 CLI 的 `output.rs` 决定。默认 YAML 适合人读，`--json` 适合脚本和 Agent，但两者共享同一个 `serde_json::Value` 数据模型。

## 为什么 `query.rs` 没有继续拆包？

从工程角度，5286 行的 `query.rs` 当然可以拆成 `messages.rs`、`sns.rs`、`attachments.rs` 等文件。但当前实现把同一个 SQLite 访问语境下的名称缓存、type 映射、消息 XML 解析、freshness 计算放在一起，有两个现实优点：

1. `Names`、`Meta` 和辅助函数可以直接共享，避免跨模块暴露大量内部类型。
2. 数据库 schema 的变化集中在一个文件，便于从上到下追踪一次查询。

代价是源码导航成本高。阅读时建议按入口函数而不是按文件顺序：从 `q_history`、`q_search`、`q_sessions`、`q_attachments` 开始，再追 helper。

## 查询层的统一返回形状

主查询通常都输出类似的 envelope：

```json
{
  "chat": "Alice",
  "username": "wxid_alice",
  "chat_type": "private",
  "count": 2,
  "messages": [],
  "meta": {
    "shards_scanned": 3,
    "shards_hit": 1,
    "unknown_shards": [],
    "status": "ok"
  }
}
```

统一 envelope 带来的收益是：Agent 不需要为每个命令重新学习“有没有漏数据”的判断方式。

## 一个值得复用的架构模板

```text
一次性高权限 bootstrap
  → 产出可复用 credential snapshot
短命命令客户端
  → 透明启动/连接常驻服务
常驻服务
  → 按资源版本做缓存
  → 通过 schema-aware adapter 输出稳定对象
输出
  → 数据 + freshness/source metadata
```

下一章会沿着进程启动和配置路径，解释这套模板如何落到具体代码上。
