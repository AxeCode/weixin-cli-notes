---
title: "01 总览：一个本地微信数据 Agent 适配层"
description: wx-cli 的目标、边界、核心数字和一次查询的全链路。
tags: [wx-cli, 总览, Agent]
---

# 01 总览：一个本地微信数据 Agent 适配层

## 一句话定位

`wx-cli` 不是微信客户端，也不是通用 ORM；它是一个把微信桌面端本地数据包装成“可被人和 LLM 消费的查询接口”的本地适配层。它处理了三个普通查询工具不会处理的问题：数据库加密、数据分片和数据持续变化。

如果只看功能列表，项目像是 `sessions`、`history`、`search` 等命令的集合；如果看运行时，它其实是下面四个角色的合体：

1. **平台探针**：在目标微信进程中找出与数据库 salt 对应的 SQLCipher key。
2. **页级解密器**：按 SQLCipher 4 的 4096 字节页读取、解密，并单独处理 WAL。
3. **本地数据库服务**：daemon 维护解密文件缓存，向多个短命 CLI 进程提供查询。
4. **语义适配器**：把 `SessionTable`、`Msg_<md5>`、朋友圈 XML、公众号 XML 等内部结构翻译成稳定 JSON。

## 为什么需要 daemon？

微信数据库不是一个永远不变的单文件。聊天库可能有 `message_0.db`、`message_1.db` 等分片；主库 mtime 与 `-wal` mtime 的变化含义不同；一次全量解密可能面对 GB 级文件；联系人名称又需要被所有查询共享。

如果每次 `wx history` 都从进程开始扫描 key、解密所有数据库、加载联系人，交互会变成“命令行等待一个后台任务”。因此项目选择：

```text
短命 CLI ──一行 JSON──▶ 常驻 daemon
                         ├─ all_keys.json
                         ├─ 解密 DB cache
                         ├─ Names 联系人映射
                         └─ query::*
```

CLI 只负责参数解析、启动 daemon、发送请求和渲染输出；成本高、可复用、有状态的部分被留在 daemon 内。

## 核心数字

| 数字 | 含义 | 代码位置 |
| ---: | --- | --- |
| 4096 | SQLCipher 页大小 | `crypto::PAGE_SZ` |
| 16 | 数据库页 salt 大小，也是第一页跳过的字节数 | `crypto::SALT_SZ` |
| 80 | 每页 reserve 区：16 字节 IV + 64 字节 HMAC | `crypto::RESERVE_SZ` |
| 96 | 内存候选中 key 64 hex + salt 32 hex | `scanner/*` |
| 2 MiB | 内存扫描单块大小 | `scanner/*::CHUNK_SIZE` |
| 24 小时 | freshness 判断中 session 领先 history 的保守阈值 | `daemon/meta.rs` |
| 15 秒 | CLI 等待 daemon 启动完成的上限 | `cli/transport.rs` |

这些数字构成了项目的“物理接口”：数据库格式决定 4096/80，进程内存扫描决定 96/2 MiB，用户体验和可靠性决定 24 小时/15 秒。

## 一次 `history` 的旅程

`src/main.rs` 只有几行，但这几行把系统分成了两个运行时世界：

```rust
fn main() {
    if std::env::var("WX_DAEMON_MODE").is_ok() {
        daemon::run();
    } else {
        cli::run();
    }
}
```

普通用户调用 `wx history Alice` 时：

1. clap 将参数变成 `Commands::History`。
2. `transport::ensure_daemon()` 先用 Ping 探测 daemon；不存在就 spawn 当前可执行文件，并设置 `WX_DAEMON_MODE=1`。
3. daemon 读取配置和密钥，创建 `DbCache`，加载联系人和消息分片列表。
4. CLI 将 `Request::History` 序列化成一行 JSON，发送到 Unix socket 或 Windows named pipe。
5. server 解析请求，调用 `query::q_history()`。
6. 查询层根据联系人 username 推导 `Msg_<md5(username)>`，跨已知 message shard 查询，再做时间排序和分页。
7. `meta` 记录扫描了多少 shard、命中了多少 shard、是否存在未知 shard、缓存走的是哪条路径。
8. CLI 将响应按 YAML 或 JSON 打印，并把 stale 警告写到 stderr。

## 这套设计最值得学的地方

### 把“物理事实”显式暴露给调用方

只输出 `messages` 容易让调用方误以为结果是全量且最新。项目通过 `meta.status` 区分 `ok`、`windowed`、`possibly_stale` 和 `possibly_stale_unknown_shards`，把“我不知道是否完整”变成结构化信息。

### 把大成本做成可观测的 tier

`DbCache::get_with_mode()` 返回 `cache_hit`、`wal_incremental`、`full_decrypt`。这让性能不再是黑盒：调用方能知道慢是因为首次解密，还是因为 WAL 增量。

### 让查询层承担领域语义

数据库里有数字 type、zstd BLOB、XML、压缩 summary、hash 表名和群成员 protobuf-like 字段。项目没有把这些原始结构直接暴露给 CLI，而是在 `query.rs` 内集中翻译：这是 CLI 能对 Agent 友好的关键。

## 下一章

[02 架构：模块骨架与数据流](02-architecture) 会从目录和依赖关系开始，把这条链路拆成可以独立理解的层。
