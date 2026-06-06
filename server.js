const express = require('express');
const fs = require('fs');
const path = require('path');
const { createBotInstance } = require('./bot');

// ========== 配置加载 ==========
const configPath = path.join(__dirname, 'config.json');

function loadConfig() {
    try {
        return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
        console.error('无法读取 config.json:', err.message);
        process.exit(1);
    }
}

function saveConfig(config) {
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (err) {
        console.error('保存 config.json 失败:', err.message);
    }
}

// ========== 日志缓冲（用于 Web 展示） ==========
const MAX_LOG_LINES = 500;
const logBuffer = [];
const sseClients = new Set();

function pushLog(level, source, message) {
    const entry = {
        time: new Date().toISOString(),
        level,   // 'info' | 'warn' | 'error' | 'chat' | 'event'
        source,  // bot name 或 'server'
        message,
    };
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();

    // 推送到所有 SSE 客户端
    const data = JSON.stringify(entry);
    for (const client of sseClients) {
        try { client.write(`event: log\ndata: ${data}\n\n`); } catch (e) {}
    }
}

// 拦截 console 输出到日志缓冲
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = function (...args) {
    originalLog.apply(console, args);
    pushLog('info', 'server', args.join(' '));
};
console.error = function (...args) {
    originalError.apply(console, args);
    pushLog('error', 'server', args.join(' '));
};
console.warn = function (...args) {
    originalWarn.apply(console, args);
    pushLog('warn', 'server', args.join(' '));
};

// ========== AI 配置（从 bot.js 提取） ==========
function getAIConfig(config) {
    const aiConfig = (config && config.ai) || {};

    const deepseekApiKey = aiConfig.deepseek?.api_key || '';
    const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
    const DEEPSEEK_MODEL = 'deepseek-chat';

    const mimoApiKey = aiConfig.mimo?.api_key || '';
    const mimoRegion = aiConfig.mimo?.region || 'cn';
    const MIMO_API_URL = mimoApiKey.startsWith('tp-')
        ? `https://token-plan-${mimoRegion}.xiaomimimo.com/v1/chat/completions`
        : 'https://api.xiaomimimo.com/v1/chat/completions';
    const MIMO_MODEL = 'mimo-v2.5-pro';

    return {
        deepseekApiKey, DEEPSEEK_API_URL, DEEPSEEK_MODEL,
        mimoApiKey, mimoRegion, MIMO_API_URL, MIMO_MODEL,
    };
}

// ========== Express 服务器 ==========
const app = express();
const PORT = process.env.WEB_PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== Bot 管理状态 ==========
const config = loadConfig();
const defaults = config.defaults || {};
const aiCfg = getAIConfig(config);
const botRegistry = new Map();

// 记录每个 bot 的启动时间和最近聊天消息
const botMeta = new Map(); // name_lower -> { startTime, recentChats: [] }

function saveBotsConfig() {
    saveConfig(config);
}

function spawnBotFromConfig(botCfg) {
    const lowerUser = (botCfg.username || '').toLowerCase();
    if (botRegistry.has(lowerUser)) {
        return `机器人 ${botCfg.username} 已在运行中`;
    }
    const merged = { ...defaults, ...botCfg };
    if (!merged.name || !merged.host || !merged.port || !merged.username) {
        return 'Bot 配置不完整（缺少 name/host/port/username）';
    }
    console.log(`[主进程] 启动机器人: ${merged.username} @ ${merged.host}:${merged.port}`);

    const bot = createBotInstance(merged, {
        configPath,
        rootConfig: config,
        botRegistry,
        saveBotsConfig,
        spawnBotFromConfig,
        aiCfg,
    });

    botRegistry.set(lowerUser, bot);
    botMeta.set(lowerUser, { startTime: Date.now(), recentChats: [] });

    // 监听聊天消息 → 推送 SSE
    bot.on('messagestr', (msg) => {
        const isSelfEcho = msg.startsWith('<') && msg.includes(bot.username);
        if (!isSelfEcho) {
            pushLog('chat', merged.name, msg);
            const meta = botMeta.get(lowerUser);
            if (meta) {
                meta.recentChats.push({ time: Date.now(), message: msg });
                if (meta.recentChats.length > 100) meta.recentChats.shift();
            }
        }
    });

    // 监听登录→推送 SSE
    bot.on('login', () => {
        pushLog('event', merged.name, `[${merged.username}] 已登录（协议版本: ${bot.version}）`);
        sendSseStatus();
    });

    bot.on('spawn', () => {
        sendSseStatus();
    });

    bot.on('end', (reason) => {
        pushLog('warn', merged.name, `[${merged.username}] 连接断开: ${reason}`);
        botRegistry.delete(lowerUser);
        sendSseStatus();
    });

    bot.on('kicked', (reason) => {
        const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason);
        pushLog('error', merged.name, `[${merged.username}] 被踢出: ${reasonStr}`);
        botRegistry.delete(lowerUser);
        sendSseStatus();
    });

    bot.on('error', (err) => {
        pushLog('error', merged.name, `[${merged.username}] 错误: ${err.message}`);
    });

    sendSseStatus();
    return null; // null = 成功
}

