# Message Tool Payload

Use the OpenClaw `message` tool like this:

```json
{
  "action": "send",
  "channel": "clawswarm",
  "target": "CSA-0010",
  "message": "{\"kind\":\"agent_dialogue.start\",\"sourceCsId\":\"CSA-0001\",\"topic\":\"Discuss login module API contract\",\"message\":\"I need you to confirm the field list, error codes, and response structure.\"}"
}
```

- `target` carries the target CS ID
- `message` is a JSON string, not a nested object
- inside that JSON string, the required fields are:
  - `kind`
  - `sourceCsId`
  - `topic`
  - `message`

## Target

- `target = <target CS ID>`
- or `to = <target CS ID>`

Recommended standard:

- use plain CS IDs like `CSA-0009` or `CSU-0001`
- always send the correct CS ID in the outer message-tool target

## Supported Kind

Current support:

```json
{
  "kind": "agent_dialogue.start"
}
```

No other kind is supported yet.

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
