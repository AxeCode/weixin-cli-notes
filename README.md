# wx-cli 源码拆解

这是对 [`jackwener/wx-cli`](https://github.com/jackwener/wx-cli) v0.3.0 本地源码快照的中文深度拆解，采用 Quartz 发布为可互链并带内容索引的在线文档。

## 阅读入口

- 在线版：<https://hanqing.github.io/weixin-cli-notes/>
- Markdown：[`content/`](./content/)
- 原始项目：<https://github.com/jackwener/wx-cli>

## 拆解主线

```text
总览 → 架构 → 启动与配置 → 密钥扫描 → SQLCipher/WAL
  → daemon/IPC → 查询层 → 消息语义 → 附件解密 → 工程化与安全
```

## 本地预览

```bash
npm ci
npx quartz plugin restore
npx quartz build --serve
```

站点内容位于 `content/`，Quartz 配置位于 `quartz.config.yaml`，GitHub Pages 由 `.github/workflows/deploy.yml` 构建并发布。

## 说明

本文档只讨论对自己拥有或获授权的数据进行本地分析的工程实现，不提供未经授权访问他人数据的指导。源码中的平台 API、权限行为和微信数据库格式可能随客户端版本变化。

Quartz 框架代码保留在本仓库中，版本为 v5.0.0；站点内容与源码分析文本为本仓库新增部分。