// SSE 状态广播
function sendSseStatus() {
    const data = JSON.stringify(getBotsStatus());
    for (const client of sseClients) {
        try { client.write(`event: status\ndata: ${data}\n\n`); } catch (e) {}
    }
}

// 获取所有 bot 状态
function getBotsStatus() {
    return (config.bots || []).map(botCfg => {
        const lowerUser = (botCfg.username || '').toLowerCase();
        const isOnline = botRegistry.has(lowerUser);
        const meta = botMeta.get(lowerUser);
        return {
            name: botCfg.name,
            username: botCfg.username,
            host: botCfg.host,
            port: botCfg.port,
            enabled: !!botCfg.enabled,
            online: isOnline,
            startTime: meta ? meta.startTime : null,
            uptime: (isOnline && meta) ? Date.now() - meta.startTime : null,
        };
    });
}

// ========== API 路由 ==========

// 获取所有 bot 状态
app.get('/api/bots', (req, res) => {
    res.json(getBotsStatus());
});

// 启动 bot
app.post('/api/bots/:name/start', (req, res) => {
    const name = req.params.name;
    const botCfg = (config.bots || []).find(b => b.name === name || (b.username || '').toLowerCase() === name.toLowerCase());
    if (!botCfg) return res.status(404).json({ error: `未找到机器人: ${name}` });
    const result = spawnBotFromConfig(botCfg);
    if (result) return res.status(400).json({ error: result });
    res.json({ success: true, message: `机器人 ${botCfg.username} 已上线` });
});

// 停止 bot
app.post('/api/bots/:name/stop', (req, res) => {
    const name = req.params.name;
    const botCfg = (config.bots || []).find(b => b.name === name || (b.username || '').toLowerCase() === name.toLowerCase());
    if (!botCfg) return res.status(404).json({ error: `未找到机器人: ${name}` });

    const lowerUser = (botCfg.username || '').toLowerCase();
    const bot = botRegistry.get(lowerUser);
    if (!bot) return res.status(400).json({ error: `机器人 ${botCfg.username} 未在运行` });

    try { bot.end(); } catch (e) {}
    botRegistry.delete(lowerUser);
    pushLog('event', botCfg.name, `[${botCfg.username}] 通过 Web 面板下线`);
    sendSseStatus();
    res.json({ success: true, message: `机器人 ${botCfg.username} 已下线` });
});

// 发送公聊消息
app.post('/api/bots/:name/chat', (req, res) => {
    const name = req.params.name;
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: '缺少 message 参数' });

    const botCfg = (config.bots || []).find(b => b.name === name || (b.username || '').toLowerCase() === name.toLowerCase());
    if (!botCfg) return res.status(404).json({ error: `未找到机器人: ${name}` });

    const lowerUser = (botCfg.username || '').toLowerCase();
    const bot = botRegistry.get(lowerUser);
    if (!bot) return res.status(400).json({ error: `机器人 ${botCfg.username} 未在线` });

    bot.chat(message);
    pushLog('chat', botCfg.name, `[${botCfg.username} → 公聊] ${message}`);
    res.json({ success: true, message: '已发送' });
});

// 执行服务器命令（直接发送到服务器，绕过 bot 内部命令系统）
app.post('/api/bots/:name/cmd', (req, res) => {
    const name = req.params.name;
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: '缺少 command 参数' });

    const botCfg = (config.bots || []).find(b => b.name === name || (b.username || '').toLowerCase() === name.toLowerCase());
    if (!botCfg) return res.status(404).json({ error: `未找到机器人: ${name}` });

    const lowerUser = (botCfg.username || '').toLowerCase();
    const bot = botRegistry.get(lowerUser);
    if (!bot) return res.status(400).json({ error: `机器人 ${botCfg.username} 未在线` });

    const cmd = command.startsWith('/') ? command : `/${command}`;
    bot.chat(cmd);
    pushLog('event', botCfg.name, `[${botCfg.username} → 服务器命令] ${cmd}`);
    res.json({ success: true, message: `已执行服务器命令: ${cmd}` });
});

