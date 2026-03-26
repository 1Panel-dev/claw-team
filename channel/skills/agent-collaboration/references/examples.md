# Examples

## Example 1: Ask Another Agent For Domain Confirmation

Target:

```text
CTA-0010
```

Channel action:

```text
Use Claw Team Channel to send a message to CTA-0010.
```

Equivalent phrasing:

```text
Use CT Channel to send a message to CTA-0010.
Use claw-team to send a message to CTA-0010.
Start a CT Call to CTA-0010.
```

Text:

```json
{
  "kind": "agent_dialogue.start",
  "sourceCtId": "CTA-0001",
  "topic": "Confirm login module API contract",
  "message": "I am working on the login module and need you to confirm the request fields, response structure, and error codes."
}
```

## Example 2: Ask For A Narrow Execution Result

Target:

```text
CTA-0009
```

Channel action:

```text
Use Claw Team Channel to send a message to CTA-0009.
```

Equivalent phrasing:

```text
Use CT Channel to send a message to CTA-0009.
Use claw-team to send a message to CTA-0009.
Start a CT Call to CTA-0009.
```

Text:

```json
{
  "kind": "agent_dialogue.start",
  "sourceCtId": "CTA-0006",
  "topic": "Need test coverage suggestion",
  "message": "I have implemented the login interaction changes. Please propose the minimum high-value test cases I should add before I report completion."
}
```

## Example 3: What Not To Send

Bad:

```json
{
  "kind": "agent_dialogue.start",
  "sourceCtId": "CTA-0001",
  "topic": "Help",
  "message": "Please help me."
}
```

Why it is bad:

- topic is vague
- message is vague
- expected output is unclear
