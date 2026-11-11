# Magpie Boss

在 Magpie 后台把日常 AI 请求变成 Boss 攻击。安装插件后，从 Magpie 侧栏的「Boss 房间」直接打开大厅。关掉页面后攻击继续结算。

## 本机试跑

本项目在 Bun 1.4.4、Magpie 0.1.3576 上验证。客户端由 Magpie 的插件宿主启动。

1. 在 Magpie 的「设置 → 插件 → 添加插件」中选择这个项目的目录。也可以在项目目录运行 `magpie plugin add "$PWD"`。如果 macOS 上的命令还没加入 PATH，可以运行 `/Applications/Magpie.app/Contents/MacOS/magpie plugin add "$PWD"`。
2. 启用后点侧栏的「Boss 房间」。新玩家默认进入公共大厅，老玩家回到原来的房间。可从大厅选择公开房、建自己的房间、输入私人房邀请码，以及随时更改昵称。
3. 发现共享大厅时会自动连接。没有共享大厅时，插件启动本机大厅，可以直接玩。也可以在浏览器打开 [本机 Boss 房间](http://127.0.0.1:3468/)。

## 叫同事加入

共享大厅由一台办公室电脑运行一次，其他玩家只需安装插件。macOS 上，下面的命令会在可信局域网内发布 Bonjour 大厅地址。

```sh
BOSS_HOST=0.0.0.0 bun run room
```

同一网络的客户端会尝试发现 `magpie-boss.local:8787`。需要跨网段或办公室禁用 Bonjour 时，可以在分发包的 `package.json` 中预设 `magpie.sharedLobby` 为共享服务的地址，所有玩家使用同一份包。也可以从插件的高级选项指定 `roomServer`。

公开房在大厅里直接进入。私人房通过 8 位数字邀请码加入，原来的邀请链接也可使用。切换房间时，个人等级保留，后续攻击计入新房间。

## 部署到服务器

1. 把 `package.json`、`room-server.mjs`、`boss.mjs`、`lobby-network.mjs`、`web-assets.mjs`、`web/` 和 `page/format.js` 放到服务器，保留目录结构。使用 Bun 启动服务，`BOSS_DB` 指向持久化目录中的数据库文件，目录需要提前创建并可写。

   ```sh
   BOSS_HOST=127.0.0.1 BOSS_PORT=8787 BOSS_DB=/path/to/data/boss-room.sqlite BOSS_PUBLIC_URL=https://boss.example.com bun run room
   ```

2. 用 HTTPS 反向代理把域名转发到 `127.0.0.1:8787`。在 Railway 上，服务也可以自动使用 `RAILWAY_PUBLIC_DOMAIN`。访问首页可打开大厅，`/health` 返回 `{"service":"magpie-boss"}`。
3. 在云端插件包中，把 `package.json` 的 `magpie.sharedLobby` 和 `page/index.html` 的 `data-hosted-lobby` 设为同一个 HTTPS 地址。高级选项中的 `roomServer` 会覆盖安装包的默认地址。

云端模式下，Magpie 直接打开服务器上的大厅，并自动绑定后台插件的玩家身份。后台插件通过 HTTPS 同步攻击。在普通浏览器中也可以先以访客身份加入房间，再从大厅的「绑定 Magpie」复制配对码，填入 Magpie Boss 的插件选项 `pairingCode`。绑定后使用 Magpie 角色的原有昵称和等级。网页显示当天已结算的攻击次数，调用量和 Token 留在本机。

私人房可用邀请码或邀请链接加入。服务器数据库保存已有房间和 Boss 进度。需要迁移旧大厅时，用 SQLite 的备份功能生成一致的数据库副本，再把副本放到服务器的 `BOSS_DB` 路径后启动服务。

## 结算规则

- 每个成功的模型请求自动攻击，基础伤害在 7 到 13 点之间随机。攻击可能触发 2 倍暴击（15%）、3 倍重暴击（5%）或 1.5 倍追击（10%）。Boss 有 10% 的基础闪避和 10% 的反击概率，反击时本次经验减半。
- 命中后有 0.5% 的概率秒杀任意血量的 Boss。Boss 血量在 25% 或以下时，另有 10% 的概率斩杀。两种终结都直接清空剩余血量，并分别奖励 30 XP 和 20 XP。Boss 闪避会阻止终结。
- 同房玩家共享连击进度。每第 5 次连续命中附加一半基础伤害，向上取整，附加伤害也受 Boss 技能影响。闪避或换到下一只 Boss 时重新累计。战报会显示实际扣血、伤害类型和连击加成。
- 玩家每 50 XP 升一级。房间从 60 HP 的第 1 关开始，每次击败 Boss 后立即进入下一关，新 Boss 的满血量增加 20 HP。关卡随房间进度保存，可以一直打下去。房间显示最近 30 条攻击的实际伤害、经验和剩余血量，新攻击会播放动画。
- 前五关依次出现带护盾的缓存怪、周期闪避的延迟幽灵、削减伤害和经验的栈甲巨像、能回血的回滚史莱姆，以及削弱暴击的镜像双子。后续关卡出现进化形态，技能会更强或触发更频繁。房间页显示技能说明、周期技能的触发倒计时和实际施放效果。
- 插件统计 Magpie 用量接口里的最终请求和 Codex 的本机会话日志。后者可以包含 Codex 直连 ChatGPT 的调用，凭响应 ID 去重。Ollama 或 LM Studio 中运行的本地模型可以通过 Magpie 网关计入。其他绕过网关的客户端需主动向 Magpie 上报用量。
- 失败的网关请求也记入调用次数。Token 按输入、输出、缓存读写相加。调用满千用 K 显示，Token 满百万用 M 显示。一次 Agent 任务可能产生多条模型请求。后台启动会检查最近 7 天中首次启用之后的记录，平时轮询当天的记录。
- 本机保存个人用量和待同步攻击，房间服务保存昵称、成员、经验和血量。同步发送的是攻击标识和日期，Token 和对话内容留在本机。重复同步同一攻击不会重复扣血。
- 默认的房间服务数据库是项目目录下的 `boss-room.sqlite`，可通过 `BOSS_DB` 指定持久化路径。每位玩家的本机数据保存在 Magpie 配置目录下的 `magpie-boss/player.sqlite`。
- 云端邀请链接直接打开云端大厅。局域网模式下，如果修改了 `localPort`，可以在本机房间页输入数字邀请码。

从旧版升级时，重启房间服务并在 Magpie 里重新启用插件。升级会保留房间、血量、经验和击败数。旧版已记入用量的请求保留原结算结果，新请求按不限次数的规则处理。

## 验证

```sh
bun test --coverage
bun test/smoke-magpie.mjs /Applications/Magpie.app/Contents/MacOS/magpie
```

联调脚本使用临时配置启动两个 Magpie 实例和一个本地模拟模型。它检查首次请求前建房、邀请码加入、真实网关请求扣血，以及重启后保留进度和避免重复结算。
