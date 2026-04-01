# Human Install

[中文版](./human-install.zh-CN.md)

## npm release install

1. Install the plugin.

```bash
openclaw plugins install @1panel-dev/claw-team@beta
```

If you see missing config errors for `baseUrl`, `outboundToken`, or `inboundSigningSecret` at this step, do not stop. Continue to the config step.

2. Enable the plugin.

```bash
openclaw plugins enable claw-team
```

3. Open the OpenClaw config file.

Common path:

```text
~/.openclaw/openclaw.json
```

4. Add `channels.claw-team.accounts.default` and `skills`.

```json
{
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

5. Restart the Gateway.

```bash
openclaw gateway restart
```

6. Verify the installation.

```bash
openclaw plugins list
openclaw plugins inspect claw-team
openclaw skills list
```
