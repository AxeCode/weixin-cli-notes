---
title: "05 SQLCipher 与 WAL：按页解密，而不是搬运整库"
description: 分析 SQLCipher 4 页面布局、第一页特殊处理、流式解密和 WAL 增量覆盖。
tags: [wx-cli, SQLCipher, AES, WAL, 性能]
---

# 05 SQLCipher 与 WAL：按页解密，而不是搬运整库

## 数据库解密的物理模型

`crypto/mod.rs` 把 SQLCipher 4 数据库当作固定大小页面的序列：

```text
每页 4096 bytes
┌───────────────────────────────┬──────────────┐
│ encrypted payload             │ reserve 80 B  │
│ 4016 B                        │ IV 16 + HMAC 64│
└───────────────────────────────┴──────────────┘
```

代码当前做的是 AES-256-CBC 页面解密；SQLCipher 的 HMAC 校验由上游数据库格式与 key 约定承担，项目的重点是把能被 SQLite 打开的明文页还原出来。页面 reserve 区被清零，不会写回 IV/HMAC。

## 第 1 页为什么特殊？

SQLCipher 数据库第一页前 16 字节保存 salt，而明文 SQLite 需要文件头：

```text
SQLite format 3\0
```

所以 `decrypt_page()`：

- `pgno == 1`：跳过 `page_data[0..16]`，解密 `[16..4016]`，在结果开头写 SQLite header；
- 其他页：解密 `[0..4016]`；
- 所有页的最后 80 字节保持零值。

这里的 `pgno` 从 1 开始，不是数组下标。第一页特殊分支不能被一个“所有页都相同”的循环误合并，否则 SQLite 打开时会直接报 malformed database。

## AES-CBC 的实现取舍

`aes_cbc_decrypt()` 不使用 PKCS#7 unpadding，因为 SQLCipher 页的 payload 是固定块，代码注释明确说明“不使用 PKCS#7 padding”。它把输入按 16 字节转换成 `aes::cipher::Block` 数组，再调用 `decrypt_blocks_mut`。

这比把整页转成一个临时可变裸指针更保守：

```rust
let mut blocks: Vec<Block> = data
    .chunks_exact(16)
    .map(Block::clone_from_slice)
    .collect();
Aes256CbcDec::new(key.into(), iv.into())
    .decrypt_blocks_mut(&mut blocks);
```

## `full_decrypt()` 是流式的

`full_decrypt()` 不把整个 DB 读入内存：

```text
open input
for pgno in 1..=total_pages:
    read_exact 当前页
    最后一页不足 4096 → 零填充
    decrypt_page()
    write 明文页
```

`read_page()` 单独抽出来处理短读和最后一页，并有测试覆盖：

- 输入分成多个短 chunk 仍能读满一页；
- 最后一页不足时尾部全零；
- 提前 EOF 返回 `UnexpectedEof`。

这使内存占用接近一个页面，而不是与数据库大小成正比。但 CPU 和磁盘写入仍然与全库大小成正比，所以不能把 full decrypt 当成每次查询的默认路径。

## WAL：主库 mtime 没变，不代表数据没变

SQLite WAL 模式下，新写入通常先追加到 `message_N.db-wal`，主 `.db` 文件 mtime 可能不变。若只看主库，查询会漏掉最近消息。

`crypto/wal.rs::apply_wal()` 读取：

```text
WAL header: 32 B
每帧:       24 B frame header + 4096 B page data
```

每帧头包含 page number、commit page count 和 salt1/salt2。代码：

1. 从 WAL header 取 `s1/s2`；
2. 遍历完整帧；
3. 跳过 `pgno == 0` 或过大页码；
4. 跳过 frame salt 与 header 不一致的旧帧；
5. 解密 frame page；
6. 按 `(pgno - 1) * PAGE_SZ` seek 到已解密 DB 并覆盖写入。

WAL frame 的第一页不含主库第一页的 salt 头，因此即便 `pgno == 1`，也要以普通页路径解密（代码传 `2` 进入非第一页分支）。这是很容易被“复用 decrypt_page”时忽略的边界。

## DbCache 的三条路径

`daemon/cache.rs` 为每个相对 DB key 保存：

```rust
struct CacheEntry {
    db_mtime: u64,
    wal_mtime: u64,
    decrypted_path: PathBuf,
}
```

`get_with_mode()` 的决策树：

```text
cached exists?
  ├─ no → full_decrypt + apply_wal        [full_decrypt]
  └─ yes
       ├─ db mtime 相同，wal mtime 相同 → 直接返回 [cache_hit]
       ├─ db mtime 相同，wal mtime 改变 → apply_wal [wal_incremental]
       └─ db mtime 改变 → full_decrypt + apply_wal [full_decrypt]
```

缓存文件名是 `md5(rel_key).db`，避免把带目录分隔符的相对 key 直接映射到文件系统，也避免不同 shard 的同名冲突。

## 跨 daemon 重启的持久化

`_mtimes.json` 保存 `rel_key → { db_mt, wal_mt, path }`。daemon 启动时，如果解密产物仍存在且主库 mtime 没变，就把它恢复到内存 map；如果 WAL mtime 变了，第一次查询仍会走 WAL 增量，而不是回退到全量解密。

这个细节说明“持久化缓存”不仅是把路径写到 JSON，还要保存足够的版本信息，才能恢复正确的缓存 tier。

## `spawn_blocking`：不要在 Tokio worker 上解密

full decrypt、WAL 读取和 rusqlite 查询都是阻塞工作。daemon 使用 `tokio::task::spawn_blocking` 将它们移出 async worker；否则一个大 DB 的解密会阻塞其它 IPC 请求的调度。

同时，`DbCache` 的 map 使用 `tokio::sync::Mutex`，锁只包围短暂的 map 查找/更新；真正的解密在锁外完成，避免把慢操作串行化。

## 可验证的性能模型

| 情况 | 主要工作 | 用户感受 |
| --- | --- | --- |
| `cache_hit` | 打开已有明文 DB | 接近 0 ms 的路径决策 |
| `wal_incremental` | 只读新增 WAL 帧并覆盖页面 | 通常远小于全量解密 |
| `full_decrypt` | 读取并解密所有主库页，再应用 WAL | 大库可能很慢 |

这三条路径被写进 `meta.cache_mode_per_shard`，因此性能问题可以被观测，而不是靠猜。

## 下一章

[06 daemon 与 IPC](06-daemon-ipc) 会把 cache 放回进程生命周期中：daemon 怎样自启动、监听、清理和安全停止。
