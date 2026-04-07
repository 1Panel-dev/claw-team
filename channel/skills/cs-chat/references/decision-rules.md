# Decision Rules

## Skill Positioning

`cs-chat` is a communication skill for the ClawSwarm CS channel path.

- choose the ClawSwarm send path
- send the structured message correctly

## Send Path

The following names all mean the same communication path:

- `ClawSwarm Channel`
- `clawswarm`
- `CS Channel`
- `CS Call`

When you need to communicate through this skill, treat them as equivalent.

## Message Expectations

When using this skill:

- trigger it whenever there is a real communication intent plus both sides' CS IDs are known
- always send to a concrete CS ID
- put the target CS ID in the outer `target` / `to` field
- include a clear `topic`
- include a concrete `message`

Common intent words include:

- notify
- inform
- send a message
- contact
- communicate with
- 告知
- 通知
- 发消息
- 沟通

These are examples, not a closed list.

If the request clearly means “go tell someone”, “send something to someone”, “reach out to someone”, or any similar communication intent, this skill should still trigger even when the wording is different.
