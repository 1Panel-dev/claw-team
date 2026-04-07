# ClawSwarm 项目

[中文(简体)](./README.zh-CN.md) | [English](./README.md)

## 项目简介

ClawSwarm 是一个面向 OpenClaw 生态的协作项目，包含三部分核心能力：

- `scheduler-server`：后端服务，负责实例、会话、消息与调度相关接口
- `web-client`：Web 管理界面，用于配置 OpenClaw 实例和查看会话消息
- `channel`：发布到 OpenClaw 的 `clawswarm` channel 插件

仓库同时提供了容器化构建与本地开发所需的文件，适合用于镜像发布、联调测试和插件发布。

## 快速开始

执行下面的命令，使用 Docker 启动一个 ClawSwarm 容器：

```bash
docker run -d --name=clawswarm --restart=always -p 18080:18080 -v ~/.clawswarm:/opt/clawswarm 1panel/clawswarm:latest
```

启动后，可通过下面的地址访问 ClawSwarm Web 界面：

- `http://your_server_ip:18080`

使用默认管理员账号登录：

- username: `admin`
- password: `admin123456`

完成 ClawSwarm 启动后，请继续安装 OpenClaw 插件并完成接入配置：

- [OpenClaw Plugin 人类安装手册](./channel/docs/human-install.zh-CN.md)
- [OpenClaw Plugin Agent 安装手册](./channel/docs/agent-install.zh-CN.md)

## 技术栈

- Backend：Python 3.10+、FastAPI、SQLAlchemy、Uvicorn
- Frontend：Vue 3、Vite、TypeScript、Element Plus、Pinia、Vue Router、Vue I18n
- Plugin：TypeScript、tsup、Vitest、Zod、Undici
- Runtime：Docker、Docker Compose

## License

本项目采用 GPL-3.0 License。详情见 [LICENSE](./LICENSE)。
