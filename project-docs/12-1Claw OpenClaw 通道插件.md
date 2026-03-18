# 1Claw OpenClaw 通道插件设计

---

## 1. 系统概述

### 1.1 系统定位

OpenClaw 通道插件是安装于 OpenClaw 端的专属插件，核心实现 OpenClaw 与调度中心的双向通讯，支持一个 OpenClaw 承载多个 Agent（身份/员工），每个 Agent 有独立记忆和配置。

### 1.2 核心功能

| 功能 | 说明 |
|------|------|
| 多 Agent 管理 | 一个 OpenClaw 可承载多个 Agent，每个 Agent 独立配置 |
| 消息接收 | 接收来自用户或其他 Agent 的消息（可指定具体 Agent） |
| 消息发送 | 以特定 Agent 身份向用户或其他 Agent 发送消息 |
| 任务接收 | 接收分配给具体 Agent 的任务 |
| 任务反馈 | 以 Agent 身份向用户反馈任务执行进度和结果 |
| 群组通讯 | 在群组中以 Agent 身份收发消息 |
| 独立记忆 | 每个 Agent 拥有独立记忆 |

---

## 2. 连接管理

### 2.1 连接流程

```
1. OpenClaw 启动
   ↓
2. 加载通道插件
   ↓
3. 读取配置（调度中心地址、OpenClaw ID）
   ↓
4. 连接到调度中心 WebSocket
   ↓
5. 发送注册请求
   ↓
6. 调度中心验证 OpenClaw 是否启用
   ↓
7. 连接成功，进入就绪状态 ✅
   ↓
8. 加载该 OpenClaw 下的所有 Agent 配置
```

### 2.2 连接状态

| 状态 | 说明 | 处理 |
|------|------|------|
| `connecting` | 连接中 | 显示连接提示 |
| `connected` | 已连接 | 正常收发消息 |
| `disconnected` | 断开 | 自动重连 |
| `disabled` | 已禁用 | 停止重连，等待启用 |

### 2.3 心跳机制

**心跳流程**：
```
OpenClaw           调度中心
   │                   │
   │───ping (30s)─────▶│
   │                   │
   │◀───pong───────────│
   │                   │
   │   (超时未响应)     │
   │                   │
   │───重连 (5s, 10s, 20s...)──▶
```

**重连策略**：
- 首次重连：5 秒后
- 第二次：10 秒后
- 第三次：20 秒后
- 后续：60 秒后（最大间隔）

---

## 3. 多 Agent 管理

### 3.1 Agent 加载

**加载流程**：
```
1. OpenClaw 连接成功
   ↓
2. 从调度中心获取该 OpenClaw 下的所有 Agent 配置
   ↓
3. 为每个 Agent 创建独立上下文
   ↓
4. 加载每个 Agent 的独立记忆
   ↓
5. Agent 进入就绪状态 ✅
```

### 3.2 Agent 隔离

**隔离机制**：
- 每个 Agent 有独立的系统提示词
- 每个 Agent 有独立的记忆存储
- 每个 Agent 有独立的技能配置
- Agent 之间不共享记忆和上下文

**示例**：
```
OpenClaw #1
├── Agent A [程序员]
│   ├── 系统提示词：你是一名资深程序员...
│   ├── 记忆：对话历史、编程任务记录...
│   └── 技能：Python, JavaScript, SQL...
│
├── Agent B [作家]
│   ├── 系统提示词：你是一名专业作家...
│   ├── 记忆：对话历史、写作任务记录...
│   └── 技能：创意写作、编辑、翻译...
│
└── Agent C [数据分析师]
    ├── 系统提示词：你是一名数据分析师...
    ├── 记忆：对话历史、分析任务记录...
    └── 技能：Python, 统计学，可视化...
```

### 3.3 Agent 切换

**消息路由**：
```
# 接收消息时
{
  "to": {
    "openclaw_id": "oc_001",
    "agent_id": "agent_A"  # 消息发送给特定 Agent
  }
}

# OpenClaw 根据 agent_id 路由到对应 Agent 处理
```

**任务分配**：
```
# 任务分配时
{
  "assignee": {
    "openclaw_id": "oc_001",
    "agent_id": "agent_A"  # 任务分配给特定 Agent
  }
}

# OpenClaw 根据 agent_id 路由到对应 Agent 执行
```

---

## 4. 消息处理

### 4.1 消息类型

| 类型 | 说明 | 处理方式 |
|------|------|----------|
| `text` | 普通文本消息 | 路由到指定 Agent 处理 |
| `task` | 任务消息 | 路由到指定 Agent，创建任务记录 |
| `system` | 系统通知 | 显示通知，不支持回复 |
| `file` | 文件消息 | 下载文件，显示链接 |

### 4.2 消息接收

**接收流程**：
```
1. 调度中心推送消息
   ↓
2. 插件接收消息
   ↓
3. 解析消息中的 target（OpenClaw ID + Agent ID）
   ↓
4. 路由到对应 Agent
   ↓
5. Agent 处理消息
   ↓
6. 以该 Agent 身份回复
```

### 4.3 消息发送

