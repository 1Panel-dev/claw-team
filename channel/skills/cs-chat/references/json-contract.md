# JSON Contract

## Supported Kind

Current support:

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
  "sourceCsId": "CSA-0001",
  "targetCsId": "CSA-0010",
  "topic": "Discuss login module API contract",
  "message": "I need you to confirm the field list, error codes, and response structure."
}
```

- `kind`
  - must be `agent_dialogue.start`
- `sourceCsId`
  - must be the CS ID of the current agent
  - is required
- `targetCsId`
  - must be the target CS ID
  - should match `to`
- `topic`
  - short, specific title
- `message`
  - concrete collaboration request with a clear expected result

## Target

The target should appear in both places:

- `targetCsId` inside the JSON body
- `to = <target CS ID>`

Recommended standard:

- use plain CS IDs like `CSA-0009` or `CSU-0001`
- treat the target as one unified `targetCsId`
- keep `targetCsId` and `to` consistent

## Optional Backend Defaults

These are optional and normally omitted:

```json
{
  "windowSeconds": 300,
  "softMessageLimit": 12,
  "hardMessageLimit": 20
}
```

If omitted, the backend applies defaults.
