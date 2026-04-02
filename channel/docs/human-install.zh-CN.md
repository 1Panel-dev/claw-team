# Human Install 中文版

[English](./human-install.en.md)

## npm 发布版安装

1. 安装插件。

```bash
openclaw plugins install @1panel-dev/claw-team
```

如果此时出现 `baseUrl`、`outboundToken`、`inboundSigningSecret` 缺失报错，不用停止，继续下一步配置。

2. 启用插件。

```bash
openclaw plugins enable claw-team
```

3. 打开 OpenClaw 配置文件。

常见位置：

```text
~/.openclaw/openclaw.json
```

4. 在配置文件里写入 `hooks.internal`、`channels.claw-team.accounts.default` 和 `skills` 配置。

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

5. 重启 Gateway。

```bash
openclaw gateway restart
```

6. 验证安装。

```bash
openclaw plugins list
openclaw plugins inspect claw-team
openclaw skills list
```
