# Claw Team Channel 插件

[English](./README.md)

## 快速安装手册

- [人类安装](./docs/human-install.zh-CN.md)
- [Agent 安装](./docs/agent-install.zh-CN.md)
- [源码安装](./docs/source-install.zh-CN.md)

`channel/` 是 Claw Team 对接 OpenClaw 的原生 Channel 插件实现。

它的目标是把 Claw Team 调度中心和 OpenClaw Gateway 连接起来，让用户可以通过 Claw Team 与多个 Agent 进行单聊、群聊和 `@mention` 定向对话。

## 功能

当前已实现：

- `direct` 单聊
- `group` 群聊
- `@mention` 定向路由
- 群广播
- webhook 入站签名校验
- nonce 防重放
- messageId + agentId 幂等
- callback 事件回推
- callback 重试和死信文件
- message state 跟踪

## 主要接口

| 路径 | 方法 | 说明 |
|------|------|------|
| `/claw-team/v1/health` | `GET` | 健康检查 |
| `/claw-team/v1/agents` | `GET` | 查看允许路由的 Agent 列表 |
| `/claw-team/v1/groups` | `GET` | 查看调试用群组列表 |
| `/claw-team/v1/groups/:groupId` | `GET` | 查看单个群组调试信息 |
| `/claw-team/v1/inbound` | `POST` | Claw Team webhook 入口 |

## 使用方式

开发环境常用命令：

```bash
npm install
npm run typecheck
npm test
npm run build
```

当前 npm beta 安装命令：

```bash
openclaw plugins install @1panel-dev/claw-team@beta
```
