const mineflayer = require('mineflayer');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// ========== 加载配置文件 ==========
function loadConfig(configPath) {
    const resolved = configPath || path.join(__dirname, 'config.json');
    try {
        return JSON.parse(fs.readFileSync(resolved, 'utf-8'));
    } catch (err) {
        console.error(`无法读取配置文件: ${resolved}`, err.message);
        console.error('请从 config.example.json 复制并填写 config.json');
        process.exit(1);
    }
}

// ========== 共享 AI 配置（从 config.json 全局读取） ==========

function getAIConfig(config) {
    const aiConfig = (config && config.ai) || {};

    // DeepSeek 配置
    const deepseekApiKey = aiConfig.deepseek?.api_key || '';
    const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
    const DEEPSEEK_MODEL = 'deepseek-chat';

    // 小米 MiMo 配置
    // Token Plan 密钥 (tp-开头) 需要匹配对应区域的端点：
    //   CN(中国):  token-plan-cn.xiaomimimo.com
    //   SGP(新加坡): token-plan-sgp.xiaomimimo.com
    //   AMS(阿姆斯特丹): token-plan-ams.xiaomimimo.com
    // 按量付费密钥 (sk-开头) 用: api.xiaomimimo.com
    const mimoApiKey = aiConfig.mimo?.api_key || '';
    const mimoRegion = aiConfig.mimo?.region || 'cn';
    const MIMO_API_URL = mimoApiKey.startsWith('tp-')
        ? `https://token-plan-${mimoRegion}.xiaomimimo.com/v1/chat/completions`
        : 'https://api.xiaomimimo.com/v1/chat/completions';
    const MIMO_MODEL = 'mimo-v2.5-pro';

    return {
        deepseekApiKey,
        DEEPSEEK_API_URL,
        DEEPSEEK_MODEL,
        mimoApiKey,
        mimoRegion,
        MIMO_API_URL,
        MIMO_MODEL,
    };
}

// ========== 共享 AI 调用函数 ==========

// 调用 DeepSeek API
async function queryDeepSeek(userMessage, systemPrompt, aiCfg) {
    const { deepseekApiKey, DEEPSEEK_API_URL, DEEPSEEK_MODEL } = aiCfg;
    if (!deepseekApiKey) {
        return '[DeepSeek] 未在 config.json 中设置 deepseek.api_key，无法调用 AI';
    }

    try {
        const res = await fetch(DEEPSEEK_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${deepseekApiKey}`,
            },
            body: JSON.stringify({
                model: DEEPSEEK_MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userMessage },
                ],
                max_tokens: 1024,
                temperature: 0.7,
            }),
        });

        if (!res.ok) {
            const errText = await res.text();
            console.error(`[DeepSeek] API 错误 ${res.status}: ${errText}`);
            return `[DeepSeek] API 请求失败 (${res.status})`;
        }

        const data = await res.json();
        const reply = data.choices?.[0]?.message?.content;
        return reply || '[DeepSeek] 空响应';
    } catch (err) {
        console.error('[DeepSeek] 请求异常:', err.message);
        return `[DeepSeek] 请求异常: ${err.message}`;
    }
}

// 调用小米 MiMo API
async function queryMiMo(userMessage, systemPrompt, aiCfg) {
    const { mimoApiKey, MIMO_API_URL, MIMO_MODEL } = aiCfg;
    if (!mimoApiKey) {
        return '[MiMo] 未在 config.json 中设置 mimo.api_key，无法调用 AI';
    }

    try {
        const res = await fetch(MIMO_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${mimoApiKey}`,
            },
            body: JSON.stringify({
                model: MIMO_MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userMessage },
                ],
                max_tokens: 1024,
                temperature: 0.7,
            }),
        });

        if (!res.ok) {
            const errText = await res.text();
            console.error(`[MiMo] API 错误 ${res.status}: ${errText}`);
            return `[MiMo] API 请求失败 (${res.status})`;
        }

        const data = await res.json();
        const reply = data.choices?.[0]?.message?.content;
        return reply || '[MiMo] 空响应';
    } catch (err) {
        console.error('[MiMo] 请求异常:', err.message);
        return `[MiMo] 请求异常: ${err.message}`;
    }
}

// ========== Bot 实例工厂 ==========

