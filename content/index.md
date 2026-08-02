---
title: wx-cli 源码拆解
description: 从进程内存取 key、按页解密 SQLCipher，再经 daemon 与 IPC 输出 Agent 友好数据的 Rust CLI 深度拆解。
tags: [wx-cli, Rust, WeChat, SQLCipher, 源码分析]
---

# wx-cli 源码拆解

> 一条命令背后，是“内存取钥匙 → 按页解密 → mtime/WAL 缓存 → SQLite 查询 → 结构化输出”的完整本地数据管线。

## 这是什么项目？

`wx-cli` 是一个 Rust 编写的本地微信数据 CLI，面向微信 4.x 桌面端的本地数据目录。它不把数据上传到服务器，而是通过平台进程内存扫描取得 SQLCipher raw key，再将数据库按需解密到本地缓存，最后通过命令行输出聊天记录、联系人、群成员、朋友圈、公众号文章、收藏、统计和附件等数据。

项目的关键不是“写了一组 SQLite 查询”，而是把一个持续变化、分片、加密、需要高权限初始化的桌面应用数据源包装成一个稳定的 Agent 接口：CLI 是薄客户端，daemon 持有缓存和查询状态，IPC 协议负责把请求与响应解耦。

## 章节地图

| 章节 | 主题 | 要回答的问题 |
| --- | --- | --- |
| [01 总览](01-overview) | 定位与核心数字 | 为什么需要一个常驻 daemon？ |
| [02 架构](02-architecture) | 模块骨架与数据流 | 代码如何分层，边界在哪里？ |
| [03 启动与配置](03-bootstrap-config) | `main`、`init`、路径探测 | 同一个二进制如何切换两种角色？ |
| [04 密钥扫描](04-key-scanning) | macOS/Linux/Windows scanner | 如何从候选 key 绑定到具体 DB？ |
| [05 SQLCipher 与 WAL](05-sqlcipher-wal) | 按页解密与增量日志 | 为什么不直接全量预解密？ |
| [06 daemon 与 IPC](06-daemon-ipc) | 生命周期、socket、请求派发 | 如何把昂贵初始化变成透明后台服务？ |
| [07 查询层](07-query-layer) | shard、Names、freshness | 如何跨分片恢复微信数据语义？ |
| [08 消息语义](08-message-semantics) | 类型、压缩、XML、群昵称 | 原始表行如何变成可读消息？ |
| [09 附件解密](09-attachments) | `.dat`、图片 key、opaque ID | 如何从查询结果安全地取回二进制？ |
| [10 工程化与安全](10-engineering-security) | 安装、CI、测试、边界 | 项目如何在跨平台和高权限条件下保持可用？ |

## 先看一条完整链路

```text
wx init
  ├─ auto_detect_db_dir() 找到 db_storage
  ├─ scanner::scan_keys() 扫 WeChat 内存中的 x'<key><salt>'
  ├─ 将 salt 与所有 .db 的前 16 字节匹配
  └─ 写 ~/.wx-cli/config.json + all_keys.json

wx history Alice
  ├─ CLI ensure_daemon()
  ├─ 自身以 WX_DAEMON_MODE=1 脱离终端启动
  ├─ daemon DbCache 按 mtime 解密/复用 message_N.db
  ├─ Unix socket / Windows named pipe 传一行 JSON
  ├─ query::q_history() 找 Msg_<md5(username)> 表并解析
  └─ 输出 YAML/JSON，附 meta.status 判断新鲜度
```

## 源码基线

本拆解以工作区中的 `wx-cli` 0.3.0 源码为准，重点文件包括：`src/main.rs`、`src/config.rs`、`src/scanner/`、`src/crypto/`、`src/daemon/`、`src/attachment/` 和 `src/cli/`。后续章节中的源码路径均以这些模块为锚点；源项目后续更新可能改变行号和数据库格式。

## 下一步

从 [01 总览：一个本地微信数据 Agent 适配层](01-overview) 开始，或直接通过章节地图按运行链路阅读。
