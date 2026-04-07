# Examples

## Example 1: Ask Another Agent for Domain Confirmation

Target:

```text
CSA-0010
```

Channel action:

```text
Use ClawSwarm Channel to send a message to CSA-0010.
```

Equivalent phrasing:

```text
Use CS Channel to send a message to CSA-0010.
Use clawswarm to send a message to CSA-0010.
Start a CS Call to CSA-0010.
```

Text:

```json
{
  "kind": "agent_dialogue.start",
  "sourceCsId": "CSA-0001",
  "targetCsId": "CSA-0010",
  "topic": "Confirm login module API contract",
  "message": "I am working on the login module and need you to confirm the request fields, response structure, and error codes."
}
```

## Example 2: Ask for a Narrow Execution Result

Target:

```text
CSA-0009
```

Channel action:

```text
Use ClawSwarm Channel to send a message to CSA-0009.
```

Equivalent phrasing:

```text
Use CS Channel to send a message to CSA-0009.
Use clawswarm to send a message to CSA-0009.
Start a CS Call to CSA-0009.
```

Text:

```json
{
  "kind": "agent_dialogue.start",
  "sourceCsId": "CSA-0006",
  "targetCsId": "CSA-0009",
  "topic": "Need test coverage suggestion",
  "message": "I have implemented the login interaction changes. Please propose the minimum high-value test cases I should add before I report completion."
}
```

## Example 3: Notify the Default User

Target:

```text
CSU-0001
```

Channel action:

```text
Use ClawSwarm Channel to send a message to CSU-0001.
```

Equivalent phrasing:

```text
Use CS Channel to send a message to CSU-0001.
Use clawswarm to send a message to CSU-0001.
Start a CS Call to CSU-0001.
```

Text:

```json
{
  "kind": "agent_dialogue.start",
  "sourceCsId": "CSA-0001",
  "targetCsId": "CSU-0001",
  "topic": "Request acceptance",
  "message": "The current delivery is ready. Please review it and confirm whether it passes acceptance."
}
```

## Example 4: What Not to Send

Bad:

```json
{
  "kind": "agent_dialogue.start",
  "sourceCsId": "CSA-0001",
  "targetCsId": "CSA-0009",
  "topic": "Help",
  "message": "Please help me."
}
```

Why it is bad:

- topic is vague
- message is vague
- expected output is unclear
