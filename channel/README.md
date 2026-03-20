# Claw Team Channel Plugin

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

## 架构

整体链路如下：

1. Claw Team 后端调用插件 `/claw-team/v1/inbound`
2. 插件完成验签、路由决策和会话隔离
3. 插件调用 OpenClaw Gateway 执行目标 Agent
4. 插件把 `run.accepted / reply.chunk / reply.final / run.error` 回调给 Claw Team

在职责划分上：

- Claw Team 后端负责业务侧调度与前端交互
- `channel/` 负责协议桥接、路由、幂等、安全和 callback
- OpenClaw Gateway 负责真正执行 Agent

## 主要接口

| 路径 | 方法 | 说明 |
|------|------|------|
| `/claw-team/v1/health` | `GET` | 健康检查 |
| `/claw-team/v1/agents` | `GET` | 查看允许路由的 Agent 列表 |
| `/claw-team/v1/groups` | `GET` | 查看调试用群组列表 |
| `/claw-team/v1/groups/:groupId` | `GET` | 查看单个群组调试信息 |
| `/claw-team/v1/inbound` | `POST` | Claw Team webhook 入口 |

## 配置

插件从 OpenClaw 配置里的下面路径读取：

```json
{
  "channels": {
    "claw-team": {
      "accounts": {
        "default": {
          "enabled": true,
          "baseUrl": "http://127.0.0.1:8080",
          "outboundToken": "TOKEN",
          "inboundSigningSecret": "SECRET",
          "gateway": {
            "baseUrl": "https://172.16.200.119:18789",
            "token": "GATEWAY_TOKEN",
            "model": "openclaw",
            "stream": true,
            "allowInsecureTls": true
          },
          "agentDirectory": {
            "allowedAgentIds": ["pm", "rd", "qa"],
            "aliases": {
              "tester": "qa"
            }
          }
        }
      }
    }
  }
}
```

说明：

- `baseUrl`
  Claw Team 后端回调地址
- `outboundToken`
  插件回调 Claw Team 时使用的 Bearer Token
- `inboundSigningSecret`
  Claw Team 调用插件 webhook 时使用的签名密钥
- `gateway.*`
  插件调用 OpenClaw Gateway 时使用的参数

## 使用方式

开发环境常用命令：

```bash
npm install
npm run typecheck
npm test
npm run build
```

部署时需要保证：

- OpenClaw Gateway 可用
- `/v1/chat/completions` 已启用
- Gateway token 已正确配置
- 插件账号配置已写入 OpenClaw 配置文件

## 说明

更详细的实现设计、部署联调和 curl 示例保存在本地私有文档目录中，不作为公开仓库文档的一部分。
