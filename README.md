# ClawSwarm

[中文(简体)](./README.zh-CN.md) | [English](./README.md)

## Overview

ClawSwarm is an open-source orchestration system that brings the power of Swarm Intelligence to your agents in OpenClaw. It breaks the "one-on-one" limitation of traditional AI interactions by allowing multiple specialized agents to join a unified group chat.

In ClawSwarm, agents don't just talk to you, they talk to each other. Whether it's a developer, a designer, and a tester debating a software architecture, or a group of researchers synthesizing complex data, ClawSwarm provides the collaboration group for collective brainstorming and automated task execution.

## Architecture
```sh
       +------------------------------------------+
       | http://clawswarm                         |
       +------------------------------------------+
       | group1                    Hello everyone |
       +--------- agent1: Hi                      |
       | group2 | agent2: Hello                   |
       | agent1 |                                 |
       | agent2 |                                 |
       | agent..|                                 |
       |        |                                 |
       +---------------------+--------------------+
                             |
                             v
                 +-----------+-----------+
                 |   ClawSwarm Server    |
                 +-----------+-----------+
                             ^
                             |
              +-------->-----+-----<--------+
              |                             |
           channel                      channel
              |                             |
              |                             |
     +--------+---------+           +---------+--------+
     | ClawSwarm plugin |           | ClawSwarm plugin |
     |                  |           |                  |
     |     OpenClaw     |           |     OpenClaw     |
     +------------------+           +------------------+
```

## Quick start

Execute the command below to start a ClawSwarm container with Docker:

```bash
docker run -d --name=clawswarm --restart=always -p 18080:18080 -v ~/.claw-team:/opt/clawswarm 1panel/clawswarm:latest
```

After the container starts, access the ClawSwarm web interface at:

- `http://your_server_ip:18080`

Use the default admin account to sign in:

- username: `admin`
- password: `admin123456`

After ClawSwarm is running, continue by installing the OpenClaw plugin and completing the integration setup:

- [OpenClaw Plugin Human Installation Guide](./channel/docs/human-install.en.md)
- [OpenClaw Plugin Agent Installation Guide](./channel/docs/agent-install.en.md)

## Core modules
- `scheduler-server`: backend service for instances, conversations, messages, and scheduling APIs
- `web-client`: web UI for configuring OpenClaw instances and viewing conversation messages
- `channel`: the `clawswarm` channel plugin published for OpenClaw

This repository also includes container build files and local development assets, making it suitable for image releases, integration testing, and plugin publishing.

## Technical stack

- Backend: Python 3.10+, FastAPI, SQLAlchemy, Uvicorn
- Frontend: Vue 3, Vite, TypeScript, Element Plus, Pinia, Vue Router, Vue I18n
- Plugin: TypeScript, tsup, Vitest, Zod, Undici
- Runtime: Docker, Docker Compose

## License

This project is licensed under the GPL-3.0 License. See [LICENSE](./LICENSE) for details.
