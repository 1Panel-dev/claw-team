---
name: cs-chat
description: Use when an agent needs to notify, inform, message, or communicate with someone through ClawSwarm, especially when both the sender CS ID and target CS ID are known.
user-invocable: true
metadata: {"openclaw":{"emoji":"🤝","requires":{"config":["channels.clawswarm.accounts.default.baseUrl"]}}}
---

# CS Chat

`ClawSwarm Channel`, `clawswarm`, `CS Channel`, and `CS Call` all refer to the same send path.

## Overview

Use `clawswarm` to send a tracked CS message. This skill is only responsible for the communication action itself.

## When to use

Use this skill when you need to send a tracked CS message through ClawSwarm.

This skill should trigger whenever all of the following are true:

- there is a clear communication intent
- the sender already knows their own `sourceCsId`
- the target CS ID is known or explicitly given

Typical communication intents include:

- notify someone
- inform someone
- send a message
- contact someone
- communicate with someone
- ask another agent to confirm, review, execute, or reply

This skill should also trigger when the request mentions CS IDs directly, including:

- `CS ID`
- `CSID`
- any concrete ID like `CSA-0001`, `CSU-0001`, or `CSG-0001`
- phrases like `通知 CSA-0001`
- phrases like `告知 CSA-0001`
- phrases like `给 CSA-0001 发消息`
- phrases like `和 CSA-0001 沟通`
- phrases like `联系 CSA-0001`
- phrases like `send a message to CSA-0001`
- phrases like `inform CSA-0001`
- phrases like `message CSA-0001`
- phrases like `notify CSA-0001`

## Inputs to collect

Before sending, collect:

- `sourceCsId` — the CS ID of the current agent
- target CS ID
- `topic` — one short, specific title
- `message` — the concrete request and expected result

## Quick steps

1. Prepare the target CS ID, `sourceCsId`, `topic`, and `message`.
2. Send through `clawswarm` using the structured JSON payload.

## Target rules

Preferred target forms:

- `CSA-0009`
- `CSU-0001`

Also accepted:

- `csid:CSA-0009`
- `@CSA-0009`

Use the plain CS ID form by default.

## Message Tool Payload

Use this shape:

```json
{
  "action": "send",
  "channel": "clawswarm",
  "target": "CSA-0010",
  "message": "{\"kind\":\"agent_dialogue.start\",\"sourceCsId\":\"CSA-0001\",\"topic\":\"Discuss login module API contract\",\"message\":\"I am working on the login module and need you to confirm the field list, error codes, and response structure.\"}"
}
```

- `target` must be the target CS ID
- `message` must be a JSON string
- inside that JSON:
  - `kind` must currently be `agent_dialogue.start`
  - `sourceCsId` is required
  - `topic` is required
  - `message` is required

Full contract details:

- [references/json-contract.md](./references/json-contract.md)

## Send action

Send through the ClawSwarm outbound path:

- `message` tool
- `channel = clawswarm`
- `to = <target CS ID>`
- `text = <JSON string payload>`

Natural-language equivalents:

- "Use ClawSwarm Channel to send a message to `<CS ID>`."
- "Use CS Channel to send a message to `<CS ID>`."
- "Use clawswarm to send a message to `<CS ID>`."
- "Start a CS Call to `<CS ID>`."
- "Notify `<CS ID>`."
- "Send a message to `<CS ID>`."
- "给 `<CS ID>` 发消息。"
- "通知 `<CS ID>`。"

Do not just describe an intention to collaborate. Perform the real channel send.

Never:

- call `/api/v1/clawswarm/events` directly
- bypass ClawSwarm conversation tracking

## References

- [references/examples.md](./references/examples.md)
- [references/decision-rules.md](./references/decision-rules.md)
