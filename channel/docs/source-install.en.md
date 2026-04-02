# Source Install

[中文版](./source-install.zh-CN.md)

1. Clone the repository.

```bash
git clone https://github.com/1Panel-dev/claw-team.git
```

2. Enter the `channel/` directory.

```bash
cd claw-team/channel
```

3. Install dependencies.

```bash
npm install
```

4. Build the plugin.

```bash
npm run typecheck
npm test
npm run build
```

5. Install the plugin.

```bash
openclaw plugins install -l .
```

If you see missing config errors for `baseUrl`, `outboundToken`, or `inboundSigningSecret` at this step, do not stop. Continue to the config step.

6. Enable the plugin.

```bash
openclaw plugins enable claw-team
```

7. Open the OpenClaw config file.

Common path:

```text
~/.openclaw/openclaw.json
```

8. Add the following config.

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
          "baseUrl": "Fill in the Claw Team backend URL, for example: http://127.0.0.1:8080",
          "outboundToken": "Fill in the callback token stored in the Claw Team backend instance config. Do not invent one.",
          "inboundSigningSecret": "Fill in the webhook signing secret stored in the Claw Team backend instance config. OpenClaw and the backend must use the same value.",
          "gateway": {
            "baseUrl": "Fill in the current OpenClaw Gateway URL",
            "token": "Fill in the current OpenClaw Gateway token",
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

The `hooks.internal` block is required. Without it, OpenClaw Web UI messages will not be mirrored back into Claw Team.

9. Restart the Gateway.

```bash
openclaw gateway restart
```

10. Verify the installation.

```bash
openclaw plugins list
openclaw plugins inspect claw-team
openclaw skills list
```
