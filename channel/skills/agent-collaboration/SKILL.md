---
name: agent-collaboration
description: Use this skill when an Agent needs to start a Claw Team collaboration with another Agent through CT IDs and an agent dialogue. Do not use it for ordinary chat or when the target Agent is still unknown.
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

# Agent Collaboration

## Overview

This skill helps an Agent start a controlled collaboration with another Agent through Claw Team.

In this skill, the following names refer to the same system unless the context clearly says otherwise:

- `Claw Team Channel`
- `claw-team`
- `CT Channel`
- `CT`
- `CT Call`

It is for:

- Agent to Agent collaboration
- cross-OpenClaw coordination
- creating a formal `agent_dialogue`

It is not for:

- ordinary replies to the human
- random brainstorming without a clear target Agent
- bypassing Claw Team by directly calling callback endpoints

## When To Use

Use this skill when all of the following are true:

1. The current Agent needs another Agent's input, decision, confirmation, or execution.
2. The collaboration target can be identified by a CT ID.
3. The request has a clear topic and a concrete ask.

Do not use this skill when:

- the current Agent can finish the work alone
- the target Agent is still unclear
- the request is vague and has not been narrowed into a concrete collaboration ask

## Default Workflow

Follow this workflow:

1. Check whether collaboration is truly needed.
2. Identify the target Agent by CT ID.
3. Narrow the collaboration into a concrete topic and one clear message.
4. Start a formal `agent_dialogue` through the `claw-team` channel.
5. Let Claw Team track the dialogue so the human can observe or intervene.

If the target Agent is still unknown:

1. First infer the best target from role, project context, team membership, and known CT IDs.
2. If the target still cannot be determined safely, ask the human or the project manager to clarify the target Agent.

## Target Rules

Preferred target format:

- `CTA-0009`

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
  "topic": "Discuss login module API contract",
  "message": "I am working on the login module and need you to confirm the field list, error codes, and response structure."
}
```

Notes:

- `kind` must currently be `agent_dialogue.start`
- `sourceCtId` is the CT ID of the current Agent
- `topic` is the collaboration title
- `message` is the concrete ask sent to the target Agent
- dialogue window defaults are handled by the backend and do not need to be passed in normal use

For the contract details, read:

- [references/json-contract.md](./references/json-contract.md)

## Message Quality Rules

A good collaboration message must include:

- what you are working on
- why you are contacting the target Agent
- what result you need back
- what decision or execution depends on that result

Avoid:

- "help me"
- "take a look"
- "continue"
- vague requests without deliverables

## Integration Target

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
3. send the structured collaboration payload

If you are speaking or reasoning in natural language before the actual send,
use wording equivalent to:

- "I should use Claw Team Channel to send a collaboration request to `CTA-0009`."
- "I should use CT Channel to send a collaboration request to `CTA-0009`."
- "I should use claw-team to send a collaboration request to `CTA-0009`."
- "I should start a CT Call to `CTA-0009`."
- "I will send this through Claw Team Channel to the target CT ID."

The important part is that the Agent should understand this is a real channel send,
not just a conversational intention.

Do not:

- call `/api/v1/claw-team/events` directly
- treat callback endpoints as business message APIs
- bypass Claw Team conversation tracking

## Human Oversight

This skill assumes:

- the human can see the resulting `agent_dialogue`
- the human can intervene, pause, resume, or stop the dialogue in Claw Team

So prefer formal tracked collaboration over hidden side communication.

## References

- [references/examples.md](./references/examples.md)
- [references/decision-rules.md](./references/decision-rules.md)