**发送流程**：
```
1. 用户/系统触发消息
   ↓
2. 指定发送的 Agent 身份
   ↓
3. 插件构建消息对象（包含 agent_id）
   ↓
4. 通过 WebSocket 发送
   ↓
5. 调度中心转发
   ↓
6. 接收方收到消息（显示发送者为该 Agent）
```

**消息格式**：
```json
{
  "type": "text|task|system|file",
  "from": {
    "openclaw_id": "oc_001",
    "agent_id": "agent_A"  # 以特定 Agent 身份发送
  },
  "to": "user",
  "content": "消息内容",
  "timestamp": "2026-03-18T04:00:00Z"
}
```

---

## 5. 任务处理

### 5.1 任务接收

**任务信息**：
- 任务 ID
- 任务标题
- 任务描述
- 截止时间
- 优先级
- 创建者
- **执行者（具体 Agent ID）**

**处理流程**：
```
1. 接收任务消息
   ↓
2. 解析任务中的 assignee（具体 Agent）
   ↓
3. 路由到对应 Agent
   ↓
4. Agent 创建任务记录
   ↓
5. 显示任务通知
   ↓
6. 更新任务状态为"in_progress"
```

### 5.2 任务执行

**任务状态流转**：
```
new → in_progress → completed → accepted
                              → rejected
```

**Agent 执行**：
- 每个 Agent 独立执行分配给自己的任务
- Agent 使用自己的记忆和技能
- Agent 之间不共享任务进度（除非在群组中）

### 5.3 任务反馈

**反馈方式**：
- 以 Agent 身份发送消息到任务群组
- 以 Agent 身份更新任务状态
- 以 Agent 身份附加文件/链接

---

## 6. 记忆管理

### 6.1 独立记忆

**每个 Agent 拥有**：
- 独立的对话历史
- 独立的任务执行记录
- 独立的用户偏好
- 独立的工作知识

### 6.2 记忆存储

**存储方式**：
```
/memory/
├── oc_001/
│   ├── agent_A/
│   │   ├── conversations.json
│   │   ├── tasks.json
│   │   └── preferences.json
│   ├── agent_B/
│   │   ├── conversations.json
│   │   ├── tasks.json
│   │   └── preferences.json
│   └── agent_C/
│       └── ...
└── oc_002/
    └── ...
```

### 6.3 记忆隔离

**隔离规则**：
- Agent A 无法访问 Agent B 的记忆
- 不同 OpenClaw 的 Agent 记忆完全隔离
- 记忆与 Agent ID 绑定，不随 OpenClaw 变化

---

## 7. 群组通讯

### 7.1 群组规则

- 群组必须由用户创建
- 用户必须在群组中
- 群组成员为多个 Agent（可跨 OpenClaw）

### 7.2 群组消息

**发送流程**：
```
1. 用户在群组中发送消息
   ↓
2. 消息发送到调度中心
   ↓
3. 调度中心转发给群组所有成员
   ↓
4. 各 Agent 收到消息
   ↓
5. Agent 可选择回复
```

**示例**：
```
群组：项目开发群
成员：用户 + Agent[程序员] + Agent[设计师] + Agent[产品经理]

用户："我们需要开发一个登录页面"
→ 所有 Agent 收到消息

Agent[产品经理]："我来写需求文档"
Agent[设计师]："我来设计 UI"
Agent[程序员]："我来开发"
```

---

## 8. 配置管理

### 8.1 配置文件

**配置项**：
```yaml
# config.yaml
openclaw:
  id: "oc_001"
  name: "AI 助手"
  
scheduler:
  websocket_url: "ws://localhost:8001/ws"
  heartbeat_interval: 30

agents:
  - id: "agent_A"
    name: "程序员"
    role: "developer"
    system_prompt: "你是一名资深程序员..."
    memory_path: "/memory/oc_001/agent_A/"
    
  - id: "agent_B"
    name: "作家"
    role: "writer"
    system_prompt: "你是一名专业作家..."
    memory_path: "/memory/oc_001/agent_B/"
```

---

## 9. 错误处理

### 9.1 连接错误

| 错误 | 原因 | 处理 |
|------|------|------|
| `CONNECTION_FAILED` | 网络故障 | 自动重连 |
| `AUTH_FAILED` | 认证失败 | 停止重连，提示检查配置 |
| `OPENCLAW_DISABLED` | OpenClaw 已禁用 | 停止重连，等待启用 |
| `SERVER_ERROR` | 服务端错误 | 等待后重连 |

### 9.2 Agent 错误

| 错误 | 原因 | 处理 |
|------|------|------|
| `AGENT_NOT_FOUND` | Agent ID 不存在 | 记录日志，跳过 |
| `AGENT_DISABLED` | Agent 已禁用 | 提示用户 |
| `MEMORY_LOAD_FAILED` | 记忆加载失败 | 使用默认记忆 |

---

## 10. 相关文档

| 文档 | 说明 |
|------|------|
| [00-需求概述.md](./00-需求概述.md) | 软件定位 |
| [13-调度中心系统.md](./13-调度中心系统.md) | 调度中心架构 |
| [20-系统架构.md](./20-系统架构.md) | 系统整体架构 |

---

**最后更新**: 2026-03-18
