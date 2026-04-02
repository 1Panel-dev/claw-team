---
name: webchat-mirror
description: "Mirror OpenClaw WebChat transcript outputs into Claw Team."
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
It handles the user message immediately, then follows the transcript and mirrors
subsequent visible outputs into Claw Team as they appear.

## Scope

- Only handles `message:received`
- Only mirrors `webchat` sessions
- Only appends mirrored messages into Claw Team
- Skips `thinking`
- Keeps other transcript outputs, including:
  - user messages
  - assistant text
  - tool calls
  - tool results
  - unknown transcript parts as generic payload summaries

## Configuration

This hook reads the Claw Team scheduler address and token from the local
`openclaw.json`:

- `channels.claw-team.accounts.default.baseUrl`
- `channels.claw-team.accounts.default.outboundToken`

To make the hook actually load and run, `openclaw.json` must also enable
internal hooks and make this directory discoverable:

- `hooks.internal.enabled = true`
- `hooks.internal.entries.webchat-mirror.enabled = true`
- `hooks.internal.load.extraDirs` must include the parent hooks directory

## Notes

- Without `hooks.internal.enabled = true`, this hook will not run.
- Without `hooks.internal.entries.webchat-mirror.enabled = true`, OpenClaw Web UI
  messages will not be mirrored into Claw Team.
- Without `hooks.internal.load.extraDirs`, the host will not discover this hook
  when it is installed outside the default built-in hooks location.
