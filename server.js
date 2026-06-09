const express = require('express');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { createBotInstance, checkBuddyWatchChain } = require('./bot');
const { loadConfig, getAIConfig, parseCookies } = require('./shared');

// ========== 配置加载 ==========
const configPath = path.join(__dirname, 'config.json');

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

// ========== Bot 管理状态 ==========
const config = loadConfig(configPath);

// ========== Web 鉴权配置 ==========
function getWebAuthConfig() {
    const cfg = config.web_auth || {};
    return {
        username: cfg.username || 'admin',
        password: cfg.password || 'admin',
        jwtSecret: cfg.jwt_secret || 'mc_bot_default_jwt_secret_change_me',
    };
}

// ========== 登录速率限制 ==========
const loginRateLimit = new Map(); // ip -> { count, windowStart }

function getClientIP(req) {
    return req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';
}

function checkLoginRateLimit(ip) {
    const now = Date.now();
    let record = loginRateLimit.get(ip);
    if (!record || now - record.windowStart > 60000) {
        record = { count: 0, windowStart: now };
        loginRateLimit.set(ip, record);
    }
    record.count++;
    return record.count;
}

// 定期清理过期的速率限制记录（每 2 分钟）
setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of loginRateLimit) {
        if (now - record.windowStart > 120000) loginRateLimit.delete(ip);
    }
}, 120000);

// ========== JWT 工具函数 ==========
function getToken(req) {
    // 1. Authorization: Bearer <token>
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7);
    }
    // 2. Query parameter（SSE 回退用）
    if (req.query && req.query.token) {
        return req.query.token;
    }
    // 3. Cookie
    const cookies = parseCookies(req);
    return cookies.mc_bot_token || null;
}

function verifyToken(token) {
    if (!token) return null;
    try {
        return jwt.verify(token, getWebAuthConfig().jwtSecret);
    } catch (e) {
        return null;
    }
}

// ========== Express 服务器 ==========
const app = express();
const PORT = process.env.WEB_PORT || config.web_port || 3000;

app.use(express.json());

// ========== 鉴权 API（无需登录） ==========

app.post('/api/auth/login', (req, res) => {
    const ip = getClientIP(req);
    const attempts = checkLoginRateLimit(ip);
    if (attempts > 5) {
        return res.status(429).json({ error: '登录尝试过于频繁，请稍后再试' });
    }

    const { username, password } = req.body || {};
    const authCfg = getWebAuthConfig();

    if (!username || !password) {
        return res.status(400).json({ error: '请输入用户名和密码' });
    }

    if (username !== authCfg.username || password !== authCfg.password) {
        return res.status(401).json({ error: '用户名或密码错误' });
    }

    const token = jwt.sign(
        { username, loginAt: Date.now() },
        authCfg.jwtSecret,
        { expiresIn: '24h' }
    );

    res.cookie('mc_bot_token', token, {
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: 'strict',
    });

    res.json({ success: true, token, username });
});

app.get('/api/auth/status', (req, res) => {
    const token = getToken(req);
    const decoded = verifyToken(token);
    if (decoded) {
        res.json({ authenticated: true, username: decoded.username });
    } else {
        res.json({ authenticated: false });
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('mc_bot_token');
    res.json({ success: true });
});

// ========== SSE 短期令牌（避免 JWT 出现在 URL 中） ==========
const sseTokens = new Map(); // token -> { username, expiresAt }

// 定期清理过期的 SSE 令牌
setInterval(() => {
    const now = Date.now();
    for (const [token, data] of sseTokens) {
        if (now > data.expiresAt) sseTokens.delete(token);
    }
}, 300000);

// 获取短期 SSE 令牌（需要有效的 JWT 认证）
app.post('/api/auth/sse-token', (req, res) => {
    const token = getToken(req);
    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ error: '未登录或登录已过期' });

    const sseToken = require('crypto').randomBytes(32).toString('hex');
    sseTokens.set(sseToken, {
        username: decoded.username,
        expiresAt: Date.now() + 5 * 60 * 1000, // 5 分钟有效期
    });
    res.json({ token: sseToken, expiresIn: 300 });
});

// ========== API 鉴权中间件（所有 /api/* 除 /api/auth/* 需登录） ==========
app.use('/api', (req, res, next) => {
    if (req.path.startsWith('/auth/') || req.path.startsWith('/events')) return next();
    const token = getToken(req);
    if (!verifyToken(token)) {
        return res.status(401).json({ error: '未登录或登录已过期' });
    }
    next();
});

