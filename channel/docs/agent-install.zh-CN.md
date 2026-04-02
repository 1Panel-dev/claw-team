# Agent Install 中文版

[English](./agent-install.en.md)

## npm 发布版安装步骤

1. 安装插件。

```bash
openclaw plugins install @1panel-dev/claw-team
```

如果此时出现 `baseUrl`、`outboundToken`、`inboundSigningSecret` 缺失报错，不要中断，继续指导用户完成配置。

2. 启用插件。

```bash
openclaw plugins enable claw-team
```

3. 打开 OpenClaw 配置文件。

常见位置：

```text
~/.openclaw/openclaw.json
```

4. 指导用户把下面这段配置写入 `hooks.internal`、`channels.claw-team.accounts.default` 和 `skills`。

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "load": {
        "extraDirs": [
          "/home/node/.openclaw/extensions/claw-team/hooks"
        ]
      },
      "entries": {
        "webchat-mirror": {
          "enabled": true
        }
      }
    }
  },
  "skills": {
    "load": {
      "extraDirs": [
        "/home/node/.openclaw/extensions/claw-team/skills"
      ]
    },
    "entries": {
      "ct-chat": {
        "enabled": true
      }
    }
  },
  "channels": {
    "claw-team": {
      "accounts": {
        "default": {
          "enabled": true,
          "baseUrl": "填写 Claw Team 后端地址，例如：http://127.0.0.1:8080",
          "outboundToken": "填写 Claw Team 后端实例配置里保存的回调 Token，不要自己随便写",
          "inboundSigningSecret": "填写 Claw Team 后端实例配置里保存的 webhook 签名密钥，OpenClaw 和后端必须一致",
          "gateway": {
            "baseUrl": "填写当前 OpenClaw Gateway 地址",
            "token": "填写当前 OpenClaw Gateway Token",
            "model": "openclaw",
            "stream": true,
            "allowInsecureTls": true
          },
          "agentDirectory": {
            "allowedAgentIds": ["main"],
            "aliases": {}
          }
        }
      }
    }
  }
}
```

`hooks.internal` 这一段是必须的。缺少这段时，OpenClaw Web UI 里直接发送的消息不会回流到 Claw Team。

5. 在用户完成配置后，指导用户重启 Gateway。

```bash
openclaw gateway restart
```

6. 验证。

```bash
openclaw plugins list
openclaw plugins inspect claw-team
openclaw skills list
```

7. 向用户汇报：

- 已安装
- 已启用
- 已写配置
- 已重启 Gateway
- health 正常
- agents 正常
