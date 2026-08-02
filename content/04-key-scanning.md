---
title: "04 密钥扫描：从三平台进程内存回到具体数据库"
description: 解释 x'<64hex><32hex>' 候选、salt join 和三平台扫描差异。
tags: [wx-cli, scanner, macOS, Linux, Windows, 安全]
---

# 04 密钥扫描：从三平台进程内存回到具体数据库

## scanner 的输入和输出

scanner 的任务不是“破解数据库”，而是从已经运行的微信进程里找到 WCDB/SQLCipher 已经派生好的 raw key。统一输出：

```rust
pub struct KeyEntry {
    pub db_name: String, // message/message_0.db
    pub enc_key: String, // 64 hex = 32 bytes
    pub salt: String,    // 32 hex = 16 bytes
}
```

`scanner/mod.rs` 只做跨平台公共工作：读取 `.db` 头部 salt、递归收集数据库、根据 `cfg(target_os)` 分发到平台实现。真正的进程读取逻辑留在 `macos.rs`、`linux.rs`、`windows.rs`。

## 候选模式：`x'<key><salt>'`

源码把 SQLCipher 连接字符串中缓存的形式当作识别锚点：

```text
x' + 64 个十六进制字符 + 32 个十六进制字符 + '
└────────────── 96 hex ──────────────┘
       key 64                 salt 32
```

扫描函数不会只检查长度，而是逐字节验证：前两个字节必须是 `x'`，中间 96 个字节全部是 ASCII hex，最后一个字节必须是 `'`。匹配后把前 64 个字符作为 key，后 32 个作为 salt，并统一转小写、去重。

### 为什么需要 chunk overlap？

大内存区域按 2 MiB 分块读取。如果一个候选刚好横跨 chunk 边界，单独扫描每块会漏掉它。因此每块推进时保留 `HEX_PATTERN_LEN + 3` 字节重叠：

```text
chunk 0: [0 ... 2MiB)
chunk 1:        [2MiB - 99 ... 4MiB)
```

这是一种很便宜的流式扫描技巧：不需要将整个进程内存加载到用户态，也不需要复杂的跨块状态机。

## salt join：把候选绑定到 DB

`collect_db_salts()` 递归遍历 `db_dir` 下扩展名为 `.db` 的文件，读取每个文件的前 16 字节：

```text
明文 SQLite:  SQLite format 3\0 → 跳过
加密 DB:     任意 16 字节 → hex salt
```

平台 scanner 得到候选后，执行等值匹配：

```text
for (key_hex, salt_hex) in raw_keys:
    for (db_salt, db_name) in db_salts:
        if salt_hex == db_salt:
            emit KeyEntry(db_name, key_hex, salt_hex)
```

这一步解决了两个问题：同一进程可能缓存多个数据库 key；单纯搜到 96 个 hex 并不能说明它属于当前账号。salt 是数据库文件头的稳定指纹，因此比按数据库文件名猜测更可靠。

## macOS：Mach VM 区域扫描

`scanner/macos.rs` 使用 Mach API：

1. `pgrep -x WeChat` 找进程 PID；
2. `task_for_pid` 获取 task port；
3. `mach_vm_region` 枚举内存区域；
4. 只读取同时可读、可写的区域；
5. `mach_vm_read` 分块读取；
6. 扫完后调用 `mach_vm_deallocate` 释放内核分配的缓冲区。

macOS 的难点不是 Rust，而是权限模型：`task_for_pid` 通常需要 root，微信还可能因为 code signature/TCC 拒绝被读取。项目文档因此把 ad-hoc 签名、开发者工具权限和 TCC reset 写进安装说明，而不是把失败简单归因于“找不到 key”。

## Linux：`/proc` 文件接口

Linux 实现走内核暴露的进程文件：

```text
/proc/<pid>/comm  → 找 wechat / weixin
/proc/<pid>/maps  → 找 rw 内存区域
/proc/<pid>/mem   → seek 到区域并读取
```

`parse_maps()` 只保留权限字符串以 `rw` 开头的区域，减少扫描范围。读取失败或出现不可读区域时，scanner 跳过当前 region，不让单个坏页中断整个扫描。

相比 macOS 的 Mach VM，Linux 代码更短，但权限由 `/proc` 和 ptrace 策略决定；远程 shell、容器和不同发行版的限制可能让 `/proc/<pid>/mem` 不可读。

## Windows：ToolHelp + VirtualQueryEx

Windows 实现分三层：

1. `CreateToolhelp32Snapshot` + `Process32First/Next` 找 `Weixin.exe`；
2. `OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION)` 拿进程句柄；
3. `VirtualQueryEx` 遍历内存，再用 `ReadProcessMemory` 读取可读写的 committed region。

`is_writable_readable_page()` 不只匹配 `PAGE_READWRITE`，还考虑 `PAGE_WRITECOPY`、`PAGE_EXECUTE_READWRITE`、`PAGE_EXECUTE_WRITECOPY`，并去掉 `PAGE_GUARD`、`PAGE_NOCACHE`、`PAGE_WRITECOMBINE` modifier bits。这是 Windows 保护位实现细节，也是跨平台 scanner 不能简单复制的地方。

## scanner 的失败模式

| 阶段 | 失败 | 用户应理解为 |
| --- | --- | --- |
| 找进程 | WeChat 未运行或进程名变化 | 先启动并登录微信 |
| 取内存权限 | task/proc/OpenProcess 被拒 | 当前权限或系统安全策略不足 |
| 找候选 | 内存中没有连接字符串 | 微信版本或 key 缓存布局变化 |
| salt join | 候选存在但没有对应 DB salt | 数据目录错误、DB 尚未出现或 key 属于别的库 |
| 写盘 | 权限不足 | 需要降权/修正 `.wx-cli` 属主 |

项目没有为所有候选做“解密后 SQLite 可打开”的二次验证，而是依赖 salt join。这在速度和实现复杂度上更简单，但意味着 key 错误可能要到 `crypto` 或 SQLite 打开阶段才暴露。

## 测试策略

平台 API 难以在 CI 中稳定复现，所以测试集中在纯函数：

- `read_db_salt()` 对明文头、短文件和加密头的判断；
- `search_pattern()` 对大小写、非法 hex、错误引号、重复和多候选的判断；
- Windows 的保护位判断和配置路径解析；
- `collect_db_salts()` 的递归和扩展名过滤。

这是一个值得复用的测试分层：把不可移植的系统调用留作薄壳，把模式识别和 join 逻辑抽到可重复的函数中。

## 下一章

[05 SQLCipher 与 WAL](05-sqlcipher-wal) 讨论拿到 32 字节 key 后，项目怎样按页还原 SQLite，以及为什么 WAL 不能被忽略。
