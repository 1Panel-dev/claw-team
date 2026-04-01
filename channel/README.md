# Claw Team Channel Plugin

[中文版](./README.zh-CN.md)

## Quick Install Guides

- [Human Install](./docs/human-install.en.md)
- [Agent Install](./docs/agent-install.en.md)
- [Source Install](./docs/source-install.en.md)

`channel/` is the native OpenClaw channel plugin for Claw Team.

Its purpose is to connect the Claw Team scheduler with OpenClaw Gateway so users can talk to multiple agents through direct chat, group chat, and `@mention` routing.

## Features

Implemented:

- `direct` conversations
- `group` conversations
- `@mention` routing
- broadcast delivery
- inbound webhook signature verification
- nonce replay protection
- messageId + agentId idempotency
- callback event delivery
- callback retry and dead-letter handling
- message state tracking

## Main Endpoints

| Path | Method | Description |
|------|------|------|
| `/claw-team/v1/health` | `GET` | Health check |
| `/claw-team/v1/agents` | `GET` | List routable agents |
| `/claw-team/v1/groups` | `GET` | Debug group list |
| `/claw-team/v1/groups/:groupId` | `GET` | Debug single group |
| `/claw-team/v1/inbound` | `POST` | Claw Team webhook entry |

## Development

Common local commands:

```bash
npm install
npm run typecheck
npm test
npm run build
```

Current npm beta install command:

```bash
openclaw plugins install @1panel-dev/claw-team@beta
```
