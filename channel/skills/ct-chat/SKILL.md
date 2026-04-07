---
name: ct-chat
description: Use when an agent needs to send a tracked Claw Team message through Claw Team Channel, claw-team, CT Channel, CT, CT Call, or when the request mentions any CT ID such as CTA-0001.
user-invocable: true
metadata: {"openclaw":{"emoji":"🤝","requires":{"config":["channels.claw-team.accounts.default.baseUrl"]}}}
---

# CT Chat

`Claw Team Channel`, `claw-team`, `CT Channel`, `CT`, and `CT Call` all refer to the same send path.

## Overview

Use `claw-team` to send a tracked CT message. This skill is only responsible for the communication action itself.

## When to use

Use this skill when you need to send a tracked CT message through Claw Team.

This skill should also trigger when the request mentions CT IDs directly, including:

- `CT ID`
- `CTID`
- any concrete ID like `CTA-0001`, `CTU-0001`, or `CTG-0001`
- phrases like `通知 CTA-0001`
- phrases like `给 CTA-0001 发消息`
- phrases like `联系 CTA-0001`
- phrases like `send a message to CTA-0001`
- phrases like `notify CTA-0001`

## Inputs to collect

Before sending, collect:

- `sourceCtId` — the CT ID of the current agent
- `targetCtId` — the target CT ID
- `topic` — one short, specific title
- `message` — the concrete request and expected result

## Quick steps

1. Prepare `sourceCtId`, `targetCtId`, `topic`, and `message`.
2. Send through `claw-team` using the structured JSON payload.

## Target rules

Preferred target forms:

- `CTA-0009`
- `CTU-0001`

Also accepted:

- `ctid:CTA-0009`
- `@CTA-0009`

Use the plain CT ID form by default.

## Payload

Use this payload shape:

```json
{
  "kind": "agent_dialogue.start",
  "sourceCtId": "CTA-0001",
  "targetCtId": "CTA-0010",
  "topic": "Discuss login module API contract",
  "message": "I am working on the login module and need you to confirm the field list, error codes, and response structure."
}
```

- `kind` must currently be `agent_dialogue.start`
- `sourceCtId` must be the CT ID of the current agent
- `sourceCtId` is required; Claw Team will not infer it for you
- `targetCtId` must be the target CT ID
- `targetCtId` should match the channel target
- `topic` should be short and specific
- `message` should contain the concrete ask

Full contract details:

- [references/json-contract.md](./references/json-contract.md)

## Send action

Send through the Claw Team outbound path:

- `message` tool
- `channel = claw-team`
- `to = <target CT ID>`
- `text = <JSON payload>`

Natural-language equivalents:

- "Use Claw Team Channel to send a message to `<CT ID>`."
- "Use CT Channel to send a message to `<CT ID>`."
- "Use claw-team to send a message to `<CT ID>`."
- "Start a CT Call to `<CT ID>`."
- "Notify `<CT ID>`."
- "Send a message to `<CT ID>`."
- "给 `<CT ID>` 发消息。"
- "通知 `<CT ID>`。"

Do not just describe an intention to collaborate. Perform the real channel send.

Never:

- call `/api/v1/claw-team/events` directly
- bypass Claw Team conversation tracking

## References

- [references/examples.md](./references/examples.md)
- [references/decision-rules.md](./references/decision-rules.md)
