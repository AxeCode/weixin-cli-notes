---
title: "06 daemon 与 IPC：把重初始化隐藏在后台"
description: 解释 daemon 生命周期、Unix socket、Windows named pipe、JSON line 协议和请求派发。
tags: [wx-cli, daemon, IPC, Unix socket, Windows]
---

# 06 daemon 与 IPC：把重初始化隐藏在后台

## CLI 为什么能“自动启动” daemon？

`cli/transport.rs` 把连接过程包装成 `send(req)`：

```text
send(req)
  └─ ensure_daemon()
       ├─ is_alive() → Ping socket/pipe
       └─ 不活跃 → start_daemon()
                         ├─ 当前 exe
                         ├─ WX_DAEMON_MODE=1
                         ├─ stdout/stderr → daemon.log
                         └─ 等待最多 15 秒
```

启动前 `preflight_cli_dir_writable()` 会在 `~/.wx-cli/` 创建一个探针文件，先把“目录不可写”变成可操作的错误，而不是 spawn 后等待超时。

## Unix：文件 socket + 一行 JSON

Unix daemon 在 `~/.wx-cli/daemon.sock` 上监听：

1. 创建父目录；
2. 删除旧 socket；
3. `UnixListener::bind`；
4. 设置 socket 权限为 `0600`；
5. accept 后为每个连接 spawn 一个 Tokio task。

连接处理只读一行：

```text
client: {"cmd":"sessions","limit":20}\n
server: {"ok":true,"sessions":[...]}\n
```

`AsyncBufReadExt::lines()` 自然提供了 framing，不需要引入额外二进制协议。请求处理结束后写一行 response，连接可以关闭。

## Windows：同一 Request，另一种 transport

Windows 不使用 `OpenOptions` 去打开一个看起来像路径的 pipe。server 和 client 都使用 `interprocess` 的 named pipe API，并用 `GenericNamespaced` 构造同一个名字：`wx-cli-daemon`。

项目规则中特别强调“server 与 client 必须使用同一个库、同一套 API”，因为 Windows overlapped/framing 行为并不等同于把 named pipe 当普通文件打开。这个经验是跨平台 IPC 最容易踩的坑之一。

## `ipc::Request` 是系统的真实 API

`Request` 是带 `cmd` tag 的 serde enum：

```json
{"cmd":"history","chat":"Alice","limit":50,"offset":0}
{"cmd":"search","keyword":"项目","in":["Alice"],"limit":20}
{"cmd":"attachments","chat":"Alice","kinds":["image"]}
```

当前请求类别覆盖：sessions、history、search、contacts、unread、members、new_messages、stats、favorites、SNS、biz articles、attachments、extract、reload 和 ping。

默认 limit 被写成函数（20/50/200），而不是散落在 CLI 和 query 两边。serde 默认值让协议对旧客户端更宽容：省略字段时 daemon 仍能构造完整请求。

## Response 的 envelope

```rust
pub struct Response {
    pub ok: bool,
    pub error: Option<String>,
    #[serde(flatten)]
    pub data: Value,
}
```

成功响应把业务字段直接 flatten 到顶层；失败响应使用 `ok=false` 和 `error`。CLI `send()` 收到失败响应后将 error 转成 `anyhow`，于是终端行为与连接错误统一成普通命令失败。

这个 envelope 让 daemon 内部可以返回 `serde_json::Value`，不必为二十多个业务命令维护一套跨模块 response trait；代价是编译期 schema 约束较弱，需要测试和文档承担契约维护。

## server dispatch 的锁粒度

server 持有：

```rust
Arc<DbCache>
Arc<RwLock<Arc<Names>>>
```

dispatch 开头读锁只做一件事：clone `Arc<Names>`，随后立即释放锁。后面的 `await`、解密和 SQLite 查询不会占着 Names 锁。Names 本身在 daemon 启动时构造后不可变，所以多个 IPC 请求可以并发读取。

这是典型的“锁保护共享指针，而不是保护长事务”：避免了为了读取联系人名称而把所有查询串行化。

## daemon 初始化顺序

从 `daemon/mod.rs` 的职责可以还原出：

```text
读取 Config
  → 读取 all_keys.json
  → 按 key 名筛出 message/biz DB
  → DbCache::new()
  → load_names()
  → 构造 Names 的 shard 列表
  → server::serve()
```

消息 shard key 和 biz shard key 在启动时从 keys 文件筛出，但运行时 freshness 还会去磁盘发现未知 `message_N.db`，所以“启动时列表”与“当前真实目录”是两个概念。

## 进程脱离终端

Unix 使用 `setsid()`，stdout/stderr 重定向到 `daemon.log`；Windows 使用 `DETACHED_PROCESS`。daemon 不依赖父终端保持打开，CLI 退出后 daemon 仍可服务下一条命令。

停止时 transport 不会盲杀 PID：

1. 读取 JSON PID 文件（也兼容旧的纯数字 PID 文件）；
2. 通过记录的 executable path 或文件名确认 PID 属于当前 daemon；
3. Unix 发送 SIGTERM 并等待最多 2 秒；
4. 清理 socket 和 pid 文件。

这避免了“陈旧 pid 文件 + PID 已被别的程序复用”造成误杀。

## 信号和清理

daemon 监听终止信号，退出时移除 socket、pid 等 IPC 文件。即使异常退出留下旧 socket，下一次启动前也会尝试删除并重新 bind；客户端则用 Ping 的真实响应判断 daemon 是否活着，而不是只看 socket 文件存在。

## 下一章

[07 查询层](07-query-layer) 进入 daemon 的业务核心：`Names` 如何把 contact 表、hash 表名和 shard 组织成查询入口，`meta` 又如何判断结果是否可靠。