function createBotInstance(config, options = {}) {
    // ---- 解构配置 ----
    const {
        name: botName,
        host,
        port,
        username,
        password,
        version,
        ai_provider: aiProvider,
        system_prompt: systemPrompt,
        trusted_players: trustedPlayers,
        queue_delay: initialQueueDelay,
        max_msg_len: maxMsgLen,
        auto_menu: autoMenu,
        auto_login: autoLogin,
        tp_reply: tpReply,
    } = config;

    // 持久化 trusted_players 的配置路径（由主入口传入）
    const configPath = options.configPath;
    const rootConfig = options.rootConfig;
    const botRegistry = options.botRegistry;
    const saveBotsConfig = options.saveBotsConfig;
    const spawnBotFromConfig = options.spawnBotFromConfig;
    const aiCfg = options.aiCfg || {};

    // 保存 trusted_players 到 config.json
    function saveTrustedPlayers() {
        if (!configPath || !rootConfig) return;
        try {
            rootConfig.defaults.trusted_players = trustedPlayers;
            fs.writeFileSync(configPath, JSON.stringify(rootConfig, null, 2));
        } catch (err) {
            console.error(`${PREFIX} [信任] 保存配置失败:`, err.message);
        }
    }

    const PREFIX = `[${botName}]`;

    // ---- 统一 AI 调用入口（根据 bot 配置的 ai_provider 路由） ----
    function queryAI(userMessage) {
        if (aiProvider === 'mimo') {
            return queryMiMo(userMessage, systemPrompt, aiCfg);
        }
        return queryDeepSeek(userMessage, systemPrompt, aiCfg);
    }

    // ---- 创建 Bot ----
    const bot = mineflayer.createBot({
        host,
        port,
        username,
        version,
        skipValidation: true,
    });

    // ---- 调试日志：监听所有关键事件 ----
    const events = [
        'whisper', 'windowOpen',
        'login', 'connect', 'end', 'error', 'kicked',
        'death', 'respawn',
        'rain',
    ];

    let spawnCount = 0;
    bot.on('login', () => {
        console.log(`${PREFIX} [协议] 版本: ${bot.version}，协议号: ${bot.protocolVersion}`);
    });
    bot.on('spawn', () => {
        spawnCount++;
        console.log(`${PREFIX} [重生] 第 ${spawnCount} 次 spawn（menuDone=${menuDone}）`);
    });

    events.forEach(eventName => {
        bot.on(eventName, (...args) => {
            const timestamp = new Date().toISOString().slice(11, 19);
            const safeArgs = args.map(a => {
                if (typeof a === 'string' && a.length > 200) return a.slice(0, 200) + '...';
                if (typeof a === 'object' && a !== null) {
                    try {
                        return JSON.stringify(a).slice(0, 200);
                    } catch (e) {
                        return `[${a.constructor?.name || 'Object'}]`;
                    }
                }
                return a;
            });
            console.log(`${PREFIX} [DEBUG ${timestamp}] 事件: ${eventName}`, ...safeArgs);
        });
    });

    // ========== 消息队列（防止发言过快被踢） ==========
    const messageQueue = [];
    let queueProcessing = false;
    let queueDelay = initialQueueDelay;

    function processQueue() {
        if (messageQueue.length === 0) {
            queueProcessing = false;
            return;
        }
        queueProcessing = true;
        const item = messageQueue.shift();
        if (item.type === 'whisper') {
            console.log(`${PREFIX} [队列-私聊] → ${item.target}: ${item.message}`);
            bot.whisper(item.target, item.message);
        } else if (item.type === 'qq') {
            const qqMsg = item.message.replace(/\s+/g, '');
            console.log(`${PREFIX} [队列-QQ] → ${qqMsg}`);
            bot.chat(`/q ${qqMsg}`);
        } else {
            console.log(`${PREFIX} [队列-公聊] → ${item.message}`);
            bot.chat(item.message);
        }
        setTimeout(() => processQueue(), queueDelay);
    }

    // ---- 长文本拆分（优先在标点处断句） ----
    function splitByLength(text) {
        if (text.length <= maxMsgLen) return [text];
        const chunks = [];
        let remaining = text;
        while (remaining.length > maxMsgLen) {
            let cutAt = maxMsgLen;
            const slice = remaining.slice(0, maxMsgLen);
            for (const sep of ['。', '！', '？', '.', '!', '?', '\n']) {
                const pos = slice.lastIndexOf(sep);
                if (pos > maxMsgLen / 2) { cutAt = pos + 1; break; }
            }
            if (cutAt === maxMsgLen) {
                for (const sep of ['，', '、', '；', ',', ';']) {
                    const pos = slice.lastIndexOf(sep);
                    if (pos > maxMsgLen / 2) { cutAt = pos + 1; break; }
                }
            }
            chunks.push(remaining.slice(0, cutAt).trim());
            remaining = remaining.slice(cutAt).trim();
        }
        if (remaining) chunks.push(remaining);
        return chunks;
    }

    function safeChat(message) {
        const lines = message.split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            for (const chunk of splitByLength(line.trim())) {
                if (chunk) messageQueue.push({ type: 'chat', message: chunk });
            }
        }
        if (!queueProcessing) {
            processQueue();
        }
    }

    function safeWhisper(target, message) {
        const lines = message.split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            for (const chunk of splitByLength(line.trim())) {
                if (chunk) messageQueue.push({ type: 'whisper', target, message: chunk });
            }
        }
        if (!queueProcessing) {
            processQueue();
        }
    }

    // ========== QQ群消息AI回复 ==========

    function escapeRegex(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function extractQQPrompt(qqMsg, targetBotName) {
        let match = qqMsg.match(new RegExp(`@${escapeRegex(targetBotName)}\\s*(.+)$`));
        if (match && match[1].trim()) return match[1].trim();
        if (new RegExp(`@${escapeRegex(targetBotName)}`).test(qqMsg)) {
            return qqMsg.replace(new RegExp(`@${escapeRegex(targetBotName)}\\s*`, 'g'), '').trim();
        }

        match = qqMsg.match(new RegExp(`>>${escapeRegex(targetBotName)}\\s*(.+)$`));
        if (match && match[1].trim()) return match[1].trim();
        if (new RegExp(`>>${escapeRegex(targetBotName)}`).test(qqMsg)) {
            return qqMsg.replace(new RegExp(`>>${escapeRegex(targetBotName)}\\s*`, 'g'), '').trim();
        }

        return null;
    }

    function sendQQReply(message) {
        messageQueue.push({ type: 'qq', message });
        if (!queueProcessing) {
            processQueue();
        }
    }

    // ========== 远程命令执行 ==========
    function formatItemName(item) {
        if (!item) return '(空)';
        const baseName = item.customName
            ? (typeof item.customName === 'string' ? item.customName : JSON.stringify(item.customName))
            : (item.displayName
                ? (typeof item.displayName === 'string' ? item.displayName : JSON.stringify(item.displayName))
                : (item.name || '(未知)'));
        return baseName;
    }

    let cmdCapture = null;
    let menuDone = false;
    let menuSearch = null;
    let pendingConfirm = null;

    // ---- 命令输出捕获 ----
    function flushCmdCapture() {
        if (!cmdCapture) return;
        const { target, type, messages } = cmdCapture;
        cmdCapture = null;

        if (messages.length > 0) {
            const filtered = [...new Set(messages)].filter(m => {
                if (m.includes('/login')) return false;
                if (m.includes('你还要再等') && m.includes('秒才能再次发送跨服消息')) return false;
                return true;
            });
            if (filtered.length > 0) {
                const reply = `[命令结果]\n${filtered.join('\n')}`;
                if (type === 'qq_at') sendQQReply(reply);
                else safeWhisper(target, reply);
            } else {
                const reply = '[命令结果] (无有效输出)';
                if (type === 'qq_at') sendQQReply(reply);
                else safeWhisper(target, reply);
            }
        } else {
            const reply = '[命令结果] (无输出)';
            if (type === 'qq_at') sendQQReply(reply);
            else safeWhisper(target, reply);
        }
    }

    // ========== 菜单窗口自动化 ==========
    bot.on('windowOpen', (window) => {
        console.log(`${PREFIX} [菜单] 窗口打开 [类型=${window.type}, 槽位数=${window.slots.length}]`);

        if (menuSearch) {
            setTimeout(() => searchMenu(window), 500);
            return;
        }

        if (menuDone) {
            console.log(`${PREFIX} [菜单] 已完成菜单选择，跳过`);
            return;
        }

        setTimeout(() => {
            clickMenu(window);
        }, 500);
    });

    function searchMenu(window) {
        const { player, keyword } = menuSearch;
        menuSearch = null;

        const endSlot = window.inventoryStart ?? window.slots.length;
        const lowerKw = keyword.toLowerCase();
        let found = null;

        for (let slot = 0; slot < endSlot; slot++) {
            const item = window.slots[slot];
            if (!item || !item.name) continue;

            const itemName = item.name || '';
            const displayName = item.displayName ? (typeof item.displayName === 'string' ? item.displayName : JSON.stringify(item.displayName)) : '';
            const customName = item.customName ? (typeof item.customName === 'string' ? item.customName : JSON.stringify(item.customName)) : '';

            if (itemName.toLowerCase().includes(lowerKw) ||
                displayName.toLowerCase().includes(lowerKw) ||
                customName.toLowerCase().includes(lowerKw)) {

                found = { slot, name: itemName, displayName: displayName || customName };
                break;
            }
        }

        if (found) {
            console.log(`${PREFIX} [搜索] 找到匹配: 栏位${found.slot} ${found.name} [${found.displayName}]`);

            clearPendingConfirm();
            pendingConfirm = {
                player,
                slot: found.slot,
                windowId: window.id,
                window: window,
                itemName: found.displayName || found.name,
                timer: setTimeout(() => {
                    safeWhisper(player, '[搜索] 确认超时，已取消');
                    try { bot.closeWindow(bot.currentWindow); } catch (e) {}
                    pendingConfirm = null;
                }, 30000),
            };

            safeWhisper(player, `[搜索] 找到: ${found.displayName || found.name} (栏位${found.slot})，回复 /confirm 确认点击`);
        } else {
            safeWhisper(player, `[搜索] 未找到包含 "${keyword}" 的物品`);
            setTimeout(() => {
                try { bot.closeWindow(window); } catch (e) {}
            }, 200);
        }
    }

    function clearPendingConfirm() {
        if (pendingConfirm) {
            clearTimeout(pendingConfirm.timer);
            pendingConfirm = null;
        }
    }

    let menuItems = [];

    function clickMenu(window) {
        const endSlot = window.inventoryStart ?? window.slots.length;
        menuItems = [];

        for (let slot = 0; slot < endSlot; slot++) {
            const item = window.slots[slot];
            if (item && item.name) {
                menuItems.push({ slot, name: item.name, count: item.count, displayName: item.displayName || item.customName });
                console.log(`${PREFIX} [菜单] 栏位 ${slot}: ${item.name} x${item.count} ${item.displayName ? '[' + JSON.stringify(item.displayName) + ']' : ''}`);
            }
        }

        const target = menuItems[1] || menuItems[0];

        if (target) {
            console.log(`${PREFIX} [菜单] 点击栏位 ${target.slot}: ${target.name}`);
            menuDone = true;

            if (bot.activateItemInterval) {
                clearInterval(bot.activateItemInterval);
                bot.activateItemInterval = null;
            }

            const originalWrite = bot._client.write.bind(bot._client);
            bot.clickWindow(target.slot, 0, 0);

            const BLOCK_LIST = ['use_item', 'arm_animation'];

            bot._client.write = function (name, params) {
                if (BLOCK_LIST.includes(name)) {
                    console.log(`${PREFIX} [阻断] 已拦截: ${name}`);
                } else {
                    originalWrite(name, params);
                }
            };

            setTimeout(() => {
                bot._client.write = originalWrite;
                console.log(`${PREFIX} [菜单] 超时未传送，恢复发包`);
            }, 5000);
        } else {
            console.log(`${PREFIX} [菜单] 菜单中没有物品，列出所有栏位:`);
            for (let slot = 0; slot < endSlot; slot++) {
                const item = window.slots[slot];
                console.log(`  [${slot}] ${item ? item.name || '(空物品)' : '(空)'}`);
            }
            menuDone = true;
        }
    }

    // ========== BungeeCord 跨服传送处理 ==========
    if (bot._client) {
        bot._client.on('transfer', (host, port) => {
            console.log(`${PREFIX} [传送] 收到跨服传送: ${host}:${port}`);
        });
    }

    // ========== 断线处理 ==========

    bot.on('kicked', (reason) => {
        const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason);
        console.log(`${PREFIX} [断开] 被踢出:`, reasonStr);
    });

    bot.on('end', (reason) => {
        console.log(`${PREFIX} [断开] 连接断开: ${reason}`);
        if (options.botRegistry) {
            options.botRegistry.delete((username || '').toLowerCase());
        }
    });

    bot.on('error', (err) => {
        console.error(`${PREFIX} [错误]`, err.message);
    });

    // ========== messagestr 事件（核心消息处理） ==========
    bot.on('messagestr', (message) => {
        const isSelfEcho = message.startsWith('<') && message.includes(bot.username);

        if (!isSelfEcho) {
            console.log(`${PREFIX} [服务器] ${message}`);
        }

        // QQ群消息 — 通过 dispatch 分发（支持命令与 AI 对话）
        const qqGroupMatch = message.match(/^【QQ群消息】(.+?)\s*\((.+?)\)\s*:\s*(.+)$/);
        if (qqGroupMatch && !isSelfEcho) {
            const qqSender = qqGroupMatch[1].trim();
            const qqDisplayName = qqGroupMatch[2].trim();
            const qqMsg = qqGroupMatch[3].trim();

            if (qqSender.toLowerCase() !== bot.username.toLowerCase()) {
                const triggerPrompt = extractQQPrompt(qqMsg, bot.username);
                if (triggerPrompt) {
                    const isTrusted = trustedPlayers.includes(qqSender);
                    const ctx = createMessageContext('qq_at', TRIGGER.QQ_AT, qqSender, triggerPrompt, isTrusted);
                    console.log(`${PREFIX} [QQ] ${qqDisplayName}(${qqSender}): ${triggerPrompt}`);
                    dispatchMessage(ctx);
                }
            }
        }

        // 私聊兜底检测 — 通过 dispatch 分发
        let whisperMatch = message.match(/\[(.+?)\s*(?:->|→)\s*我\]\s*(.+)/);
        if (!whisperMatch) {
            whisperMatch = message.match(/(\S+)\s+(?:悄悄地对你说|→ 你|私聊)[：:]\s*(.+)/);
        }
        if (whisperMatch && !isSelfEcho) {
            const [_, sender, msg] = whisperMatch;
            console.log(`${PREFIX} [私聊-兜底] ${sender}: ${msg}`);
            const isTrusted = trustedPlayers.includes(sender.trim());
            const ctx = createMessageContext('whisper', TRIGGER.WHISPER, sender.trim(), msg.trim(), isTrusted);
            dispatchMessage(ctx);
        }

        // ========== 传送请求检测与私聊回复 ==========
        const tpMatch = message.match(/(\S+)\s*请求(?:传送|你传送)到(?:你这里|他那里)/);
        if (tpMatch && !isSelfEcho) {
            const tpSender = tpMatch[1].trim();
            if (tpReply) {
                safeWhisper(tpSender, tpReply);
                console.log(`${PREFIX} [传送] 检测到 ${tpSender} 的传送请求，已回复私聊`);
            }
        }

        // 命令输出捕获
        if (cmdCapture && !isSelfEcho) {
            clearTimeout(cmdCapture.timer);
            cmdCapture.messages.push(message);
            cmdCapture.timer = setTimeout(flushCmdCapture, 1000);
        }

        // 登录检测
        if (autoLogin && message.includes('/login') && password) {
            safeChat(`/login ${password}`);
            console.log(`${PREFIX} 已发送登录指令`);
        }

        // 跨服消息频率限制
        if (message.includes('你还要再等') && message.includes('秒才能再次发送跨服消息')) {
            queueDelay = Math.max(queueDelay, 2000);
            console.log(`${PREFIX} [限速] 检测到频率限制，消息间隔调整为 ${queueDelay}ms`);
        }
    });

    // ========== 机器人 spawn 行为 ==========
    bot.on('spawn', () => {
        console.log(`${PREFIX} 进入游戏 (第 ${spawnCount} 次 spawn)，开始挂机`);

        if (!bot.activateItemInterval) {
            bot.activateItemInterval = setInterval(() => bot.activateItem(), 50);
        }

        if (spawnCount === 1 && !menuDone && autoMenu) {
            setTimeout(() => {
                console.log(`${PREFIX} [菜单] 自动发送 /menu 打开服务器菜单...`);
                safeChat('/menu');
            }, 3000);
        } else if (spawnCount > 1) {
            console.log(`${PREFIX} [重生] 第 ${spawnCount} 次 spawn，跳过菜单（已在生存服）`);
        }
    });

    // ========== 命令注册系统 ==========

    // 触发条件（位掩码，可用 | 组合）
    const TRIGGER = {
        CHAT:    1 << 0,  // 公聊直接发送（无 @/>> 前缀，不带 /，因为 / 会被客户端拦截）
        WHISPER: 1 << 1,  // 私聊
        MENTION: 1 << 2,  // 公聊 @botname
        REPLY:   1 << 3,  // 公聊 >>botname
        QQ_AT:   1 << 4,  // QQ群 @botname
        WEB:     1 << 5,  // Web 管理面板
    };

    const TARGET = {
        ALL:     'all',
        TRUSTED: 'trusted',
    };

    const commandRegistry = [];

    // 注册命令：cmd(名称, 匹配前缀数组, 触发条件, 触发对象, 帮助文本, 处理函数)
    // handler 签名: async (ctx, args) — ctx 为消息上下文，args 为命令参数
    function cmd(name, patterns, triggers, target, help, handler) {
        commandRegistry.push({ name, patterns, triggers, target, help, handler });
    }

    // 查找匹配的命令（最长前缀匹配，确保 /trust add 优先于 /trust）
    function findCommand(content) {
        let best = null, bestLen = 0;
        for (const def of commandRegistry) {
            for (const pat of def.patterns) {
                if (content === pat || content.startsWith(pat + ' ')) {
                    if (pat.length > bestLen) {
                        best = { def, args: content === pat ? '' : content.slice(pat.length + 1).trim() };
                        bestLen = pat.length;
                    }
                }
            }
        }
        return best;
    }

    // ========== 消息上下文 ==========

    function createMessageContext(type, triggerFlag, sender, content, isTrusted) {
        return {
            type,          // 'chat' | 'whisper' | 'mention' | 'reply' | 'qq_at' | 'web'
            triggerFlag,   // 匹配的 TRIGGER 位
            sender,        // 发送者用户名
            content,       // 清洗后的消息内容（不含 @botname / >>botname 等前缀）
            isTrusted,     // 是否为可信玩家
            // 根据消息类型原路返回
            reply(text) {
                if (type === 'whisper') safeWhisper(sender, text);
                else if (type === 'qq_at') sendQQReply(text);
                else if (type === 'web') {
                    // Web 端回复：存入 bot._webReply 供 API 读取，同时输出到控制台
                    if (!bot._webReply) bot._webReply = [];
                    bot._webReply.push(text);
                    console.log(`${PREFIX} [Web回复] ${text}`);
                }
                else safeChat(text); // chat / mention / reply → 公聊
            },
        };
    }

    // ========== AI 对话处理 ==========

    async function handleAIChat(ctx) {
        const prompt = ctx.content.trim();
        if (!prompt) return;

        console.log(`${PREFIX} [AI-${aiProvider}] ${ctx.sender} (${ctx.type}): ${prompt}`);
        const reply = await queryAI(prompt);
        console.log(`${PREFIX} [AI-${aiProvider}] 回复: ${reply}`);
        ctx.reply(`[AI] ${reply}`);
    }

    // ========== 远程命令转发（兜底） ==========

    function executeRemoteCommand(ctx) {
        console.log(`${PREFIX} [命令] ${ctx.sender} 执行: ${ctx.content}`);
        cmdCapture = {
            target: ctx.sender,
            type: ctx.type,
            messages: [],
            timer: setTimeout(flushCmdCapture, 1500),
        };
        safeChat(ctx.content);
    }

    // ========== 命令分发 ==========

    async function dispatchMessage(ctx) {
        const content = ctx.content.trim();

        // 尝试匹配已注册命令（支持 /xxx 和纯文本如 ping、v50）
        const match = findCommand(content);
        if (match) {
            const { def, args } = match;

            // 检查触发条件（位掩码匹配）
            if (!(def.triggers & ctx.triggerFlag)) {
                if (ctx.type === 'whisper') {
                    ctx.reply(`[命令] ${def.name} 不支持在此方式下使用`);
                }
                return;
            }

            // 检查触发对象
            if (def.target === TARGET.TRUSTED && !ctx.isTrusted) {
                ctx.reply('[权限] 你没有权限使用此命令');
                return;
            }

            // 执行命令
            try {
                console.log(`${PREFIX} [命令] ${ctx.sender} → ${def.name} ${args || ''}`);
                await def.handler(ctx, args);
            } catch (err) {
                console.error(`${PREFIX} [命令错误] ${def.name}:`, err.message);
                ctx.reply(`[错误] 命令执行失败: ${err.message}`);
            }
            return;
        }

        // 未匹配的 / 命令：可信玩家（私聊 / QQ群@）→ 远程命令转发（兜底）
        if (content.startsWith('/')) {
            if (ctx.isTrusted && (ctx.type === 'whisper' || ctx.type === 'qq_at')) {
                executeRemoteCommand(ctx);
                return;
            } else if (ctx.type === 'whisper' || ctx.type === 'qq_at') {
                ctx.reply(`[命令] 未知命令: ${content.split(' ')[0]}。输入 /help 查看帮助`);
            }
            return;
        }

        // 无 / 的非命令消息 → AI 对话
        // 公聊无提及的消息不触发 AI（避免噪声）
        if (ctx.type === 'chat') return;

        // 私聊 / @提及 / >>回复 / QQ群@ → 一律进入 AI 对话
        await handleAIChat(ctx);
    }

    // ================================================================
    //  命令定义（按类别分组）
    // ================================================================

    // ---- 公共命令（所有人可用） ----

    cmd('/ping', ['/ping', 'ping'],
        TRIGGER.WEB | TRIGGER.CHAT | TRIGGER.WHISPER | TRIGGER.MENTION | TRIGGER.REPLY | TRIGGER.QQ_AT,
        TARGET.ALL,
        '/ping — 测试机器人是否在线',
        (ctx) => { ctx.reply('pong!'); });

    cmd('/v50', ['/v50', 'v50'],
        TRIGGER.WEB | TRIGGER.CHAT | TRIGGER.WHISPER | TRIGGER.MENTION | TRIGGER.REPLY | TRIGGER.QQ_AT,
        TARGET.ALL,
        '/v50 — 疯狂星期四文案',
        async (ctx) => {
            try {
                const res = await fetch('https://api.shadiao.pro/kfc');
                const data = await res.json();
                const text = data?.data?.text;
                ctx.reply(text ? `[疯狂星期四] ${text.replace(/\r?\n/g, ' ').trim()}` : '今天不是疯狂星期四，但你可以 V 我 50！');
            } catch (err) {
                console.error(`${PREFIX} KFC API 请求失败:`, err);
                ctx.reply('疯狂星期四文案获取失败，但 V 我 50 的心是真的！');
            }
        });

    // ---- 帮助（自动生成） ----

    cmd('/help', ['/help'],
        TRIGGER.WHISPER | TRIGGER.MENTION | TRIGGER.REPLY | TRIGGER.QQ_AT | TRIGGER.WEB,
        TARGET.TRUSTED,
        '/help — 显示此帮助',
        (ctx) => {
            const lines = [`[帮助] 可用指令 (${commandRegistry.length} 个):`];
            for (const c of commandRegistry) {
                if (!c.help) continue;
                // 将 "/cmd [args] — desc" 转为 "[cmd args] desc"，避免公聊中以 / 开头被当作服务器指令
                const sepIdx = c.help.search(/\s+[—\-]\s+/);
                if (sepIdx !== -1) {
                    const cmdPart = c.help.slice(1, sepIdx).trim(); // 去掉开头的 /
                    const descPart = c.help.slice(sepIdx).replace(/^\s+[—\-]\s+/, '').trim();
                    lines.push(`[${cmdPart}] ${descPart}`);
                } else {
                    lines.push(c.help);
                }
            }
            ctx.reply(lines.join('\n'));
        });

    // ---- 物品栏 / 快捷栏 ----

    cmd('/inv', ['/inv', '/inventory'],
        TRIGGER.WHISPER | TRIGGER.WEB | TRIGGER.QQ_AT,
        TARGET.TRUSTED,
        '/inv — 查看物品栏',
        (ctx) => {
            const items = bot.inventory.items();
            if (items.length === 0) { ctx.reply('[物品栏] 物品栏为空'); return; }
            const hotbarSlot = bot.quickBarSlot;
            const lines = items.map(item => {
                const name = formatItemName(item);
                const slot = item.slot;
                const isHotbar = slot >= 36 && slot <= 44;
                const marker = isHotbar ? (slot - 36 === hotbarSlot ? ' [当前手持]' : ' [快捷栏]') : '';
                return `栏${slot} ${name} x${item.count}${marker}`;
            });
            ctx.reply(`[物品栏] 共 ${items.length} 种物品:\n${lines.join('\n')}`);
        });

    cmd('/hotbar', ['/hotbar'],
        TRIGGER.WEB | TRIGGER.WHISPER,
        TARGET.TRUSTED,
        '/hotbar <1-9> — 切换快捷栏',
        (ctx, args) => {
            const slot = parseInt(args);
            if (isNaN(slot) || slot < 1 || slot > 9) { ctx.reply('[切换] 用法: /hotbar <1-9>'); return; }
            bot.setQuickBarSlot(slot - 1);
            ctx.reply(`[切换] 已切换到快捷栏 ${slot}: ${formatItemName(bot.heldItem)}`);
        });

    // ---- 物品操作 ----

    cmd('/drop', ['/drop'],
        TRIGGER.WEB | TRIGGER.WHISPER,
        TARGET.TRUSTED,
        '/drop <物品名> [数量] — 丢弃物品',
        async (ctx, args) => {
            const parts = args.split(' ');
            const countStr = parts[parts.length - 1];
            const isCount = /^\d+$/.test(countStr);
            const count = isCount ? parseInt(countStr) : 1;
            const nameParts = isCount ? parts.slice(0, -1) : parts;
            const itemName = nameParts.join(' ').toLowerCase();

            const item = bot.inventory.items().find(it =>
                it.name?.toLowerCase().includes(itemName) ||
                formatItemName(it).toLowerCase().includes(itemName)
            );
            if (!item) { ctx.reply(`[丢弃] 物品栏中没有找到 "${nameParts.join(' ')}"`); return; }
            try {
                await bot.toss(item.type, null, Math.min(count, item.count));
                ctx.reply(`[丢弃] 已丢弃 ${formatItemName(item)} x${Math.min(count, item.count)}`);
            } catch (err) {
                ctx.reply(`[丢弃] 失败: ${err.message}`);
            }
        });

    cmd('/dropstack', ['/dropstack'],
        TRIGGER.WEB | TRIGGER.WHISPER,
        TARGET.TRUSTED,
        '/dropstack — 丢弃手中整组物品',
        async (ctx) => {
            if (!bot.heldItem) { ctx.reply('[丢弃] 手中没有物品'); return; }
            try {
                const itemName = formatItemName(bot.heldItem);
                await bot.tossStack(bot.heldItem);
                ctx.reply(`[丢弃] 已丢弃整组: ${itemName}`);
            } catch (err) {
                ctx.reply(`[丢弃] 失败: ${err.message}`);
            }
        });

    cmd('/equip', ['/equip'],
        TRIGGER.WEB | TRIGGER.WHISPER,
        TARGET.TRUSTED,
        '/equip <物品名> — 装备物品到手中',
        async (ctx, args) => {
            const equipName = args.toLowerCase();
            const item = bot.inventory.items().find(it =>
                it.name?.toLowerCase().includes(equipName) ||
                formatItemName(it).toLowerCase().includes(equipName)
            );
            if (!item) { ctx.reply(`[装备] 物品栏中没有找到 "${args}"`); return; }
            try {
                await bot.equip(item, 'hand');
                ctx.reply(`[装备] 已装备: ${formatItemName(item)}`);
            } catch (err) {
                ctx.reply(`[装备] 失败: ${err.message}`);
            }
        });

    // ---- 攻击 ----

    cmd('/attack', ['/attack'],
        TRIGGER.WEB | TRIGGER.WHISPER,
        TARGET.TRUSTED,
        '/attack [实体名] — 攻击最近实体（不填则攻击敌对生物）',
        (ctx, args) => {
            let target;
            if (args) {
                const targetName = args.toLowerCase();
                target = bot.nearestEntity(e => e.name && e.name.toLowerCase().includes(targetName));
                if (!target) { ctx.reply(`[攻击] 附近没有找到 "${args}"`); return; }
            } else {
                target = bot.nearestEntity(e => e.kind === 'hostile');
                if (!target) { ctx.reply('[攻击] 附近没有敌对生物'); return; }
            }
            try {
                bot.attack(target);
                ctx.reply(`[攻击] 正在攻击: ${target.displayName || target.name}${target.username ? ' (' + target.username + ')' : ''}`);
            } catch (err) {
                ctx.reply(`[攻击] 失败: ${err.message}`);
            }
        });

    // ---- 物品使用 ----

    cmd('/use', ['/use'],
        TRIGGER.WEB | TRIGGER.WHISPER,
        TARGET.TRUSTED,
        '/use — 使用手中物品（单次）',
        (ctx) => {
            if (!bot.heldItem) { ctx.reply('[使用] 手中没有物品'); return; }
            bot.activateItem();
            setTimeout(() => { if (bot.usingHeldItem) bot.deactivateItem(); }, 100);
            ctx.reply(`[使用] 已使用: ${formatItemName(bot.heldItem)}`);
        });

    cmd('/use hold', ['/use hold'],
        TRIGGER.WEB | TRIGGER.WHISPER,
        TARGET.TRUSTED,
        '/use hold — 开始持续右键',
        (ctx) => {
            if (bot.activateItemInterval) clearInterval(bot.activateItemInterval);
            bot.activateItemInterval = setInterval(() => bot.activateItem(), 50);
            ctx.reply('[使用] 已开始持续右键');
        });

    cmd('/use stop', ['/use stop'],
        TRIGGER.WEB | TRIGGER.WHISPER,
        TARGET.TRUSTED,
        '/use stop — 停止持续右键',
        (ctx) => {
            if (bot.activateItemInterval) {
                clearInterval(bot.activateItemInterval);
                bot.activateItemInterval = null;
                ctx.reply('[使用] 已停止持续右键');
            } else {
                ctx.reply('[使用] 当前未在持续右键');
            }
        });

    // ---- 信息查询 ----

    cmd('/nearby', ['/nearby'],
        TRIGGER.MENTION | TRIGGER.WEB | TRIGGER.WHISPER | TRIGGER.QQ_AT,
        TARGET.TRUSTED,
        '/nearby — 查看附近实体（玩家 & 生物）',
        (ctx) => {
            const pos = bot.entity?.position;
            if (!pos) { ctx.reply('[附近] 机器人尚未完全加载'); return; }
            const lines = [];

            const players = Object.values(bot.players).filter(p => p.entity && p.username !== bot.username);
            if (players.length > 0) {
                lines.push('=== 玩家 ===');
                players.forEach(p => {
                    const dist = Math.round(pos.distanceTo(p.entity.position) * 10) / 10;
                    lines.push(`${p.username} (${dist}m)`);
                });
            }

            const mobs = Object.values(bot.entities).filter(e =>
                e.type === 'mob' && e.name && e.position && pos.distanceTo(e.position) <= 30
            ).sort((a, b) => pos.distanceTo(a.position) - pos.distanceTo(b.position)).slice(0, 20);

            if (mobs.length > 0) {
                lines.push('=== 生物 ===');
                mobs.forEach(e => {
                    const dist = Math.round(pos.distanceTo(e.position) * 10) / 10;
                    const health = e.health !== undefined ? ` ❤${Math.round(e.health)}` : '';
                    const name = e.displayName || e.name || '(未知)';
                    lines.push(`${name} (${dist}m)${health}`);
                });
            }

            ctx.reply(lines.length === 0 ? '[附近] 附近没有实体' : `[附近]\n${lines.join('\n')}`);
        });

    // ---- 菜单操作 ----

    cmd('/menu', ['/menu'],
        TRIGGER.WEB | TRIGGER.WHISPER,
        TARGET.TRUSTED,
        '/menu [关键词] — 打开菜单或搜索物品',
        (ctx, args) => {
            if (args) {
                // 交互式菜单搜索
                console.log(`${PREFIX} [搜索] ${ctx.sender} 搜索菜单: "${args}"`);
                clearPendingConfirm();
                menuSearch = { player: ctx.sender, keyword: args };
                safeChat('/menu');
            } else {
                // 手动打开菜单
                menuDone = false;
                safeChat('/menu');
                ctx.reply('已发送 /menu');
            }
        });

    cmd('/confirm', ['/confirm'],
        TRIGGER.WEB | TRIGGER.WHISPER,
        TARGET.TRUSTED,
        '/confirm — 确认菜单搜索点击',
        (ctx) => {
            if (!pendingConfirm || pendingConfirm.player !== ctx.sender) {
                ctx.reply('[搜索] 没有待确认的操作');
                return;
            }
            const pc = pendingConfirm;
            clearPendingConfirm();
            console.log(`${PREFIX} [搜索] ${ctx.sender} 确认点击栏位 ${pc.slot}: ${pc.itemName}`);

            if (bot.activateItemInterval) {
                clearInterval(bot.activateItemInterval);
                bot.activateItemInterval = null;
            }

            const originalWrite = bot._client.write.bind(bot._client);
            bot.clickWindow(pc.slot, 0, 0);

            bot._client.write = function (name, params) {
                if (name === 'use_item' || name === 'arm_animation') {
                    console.log(`${PREFIX} [阻断] 已拦截: ${name}`);
                } else {
                    originalWrite(name, params);
                }
            };
            setTimeout(() => { bot._client.write = originalWrite; }, 5000);

            ctx.reply(`[搜索] 已点击 ${pc.itemName}`);
        });

    // ---- 信任玩家管理 ----

    cmd('/trust', ['/trust', '/trust list'],
        TRIGGER.MENTION | TRIGGER.WEB | TRIGGER.WHISPER | TRIGGER.QQ_AT,
        TARGET.TRUSTED,
        '/trust [list] — 查看信任玩家列表',
        (ctx) => {
            if (trustedPlayers.length === 0) {
                ctx.reply('[信任] 当前无信任玩家');
            } else {
                ctx.reply(`[信任] 信任玩家列表 (${trustedPlayers.length}人):\n${trustedPlayers.join('\n')}`);
            }
        });

    cmd('/trust add', ['/trust add'],
        TRIGGER.MENTION | TRIGGER.WEB | TRIGGER.WHISPER | TRIGGER.QQ_AT,
        TARGET.TRUSTED,
        '/trust add <玩家名> — 添加信任玩家',
        (ctx, args) => {
            const targetPlayer = args.trim();
            if (!targetPlayer) { ctx.reply('[信任] 用法: /trust add <玩家名>'); return; }
            if (trustedPlayers.includes(targetPlayer)) {
                ctx.reply(`[信任] ${targetPlayer} 已在信任列表中`);
                return;
            }
            trustedPlayers.push(targetPlayer);
            saveTrustedPlayers();
            ctx.reply(`[信任] 已添加 ${targetPlayer} 到信任列表`);
            console.log(`${PREFIX} [信任] ${ctx.sender} 添加了 ${targetPlayer}`);
        });

    cmd('/trust remove', ['/trust remove'],
        TRIGGER.MENTION | TRIGGER.WEB | TRIGGER.WHISPER | TRIGGER.QQ_AT,
        TARGET.TRUSTED,
        '/trust remove <玩家名> — 移除信任玩家',
        (ctx, args) => {
            const targetPlayer = args.trim();
            if (!targetPlayer) { ctx.reply('[信任] 用法: /trust remove <玩家名>'); return; }
            const idx = trustedPlayers.indexOf(targetPlayer);
            if (idx === -1) { ctx.reply(`[信任] ${targetPlayer} 不在信任列表中`); return; }
            trustedPlayers.splice(idx, 1);
            saveTrustedPlayers();
            ctx.reply(`[信任] 已从信任列表移除 ${targetPlayer}`);
            console.log(`${PREFIX} [信任] ${ctx.sender} 移除了 ${targetPlayer}`);
        });

    // ---- 机器人管理 ----

    cmd('/bot add', ['/bot add'],
        TRIGGER.WEB | TRIGGER.WHISPER,
        TARGET.TRUSTED,
        '/bot add <用户名> <密码> — 添加机器人（默认不启动）',
        (ctx, args) => {
            const parts = args.trim().split(/\s+/);
            if (parts.length < 2) { ctx.reply('[Bot管理] 用法: /bot add <用户名> <密码>'); return; }
            const newUsername = parts[0];
            const newPassword = parts.slice(1).join(' ');
            const lowerUser = newUsername.toLowerCase();

            const existing = (rootConfig && rootConfig.bots || []).find(b => (b.username || '').toLowerCase() === lowerUser);
            if (existing) { ctx.reply(`[Bot管理] 机器人 ${newUsername} 已在配置中`); return; }

            const newBot = {
                name: newUsername, host, port, username: newUsername,
                password: newPassword, ai_provider: aiProvider, enabled: false,
            };
            if (rootConfig && rootConfig.bots) rootConfig.bots.push(newBot);
            if (saveBotsConfig) saveBotsConfig();
            ctx.reply(`[Bot管理] 已添加机器人 ${newUsername}（默认不启动）。使用 /bot spawn ${newUsername} 上线`);
            console.log(`${PREFIX} [Bot管理] ${ctx.sender} 添加了机器人 ${newUsername}`);
        });

    cmd('/bot del', ['/bot del'],
        TRIGGER.WEB | TRIGGER.WHISPER,
        TARGET.TRUSTED,
        '/bot del <用户名> — 移除机器人',
        (ctx, args) => {
            const targetUser = args.trim();
            if (!targetUser) { ctx.reply('[Bot管理] 用法: /bot del <用户名>'); return; }
            const lowerTarget = targetUser.toLowerCase();

            if (lowerTarget === bot.username.toLowerCase()) {
                ctx.reply('[Bot管理] 不能删除当前正在使用的机器人，请通过其他机器人操作');
                return;
            }

            const idx = (rootConfig && rootConfig.bots || []).findIndex(b => (b.username || '').toLowerCase() === lowerTarget);
            if (idx === -1) { ctx.reply(`[Bot管理] 未找到机器人 ${targetUser}`); return; }

            if (botRegistry && botRegistry.has(lowerTarget)) {
                const targetBot = botRegistry.get(lowerTarget);
                try { targetBot.end(); } catch (e) {}
                botRegistry.delete(lowerTarget);
            }

            rootConfig.bots.splice(idx, 1);
            if (saveBotsConfig) saveBotsConfig();
            ctx.reply(`[Bot管理] 已移除机器人 ${targetUser}`);
            console.log(`${PREFIX} [Bot管理] ${ctx.sender} 移除了机器人 ${targetUser}`);
        });

    cmd('/bot enable', ['/bot enable'],
        TRIGGER.WEB | TRIGGER.WHISPER,
        TARGET.TRUSTED,
        '/bot enable <用户名> — 设为默认启动',
        (ctx, args) => {
            const targetUser = args.trim();
            if (!targetUser) { ctx.reply('[Bot管理] 用法: /bot enable <用户名>'); return; }
            const botCfg = (rootConfig && rootConfig.bots || []).find(b => (b.username || '').toLowerCase() === targetUser.toLowerCase());
            if (!botCfg) { ctx.reply(`[Bot管理] 未找到机器人 ${targetUser}`); return; }
            botCfg.enabled = true;
            if (saveBotsConfig) saveBotsConfig();
            ctx.reply(`[Bot管理] 机器人 ${targetUser} 已设为默认启动`);
            console.log(`${PREFIX} [Bot管理] ${ctx.sender} 启用了机器人 ${targetUser} 的默认启动`);
        });

    cmd('/bot kill', ['/bot kill'],
        TRIGGER.MENTION | TRIGGER.WEB | TRIGGER.WHISPER | TRIGGER.QQ_AT,
        TARGET.TRUSTED,
        '/bot kill <用户名> — 下线机器人',
        (ctx, args) => {
            const targetUser = args.trim();
            if (!targetUser) { ctx.reply('[Bot管理] 用法: /bot kill <用户名>'); return; }
            const lowerTarget = targetUser.toLowerCase();

            if (!botRegistry || !botRegistry.has(lowerTarget)) {
                ctx.reply(`[Bot管理] 机器人 ${targetUser} 未在运行`);
                return;
            }

            const isSelf = lowerTarget === bot.username.toLowerCase();
            const targetBot = botRegistry.get(lowerTarget);

            if (isSelf) {
                // 自 kill：先发告别消息，再下线
                console.log(`${PREFIX} [Bot管理] ${ctx.sender} 命令我下线`);
                bot.chat(`§e[${bot.username}] 收到 ${ctx.sender} 的指令，正在下线... 再见！`);
                bot.whisper(ctx.sender, `[Bot管理] 正在下线...`);
                // 给消息一点时间发出
                setTimeout(() => {
                    try { targetBot.end(); } catch (e) {}
                    botRegistry.delete(lowerTarget);
                }, 500);
            } else {
                try { targetBot.end(); } catch (e) {}
                botRegistry.delete(lowerTarget);
                ctx.reply(`[Bot管理] 机器人 ${targetUser} 已下线`);
                console.log(`${PREFIX} [Bot管理] ${ctx.sender} 将机器人 ${targetUser} 下线`);
            }
        });

    cmd('/bot spawn', ['/bot spawn'],
        TRIGGER.MENTION | TRIGGER.WEB | TRIGGER.WHISPER | TRIGGER.QQ_AT,
        TARGET.TRUSTED,
        '/bot spawn <用户名> — 上线机器人',
        (ctx, args) => {
            const targetUser = args.trim();
            if (!targetUser) { ctx.reply('[Bot管理] 用法: /bot spawn <用户名>'); return; }
            const botCfg = (rootConfig && rootConfig.bots || []).find(b => (b.username || '').toLowerCase() === targetUser.toLowerCase());
            if (!botCfg) { ctx.reply(`[Bot管理] 未找到机器人 ${targetUser}，请先使用 /bot add 添加`); return; }
            if (spawnBotFromConfig) {
                const result = spawnBotFromConfig(botCfg);
                if (result) { ctx.reply(`[Bot管理] ${result}`); }
                else { ctx.reply(`[Bot管理] 机器人 ${targetUser} 已上线`); }
            } else {
                ctx.reply('[Bot管理] 不支持动态启动机器人');
            }
        });

    // ========== 事件处理器 ==========

    // 公聊事件
    bot.on('chat', (username, message) => {
        const isTrusted = trustedPlayers.includes(username);

        // 检测 @提及 / >> 回复
        const mentionPrefixes = [`>>${bot.username}`, `@${bot.username}`];
        for (const prefix of mentionPrefixes) {
            if (message.startsWith(prefix)) {
                const content = message.slice(prefix.length).trim();
                if (!content) return;
                const triggerFlag = prefix.startsWith('>>') ? TRIGGER.REPLY : TRIGGER.MENTION;
                const ctx = createMessageContext(
                    prefix.startsWith('>>') ? 'reply' : 'mention',
                    triggerFlag, username, content, isTrusted
                );
                dispatchMessage(ctx);
                return;
            }
        }

        // 无前缀的公聊消息
        const ctx = createMessageContext('chat', TRIGGER.CHAT, username, message, isTrusted);
        dispatchMessage(ctx);
    });

    // 私聊事件
    bot.on('whisper', (username, message) => {
        console.log(`${PREFIX} [私聊] ${username}: ${message}`);
        const isTrusted = trustedPlayers.includes(username);
        const ctx = createMessageContext('whisper', TRIGGER.WHISPER, username, message, isTrusted);
        dispatchMessage(ctx);
    });

    // ========== 外部命令执行接口（供 Web 面板等外部调用） ==========
    // 优先匹配内部注册命令；未匹配则以服务器命令方式发送到公聊
    // 回复内容存储在 bot._webReply 数组中，调用方可读取
    bot.execCommand = async function (cmdText) {
        const trimmed = cmdText.trim();
        const match = findCommand(trimmed);
        if (match) {
            // 内部注册命令 — 以 Web 管理员身份执行
            // 命令必须显式声明 TRIGGER.WEB 才能从 Web 端调用
            // 回复走 'web' 类型 → 存入 bot._webReply，不尝试发私聊
            bot._webReply = [];
            const ctx = createMessageContext('web', TRIGGER.WEB, '__web_admin__', trimmed, true);
            await dispatchMessage(ctx);
        } else {
            // 未匹配内部命令 → 作为服务器命令发送到公聊
            const cmd = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
            safeChat(cmd);
        }
    };

    return bot;
}

