---
title: "03 启动与配置：同一二进制的两种身份"
description: 分析 wx init、配置查找、平台数据目录和权限降级。
tags: [wx-cli, 启动, 配置, 权限]
---

# 03 启动与配置：同一二进制的两种身份

## `main` 的最小分流

`src/main.rs` 没有复杂的启动框架，只有一个环境变量开关：

```rust
if std::env::var("WX_DAEMON_MODE").is_ok() {
    daemon::run();
} else {
    cli::run();
}
```

daemon 的身份不是来自一个公开 CLI 子命令，而是来自 transport 在后台 spawn 时注入的内部环境变量。用户只知道 `wx history`，不知道也不需要知道 `wx-daemon` 是另一个安装产物。

## 配置文件的查找优先级

`config::find_config_file()` 依次考虑：当前工作目录下的 `config.json`、可执行文件目录下的 `config.json`、`~/.wx-cli/config.json`。这同时支持便携目录、从任意工作目录运行和正常全局安装。

相对路径以配置文件所在目录为基准，而不是以当前工作目录为基准：

```json
{
  "db_dir": "/path/to/db_storage",
  "keys_file": "all_keys.json",
  "decrypted_dir": "decrypted"
}
```

这里 `all_keys.json` 和 `decrypted` 会落在 `config.json` 同目录下；绝对路径则原样使用。

## 运行时目录与 root 用户修正

`cli_dir()` 不是简单调用 `dirs::home_dir().join(".wx-cli")`。在 Unix 下，如果进程由 `sudo wx init` 启动，代码会读取 `SUDO_USER`，再用 `getpwnam` 找到调用用户的 home：

```text
当前 euid = root
SUDO_USER = alice
  └─ 运行时目录仍应是 /Users/alice/.wx-cli
```

运行时文件集中在：

```text
~/.wx-cli/
├── config.json
├── all_keys.json
├── daemon.sock
├── daemon.pid
├── daemon.log
└── cache/
    ├── _mtimes.json
    └── <md5(rel_key)>.db
```

`config.rs` 提供这些路径函数，而不是在各模块中手写字符串，减少 CLI、daemon、attachment resolver 之间的路径漂移。

## `wx init` 是 bootstrap，而不是普通查询

`cli/init.rs::cmd_init()` 的四步：

```text
1. 找/创建 config.json
2. auto_detect_db_dir()
3. scanner::scan_keys(db_dir)
4. 写 all_keys.json，再写 config.json，停止旧 daemon
```

如果已有配置和 key 文件且 `--force` 未设置，init 会快速返回，避免每次安装都触碰高权限 API。`--force` 用于微信更新、数据库出现新分片或 key 快照需要刷新时重新扫描。

### 为什么先收集 salt，再匹配 key？

内存中的候选格式只包含 64 hex 的 key 和 32 hex 的 salt；它没有直接告诉 scanner “这是哪个文件”。`scanner::collect_db_salts()` 遍历所有 `.db`，读取前 16 字节作为 salt，形成：

```text
database file → salt
memory candidate → key + salt
join(salt) → KeyEntry { db_name, enc_key, salt }
```

这个 join 是整个 key 识别的核心：避免把某个合法但不属于当前数据库的候选 key 写进配置。

## 权限边界：扫描需要高权限，写配置不应继承高权限

内存扫描常需要 root/Administrator，但 `~/.wx-cli/`、socket、log 和 key 文件应属于普通用户。Unix 初始化完成后，`drop_privileges_if_sudo()`：

1. 在仍有 root 权限时迁移旧的 root-owned `.wx-cli` 文件；
2. 将目录权限收紧到 `0700`，JSON key 文件收紧到 `0600`；
3. 设置 `umask(077)`；
4. 先 `setgid`，再 `setuid` 回 `SUDO_GID/SUDO_UID`。

“先 root 做扫描，再普通用户写敏感文件”是这里最重要的安全设计。否则一次 `sudo wx init` 可能导致后续普通命令启动 daemon 时只能等到 15 秒超时。

## 平台默认目录

`default_db_dir()` 使用编译条件选择默认路径：

| 平台 | 默认 process 名 | 默认数据根 |
| --- | --- | --- |
| macOS | `WeChat` | `~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files` |
| Linux | `wechat` | `~/Documents/xwechat_files` |
| Windows | `Weixin.exe` | `%APPDATA%/Tencent/xwechat` |

真正的 `auto_detect_db_dir()` 还会在这些根目录下枚举用户目录，找到 `db_storage`，并按数据库文件最新 mtime 选择最近活跃的账号。Windows 还读取 `%APPDATA%/Tencent/xwechat/config/*.ini`，把 `MyDocument:` 解析为系统 Documents 目录，以适应用户重定向文档目录的情况。

## 初始化后旧 daemon 为什么必须停？

daemon 在启动时将 `all_keys.json` 读入内存。`wx init --force` 写入新 key 后，旧 daemon 并不会自动看到文件变化。`cmd_init()` 最后调用 `stop_daemon()`，让下一条普通命令重新启动 daemon，确保它使用新配置。

这是一个有意的“一次性重载边界”：比在 daemon 中实现全套动态 key 变更协议更简单，也更容易保证查询过程中不会半途切换 key 集合。

## 下一章

[04 密钥扫描](04-key-scanning) 继续分析三个平台如何读进程内存、怎样跨 chunk 找到 96 个 hex 字符，以及候选如何回到数据库 salt join。
