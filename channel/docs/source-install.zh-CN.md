# Source Install 中文版

[English](./source-install.en.md)

1. 克隆仓库。

```bash
git clone https://github.com/1Panel-dev/claw-team.git
```

2. 进入 `channel/` 目录。

```bash
cd claw-team/channel
```

3. 安装依赖。

```bash
npm install
```

4. 构建插件。

```bash
npm run typecheck
npm test
npm run build
```

5. 安装插件。

```bash
openclaw plugins install -l .
```

如果此时出现 `baseUrl`、`outboundToken`、`inboundSigningSecret` 缺失报错，不用停止，继续后面的配置步骤。

6. 启用插件。

```bash
openclaw plugins enable claw-team
```

7. 打开 OpenClaw 配置文件。

常见位置：

```text
~/.openclaw/openclaw.json
```

8. 写入下面这段配置。

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

9. 重启 Gateway。

```bash
openclaw gateway restart
```

10. 验证安装。

```bash
openclaw plugins list
openclaw plugins inspect claw-team
openclaw skills list
```
