# mc-bot

基于 [Node.js](https://nodejs.org/) 和 [Mineflayer](https://github.com/PrismarineJS/mineflayer) 的 Minecraft AI 机器人。支持多机器人管理、DeepSeek / 小米 MiMo 大模型对话、工具调用、自动登录与菜单、可信玩家、Web 控制台和实时日志。

## 功能

- **多机器人管理**：每个 bot 拥有独立账号、服务器、AI 配置和身份提示
- **AI 对话**：支持 DeepSeek 与 MiMo，可为不同 bot 指定不同 provider
- **工具调用（Function Calling）**：AI 可直接执行游戏内命令，如查询金币、转账、查看背包、切换服务器、查询领地等
- **可信玩家**：只有可信玩家可以使用转账、挖掘、传送、姿态等敏感工具
- **自动流程**：自动登录、自动菜单、服务器切换、上线/下线联动（buddy watch）
- **聊天处理**：消息分片、发送队列、长度限制、Markdown 清理、对话上下文记忆
- **Web 控制台**：登录鉴权、启动/停止 bot、发送聊天或命令、执行代码、SSE 实时日志
- **配置管理**：通过 Web 控制台查看和保存 `config.json`

## 环境要求

- Node.js 18+
- 一个支持 Mineflayer 的 Minecraft 服务器账号
- DeepSeek 或 MiMo 的 API Key（使用 AI 功能时）

## 快速开始

```bash
npm install

# 复制示例配置
cp config.example.json config.json     # Linux / macOS
copy config.example.json config.json   # Windows

# 编辑 config.json，填写 AI Key 和机器人账号
npm start        # 只启动机器人
npm run web      # 启动机器人 + Web 控制台
```

Web 控制台默认监听 `http://localhost:3000`，可通过环境变量 `WEB_PORT` 或 `config.json` 中的 `web_port` 修改。

> `config.json`、`.env` 和日志文件已加入 `.gitignore`，请勿把真实 API Key 或账号密码提交到仓库。

## 配置

参考 [`config.example.json`](config.example.json)：

```json
{
  "ai": {
    "provider": "mimo",
    "deepseek": { "api_key": "sk-..." },
    "mimo": { "api_key": "tp-...", "region": "cn" }
  },
  "defaults": {
    "version": "1.20.4",
    "system_prompt": "你是一个 Minecraft 服务器中的 AI 助手……",
    "trusted_players": ["player1"],
    "queue_delay": 1500,
    "max_msg_len": 40,
    "auto_menu": true,
    "auto_login": true,
    "max_pay_amount": 100000
  },
  "bots": [
    {
      "name": "my_bot",
      "host": "your-server.com",
      "port": 25565,
      "username": "my_bot_username",
      "password": "my_bot_password",
      "enabled": true,
      "buddy_watch": ""
    }
  ]
}
```

可选配置：

```json
{
  "web_port": 3000,
  "web_auth": {
    "username": "admin",
    "password": "change-me",
    "jwt_secret": "change-me-too"
  }
}
```

`web_auth` 未设置时使用默认的 `admin` / `admin`，部署到公网前务必修改。

## 常用游戏内命令

| 命令 | 说明 |
|---|---|
| `/help` | 查看帮助 |
| `/ping` | 测试机器人是否在线 |
| `/money [玩家]` | 查询金币 |
| `/pay <玩家> <金额>` | 转账（可信玩家） |
| `/inv`、`/armor`、`/health`、`/effects`、`/xp`、`/oxygen` | 查看背包、装备与状态 |
| `/server <名称>` | 通过菜单切换子服 |
| `/minechunk [半径]` | 自动挖掘当前区块（可信玩家） |
| `/attack loop [实体] [范围]` | 持续攻击（可信玩家） |
| `/follow`、`/collect`、`/stop` | 跟随、收集、停止当前动作 |
| `/sit`、`/crawl`、`/lay`、`/spin`、`/bellyflop`、`/sneak` | 姿态控制（可信玩家） |
| `/res info`、`/res list`、`/res tp` | Residence 领地查询与传送 |
| `/trust add <玩家>`、`/trust remove <玩家>`、`/trust list` | 管理可信玩家 |
| `/bot add`、`/bot del`、`/bot enable`、`/bot kill`、`/bot spawn` | 管理机器人 |
| `/craftstation`、`/washbox`、`/buddy`、`/afk` | 自动化与挂机功能 |

具体可用命令和权限以 `bot.js` 中的命令注册表和服务器权限配置为准。

## Web 控制台

`npm run web` 会启动 Express 服务，提供：

- 登录鉴权（JWT + 登录速率限制）
- bot 列表与启停
- 发送聊天消息、执行游戏命令或 JavaScript 代码
- 配置查看与保存
- SSE 实时日志流

## 项目结构

```text
bot.js               Mineflayer 机器人、AI 对话与工具调用
server.js            Express Web 控制台
shared.js            配置加载与共享工具
config.example.json  配置示例
public/              Web 前端
```

## 安全提示

- AI 工具能够执行真实游戏命令（包括转账、挖掘、传送），请谨慎配置 `trusted_players`
- 不要把 Web 控制台直接暴露到公网；如必须暴露，请使用 HTTPS 反向代理并设置强密码
- 不要提交 `config.json`、`.env` 或包含 API Key 的日志

## License

ISC
