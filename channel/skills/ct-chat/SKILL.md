---
name: ct-chat
description: Use this skill when an Agent needs to send a tracked CT message to a concrete CT ID. Do not use it for ordinary chat or when the target is still unknown.
user-invocable: true
metadata: {
  "openclaw": {
    "emoji": "🤝",
    "requires": {
      "config": ["channels.claw-team.accounts.default.baseUrl"]
    }
  }
}
---

# CT Chat

In this skill, the following names refer to the same sending action:

- `Claw Team Channel`
- `claw-team`
- `CT Channel`
- `CT`
- `CT Call`

## When To Use

Use this skill when all of the following are true:

1. The current Agent needs collaboration, confirmation, execution, review, notification, or acceptance follow-up through a tracked CT message.
2. The collaboration target can be identified by a concrete target CT ID.
3. The request has a clear topic and a concrete ask.

Do not use this skill when:

- the current Agent can finish the work alone
- the target is still unclear
- the request is vague and has not been narrowed into a concrete ask
- an ordinary reply in the current conversation is enough

## How To Use

Follow this workflow:

1. Confirm that a tracked CT message is really needed.
2. Identify the target CT ID.
3. Narrow the request into one clear topic and one clear message.
4. Use the `claw-team` channel to send the structured payload.
5. Let Claw Team track the result so the human can observe or intervene.

## Target Rules

Preferred target format:

- `CTA-0009`
- `CTU-0001`

Also accepted by the channel:

- `ctid:CTA-0009`
- `@CTA-0009`

Use the plain CT ID form unless you have a strong reason not to.

## Payload Contract

Current first-stage payload:

```json
{
  "kind": "agent_dialogue.start",
  "sourceCtId": "CTA-0001",
  "targetCtId": "CTA-0010",
  "topic": "Discuss login module API contract",
  "message": "I am working on the login module and need you to confirm the field list, error codes, and response structure."
}
```

Notes:

- `kind` must currently be `agent_dialogue.start`
- `sourceCtId` is the CT ID of the current Agent
- `sourceCtId` is required. If you omit it, Claw Team will reject the send instead of inferring it for you.
- `targetCtId` is the target CT ID
- `topic` is the collaboration title
- `message` is the concrete ask sent to the target
- `targetCtId` should match the channel target
- dialogue window defaults are handled by the backend and do not need to be passed in normal use

For the contract details, read:

- [references/json-contract.md](./references/json-contract.md)

## Message Rules

A good CT message includes:

- what you are working on
- why you are contacting the target
- what result, decision, confirmation, or action you need back
- what decision or execution depends on that result

Avoid:

- "help me"
- "take a look"
- "continue"
- vague requests without deliverables

## Send Action

Use the Claw Team channel outbound path:

- `message` tool
- `channel = claw-team`
- `to = <target CT ID>`
- `text = <JSON payload>`

Operationally, think of this as:

- "Use Claw Team Channel to send a message to `<CT ID>`."
- "Use CT Channel to send a message to `<CT ID>`."
- "Use claw-team to send a message to `<CT ID>`."
- "Start a CT Call to `<CT ID>`."

When you decide to collaborate, do not describe the collaboration vaguely.
Instead, explicitly treat the action as:

1. choose the target CT ID
2. use Claw Team Channel / CT Channel / claw-team / CT Call
3. send the structured payload

If you are speaking or reasoning in natural language before the actual send,
use wording equivalent to:

- "I should use Claw Team Channel to send a message to `CTA-0009`."
- "I should use CT Channel to send a message to `CTA-0009`."
- "I should use claw-team to send a message to `CTA-0009`."
- "I should start a CT Call to `CTA-0009`."
- "I will send this through Claw Team Channel to the target CT ID."

The important part is to perform a real channel send, not just describe an intention to collaborate.

Do not:

- call `/api/v1/claw-team/events` directly
- bypass Claw Team conversation tracking

## References

- [references/examples.md](./references/examples.md)
- [references/decision-rules.md](./references/decision-rules.md)
