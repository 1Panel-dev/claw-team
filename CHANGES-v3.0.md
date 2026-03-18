# 1Claw v3.0 更新说明

**更新日期**: 2026-03-18  
**核心变更**: 移除雇佣关系，简化为直连模式

---

## 🎯 核心理念变化

### v1.0/v2.0（雇佣模式）
```
用户 → 雇佣 OpenClaw → 建立关系 → 才能使用
```

### v3.0（直连模式）✅
```
用户 → 所有 OpenClaw 直接可用
```

---

## 📝 文档更新清单

### 已更新的文档

| 文档 | 更新内容 |
|------|---------|
| `project-docs/00-需求概述.md` | ✅ 重写为直连模式，移除雇佣关系 |
| `project-docs/20-系统架构.md` | ✅ 重写架构图，移除管理系统和雇佣关系 |
| `project-docs/13-调度中心系统.md` | ✅ 移除雇佣关系校验，简化权限管理 |
| `project-docs/README.md` | ✅ 更新文档索引，标记 v3.0 变化 |

### 需要手动更新的文档

| 文档 | 操作 | 说明 |
|------|------|------|
| `project-docs/01-目录结构.md` | 编辑 | 移除 management/目录，标记雇佣关系管理为已移除 |
| `project-docs/02-雇佣关系管理.md` | 删除 | 不再需要 |
| `project-docs/10-管理系统.md` | 删除或标记 | 单用户无需管理系统 |
| `project-docs/development/01-开发框架.md` | 编辑 | 更新为单用户、SQLite、直连模式 |

---

## 🗄️ 数据库变化

### 移除的表

```sql
-- 以下表已移除（不再需要）
DROP TABLE IF EXISTS humans;              -- 人类用户表（单用户无需）
DROP TABLE IF EXISTS employments;         -- 雇佣关系表
DROP TABLE IF EXISTS employment_history;  -- 雇佣历史表
DROP TABLE IF EXISTS group_members;       -- 群组成员表（简化）
```

### 保留的表

```sql
-- 保留的核心表
openclaws          -- OpenClaw 配置和状态
tasks              -- 任务管理
task_history       -- 任务历史
task_comments      -- 任务评论
messages           -- 消息记录
notifications      -- 通知记录
roles              -- 角色模板
```

---

## 🔧 API 变化

### 移除的 API

```
# 雇佣关系相关 API（已移除）
POST   /api/hire/hire              # 雇佣 OpenClaw
POST   /api/hire/fire              # 解雇 OpenClaw
GET    /api/hire/relationship      # 查询雇佣关系
```

### 简化的 API

```
# OpenClaw 管理（简化）
GET    /api/openclaws              # 获取所有 OpenClaw（无需过滤"我的"）
POST   /api/openclaws              # 添加 OpenClaw（直接添加，无需雇佣）
PUT    /api/openclaws/:id          # 更新 OpenClaw 配置
POST   /api/openclaws/:id/enable   # 启用 OpenClaw
POST   /api/openclaws/:id/disable  # 禁用 OpenClaw

# 任务管理（简化）
POST   /api/tasks                  # 创建任务（直接分配，无需权限校验）
PUT    /api/tasks/:id/assign       # 分配任务（直接分配）
```

---

## 📊 对比表

| 功能 | v1.0/v2.0 | v3.0 |
|------|-----------|------|
| 用户模式 | 多用户/单用户 | 单用户 |
| OpenClaw 连接 | 需要雇佣 | 直接连接 |
| 雇佣关系表 | ✅ 需要 | ❌ 移除 |
| 权限校验 | 复杂（雇佣关系） | 简单（启用即可） |
| 管理系统 | 需要（多用户） | 不需要 |
| 数据库 | PostgreSQL | SQLite（默认） |
| 部署步骤 | 6 步 | 3 步 |
| 数据库表 | 10+ 表 | 7 表 |

---

## 🚀 快速开始（v3.0）

```bash
# 1. 部署
docker-compose up -d

# 2. 访问 Web 界面
http://localhost:3000

# 3. 添加 OpenClaw
# 在 Web 界面直接添加，无需雇佣

# 4. 开始使用 ✅
```

---

## 📋 待办事项

- [ ] 删除 `project-docs/02-雇佣关系管理.md`
- [ ] 删除或标记 `project-docs/10-管理系统.md`
- [ ] 更新 `project-docs/01-目录结构.md`
- [ ] 更新 `project-docs/development/01-开发框架.md`
- [ ] 更新 `project-docs/11-人类 Web 客户端.md`（移除人才市场、雇佣相关）
- [ ] 更新 `project-docs/12-1Claw OpenClaw 通道插件.md`（移除雇佣相关）
- [ ] 更新 `project-docs/13-1-任务管理.md`（移除雇佣相关）

---

## 🎯 提交建议

```bash
git add -A
git commit -m "refactor: v3.0 直连模式 - 移除雇佣关系

主要变更:
- 移除雇佣关系概念，所有 OpenClaw 直接连接
- 删除 employments、employment_history 等表
- 简化权限校验（启用即可，无需雇佣关系）
- 移除管理系统（单用户无需）
- 数据库改为 SQLite 默认

文档更新:
- 00-需求概述.md - 重写为直连模式
- 20-系统架构.md - 移除管理系统架构
- 13-调度中心系统.md - 移除雇佣校验
- project-docs/README.md - 更新文档索引

版本：v3.0"

git push
```

---

**更新完成时间**: 2026-03-18
