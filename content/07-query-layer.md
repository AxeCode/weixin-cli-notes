---
title: "07 查询层：跨分片恢复微信的数据模型"
description: 分析 Names、Msg_<md5> 表发现、sessions/history/search 和 freshness meta。
tags: [wx-cli, SQLite, 查询, 分片, freshness]
---

# 07 查询层：跨分片恢复微信的数据模型

## Names 是查询层的“索引中枢”

`daemon/query.rs::Names` 不是简单的联系人 map：

```rust
pub struct Names {
    pub map: HashMap<String, String>,
    pub md5_to_uname: HashMap<String, String>,
    pub msg_db_keys: Vec<String>,
    pub biz_msg_db_keys: Vec<String>,
    pub verify_flags: HashMap<String, i64>,
}
```

它同时解决五个问题：

- username → 展示名；
- `Msg_<md5(username)>` → username；
- 当前已知的普通消息 shard；
- 公众号文章 shard；
- `verify_flag` → 公众号/服务号判别。

启动时 `load_names()` 从解密后的 `contact/contact.db` 读取 `username`、`nick_name`、`remark`、`verify_flag`。展示名优先级是备注 > 昵称 > username。之后对每个 username 计算 MD5，建立反向索引。

## 微信消息表为什么是 `Msg_<md5>`？

message DB 内部不是一张统一 messages 表，而是每个聊天一个表，名称形如：

```text
Msg_<32 位小写 md5(username)>
```

因此 history 的主定位流程是：

```text
用户输入 Alice / 备注 / wxid
  → resolve_username()
  → md5(username)
  → Msg_<md5>
  → 在所有 message_N.db 中找表
  → 汇总结果、按 timestamp 排序、分页
```

`resolve_username()` 会在 Names map 中对显示名做模糊匹配，也支持直接输入 username；这让 CLI 适合人类使用，同时保持稳定的内部主键。

## `find_msg_shards()` 的真正职责

它不是只拼一个表名，而是遍历已知 message shard：

1. `DbCache::get_with_mode(rel_key)` 得到解密 DB 和 cache mode；
2. 用正则 `^Msg_[0-9a-f]{32}$` 约束表名；
3. 检查目标表是否存在；
4. 求每个表的最大时间戳 `max_ts`；
5. 产出 `MessageShard { rel_key, path, table, max_ts, cache_mode }`。

按 `max_ts` 排序后，history 可以先处理更新的 shard；但最终仍需要全量汇总和排序，因为同一个聊天的记录可能分布在多个 shard。

## `q_sessions`：从 SessionTable 取得“导航页”

会话列表不扫描每张 Msg 表，而是打开 `session/session.db` 的 `SessionTable`，按 `last_timestamp DESC` 取前 N 条。输出包含：

- chat / username；
- `chat_type`；
- unread；
- last_msg_type；
- last_sender；
- summary；
- timestamp/time。

summary 可能是 zstd 压缩 BLOB，查询层先 `decompress_or_str()`，再去掉群聊前缀。群聊还会加载群昵称表，以免会话列表只显示微信内部 username。

## `q_history`：分片内上限 + 全局排序

history 对每个 shard 使用 `per_db_cap = offset + limit`，只取足够参与全局分页的行，避免一个大群在每个 DB 都完整加载。随后：

```text
各 shard 局部结果
  → 合并 all_msgs
  → 按 timestamp 倒序
  → skip(offset).take(limit)
  → 再按 timestamp 正序输出
```

最终输出顺序是“时间从旧到新”，更适合阅读和连续上下文；数据库扫描阶段则使用倒序方便取最近窗口。

过滤条件包括 since/until、message type 和 offset。只要存在这些窗口条件，`meta.status` 就会是 `windowed`，不会把局部查询错误描述成全量最新结果。

## `q_search`：全局搜索不是简单 SQL LIKE

带 `--in CHAT` 时，search 先定位目标聊天，再在对应表中匹配；不带时，它遍历所有已知消息 DB，查询 SQLite master 找到合法 `Msg_<md5>` 表，再通过 `md5_to_uname` 反推显示名。

搜索使用参数绑定而不是字符串拼接，且会限制结果数量和时间窗口。对 appmsg 内容，后续 parser 还会将解压、XML 和引用正文纳入可检索的可见文本。

## 会话类型判定：先强证据，后前缀兜底

`chat_type_of()` 的次序很有代表性：

1. username 含 `@chatroom` → `group`；
2. `brandsessionholder`、`@placeholder_foldgroup` → `folded`；
3. contact 的 `verify_flag != 0` → `official_account`；
4. `gh_`、`biz_` 或 `@` 前缀 → `official_account`；
5. 其它 → `private`。

先读结构化 `verify_flag`，再用 username 前缀兜底，能覆盖 contact 表不完整或系统账号不在联系人列表中的情况。

## freshness meta：解决“查询成功但结果可能不全”

`daemon/meta.rs::Meta` 记录：

```text
chat_latest_timestamp
chat_latest_db
session_last_timestamp
shards_scanned / shards_hit
unknown_shards
status
per_shard_latest / cache_mode_per_shard / shard_paths
```

status 的优先级是：

```text
unknown_shards 非空 → possibly_stale_unknown_shards
否则 windowed      → windowed
否则 session - chat > 24h → possibly_stale
否则                → ok
```

### 为什么要比 session.db？

`SessionTable.last_timestamp` 是微信认为这个会话最新的时间；history 实际能读到的最新消息则来自已解密并扫描的 Msg 表。两者差距很大，通常说明：

- init 之后出现了新的 `message_N.db`，但 key 快照没更新；
- 当前只查了某个窗口；
- 某个 shard 解密/读取失败。

### unknown shard 的动态发现

daemon 启动时的 `msg_db_keys` 来源是 `all_keys.json`，而 `discover_unknown_shards()` 每次会扫描磁盘上的 `message/message_*.db`，排除 `_fts`、`_resource` 等辅助文件，diff 出不在 key 快照里的 shard。这把“静态配置过期”转成可操作提示：重新运行 `wx init --force`。

## 调试 source 的分级暴露

默认响应不包含完整路径，只暴露必要 freshness；`--with-meta` 增加每 shard 的 latest/cache mode；隐藏的 `--debug-source` 再增加真实 `shard_paths`。这是“可观测性”和“路径泄露”之间的折中：正常 Agent 不需要知道本机文件系统布局。

## 下一章

[08 消息语义](08-message-semantics) 继续沿着 Msg 行往下走，解释数字 type、zstd、群发件人、appmsg XML 和朋友圈 XML 是如何被翻译成文本与结构化对象。
