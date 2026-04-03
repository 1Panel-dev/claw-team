# Agent Install 中文版

[English](./agent-install.en.md)

## npm 发布版安装步骤

1. 安装插件。

```bash
openclaw plugins install @1panel-dev/claw-team
```

如果此时出现 `baseUrl`、`outboundToken`、`inboundSigningSecret` 缺失报错，不要中断，继续指导用户完成配置。

2. 启用插件。

```bash
openclaw plugins enable claw-team
```

3. 打开 Claw Team 客户端，进入 `OpenClaw` 页面，先创建实例或编辑已有实例。

4. 在实例抽屉里填写并获取这些内容：

- `OpenClaw URL`
  填当前 OpenClaw 实例地址。
- `Gateway Token`
  填当前 OpenClaw Gateway 正在使用的 token。

5. 先保存实例。

实例保存成功后，Claw Team 才会为这个实例生成：

- `outboundToken`
- `inboundSigningSecret`

之后，实例抽屉里才会出现可复制的 `OpenClaw JSON 配置`。

6. 在实例抽屉里点击 `OpenClaw JSON 配置` 右侧的复制图标。

这时客户端会自动生成实际可用的配置内容，包括：

- `hooks.internal`
- `skills`
- `channels.claw-team.accounts.default.baseUrl`
- `outboundToken`
- `inboundSigningSecret`
- `gateway.baseUrl`

你只需要补 `Gateway Token`，其余值由 Claw Team 自动生成。

7. 打开 OpenClaw 配置文件。

常见位置：

```text
~/.openclaw/openclaw.json
```

8. 把刚才复制出来的 JSON 片段合并到 `openclaw.json` 里。

注意：

- 不要把整个文件直接覆盖掉。
- 如果 `openclaw.json` 里已经存在 `hooks`、`skills` 或 `channels`，请务必先仔细检查，再手动合并。
- `hooks.internal` 这一段是必须的。缺少这段时，OpenClaw Web UI 里直接发送的消息不会回流到 Claw Team。

9. 在用户完成配置后，指导用户重启 Gateway。

```bash
openclaw gateway restart
```

如果你运行在容器环境里，不能直接使用 `openclaw gateway restart`，请改为重启 OpenClaw 容器。

10. 验证。

```bash
openclaw plugins list
openclaw plugins inspect claw-team
openclaw skills list
```

11. 向用户汇报：

- 已安装
- 已启用
- 已写配置
- 已重启 Gateway
- health 正常
- agents 正常
