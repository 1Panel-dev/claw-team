---
name: webchat-mirror
description: "Mirror OpenClaw WebChat user messages and assistant replies into Claw Team."
metadata:
  {
    "openclaw":
      {
        "emoji": "🪞",
        "events": ["message:received"],
        "requires": { "config": ["channels.claw-team.accounts.default.baseUrl"] },
      },
  }
---

# WebChat Mirror

This hook mirrors WebChat conversations into Claw Team.
It handles the user message immediately, then polls the transcript file for the
matching assistant reply and mirrors that reply as well.

## Scope

- Only handles `message:received`
- Only mirrors `webchat` sessions
- Only appends mirrored messages into Claw Team

## Configuration

This hook reads the Claw Team scheduler address and token from the local
`openclaw.json`:

- `channels.claw-team.accounts.default.baseUrl`
- `channels.claw-team.accounts.default.outboundToken`

## Notes

- The hook must be enabled through `hooks.internal.entries.webchat-mirror.enabled`
- The hook directory must be discoverable through `hooks.internal.load.extraDirs`