// ========== 页面访问鉴权（跳转登录页） ==========
app.use((req, res, next) => {
    const p = req.path;
    // 不拦截 API 请求
    if (p.startsWith('/api/')) return next();
    // 允许登录页及共享资源
    if (p === '/login.html' || p.startsWith('/css/') || p.startsWith('/js/')) return next();
    // 对根路径和 HTML 页面检查登录
    if (req.method === 'GET' && (p === '/' || p === '/index.html' || !p.includes('.'))) {
        const token = getToken(req);
        if (!verifyToken(token)) {
            return res.redirect('/login.html');
        }
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));
const defaults = config.defaults || {};
const aiCfg = getAIConfig(config);
const botRegistry = new Map();

// TPS 紧急下线回调（全局，所有 bot 共享）
function emergencyShutdown(reason) {
    console.log(`[主进程] ⚠️ 紧急下线触发！原因: ${reason}`);
    pushLog('error', 'server', `⚠️ 紧急下线触发！原因: ${reason}`);
    console.log(`[主进程] 正在下线所有机器人...`);
    let count = 0;
    for (const [key, b] of botRegistry) {
        try {
            console.log(`[主进程] 下线: ${b._botName || b.username}`);
            pushLog('warn', b._botName || key, `紧急下线: ${b.username}`);
            b.end();
            count++;
        } catch (e) {
            console.error(`[主进程] 下线 ${key} 失败:`, e.message);
        }
    }
    botRegistry.clear();
    console.log(`[主进程] 已下线 ${count} 个机器人`);
    pushLog('info', 'server', `紧急下线完成: 已下线 ${count} 个机器人`);
    sendSseStatus();
}

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
        emergencyShutdown,
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
        // Buddy Watch 链式传播
        checkBuddyWatchChain(merged.name, merged.username, botRegistry);
    });

    bot.on('kicked', (reason) => {
        const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason);
        pushLog('error', merged.name, `[${merged.username}] 被踢出: ${reasonStr}`);
        botRegistry.delete(lowerUser);
        sendSseStatus();
        // Buddy Watch 链式传播
        checkBuddyWatchChain(merged.name, merged.username, botRegistry);
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

// ========== 配置管理 API ==========

function maskApiKey(key) {
    if (!key || key.length <= 4) return key ? '****' : '';
    return '*'.repeat(key.length - 4) + key.slice(-4);
}

function maskPassword(pw) {
    if (!pw || pw.length <= 2) return pw ? '**' : '';
    return '*'.repeat(pw.length - 2) + pw.slice(-2);
}

// 获取完整配置（bots 除外，敏感字段脱敏）
app.get('/api/config', (req, res) => {
    const cfg = JSON.parse(JSON.stringify(config));
    // 脱敏 API keys
    if (cfg.ai) {
        if (cfg.ai.deepseek && cfg.ai.deepseek.api_key) {
            cfg.ai.deepseek.api_key = maskApiKey(cfg.ai.deepseek.api_key);
        }
        if (cfg.ai.mimo && cfg.ai.mimo.api_key) {
            cfg.ai.mimo.api_key = maskApiKey(cfg.ai.mimo.api_key);
        }
    }
    // 脱敏密码
    if (cfg.web_auth && cfg.web_auth.password) {
        cfg.web_auth.password = maskPassword(cfg.web_auth.password);
    }
    // 移除 bots（由专门的 bot API 管理）
    delete cfg.bots;
    res.json(cfg);
});

// 更新配置（部分合并）
app.put('/api/config', (req, res) => {
    const updates = req.body;
    if (!updates || typeof updates !== 'object') {
        return res.status(400).json({ error: '请求体必须为 JSON 对象' });
    }
    // 禁止通过此接口修改 bots 数组
    delete updates.bots;

    // 脱敏值过滤：如果值包含 "****" 则为未修改的脱敏字段，跳过
    function isMasked(val) {
        return typeof val === 'string' && val.includes('****');
    }

    // 深度合并辅助函数（跳过脱敏值）
    function deepMerge(target, source) {
        for (const key of Object.keys(source)) {
            const srcVal = source[key];
            const tgtVal = target[key];
            if (srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal) &&
                tgtVal && typeof tgtVal === 'object' && !Array.isArray(tgtVal)) {
                deepMerge(tgtVal, srcVal);
            } else if (!isMasked(srcVal)) {
                target[key] = srcVal;
            }
        }
    }

    deepMerge(config, updates);
    saveConfig(config);

    // 如果 AI 配置变更，需更新 aiCfg 引用（下次 spawn 生效）
    const newAiCfg = getAIConfig(config);
    Object.assign(aiCfg, newAiCfg);

    pushLog('event', 'server', '[配置] Web 面板更新了配置');
    sendSseStatus();
    res.json({ success: true, message: '配置已保存' });
});

// SSE 事件流
app.get('/api/events', (req, res) => {
    // 优先验证 SSE 短期令牌，其次回退到标准 JWT
    const sseToken = req.query.token;
    let authenticated = false;
    if (sseToken) {
        const tokenData = sseTokens.get(sseToken);
        if (tokenData && Date.now() <= tokenData.expiresAt) {
            authenticated = true;
            // 使用后不删除令牌，允许重连
        }
    }
    if (!authenticated) {
        // 回退到标准 JWT 认证
        const jwt = getToken(req);
        if (!verifyToken(jwt)) {
            res.status(401).json({ error: '未登录或登录已过期' });
            return;
        }
    }

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

// SPA fallback — 非 API/静态文件请求返回 index.html（需登录）
app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    if (req.method === 'GET' && !req.path.includes('.')) {
        const token = getToken(req);
        if (!verifyToken(token)) {
            return res.redirect('/login.html');
        }
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
