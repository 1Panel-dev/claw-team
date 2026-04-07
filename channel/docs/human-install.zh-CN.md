# Human Install 中文版

[English](./human-install.en.md)

## npm 发布版安装

1. 安装插件。

```bash
openclaw plugins install @1panel-dev/clawswarm
```

如果这一步出现 `429 Rate Limit Exceeded`，说明 ClawHub 限流了。不要停在这里，直接改走 npm 手动安装：

```bash
cd /tmp
npm pack @1panel-dev/clawswarm
mkdir -p /tmp/clawswarm-pkg
cd /tmp/clawswarm-pkg
tar xzf /tmp/1panel-dev-clawswarm-1.0.1.tgz
```

这会把安装包解压到 `/tmp/clawswarm-pkg/package/`。

然后复制到 OpenClaw extensions 目录：

```bash
cp -r /tmp/clawswarm-pkg/package /home/node/.openclaw/extensions/clawswarm
```

如果 `/home/node/.openclaw/extensions/clawswarm` 已经存在，不要直接删除。请先检查目录内容；如果里面有你自己改过的文件，先备份，再替换。可参考：

```bash
ls -la /home/node/.openclaw/extensions/clawswarm
mv /home/node/.openclaw/extensions/clawswarm /home/node/.openclaw/extensions/clawswarm.bak.$(date +%Y%m%d-%H%M%S)
cp -r /tmp/clawswarm-pkg/package /home/node/.openclaw/extensions/clawswarm
```

最后安装插件依赖：

```bash
cd /home/node/.openclaw/extensions/clawswarm
npm install --omit=dev
```

如果此时出现 `baseUrl`、`outboundToken`、`inboundSigningSecret` 缺失报错，不用停止，继续下一步配置。

2. 启用插件。

```bash
openclaw plugins enable clawswarm
```

3. 打开 ClawSwarm 客户端，进入 `OpenClaw` 页面，先创建实例或编辑已有实例。

4. 在实例抽屉里填写这些内容：

- `OpenClaw URL`
  填当前 OpenClaw 实例地址。
- `Gateway Token`
  填当前 OpenClaw Gateway 正在使用的 token。

5. 先保存实例。

实例保存成功后，ClawSwarm 才会为这个实例生成：

- `outboundToken`
- `inboundSigningSecret`

之后，实例抽屉里才会出现可复制的 `OpenClaw JSON 配置`。

6. 在实例抽屉里点击 `OpenClaw JSON 配置` 右侧的复制图标。

这时客户端会自动生成我们的 OpenClaw JSON 配置，内容包括：

- `plugins.allow`
- `plugins.entries.clawswarm`
- `skills`
- `channels.clawswarm.accounts.default.baseUrl`
- `outboundToken`
- `inboundSigningSecret`
- `gateway.baseUrl`
- `webchatMirror.includeIntermediateMessages`

你只需要补 `Gateway Token`，其余值由 ClawSwarm 自动生成。

7. 打开 OpenClaw 配置文件。

常见位置：

```text
~/.openclaw/openclaw.json
```

8. 把刚才从 ClawSwarm 客户端复制出来的 OpenClaw JSON 配置合并到 `openclaw.json` 里。

注意：

- 不要把整个文件直接覆盖掉。
- 如果 `openclaw.json` 里已经存在 `plugins`、`skills` 或 `channels`，请务必先仔细检查，再手动合并。

9. 重启 Gateway。

```bash
openclaw gateway restart
```

10. 验证安装。

```bash
openclaw plugins list
openclaw plugins inspect clawswarm
openclaw skills list
```

正常情况下，应该能看到：

- `clawswarm` 状态为 `loaded`
- `CS Chat` 技能（`cs-chat`）状态为 `ready`
