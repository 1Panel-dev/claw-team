# JSON Contract

## Supported Kind

Current first-stage support:

```json
{
  "kind": "agent_dialogue.start"
}
```

No other kind is supported yet.

## Required Fields

```json
{
  "kind": "agent_dialogue.start",
  "sourceCtId": "CTA-0001",
  "topic": "Discuss login module API contract",
  "message": "I need you to confirm the field list, error codes, and response structure."
}
```

Field rules:

- `kind`
  - must be `agent_dialogue.start`
- `sourceCtId`
  - must be the CT ID of the current Agent
- `topic`
  - short collaboration title
- `message`
  - concrete collaboration request

## Target

The target Agent is not inside the JSON body.

It is passed through the channel target:

- `to = CTA-0009`

Recommended standard:

- use plain CT IDs like `CTA-0009`

## Optional Backend Defaults

These are optional and normally should be omitted:

```json
{
  "windowSeconds": 300,
  "softMessageLimit": 12,
  "hardMessageLimit": 20
}
```

If omitted, the backend applies defaults.
