---
title: "10 工程化与安全：把研究型工具做成可交付 CLI"
description: 总结 Cargo/npm/脚本分发、跨平台 CI、测试、权限模型和使用边界。
tags: [wx-cli, 工程化, CI, 安全, 发布]
---

# 10 工程化与安全：把研究型工具做成可交付 CLI

## Cargo：单二进制、按平台依赖

`Cargo.toml` 使用一个 `wx` binary，依赖按功能分组：clap、tokio、serde、rusqlite bundled、AES/CBC/HMAC/SHA/PBKDF2、zstd、chrono、roxmltree 等。平台相关依赖用 target section：

```toml
[target.'cfg(windows)'.dependencies]
interprocess = { version = "2", features = ["tokio"] }

[target.'cfg(unix)'.dependencies]
libc = "0.2"
```

Windows 额外启用进程、内存、Shell 等 Win32 feature；这让 macOS/Linux 编译时不必带入 Windows API。

release profile 开启 LTO、`opt-level=3`、单 codegen unit 和 strip，目标是一个体积较小、可直接分发的静态感二进制。

## npm 包：平台包 + thin wrapper

`npm/wx-cli` 不是把 Rust 编译工具链带给用户，而是一个 Node wrapper：

```text
@jackwener/wx-cli
  ├─ optional @...-darwin-arm64
  ├─ optional @...-darwin-x64
  ├─ optional @...-linux-x64
  ├─ optional @...-linux-arm64
  └─ optional @...-win32-x64
```

安装时根据 `process.platform-process.arch` resolve 对应 package 的 `bin/wx`；也支持 `WX_CLI_BINARY` 覆盖实际二进制，方便开发和测试。

这个发布结构把“包管理器体验”和“原生程序运行”结合起来：用户只需要 `npm install -g`，发布端则分别构建五个平台产物。

## shell/PowerShell 安装脚本

`install.sh`、`install.ps1` 负责下载 release asset、放到用户 bin 目录并给出下一步 init。它们与 npm 安装共用 GitHub Release 产物，而不是各自重新编译。文档必须明确：初始化可能需要高权限，查询阶段应回到普通用户。

## Release workflow

`.github/workflows/release.yml` 在 tag `v*` 或手动触发时运行：

1. Linux 先 `cargo check`；
2. matrix 构建 macOS arm64/x64、Linux x64/arm64、Windows x64；
3. 上传独立 release asset；
4. 下载各平台 artifact，填充 npm platform package；
5. 发布平台包，再发布主 npm 包。

构建顺序中 `publish-npm` 依赖 `build`，避免 npm package 先发布但内部还没有对应 binary。

## 测试：纯函数优先，数据库用临时目录

当前测试覆盖四类逻辑：

### 格式和协议

- attachment ID encode/decode round trip；
- 版本字段拒绝未知 schema；
- local_type 高位 flag mask；
- IPC 默认值和 response 序列化。

### 加密和缓存

- read_page 短读、zero padding、EOF；
- cache exact hit 不触发 full decrypt；
- 只有 WAL mtime 改变时走增量路径；
- 主 DB mtime 改变时走 full decrypt。

### 文本/结构化解析

- appmsg 文件、引用、合并聊天记录；
- group nickname protobuf-like chunks；
- malformed SNS XML fallback；
- 公众号多图文和时间字段。

### 平台适配

- scanner pattern、DB salt、Windows path token；
- macOS image key 的 kvcomm/fallback 派生和模板验证。

测试的共同特点是尽量把系统边界压到 helper 外面，用临时目录、人工构造的 bytes 和小型 SQLite 数据验证核心规则。

## 安全边界一：raw key 是高敏感文件

`all_keys.json` 相当于本地数据库的解密凭证。实现中已有的保护包括：

- `.wx-cli` 目录 `0700`；
- JSON key 文件 `0600`；
- Unix socket `0600`；
- daemon 不默认把真实 shard path 放进响应；
- daemon 只接受本机 Unix socket / named pipe；
- `stop` 会确认 PID 属于当前 executable。

仍应把 `all_keys.json` 当作秘密对待：不要上传 issue、不要放进日志或备份到共享目录。文档和工具都应只对自己拥有或明确获授权的数据使用。

## 安全边界二：高权限初始化的副作用

macOS ad-hoc 重签名可能改变 WeChat 的 code identity，进而影响 TCC 记录；Windows 读取进程需要管理员权限；Linux `/proc/<pid>/mem` 受 ptrace 策略影响。这些都不是查询层 bug，而是操作系统安全模型的一部分。

好的错误信息应说明下一步：确认微信运行、确认权限、确认数据目录、确认 `.wx-cli` 所属用户，而不是只打印“扫描失败”。

## 安全边界三：输出不是完整世界

`meta.status` 把三种不确定性公开出来：

- `possibly_stale_unknown_shards`：磁盘有新分片，key 快照落后；
- `possibly_stale`：session.db 明显领先实际读到的消息；
- `windowed`：调用方主动限定了时间/分页窗口。

Agent 使用时应先检查 `meta`，再决定是否把结果当作“没有更多数据”。这是一种数据正确性安全，而不仅是文件权限安全。

## 当前实现的已知边界

- Linux 图片 V2 key provider 仍是 unsupported；
- 微信升级可能改变进程名、内存中的 key 形态、数据库目录或 XML schema；
- `all_keys.json` 是 init 时快照，新 message shard 出现后需要 `wx init --force`；
- SNS 只能看到本机曾经刷到并缓存的帖子；
- 真实微信数据库、TCC、进程内存扫描无法在普通 CI 中完整端到端验证。

把这些边界写进文档和 meta，比声称“支持所有微信数据”更可靠。

## 最后的工程判断

这个项目最有价值的不是某一个 AES 函数，而是把不稳定的本地应用数据源整理成了稳定的可观测查询管线：

```text
平台特定 bootstrap
  → 统一 KeyEntry
  → 统一 DbCache
  → 统一 Request/Response
  → 领域化 query
  → 数据 + freshness/source metadata
```

如果要扩展它，最安全的顺序是：先在 `ipc::Request` 定义契约，再在 `query.rs` 增加纯函数/临时 DB 测试，最后接入 CLI 命令；不要直接在每个命令里重复打开数据库、解析联系人和处理缓存。

## 完成阅读后的源码路线

```text
src/main.rs
  → cli/transport.rs
  → daemon/mod.rs + server.rs
  → daemon/cache.rs
  → crypto/mod.rs + crypto/wal.rs
  → daemon/query.rs:q_history
  → daemon/meta.rs
  → attachment/decoder/mod.rs
```

这条路线先看控制流，再看数据格式，最后看边界条件，适合继续对照上游源码做版本差异分析。
