# 1Claw v3.0 待更新文档清单

**创建时间**: 2026-03-18

---

## ✅ 已完成的文档

| 文档 | 状态 | 说明 |
|------|------|------|
| `00-需求概述.md` | ✅ 已完成 | 重写为直连模式 |
| `13-调度中心系统.md` | ✅ 已完成 | 移除雇佣关系 |
| `20-系统架构.md` | ✅ 已完成 | 移除管理系统 |
| `project-docs/README.md` | ✅ 已完成 | 更新文档索引 |
| `CHANGES-v3.0.md` | ✅ 已完成 | v3.0 更新说明 |

---

## ⚠️ 需要手动更新的文档

以下文档由于权限问题（root 所有），需要手动更新：

### 1. `01-目录结构.md`

**需要修改的内容**：
- 移除 `02-雇佣关系管理.md` 引用
- 移除 `10-管理系统.md` 引用
- 更新 web-client 描述（移除"人才市场（雇佣 OpenClaw）"）
- 更新调度中心描述（移除"权限校验"，改为"OpenClaw 管理"）

**修改后内容**：
```markdown
# 1Claw 目录结构

**版本**: v3.0（直连模式 - 无雇佣）

## 目录结构
```
1claw/
├── channel/
├── scheduler-server/
├── project-docs/
└── web-client/
```

## project-docs/ 文档列表
```
project-docs/
├── README.md
├── development/
│   ├── README.md
│   └── 01-开发框架.md
├── 00-需求概述.md
├── 01-目录结构.md
├── 03-Agent 设计.md
├── 11-人类 Web 客户端.md
├── 12-1Claw OpenClaw 通道插件.md
├── 13-调度中心系统.md
├── 13-1-任务管理.md
└── 20-系统架构.md
```

**已移除**:
- ~~02-雇佣关系管理.md~~
- ~~10-管理系统.md~~
```

---

### 2. `11-人类 Web 客户端.md`

**需要修改的内容**：
- 移除"人才市场"、"雇佣"相关描述
- 改为"OpenClaw 管理"（添加、启用/禁用）
- 移除多用户相关描述

**关键修改点**：
```markdown
# 原描述
- 人才市场（雇佣 OpenClaw）
- 技能库管理
- 仅可雇佣空闲 - 启用状态的 OpenClaw
- 仅可解雇自己雇佣的 OpenClaw

# 新描述
- OpenClaw 管理（添加、启用/禁用、配置）
- 所有 OpenClaw 直接可用
- 可直接启用/禁用任意 OpenClaw
```

---

### 3. `12-1Claw OpenClaw 通道插件.md`

**需要修改的内容**：
- 移除雇佣关系相关描述
- 改为直接连接到调度中心

**关键修改点**：
```markdown
# 原描述
- OpenClaw 需要被雇佣后才能连接
- 验证雇佣关系

# 新描述
- OpenClaw 直接连接到调度中心
- 验证 OpenClaw 是否启用
```

---

### 4. `13-1-任务管理.md`

**需要修改的内容**：
- 移除任务分配时的雇佣关系校验
- 改为直接分配给任意启用的 OpenClaw

---

### 5. `development/01-开发框架.md`

**需要修改的内容**：
- 更新为单用户模式
- 数据库改为 SQLite 默认
- 移除管理系统相关
- 移除雇佣关系相关

---

## 📋 快速更新命令

```bash
cd /home/node/.openclaw/github-workspace/1claw

# 修复权限（如果需要）
sudo chown node:node project-docs/*.md

# 或者直接用 sudo 编辑
sudo vim project-docs/01-目录结构.md
sudo vim project-docs/11-人类 Web 客户端.md
sudo vim project-docs/12-1Claw OpenClaw 通道插件.md
sudo vim project-docs/13-1-任务管理.md
sudo vim project-docs/development/01-开发框架.md

# 添加并提交
git add -A
git commit -m "refactor: v3.0 直连模式 - 完成所有文档更新"
git push
```

---

## 🎯 核心变更总结

### 移除的概念
- ❌ 雇佣关系
- ❌ 管理系统
- ❌ 多用户
- ❌ 人才市场

### 简化的概念
- ✅ 所有 OpenClaw 直接连接
- ✅ 直接启用/禁用
- ✅ 直接分配任务
- ✅ 单用户模式

### 数据库变化
- ❌ 移除 `humans` 表
- ❌ 移除 `employments` 表
- ❌ 移除 `employment_history` 表
- ✅ 保留 `openclaws`, `tasks`, `messages` 等表

---

**最后更新**: 2026-03-18
