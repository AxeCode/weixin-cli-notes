---
title: "08 消息语义：把 SQLite 行翻译成可读对象"
description: 分析消息 type、zstd 压缩、群昵称、appmsg XML、朋友圈和公众号数据解析。
tags: [wx-cli, 消息, XML, zstd, 微信数据库]
---

# 08 消息语义：把 SQLite 行翻译成可读对象

## 原始消息不是“content 字符串”

微信消息行至少包含 local_id、create_time、local_type、message_content、real_sender_id 等信息。真正输出时，还需要考虑：

- `message_content` 可能是 TEXT，也可能是 zstd BLOB；
- 群消息 content 可能带 `sender:\n` 前缀；
- 图片、语音、视频和表情没有可读正文；
- type=49 的 appmsg 可能是文件、链接、引用、合并聊天记录或小程序；
- type=10000/10002 是系统消息和撤回；
- 群成员的群昵称可能藏在扩展字段中。

因此 `query.rs` 采用“先读原始列，再按 type 派生语义”的管线。

## 先兼容 SQLite TEXT/BLOB

`get_content_bytes()` 先尝试 `Vec<u8>`，失败后 fallback 到 `String` 再转 bytes：

```text
SQLite BLOB → Vec<u8>
SQLite TEXT → String → bytes
其它/NULL  → empty
```

源码注释指出，直接用 rusqlite 的 `Vec<u8>` 读取 TEXT 可能静默得到空结果。这个兼容函数是一个小但关键的 schema 防御：数据库同一逻辑列的物理存储类型并不稳定。

## zstd：用 content type 决定解压

消息内容的 `ct == 4` 时尝试 zstd 解压，失败则回退为 UTF-8 lossily 解码。summary 字段则采用更宽松的“先尝试 zstd，失败就当普通字符串”。

这种“可逆优先、可读兜底”的策略比遇到解压错误就整条消息失败更适合历史数据：旧版本微信、损坏记录或非标准消息都不会阻塞整个查询。

## type 映射与高位 flag

`fmt_type()` 和附件类型判断都会先 mask 低 32 bit：

```rust
let base = (t as u64 & 0xFFFFFFFF) as i64;
```

输出标签包括：

| local_type | 语义 |
| ---: | --- |
| 1 | 文本 |
| 3 | 图片 |
| 34 | 语音 |
| 43 | 视频 |
| 47 | 表情 |
| 48 | 位置 |
| 49 | 链接/文件/appmsg |
| 50 | 通话 |
| 10000 | 系统 |
| 10002 | 撤回 |

高位可能带版本或会话 flag；如果不 mask，图片和附件判断会被错误地当成未知类型。

## `fmt_content()` 的语义分发

```text
type 3    → [图片] local_id=...
type 34   → [语音]
type 43   → [视频]
type 47   → [表情]
type 50   → [通话]
type 10000→ parse_sysmsg()
type 10002→ parse_revoke()
type 49   → parse_appmsg()
其它      → 原文
```

图片输出保留 local_id，是为了给 attachment 查询和后续定位资源提供线索；本体不被塞进文本响应。

## 群消息的 sender 处理

群消息可能把发送者写在正文前缀：

```text
张三:
早上好
```

查询层同时读取 `real_sender_id` 关联的 username，并从群成员扩展字段解析群昵称。展示优先级通常是：

```text
group_nickname > contact display > 微信回填 sender name > username
```

为了避免同名成员混淆，group message 和 stats 的 top_senders 还输出：

- `sender_username`：稳定 wxid；
- `sender_contact_display`：联系人备注/昵称；
- `sender_group_nickname`：群名片。

这体现了“展示字段”和“身份字段”分离：人看起来友好，机器仍能用 username 去重。

## appmsg XML：从字符串中恢复业务对象

type=49 的消息内容是 `<appmsg>` XML，`parse_appmsg()` 先走 roxmltree DOM，失败后走兼容性字符串 parser。重点分支包括：

- type=6：文件，读取 title、totallen、fileext；
- type=19：合并聊天记录，解析 `dataitem` 并列出摘要；
- type=57：引用消息，提取 refermsg、displayname 和原文/原消息 type；
- type=33/36/44：小程序；
- 其它：链接/文件 fallback。

URL 提取也区分 `<url>`、`<url1>`，去掉 CDATA 和 HTML entity，并拒绝非 `http://`/`https://` 的值。它没有把原始 XML 直接交给 Agent，而是返回带标签的短文本和结构化 URL。

## 系统消息与撤回

系统消息可能是 XML，也可能是纯文本；`parse_sysmsg()` 尝试提取 `<content>`，并只保留前 50 个字符。撤回消息则提取被撤回内容的摘要，避免在终端输出巨大的原始 XML。

这种截断是输出层的语义选择：历史导出需要可读性，完整本体仍应保留在源数据库或附件流程中。

## 朋友圈：XML DOM + fallback

SNS 数据被存储为 content XML。`parse_post_xml()` 先读取 author、content、create time、location 和 media；malformed XML 时使用字符串字段 fallback，尽可能返回可用作者和文本。

媒体节点会被解析成带 url/thumb/key/token/md5/enc_idx/size 的对象，`media_count` 取合法 `<media>` 子节点数。这里特别强调“本地缓存过的朋友圈”：微信按需下载，没刷到过的帖子不会凭空出现在本地数据库中。

## 公众号文章：多图文推送展开

`q_biz_articles()` 遍历 `biz_message_N.db` 分片，解析推送 XML 的多图文 item。每行同时带：

```text
account / account_username
title / url / digest / cover_url
time / timestamp          # 文章发布时间
recv_time_str / recv_time # 微信接收推送时间
```

把发布时间与接收时间分开，是为了避免用户按日期筛选时把“文章发布时间”和“消息到达时间”混为一谈。

## 查询层的设计哲学

消息解析器的共同模式是：

```text
物理兼容 → 语义分发 → 结构化身份 → 可读 fallback
```

它不追求把每一种微信内部格式都完美还原，而是保证未知/损坏/旧版本输入不会让整条查询崩溃，同时把最有用的字段交给 Agent。

## 下一章

[09 附件解密](09-attachments) 将处理消息正文之外的 `.dat` 二进制：如何用 opaque attachment ID 把“列出资源”和“写出文件”拆成两个安全步骤。