// 执行 Bot 内部指令（优先匹配注册命令，未匹配则转发到服务器）
app.post('/api/bots/:name/exec', async (req, res) => {
    const name = req.params.name;
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: '缺少 command 参数' });

    const botCfg = (config.bots || []).find(b => b.name === name || (b.username || '').toLowerCase() === name.toLowerCase());
    if (!botCfg) return res.status(404).json({ error: `未找到机器人: ${name}` });

    const lowerUser = (botCfg.username || '').toLowerCase();
    const bot = botRegistry.get(lowerUser);
    if (!bot) return res.status(400).json({ error: `机器人 ${botCfg.username} 未在线` });

    if (typeof bot.execCommand !== 'function') {
        return res.status(500).json({ error: 'Bot 实例不支持 execCommand（bot.js 版本过旧）' });
    }

    try {
        await bot.execCommand(command);
        const reply = (bot._webReply && bot._webReply.length > 0) ? bot._webReply.join('\n') : null;
        pushLog('event', botCfg.name, `[${botCfg.username} → Bot指令] ${command}${reply ? ' → ' + reply : ''}`);
        res.json({ success: true, message: `已执行 Bot 指令: ${command}`, reply });
    } catch (err) {
        pushLog('error', botCfg.name, `[${botCfg.username} → Bot指令失败] ${err.message}`);
        res.status(500).json({ error: `指令执行失败: ${err.message}` });
    }
});

// 设为默认启动
app.post('/api/bots/:name/enable', (req, res) => {
    const name = req.params.name;
    const botCfg = (config.bots || []).find(b => b.name === name || (b.username || '').toLowerCase() === name.toLowerCase());
    if (!botCfg) return res.status(404).json({ error: `未找到机器人: ${name}` });
    botCfg.enabled = true;
    saveBotsConfig();
    pushLog('event', 'server', `[配置] ${botCfg.username} 已设为默认启动`);
    sendSseStatus();
    res.json({ success: true, message: `机器人 ${botCfg.username} 已设为默认启动` });
});

// 取消默认启动
app.post('/api/bots/:name/disable', (req, res) => {
    const name = req.params.name;
    const botCfg = (config.bots || []).find(b => b.name === name || (b.username || '').toLowerCase() === name.toLowerCase());
    if (!botCfg) return res.status(404).json({ error: `未找到机器人: ${name}` });
    botCfg.enabled = false;
    saveBotsConfig();
    pushLog('event', 'server', `[配置] ${botCfg.username} 已取消默认启动`);
    sendSseStatus();
    res.json({ success: true, message: `机器人 ${botCfg.username} 已取消默认启动` });
});

// 获取最近日志
app.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 200;
    const source = req.query.source; // 可选：按 bot 名称过滤
    let logs = logBuffer;
    if (source) {
        logs = logs.filter(l => l.source === source);
    }
    res.json(logs.slice(-limit));
});

// SSE 事件流
app.get('/api/events', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.write('\n');

    // 发送初始状态
    res.write(`event: status\ndata: ${JSON.stringify(getBotsStatus())}\n\n`);

    sseClients.add(res);

    // 心跳保活（每 30 秒）
    const heartbeat = setInterval(() => {
        try { res.write(`: heartbeat\n\n`); } catch (e) { clearInterval(heartbeat); }
    }, 30000);

    req.on('close', () => {
        sseClients.delete(res);
        clearInterval(heartbeat);
    });
});

// SPA fallback — 非 API/静态文件请求返回 index.html
app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    // 静态文件已经由 express.static 处理，剩下的交给 index.html
    if (req.method === 'GET' && !req.path.includes('.')) {
        return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
    next();
});

// ========== 启动服务器 & 默认启用的 Bot ==========
app.listen(PORT, () => {
    console.log(`========================================`);
    console.log(`  MC Bot Web 管理面板已启动`);
    console.log(`  地址: http://localhost:${PORT}`);
    console.log(`========================================`);

    // 启动 enabled 的 bot（同 bot.js 主入口逻辑）
    const enabledBots = (config.bots || []).filter(b => b.enabled !== false);
    if (enabledBots.length > 0) {
        console.log(`正在启动 ${enabledBots.length} 个已启用的机器人...`);
        for (const botCfg of enabledBots) {
            const merged = { ...defaults, ...botCfg };
            if (!merged.name || !merged.host || !merged.port || !merged.username) {
                console.error(`Bot 配置不完整:`, merged);
                continue;
            }
            const result = spawnBotFromConfig(botCfg);
            if (result) console.error(result);
        }
    } else {
        console.log('没有默认启用的机器人，可通过 Web 面板手动启动');
    }
});
