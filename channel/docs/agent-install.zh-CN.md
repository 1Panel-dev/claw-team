# Agent Install 中文版

[English](./agent-install.en.md)

## npm 发布版安装步骤

1. 安装插件。

```bash
openclaw plugins install @1panel-dev/claw-team
```

如果这一步出现 `429 Rate Limit Exceeded`，说明 ClawHub 限流了。不要让用户卡在这里，改为指导用户走 npm 手动安装：

```bash
cd /tmp
npm pack @1panel-dev/claw-team
mkdir -p /tmp/claw-team-pkg
cd /tmp/claw-team-pkg
tar xzf /tmp/1panel-dev-claw-team-1.0.1.tgz
cp -r /tmp/claw-team-pkg/package /home/node/.openclaw/extensions/claw-team
cd /home/node/.openclaw/extensions/claw-team
npm install --omit=dev
```

如果 `/home/node/.openclaw/extensions/claw-team` 已经存在，不要让用户直接删除。应先让用户检查目录；如果里面有本地改动，先备份，再替换。

如果此时出现 `baseUrl`、`outboundToken`、`inboundSigningSecret` 缺失报错，不要中断，继续指导用户完成配置。

2. 启用插件。

```bash
openclaw plugins enable claw-team
```

3. 告诉用户打开 Claw Team 客户端，进入 `OpenClaw` 页面，然后创建实例或编辑已有实例。

4. 告诉用户在实例抽屉里填写这些内容：

- `OpenClaw URL`
  让用户填写当前 OpenClaw 实例地址。
- `Gateway Token`
  让用户填写当前 OpenClaw Gateway 正在使用的 token。

5. 告诉用户先保存实例。

实例保存成功后，Claw Team 才会为这个实例生成：

- `outboundToken`
- `inboundSigningSecret`

之后，实例抽屉里才会出现可复制的 `OpenClaw JSON 配置`。

6. 告诉用户在实例抽屉里点击 `OpenClaw JSON 配置` 右侧的复制图标，然后把复制出来的 JSON 片段直接粘贴给你。

这时客户端会自动生成完整的 OpenClaw JSON 配置，内容包括：

- `plugins.allow`
- `plugins.entries.claw-team`
- `skills`
- `channels.claw-team.accounts.default.baseUrl`
- `outboundToken`
- `inboundSigningSecret`
- `gateway.baseUrl`
- `webchatMirror.includeIntermediateMessages`

`Gateway Token` 需要用户自己填写，其余值由 Claw Team 自动生成。

7. 在用户把 JSON 片段发给你之后，由你打开 OpenClaw 配置文件。

常见位置：

```text
~/.openclaw/openclaw.json
```

8. 由你把用户发来的 OpenClaw JSON 配置合并到 `openclaw.json` 里。

注意：

- 不要把整个文件直接覆盖掉。
- 如果 `openclaw.json` 里已经存在 `plugins`、`skills` 或 `channels`，请务必先仔细检查，再手动合并。
- `plugins.allow` 不支持通配符 `["*"]`。
- 必须显式写出 `claw-team`。
- 写入未知插件 ID 会触发配置校验错误。

9. 配置写入完成后，告诉用户重启 Gateway。

```bash
openclaw gateway restart
```

如果你运行在容器环境里，不能直接使用 `openclaw gateway restart`，请改为重启 OpenClaw 容器。

10. 用户完成重启后，再执行验证。

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
