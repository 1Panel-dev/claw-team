# Agent Install

[中文版](./agent-install.zh-CN.md)

## npm release install steps

1. Install the plugin.

```bash
openclaw plugins install @1panel-dev/claw-team
```

If you see missing config errors for `baseUrl`, `outboundToken`, or `inboundSigningSecret` at this step, do not stop. Continue and guide the user to complete the config.

2. Enable the plugin.

```bash
openclaw plugins enable claw-team
```

3. Open the OpenClaw config file.

Common path:

```text
~/.openclaw/openclaw.json
```

4. Instruct the user to add the following config to `hooks.internal`, `channels.claw-team.accounts.default`, and `skills`.

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

5. After the user finishes the config, instruct the user to restart the Gateway.

```bash
openclaw gateway restart
```

6. Verify.

```bash
openclaw plugins list
openclaw plugins inspect claw-team
openclaw skills list
```

7. Report back to the user:

- installed
- enabled
- config written
- Gateway restarted
- health OK
- agents OK
