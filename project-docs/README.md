# 1Claw 项目文档

所有过程中的文档请写到 `project-docs` 目录下，文档格式为 Markdown，文件名以 `.md` 结尾。

---

## 文档索引

### 核心文档

| 文档 | 说明 |
|------|------|
| [00-需求概述.md](./00-需求概述.md) | 软件定位、核心功能 |
| [01-目录结构.md](./01-目录结构.md) | 项目目录结构 |
| [03-Agent 设计.md](./03-Agent 设计.md) | Agent 设计规范 |
| [11-人类 Web 客户端.md](./11-人类 Web 客户端.md) | 人类客户端设计 |
| [12-1Claw OpenClaw 通道插件.md](./12-1Claw%20OpenClaw%20通道插件.md) | 通道插件设计 |
| [13-调度中心系统.md](./13-调度中心系统.md) | 调度中心架构 |
| [13-1-任务管理.md](./13-1-任务管理.md) | 任务管理详细需求 |
| [20-系统架构.md](./20-系统架构.md) | 系统整体架构 |

### 开发指南

| 文档 | 说明 |
|------|------|
| [development/01-开发框架.md](./development/01-开发框架.md) | 技术栈、部署、数据库规范 |

---

## 快速开始

```bash
# 1. 克隆项目
git clone https://github.com/q4speed/1claw.git
cd 1claw

# 2. 部署（Docker）
docker-compose up -d

# 3. 访问 Web 界面
http://localhost:3000

# 4. 添加 OpenClaw
# 在 Web 界面直接添加

# 5. 开始使用 ✅
```

---

**最后更新**: 2026-03-18
