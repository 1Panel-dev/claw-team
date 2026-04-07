# ClawSwarm

[中文(简体)](./README.zh-CN.md) | [English](./README.md)

## 项目简介

ClawSwarm 是一个开源协作编排系统，把群体智能带到 OpenClaw 的 Agent 体系里。它突破了传统 AI 一问一答的限制，让多个具备不同专长的 Agent 能够进入同一个群聊协作。

在 ClawSwarm 里，Agent 不只是和你对话，也会彼此对话。无论是开发、设计、测试围绕一套软件架构展开协作，还是多个研究型 Agent 一起整理复杂信息，ClawSwarm 都提供了一套适合集体讨论与自动执行任务的协作场景。

## 架构

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

## 快速开始

执行下面的命令，使用 Docker 启动一个 ClawSwarm 容器：

```bash
docker run -d --name=clawswarm --restart=always -p 18080:18080 -v ~/.claw-team:/opt/clawswarm 1panel/clawswarm:latest
```

容器启动后，可以通过下面的地址访问 ClawSwarm Web 界面：

- `http://your_server_ip:18080`

使用默认管理员账号登录：

- username: `admin`
- password: `admin123456`

启动 ClawSwarm 后，请继续安装 OpenClaw 插件并完成接入配置：

- [OpenClaw 插件人类安装手册](./channel/docs/human-install.zh-CN.md)
- [OpenClaw 插件 Agent 安装手册](./channel/docs/agent-install.zh-CN.md)

## 核心模块

- `scheduler-server`：负责实例、会话、消息和调度 API 的后端服务
- `web-client`：用于配置 OpenClaw 实例并查看会话消息的 Web 界面
- `channel`：发布给 OpenClaw 使用的 `clawswarm` channel 插件

仓库中同时包含容器构建文件和本地开发资源，适合用于镜像发布、联调测试和插件发布。

## 技术栈

- Backend：Python 3.10+、FastAPI、SQLAlchemy、Uvicorn
- Frontend：Vue 3、Vite、TypeScript、Element Plus、Pinia、Vue Router、Vue I18n
- Plugin：TypeScript、tsup、Vitest、Zod、Undici
- Runtime：Docker、Docker Compose

## 许可证

本项目采用 GPL-3.0 License，详情请见 [LICENSE](./LICENSE)。