// ========== 主入口 ==========
if (require.main === module) {
    const configPath = process.argv[2] || path.join(__dirname, 'config.json');

    let config = loadConfig(configPath);

    if (!config.bots || !Array.isArray(config.bots) || config.bots.length === 0) {
        console.error('配置文件 config.json 中没有定义任何 bot（bots 数组为空）');
        process.exit(1);
    }

    const defaults = config.defaults || {};
    const aiCfg = getAIConfig(config);

    // 机器人实例注册表（username_lowercase -> bot 实例）
    const botRegistry = new Map();

    // 持久化配置到 config.json
    function saveBotsConfig() {
        try {
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        } catch (err) {
            console.error(`[主进程] 保存配置失败:`, err.message);
        }
    }

    // 从配置启动指定机器人（用于 /bot spawn）
    function spawnBotFromConfig(botCfg) {
        const lowerUser = (botCfg.username || '').toLowerCase();
        if (botRegistry.has(lowerUser)) {
            return `机器人 ${botCfg.username} 已在运行中`;
        }
        const merged = { ...defaults, ...botCfg };
        if (!merged.name || !merged.host || !merged.port || !merged.username) {
            return `Bot 配置不完整（缺少 name/host/port/username）`;
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
        return null; // null 表示成功
    }

    console.log(`启动 ${config.bots.length} 个机器人（仅 enabled 的）...`);

    for (const botCfg of config.bots) {
        // 跳过 enabled === false 的机器人
        if (botCfg.enabled === false) {
            console.log(`[主进程] 跳过未启用的机器人: ${botCfg.username || botCfg.name}`);
            continue;
        }

        // 合并默认配置与 bot 专属配置
        const merged = { ...defaults, ...botCfg };

        // 验证必填字段
        if (!merged.name || !merged.host || !merged.port || !merged.username) {
            console.error(`Bot 配置不完整（缺少 name/host/port/username）:`, merged);
            continue;
        }

        console.log(`[${merged.name}] 正在连接到 ${merged.host}:${merged.port}...`);
        const bot = createBotInstance(merged, {
            configPath,
            rootConfig: config,
            botRegistry,
            saveBotsConfig,
            spawnBotFromConfig,
            aiCfg,
        });
        botRegistry.set((merged.username || '').toLowerCase(), bot);
    }
}

module.exports = { createBotInstance };
