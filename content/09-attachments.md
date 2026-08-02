---
title: "09 附件解密：opaque ID、路径解析和三档 dat decoder"
description: 从 attachments 查询到 extract 写盘，分析 legacy XOR、V1 AES、V2 AES+XOR 和图片 key。
tags: [wx-cli, 附件, 解密, AES, 图片]
---

# 09 附件解密：opaque ID、路径解析和三档 dat decoder

## 为什么不能直接把文件路径交给 CLI？

微信附件路径由聊天 username、日期目录、md5 和不同版本的目录规则共同决定；查询结果也不应该把本机真实路径默认暴露给 Agent。项目把“发现资源”和“读取本体”拆开：

```text
wx attachments Alice
  → 返回 metadata + attachment_id

wx extract <attachment_id> -o image.jpg
  → daemon 解码并写绝对/相对目标路径
```

`attachment_id` 是 base64url(no padding) 编码的 JSON，不是数据库 rowid，也不是可执行路径：

```json
{
  "v": 1,
  "chat": "wxid_alice",
  "local_id": 123,
  "create_time": 1715678901,
  "kind": "image",
  "db": 2
}
```

版本字段让未来增加字段或切换 schema 时可以显式拒绝/兼容；`db` 是可选 shard hint，减少 resolver 的全库扫描。

## 为什么 ID 需要三元组？

源码注释指出，同一个 chat 内 `local_id` 可能被微信复用。因此资源定位的最小可靠信息是：

```text
(chat, local_id, create_time)
```

`AttachmentKind::from_local_type()` 先 mask 低 32 bit，再把 3/34/43/49 映射到 image/voice/video/file；appmsg 的 file subtype 还会由 resolver 进一步确认。

## resolver：从消息行到 `.dat`

resolver 的职责链是：

1. 解码 opaque ID；
2. 用 chat username 找消息表；
3. 读取消息行里的 blob/appmsg 信息；
4. 提取资源 md5；
5. 根据聊天、月份和 md5 在 `msg/attach` 目录中定位 `.dat`；
6. 选择 full、`h`、`t` 等候选文件中最匹配的版本；
7. 交给 decoder dispatch。

消息里的 packed info 可能是 protobuf-like bytes，`extract_md5_from_packed_info()` 优先寻找 marker 后的 32 hex 字符，失败再走 fallback。路径解析还会围绕 create_time 生成前一个月、当前月、后一个月候选，处理跨月目录和微信缓存延迟。

## decoder dispatch：看 6 字节 magic

`attachment/decoder/mod.rs` 将 `.dat` 分三档：

| header | decoder | 组合 |
| --- | --- | --- |
| `07 08 V2 08 07` | `v2` | AES-128-ECB + raw + XOR |
| `07 08 V1 08 07` | `v1_aes` | 固定 AES key + raw + XOR |
| 其它，通常无 magic | `legacy_xor` | 单字节 XOR |

统一输出 `DecodedImage { data, format, decoder }`，上层不必知道具体算法，只需要提供 V2 image key。

## legacy XOR：先猜 key，再验证 magic

无 magic 的旧 `.dat` 用单字节 XOR。已知明文图片 magic 可以直接反推：

```text
key = encrypted[0] XOR plaintext_magic[0]
```

代码依次尝试 PNG、GIF、TIF、WEBP、JPG，要求 magic 的每个字节都验证通过；BMP 只有 `BM` 两字节，容易误判，所以额外验证 BMP header 中的文件大小和像素偏移是否合理。

解出后再用 `detect_image_format()` 检查 JPG/PNG/GIF/WEBP/TIF/BMP/wxgf；格式是 `bin` 时拒绝输出。这是“已知格式做 key oracle”的安全边界：不会把随机垃圾当作成功解密。

## V1/V2：三个段拼接

V2 `.dat` 的头部结构：

```text
6 B magic
4 B aes_size (LE)
4 B xor_size (LE)
1 B padding
AES ciphertext (PKCS7 对齐)
raw data (不加密)
XOR data (单字节)
```

`aes_size` 需要按 PKCS#7 规则向上对齐：即便原始长度已是 16 的倍数，也会额外包含一整块 padding。解码流程是：

```text
AES-ECB decrypt + strict PKCS7 unpad
  + raw segment 原样拼接
  + xor segment 每字节 XOR xor_key
  → detect_image_format
```

V1 使用固定 key `cfcd208495d565ef`；V2 没有 image AES key 时返回明确错误，而不是输出半成品。

## macOS 图片 key：优先 kvcomm，fallback brute force

`image_key/macos.rs` 的主路径：

1. 在 `kvcomm` 目录里找 `key_<uin>_*.statistic`；
2. 从文件名取 uin；
3. 用 `md5(str(uin) + normalize(wxid)).hex()[:16]` 派生 AES key；
4. `xor_key = uin & 0xff`；
5. 用 V2 模板 ciphertext block 解密验证。

若找不到 kvcomm，fallback 会利用 wxid 后缀和 V2 样本推导 xor key，再把 uin 搜索空间压缩到 `2^24`，多线程计算 `md5(str(uin))`，匹配 wxid 后缀后再派生 AES key，最后用多个模板验证。

关键点是“候选 key 必须通过真实模板验证”，而不是仅凭 md5 形状选第一个候选。provider 还对 normalized wxid 做 cache，避免一个进程多次提取同一图片 key。

## 平台差异

- macOS：实现了 kvcomm + fallback 的 V2 key provider；
- Windows：实现内存扫描 `[A-Za-z0-9]{16|32}` 候选，再用 V2 template ciphertext block 反验；
- Linux：图片 key provider 当前返回 unsupported，legacy XOR 仍可工作。

这说明“主数据库能解密”与“附件能解密”是两条独立能力链，不应因为 CLI 的消息查询成功就假设图片提取也一定成功。

## 写盘边界

`q_extract()` 接收 output path 和 overwrite：

- 默认不覆盖已有目标；
- daemon 直接写盘，避免二进制通过 JSON socket 传输；
- 返回 decoder、format、字节数等元数据；
- 调用方应保留用户传入的扩展名，或使用 detect 到的格式。

把大二进制留在文件系统、IPC 只传句柄和状态，是比 base64 塞进 JSON 更合适的接口设计。

## 下一章

[10 工程化与安全](10-engineering-security) 总结安装分发、GitHub Actions、测试、权限和当前实现的边界。
