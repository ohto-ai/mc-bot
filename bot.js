const mineflayer = require('mineflayer');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { loadConfig, getAIConfig } = require('./shared');

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

// ========== Buddy Watch 链式传播检查 ==========
// 当 bot 下线时，检查是否有其他 bot 在监视它，触发链式下线
function checkBuddyWatchChain(myName, myUsername, botRegistry) {
    if (!botRegistry) return;
    for (const [key, otherBot] of botRegistry) {
        const watchTarget = otherBot._buddyWatch;
        if (watchTarget && (watchTarget === myName || watchTarget === myUsername)) {
            console.log(`[Buddy] 监视者 ${otherBot._botName || otherBot.username} 因目标 ${myName || myUsername} 下线而链式下线`);
            try { otherBot.end(); } catch (e) { /* ignore */ }
            botRegistry.delete(key);
            // 递归：otherBot 下线也会触发它的监视者
            checkBuddyWatchChain(otherBot._botName || otherBot.username, otherBot.username, botRegistry);
        }
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
        system_prompt: _systemPrompt,
        trusted_players: trustedPlayers,
        queue_delay: initialQueueDelay,
        max_msg_len: maxMsgLen,
        auto_menu: autoMenu,
        auto_login: autoLogin,
        default_server: defaultServer,
        tp_reply: tpReply,
        buddy_watch: buddyWatch = null,
        view_distance: viewDistanceCfg,
    } = config;

    // 视图距离：支持字符串 ("tiny"/"short"/"medium"/"far") 或数字 (2-32)
    // 默认 "tiny" = 2 区块半径（5x5=25 区块），大幅减少服务器区块加载开销
    const viewDistance = viewDistanceCfg || 'tiny';

    // 为每个 bot 实例注入独立的身份信息，防止多 bot 之间身份混淆
    const systemPrompt = _systemPrompt
        + `\n\n[身份信息] 你是机器人「${botName}」（游戏内名称: ${username}）。`
        + ` 当玩家问"你是谁""你叫什么名字"时，必须回答你是「${botName}」，不要只说自己是一个 AI 助手。`;

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
    function queryAI(userMessage, overrideSystemPrompt) {
        const effectivePrompt = overrideSystemPrompt || systemPrompt;
        if (aiProvider === 'mimo') {
            return queryMiMo(userMessage, effectivePrompt, aiCfg);
        }
        return queryDeepSeek(userMessage, effectivePrompt, aiCfg);
    }

    // ---- 创建 Bot ----
    const bot = mineflayer.createBot({
        host,
        port,
        username,
        version,
        viewDistance,
        skipValidation: true,
    });

    // ---- 安全保险：初始化 Buddy Watch 运行时变量 ----
    bot._botName = botName;
    bot._buddyWatch = buddyWatch || null;
    bot._intervals = []; // 收集所有 setInterval ID，断线时统一清理

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

    // ---- Markdown 格式清洗（去掉聊天窗里不好看的星号等标记） ----
    function stripMarkdown(text) {
        if (!text) return text;
        let result = text;
        // 粗体+斜体 (***text***)
        result = result.replace(/\*\*\*(.+?)\*\*\*/g, '$1');
        // 粗体 (**text** 或 __text__)
        result = result.replace(/\*\*(.+?)\*\*/g, '$1');
        result = result.replace(/__(.+?)__/g, '$1');
        // 斜体 (*text* 或 _text_) — 用 \B 避免误伤列表符号 "* item"
        result = result.replace(/\B\*([^*\n]+?)\*\B/g, '$1');
        result = result.replace(/\B_([^_\n]+?)_\B/g, '$1');
        // 删除线 (~~text~~)
        result = result.replace(/~~(.+?)~~/g, '$1');
        // 行内代码 (`text`)
        result = result.replace(/`([^`\n]+?)`/g, '$1');
        // 链接 [text](url) → text
        result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
        return result;
    }

    // ---- 长文本拆分（优先在标点处断句） ----
    function splitByLength(text, maxLen = maxMsgLen) {
        if (text.length <= maxLen) return [text];
        const chunks = [];
        let remaining = text;
        while (remaining.length > maxLen) {
            let cutAt = maxLen;
            const slice = remaining.slice(0, maxLen);
            for (const sep of ['。', '！', '？', '.', '!', '?', '\n']) {
                const pos = slice.lastIndexOf(sep);
                if (pos > maxLen / 2) { cutAt = pos + 1; break; }
            }
            if (cutAt === maxLen) {
                for (const sep of ['，', '、', '；', ',', ';']) {
                    const pos = slice.lastIndexOf(sep);
                    if (pos > maxLen / 2) { cutAt = pos + 1; break; }
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

    // QQ群消息最大长度（中英文均按1个字符计算）
    const QQ_MAX_LEN = 100;

    function sendQQReply(message) {
        for (const chunk of splitByLength(message, QQ_MAX_LEN)) {
            if (chunk) messageQueue.push({ type: 'qq', message: chunk });
        }
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

    let menuDone = false;
    let menuSearch = null;
    let pendingConfirm = null;
    let botFollowTarget = null;
    let botFollowInterval = null;
    let aiCallCount = 0;
    let botMiningActive = false; // 挖掘状态标志（/stop 可终止）
    let botAttackingActive = false; // 持续攻击状态标志（/stop 可终止）
    let botAttackLoopInterval = null;
    let autoClickTarget = null; // { serverName, resolve, reject, timer } — 自动点击菜单中的服务器物品

    // ========== 启动任务：向后兼容旧 auto_menu / default_server 配置 ==========
    function getEffectiveStartupTasks(cfg) {
        // 如果明确配置了 startup_tasks 且非空，直接使用（纯指令字符串数组）
        const explicitTasks = cfg.startup_tasks || cfg.startupTasks;
        if (explicitTasks && Array.isArray(explicitTasks) && explicitTasks.length > 0) {
            return explicitTasks;
        }

        // 向后兼容：根据 auto_menu + default_server 自动生成等效指令
        const legacyAutoMenu = cfg.auto_menu || cfg.autoMenu;
        const legacyDefaultServer = cfg.default_server || cfg.defaultServer;
        const tasks = [];

        if (legacyDefaultServer && legacyDefaultServer.trim() !== '') {
            tasks.push(`/sleep 5000`);
            tasks.push(`/server ${legacyDefaultServer}`);
        } else if (legacyAutoMenu) {
            tasks.push(`/sleep 3000`);
            tasks.push(`/menu`);
        }

        return tasks;
    }

    // ========== 合成站自动化状态 ==========
    let pendingStartupTasks = null;     // 等待登录完成后执行的启动任务
    let pendingStartupTimeout = null;   // 登录等待超时计时器
    let craftStationActive = false;
    let craftStationState = 'IDLE';      // IDLE → FIND_CHESTS → WITHDRAW → CRAFT → DEPOSIT → CHECK → ...
    let craftStationInputName = '';      // 原材料物品名，如 'gold_nugget'
    let craftStationOutputName = '';     // 产物物品名，如 'gold_ingot'
    let craftStationCycles = 0;          // 0 = infinite
    let craftStationCycleCount = 0;
    let craftStationTotalCrafted = 0;    // 累计合成产物总数
    let craftStationSender = '';         // 启动者
    let craftStationRetries = 0;         // 当前阶段重试次数
    let craftStationPendingStop = false; // 优雅停止标志
    let craftStationLoopTimer = null;    // setTimeout 句柄
    // 日志节流计数器已移除 —— 合成站只在开始/结束/出错时输出，避免内存持续增长
    let craftStationStartTime = 0;       // 合成站启动时刻 ms
    let craftStationSourcePos = null;    // 左侧箱子 Vec3（每轮更新）
    let craftStationDestPos = null;      // 右侧箱子 Vec3（每轮更新）
    let craftStationTablePos = null;     // 工作台 Vec3（首次找到后缓存）
    let craftStationConfigPos = null;   // 手动坐标配置 { source: Vec3, dest: Vec3 }（可选扩展）
    let craftStationAwaitingWindow = false; // 等待 windowOpen 事件

    // ========== 洗潜影盒自动化状态 ==========
    let washStationActive = false;
    let washStationState = 'IDLE';          // IDLE → PREFLIGHT → CAULDRON_CHECK → WITHDRAW → WASH → DEPOSIT → TRANSFER_UNDYED → CHECK → ...
    let washStationWaterPos = null;         // A: 无限水源坐标 Vec3
    let washStationCauldronPos = null;      // B: 炼药锅坐标 Vec3
    let washStationBucketPos = null;        // C: 水桶/空桶容器坐标 Vec3
    let washStationDyedPos = null;          // D: 染色盒子容器坐标 Vec3
    let washStationUndyedPos = null;        // E: 无色盒子容器坐标 Vec3
    let washStationSender = '';
    let washStationRetries = 0;
    let washStationLoopTimer = null;
    let washStationCycles = 0;              // 0 = infinite
    let washStationCycleCount = 0;
    let washStationTotalWashed = 0;         // 累计已洗盒子数
    let washStationPendingStop = false;
    let washStationCauldronLevel = 0;       // 炼药锅水位缓存 (0-3)
    let washStationLogCycleCounter = 0;
    let washStationStartTime = 0;
    let washStationSubState = '';           // 预检子状态
    let washStationSourceDepleted = false;  // D容器已耗尽（无染色盒也无无色盒）

    // ========== 挖掘工具匹配系统 ==========

    // 工具材质等级（数字越大越好）
    const TOOL_MATERIAL_TIER = {
        'wooden': 1, 'stone': 2, 'iron': 3, 'golden': 4, 'diamond': 5, 'netherite': 6,
    };

    // 从物品名提取工具信息：{ type, material, tier }
    function getToolInfo(itemName) {
        if (!itemName) return null;
        const name = itemName.toLowerCase();

        // 剪刀
        if (name.includes('shears')) return { type: 'shears', material: 'shears', tier: 10 };

        const toolPatterns = [
            { type: 'pickaxe', re: /pickaxe|pick\b/ },
            { type: 'axe',     re: /\baxe\b|_axe|hatchet/ },
            { type: 'shovel',  re: /shovel|spade/ },
            { type: 'hoe',     re: /_hoe|hoe\b/ },
            { type: 'sword',   re: /sword/ },
        ];

        for (const tp of toolPatterns) {
            if (tp.re.test(name)) {
                for (const [mat, tier] of Object.entries(TOOL_MATERIAL_TIER)) {
                    if (name.includes(mat)) return { type: tp.type, material: mat, tier };
                }
                return { type: tp.type, material: 'unknown', tier: 0 };
            }
        }
        return null;
    }

    // 根据方块名推断最佳工具类型
    function getPreferredToolType(blockName) {
        const name = (blockName || '').toLowerCase();

        // 镐子类
        if (/ore|stone\b|cobble|granite|diorite|andesite|deepslate|tuff|obsidian|netherrack|basalt|blackstone|end.?stone|brick|concrete|terracotta|furnace\b|iron_|gold_|copper_|diamond_|emerald_|redstone_|lapis|quartz|rail|spawner|enchant|anvil|hopper|dispenser|dropper|observer|piston|ice\b|packed_ice|blue_ice|calcite|amethyst|prismarine|purpur|shulker|glazed|beacon|chain\b|lantern|bell\b|grindstone|stonecutter|lodestone|pointed_dripstone|dripstone_block|copper|raw_|smithing|blast_furnace|smoker/.test(name)) {
            return 'pickaxe';
        }
        // 斧头类
        if (/log|wood|plank|fence|door|trapdoor|gate|sign|chest|barrel|crafting_table|loom|cartography|composter|note\b|jukebox|bookshelf|ladder|bamboo|mangrove|stem|hyphae|crimson|warped|beehive|bee_nest|cocoa|pumpkin|melon|mushroom/.test(name)) {
            return 'axe';
        }
        // 铲子类
        if (/dirt\b|grass|sand\b|gravel|clay\b|snow\b|soul_sand|soul_soil|farmland|mud\b|mycelium|podzol|rooted|concrete_powder/.test(name)) {
            return 'shovel';
        }
        // 剪刀类
        if (/leaves|wool|web|vine|grass\b|fern|dead_bush|seagrass|tall_grass|glow_lichen/.test(name)) {
            return 'shears';
        }
        // 锄头类
        if (/hay|target|dried_kelp|wart_block|shroomlight|sculk|moss|sponge/.test(name)) {
            return 'hoe';
        }

        return null; // 任何工具或空手均可
    }

    // 从背包中找到最适合挖掘指定方块的物品
    function findBestTool(bot, blockName) {
        const preferred = getPreferredToolType(blockName);
        const items = bot.inventory.items();

        // 剪刀直接匹配
        if (preferred === 'shears') {
            const shears = items.find(it => (it.name || '').toLowerCase().includes('shears'));
            if (shears) return shears;
        }

        let bestItem = null;
        let bestScore = -1;

        for (const item of items) {
            const info = getToolInfo(item.name);
            if (!info) continue;

            let score = info.tier;
            if (preferred && info.type === preferred) {
                score += 100; // 类型匹配大幅加分
            }

            if (score > bestScore) {
                bestScore = score;
                bestItem = item;
            }
        }

        return bestItem; // null = 空手
    }

    // 方块是否值得挖掘
    function isMineableBlock(block) {
        if (!block) return false;
        const name = (block.name || '').toLowerCase();
        if (name === 'air' || name === 'cave_air' || name === 'void_air') return false;
        if (name === 'bedrock') return false;
        if (name === 'water' || name === 'lava' || name === 'bubble_column') return false;
        if (name.includes('portal') || name === 'end_gateway') return false;
        if (name === 'barrier' || name === 'structure_void') return false;
        if (name.includes('command_block') || name.includes('jigsaw')) return false;
        return true;
    }

    // 获取当前区块边界
    function getChunkBounds(pos) {
        const cx = Math.floor(pos.x / 16);
        const cz = Math.floor(pos.z / 16);
        return {
            minX: cx * 16, maxX: cx * 16 + 15,
            minZ: cz * 16, maxZ: cz * 16 + 15,
            chunkX: cx, chunkZ: cz,
        };
    }

    // 扫描区块内所有可挖掘方块（按距离排序，从近到远）
    function scanChunkBlocks(maxCount = 2000) {
        const entity = bot.entity;
        if (!entity) return [];
        const pos = entity.position;
        const bounds = getChunkBounds(pos);

        const blocks = [];
        const yMin = Math.max(-64, Math.floor(pos.y) - 1); // 至少保留脚下的方块
        const yMax = Math.min(320, Math.floor(pos.y) + 8);

        for (let x = bounds.minX; x <= bounds.maxX; x++) {
            for (let z = bounds.minZ; z <= bounds.maxZ; z++) {
                for (let y = yMin; y <= yMax; y++) {
                    const block = bot.blockAt(new Vec3(x, y, z));
                    if (!isMineableBlock(block)) continue;

                    const dist = pos.distanceTo(block.position);
                    // 排除脚下方块（防止掉落）
                    const dx = x - Math.floor(pos.x);
                    const dz = z - Math.floor(pos.z);
                    if (y <= Math.floor(pos.y) - 1 && dx === 0 && dz === 0) continue;

                    blocks.push({ block, dist, x, y, z });
                }
                // 每列限制 Y 扫描范围，加速扫描
            }
        }

        // 按距离排序（近到远）
        blocks.sort((a, b) => a.dist - b.dist);
        return blocks.slice(0, maxCount);
    }

    // 走向目标位置（简单的直线移动）
    const Vec3 = require('vec3').Vec3;

    // ========== 合成站：方向 & 方块探测辅助函数 ==========

    /** Promise 延时 */
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /** 根据 yaw 获取前方向量 */
    function getForwardVec(yaw) {
        return new Vec3(-Math.sin(yaw), 0, Math.cos(yaw));
    }

    /** 根据 yaw 获取右方向量（垂直于前方向） */
    function getRightVec(yaw) {
        return new Vec3(Math.cos(yaw), 0, Math.sin(yaw));
    }

    /** 获取 bot 相对坐标处的方块（fwd=前, right=右, up=上） */
    function getRelativeBlock(fwd, right, up = 0) {
        if (!bot.entity) return null;
        const yaw = bot.entity.yaw;
        const fv = getForwardVec(yaw);
        const rv = getRightVec(yaw);
        const pos = bot.entity.position;
        const target = new Vec3(
            Math.floor(pos.x + fv.x * fwd + rv.x * right),
            Math.floor(pos.y + up),
            Math.floor(pos.z + fv.z * fwd + rv.z * right)
        );
        return bot.blockAt(target);
    }

    /** 判断方块是否为容器（箱子/木桶/潜影盒） */
    function isContainerBlock(name) {
        if (!name) return false;
        return name === 'chest' || name === 'trapped_chest' || name === 'barrel'
            || name.endsWith('_shulker_box') || name === 'shulker_box';
    }

    /** 判断方块是否为潜影盒（仅潜影盒，不包含箱子/木桶） */
    function isShulkerBox(name) {
        if (!name) return false;
        return name.endsWith('_shulker_box') || name === 'shulker_box';
    }

    /** 判断是否为染色潜影盒（排除无色潜影盒） */
    function isDyedShulkerBox(name) {
        if (!name) return false;
        return name.endsWith('_shulker_box') && name !== 'shulker_box';
    }

    /** 判断物品名是否为无色潜影盒 */
    function isUndyedShulkerBox(name) {
        return name === 'shulker_box';
    }

    /** 判断物品是否为水桶 */
    function isWaterBucket(name) {
        return name === 'water_bucket';
    }

    /** 判断物品是否为空桶 */
    function isEmptyBucket(name) {
        return name === 'bucket';
    }

    /** 获取炼药锅水位（0-3），若方块不是炼药锅则返回 -1 */
    function getCauldronWaterLevel(pos, debug = false) {
        if (!pos) return -1;
        const block = bot.blockAt(pos);
        if (!block) {
            if (debug) console.log(`${PREFIX} [洗盒-诊断] bot.blockAt(${pos.x},${pos.y},${pos.z}) 返回 null——区块未加载或坐标错误`);
            return -1;
        }
        const name = (block.name || '').toLowerCase();
        // 兼容带命名空间前缀的情况（如 minecraft:water_cauldron）
        if (name === 'water_cauldron' || name.endsWith(':water_cauldron') || name === 'cauldron') {
            // 尝试多种途径获取 level
            let level = null;
            // 途径1: properties.level（mineflayer 标准）
            if (block.properties?.level !== undefined) {
                level = parseInt(block.properties.level);
            }
            // 途径2: getProperties() 方法（某些 mineflayer 版本）
            if ((level === null || isNaN(level)) && typeof block.getProperties === 'function') {
                const props = block.getProperties();
                if (props?.level !== undefined) level = parseInt(props.level);
            }
            // 途径3: metadata（旧版兼容）
            if ((level === null || isNaN(level)) && block.metadata !== undefined) {
                level = block.metadata;
            }
            if (level !== null && !isNaN(level) && level >= 0 && level <= 3) {
                if (debug) console.log(`${PREFIX} [洗盒-诊断] 炼药锅水位: ${level}/3 (name=${block.name})`);
                return level;
            }
            // water_cauldron 但读不到 level，默认认为有 1 格水
            if (name === 'water_cauldron' || name.endsWith(':water_cauldron')) {
                if (debug) console.log(`${PREFIX} [洗盒-诊断] water_cauldron 但读不到 level，默认=1 (props=${JSON.stringify(block.properties)}, meta=${block.metadata})`);
                return 1;
            }
            // 普通 cauldron
            if (debug) console.log(`${PREFIX} [洗盒-诊断] 空炼药锅 (name=${block.name})`);
            return 0;
        }
        if (name === 'lava_cauldron' || name === 'powder_snow_cauldron' || name.endsWith(':lava_cauldron') || name.endsWith(':powder_snow_cauldron')) {
            if (debug) console.log(`${PREFIX} [洗盒-诊断] 炼药锅装了其他液体: ${block.name}`);
            return -2;
        }
        if (debug) console.log(`${PREFIX} [洗盒-诊断] 方块 ${block.name} 不是炼药锅`);
        return -1;
    }

    /** 判断方块是否为水源（水方块或含水方块） */
    function isWaterSourceBlock(block) {
        if (!block) return false;
        const name = (block.name || '').toLowerCase();
        // 水方块
        if (name === 'water') return true;
        // 含水方块（waterlogged）：mineflayer 返回的 properties 值可能是字符串 "true" 或布尔 true
        const wl = block.properties?.waterlogged;
        if (wl === 'true' || wl === true || wl === 1) return true;
        return false;
    }

    /** 在指定坐标附近搜索水源方块（半径内），返回最近的一个，没找到返回 null */
    function findNearbyWater(centerPos, radius = 5) {
        if (!centerPos) return null;
        const cx = centerPos.x, cy = centerPos.y, cz = centerPos.z;
        let bestBlock = null, bestDist = Infinity;
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dy = -2; dy <= 2; dy++) {
                for (let dz = -radius; dz <= radius; dz++) {
                    const pos = centerPos.offset(dx, dy, dz);
                    const block = bot.blockAt(pos);
                    if (block && isWaterSourceBlock(block)) {
                        const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
                        if (dist < bestDist) {
                            bestDist = dist;
                            bestBlock = block;
                        }
                    }
                }
            }
        }
        return bestBlock;
    }

    /** 根据配置坐标查找方块，返回 block 或 null */
    function getBlockAtConfigPos(pos, expectedType) {
        if (!pos) return null;
        const block = bot.blockAt(pos);
        if (!block) return null;
        if (expectedType) {
            const name = (block.name || '').toLowerCase();
            if (expectedType === 'water') return isWaterSourceBlock(block);
            if (expectedType === 'cauldron') return name.includes('cauldron');
            if (expectedType === 'container') return isContainerBlock(name);
        }
        return block;
    }

    /** 检查容器是否有空间（粗略检测：是否至少有一个空槽位） */
    function containerHasSpace(window) {
        const invStart = window.inventoryStart ?? 0;
        const slots = window.slots ?? [];
        const end = Math.min(slots.length, invStart > 0 ? invStart : slots.length);
        // 实际容器槽位从 0 到 inventoryStart-1（如果 inventoryStart > 0）
        const containerEnd = invStart > 0 ? invStart : end;
        for (let i = 0; i < containerEnd; i++) {
            if (!slots[i]) return true; // 有空槽
        }
        return false;
    }

    /** 找附近工作台（优先缓存位置，其次相对探测，最后全图搜索） */
    function findCraftingTable() {
        // 使用缓存
        if (craftStationTablePos) {
            const cached = bot.blockAt(craftStationTablePos);
            if (cached && cached.name === 'crafting_table') return cached;
            craftStationTablePos = null; // 缓存失效
        }
        // 相对探测：正前方、右前方、左前方
        const candidates = [
            getRelativeBlock(1, 0, 0),
            getRelativeBlock(2, 0, 0),
            getRelativeBlock(1, 1, 0),
            getRelativeBlock(1, -1, 0),
            getRelativeBlock(2, 1, 0),
            getRelativeBlock(2, -1, 0),
            getRelativeBlock(1, 0, -1),
        ];
        for (const b of candidates) {
            if (b && b.name === 'crafting_table') {
                craftStationTablePos = b.position;
                return b;
            }
        }
        // 全图搜索
        const found = bot.findBlock({
            matching: b => b && b.name === 'crafting_table',
            maxDistance: 6,
        });
        if (found) craftStationTablePos = found.position;
        return found;
    }

    /** 找左前方箱子（原材料盒） */
    function findSourceChest() {
        // 手动配置优先 —— 不 fallback，缺失则等重试
        if (craftStationConfigPos && craftStationConfigPos.source) {
            const pos = craftStationConfigPos.source;
            const b = bot.blockAt(pos);
            if (b && isContainerBlock(b.name)) return b;
            // 指定了坐标就不用 fallback，避免误触其他方块
            return null;
        }
        // 相对探测：左前 2 格 → 左前 1 格
        let b = getRelativeBlock(2, -2, 0);
        if (b && isContainerBlock(b.name)) return b;
        b = getRelativeBlock(2, -1, 0);
        if (b && isContainerBlock(b.name)) return b;
        // fallback：仅找潜影盒，避免误开到箱子/木桶
        const found = bot.findBlock({
            matching: bl => bl && isShulkerBox(bl.name),
            maxDistance: 5,
        });
        return found || null;
    }

    /** 找右前方箱子（产物盒） */
    function findDestChest() {
        // 手动配置优先 —— 不 fallback，缺失则等重试
        if (craftStationConfigPos && craftStationConfigPos.dest) {
            const pos = craftStationConfigPos.dest;
            const b = bot.blockAt(pos);
            if (b && isContainerBlock(b.name)) return b;
            // 指定了坐标就不用 fallback，避免误触其他方块
            return null;
        }
        // 相对探测：右前 2 格 → 右前 1 格
        let b = getRelativeBlock(2, 2, 0);
        if (b && isContainerBlock(b.name)) return b;
        b = getRelativeBlock(2, 1, 0);
        if (b && isContainerBlock(b.name)) return b;
        // fallback：仅找潜影盒，避免误开到箱子/木桶
        const found = bot.findBlock({
            matching: bl => bl && isShulkerBox(bl.name),
            maxDistance: 5,
        });
        return found || null;
    }

    function walkToPosition(targetPos, minDist = 2.5) {
        return new Promise((resolve) => {
            const checkInterval = 150;
            const lookInterval = 450; // 降低视角更新频率，避免频繁 snap 导致转圈
            const maxTime = 30000;
            const startTime = Date.now();
            let lastLookTime = 0;

            const stopMove = () => {
                for (const ctrl of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
                    bot.setControlState(ctrl, false);
                }
            };

            function step() {
                if (!botMiningActive) {
                    stopMove();
                    return resolve(false);
                }

                const myPos = bot.entity.position;
                const dist = myPos.distanceTo(targetPos);
                if (dist <= minDist) {
                    stopMove();
                    return resolve(true);
                }

                if (Date.now() - startTime > maxTime) {
                    stopMove();
                    return resolve(false);
                }

                // 只在距离较远或方向变化较大时更新视角，避免近距离时频繁转头导致转圈
                const dx = targetPos.x - myPos.x;
                const dz = targetPos.z - myPos.z;
                const horizDist = Math.sqrt(dx * dx + dz * dz);
                const now = Date.now();
                if (horizDist > 1.0 && now - lastLookTime > lookInterval) {
                    // 使用 non-force 模式平滑转头，避免 snap 造成的视角抖动
                    const lookTarget = targetPos.offset(0, 0.5, 0);
                    // 避免目标在正上方/正下方时 yaw 无定义导致的旋转
                    if (horizDist > 0.3) {
                        bot.lookAt(lookTarget, false);
                    }
                    lastLookTime = now;
                }

                bot.setControlState('forward', true);
                if (dist > 6) bot.setControlState('sprint', true);

                // 只在目标明显高于自身时才启动飞行（飞行会降低挖掘效率）
                // 阈值 3 格：普通跳跃+脚下垫方块可达 1-2 格高度差，超过 3 格才需要飞行
                const dy = targetPos.y - myPos.y;
                if (dy > 3) {
                    bot.setControlState('jump', true);
                } else {
                    bot.setControlState('jump', false);
                }

                setTimeout(step, checkInterval);
            }

            step();
        });
    }

    // 异步挖掘单个方块（自动切换工具）
    async function mineSingleBlock(blockInfo) {
        if (!botMiningActive) return false;
        const { x, y, z } = blockInfo;
        const block = bot.blockAt(new Vec3(x, y, z));
        if (!block) return false;

        // 辅助函数：停止所有移动控制
        const stopAllMove = () => {
            for (const ctrl of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
                bot.setControlState(ctrl, false);
            }
        };

        try {
            // 1. 走到方块附近
            const center = block.position.offset(0.5, 0.5, 0.5);
            const reached = await walkToPosition(center, 4.0);
            if (!reached) return false;

            // 1.5 停止移动，等待身体稳定后再操作（避免走路惯性导致转圈）
            stopAllMove();
            await new Promise(r => setTimeout(r, 250));

            if (!botMiningActive) return false;

            // 2. 切换最佳工具
            const bestTool = findBestTool(bot, block.name);
            if (bestTool && bot.heldItem !== bestTool) {
                try {
                    await bot.equip(bestTool, 'hand');
                } catch (e) {
                    // 装备失败，继续用手中物品
                }
            }

            // 3. 看向方块中心（force=true 确保精准对准挖掘目标）
            const myPos = bot.entity.position;
            const dx = center.x - myPos.x;
            const dz = center.z - myPos.z;
            const horizDist = Math.sqrt(dx * dx + dz * dz);
            // 只在水平距离足够时调整视角，避免正上方/下方时 yaw 无定义导致转圈
            if (horizDist > 0.3) {
                bot.lookAt(center, true);
            }
            // horizDist <= 0.3 时跳过 lookAt，保持当前朝向（只差高度，yaw 无关紧要）
            await new Promise(r => setTimeout(r, 300)); // 等待服务器确认视角

            if (!botMiningActive) return false;

            if (bot.canDigBlock(block)) {
                await bot.dig(block, true, 'auto');
                // 挖掘完成后停止移动，避免惯性
                stopAllMove();
                return true;
            }
        } catch (err) {
            // 挖掘失败，跳过该方块
        }
        return false;
    }

    // ---- 命令输出捕获（基于 correlation ID 的 Map，支持并发） ----
    const cmdCaptureMap = new Map(); // correlationId -> CaptureState
    let captureIdCounter = 0;

    function nextCaptureId() {
        return `cap_${Date.now()}_${++captureIdCounter}`;
    }

    function flushCmdCapture(correlationId, forceMsg) {
        const state = cmdCaptureMap.get(correlationId);
        if (!state) return;
        clearTimeout(state.timer);
        cmdCaptureMap.delete(correlationId);
        const { target, type, messages, _capture, _onFlush } = state;

        function sendOrCapture(reply) {
            if (_capture) {
                _capture.push(reply);
            } else if (type === 'qq_at') {
                sendQQReply(reply);
            } else {
                safeWhisper(target, reply);
            }
        }

        if (forceMsg) {
            sendOrCapture(forceMsg);
        } else if (messages.length > 0) {
            const filtered = [...new Set(messages)].filter(m => {
                if (m.includes('/login')) return false;
                if (m.includes('你还要再等') && m.includes('秒才能再次发送跨服消息')) return false;
                return true;
            });
            if (filtered.length > 0) {
                sendOrCapture(`[命令结果]\n${filtered.join('\n')}`);
            } else {
                sendOrCapture('[命令结果] (无有效输出)');
            }
        } else {
            sendOrCapture('[命令结果] (无输出)');
        }

        // 通知 executeToolCall 捕获已完成（AI 工具调用用）
        if (_onFlush) _onFlush();
    }

    function startCapture(target, type, _capture, timeoutMs = 5000, prefillMessages = null) {
        const id = nextCaptureId();
        const timer = setTimeout(() => flushCmdCapture(id), timeoutMs);
        cmdCaptureMap.set(id, { target, type, messages: prefillMessages || [], timer, _capture, _onFlush: null });
        return id;
    }

    // ========== 菜单窗口自动化 ==========
    bot.on('windowOpen', (window) => {
        console.log(`${PREFIX} [菜单] 窗口打开 [类型=${window.type}, 槽位数=${window.slots.length}]`);

        // 合成站窗口分流：CRAFT 阶段等待工作台窗口
        if (craftStationActive && craftStationAwaitingWindow && craftStationState === 'CRAFT') {
            handleCraftingWindow(window);
            return;
        }

        // 合成站运行中（预检、存取物等阶段），不触发菜单自动点击，避免干扰合成站操作
        if (craftStationActive) {
            return;
        }

        // 自动点击目标（服务器切换）→ 最高优先级
        if (autoClickTarget) {
            setTimeout(() => autoClickServerItem(window), 500);
            return;
        }

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

    // 自动点击菜单中的服务器物品（无需确认，用于服务器切换）
    function autoClickServerItem(window) {
        const target = autoClickTarget;
        autoClickTarget = null;
        clearTimeout(target.timer);

        const endSlot = window.inventoryStart ?? window.slots.length;
        const lowerName = target.serverName.toLowerCase();
        let foundSlot = null;
        let foundName = '';

        // 遍历菜单物品，匹配服务器名称（在 name / displayName / customName 中搜索）
        for (let slot = 0; slot < endSlot; slot++) {
            const item = window.slots[slot];
            if (!item || !item.name) continue;

            const itemName = (item.name || '').toLowerCase();
            const displayName = (typeof item.displayName === 'string' ? item.displayName : '').toLowerCase();
            const customName = (typeof item.customName === 'string' ? item.customName : '').toLowerCase();

            // 同时也检查 JSON.stringified 格式的 displayName（去除 JSON 引号和转义）
            const rawDisplay = item.displayName
                ? (typeof item.displayName === 'string' ? item.displayName : JSON.stringify(item.displayName)).toLowerCase()
                : '';
            const rawCustom = item.customName
                ? (typeof item.customName === 'string' ? item.customName : JSON.stringify(item.customName)).toLowerCase()
                : '';

            if (itemName.includes(lowerName) ||
                displayName.includes(lowerName) ||
                customName.includes(lowerName) ||
                rawDisplay.includes(lowerName) ||
                rawCustom.includes(lowerName)) {

                foundSlot = slot;
                foundName = item.displayName
                    ? (typeof item.displayName === 'string' ? item.displayName : JSON.stringify(item.displayName))
                    : (item.customName
                        ? (typeof item.customName === 'string' ? item.customName : JSON.stringify(item.customName))
                        : item.name);
                break;
            }
        }

        if (foundSlot !== null) {
            console.log(`${PREFIX} [服务器] 菜单中匹配到 "${foundName}" (栏位 ${foundSlot})，自动点击`);
            if (bot.activateItemInterval) {
                clearInterval(bot.activateItemInterval);
                bot.activateItemInterval = null;
            }

            blockUseItemPackets();
            bot.clickWindow(foundSlot, 0, 0);

            target.resolve(`[服务器切换] 已切换到: ${foundName}`);
        } else {
            console.log(`${PREFIX} [服务器] 菜单中未找到 "${target.serverName}"`);
            // 列出菜单内容帮助调试
            for (let slot = 0; slot < endSlot; slot++) {
                const item = window.slots[slot];
                if (item && item.name) {
                    const d = item.displayName ? ` [${JSON.stringify(item.displayName)}]` : '';
                    console.log(`${PREFIX} [菜单] 栏位 ${slot}: ${item.name}${d}`);
                }
            }
            target.reject(`[服务器切换] 菜单中未找到服务器 "${target.serverName}"`);
        }
    }

    // 通过菜单切换服务器（打开 /menu → 自动点击匹配的服务器物品）
    function switchServer(serverName) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                autoClickTarget = null;
                reject('[服务器切换] 等待菜单超时（15 秒），请确认服务器在线且菜单可用');
            }, 15000);

            autoClickTarget = { serverName, resolve, reject, timer };
            safeChat('/menu');
        });
    }

    // ========== 启动任务执行器（纯指令字符串数组，顺序执行） ==========
    async function runStartupTasks(tasks) {
        console.log(`${PREFIX} [启动任务] 开始执行 ${tasks.length} 个指令`);

        // 重置 menuDone，确保 /menu 指令能触发 clickMenu()
        menuDone = false;

        for (let i = 0; i < tasks.length; i++) {
            if (bot.ended) {
                console.log(`${PREFIX} [启动任务] Bot 已断开，中止执行`);
                break;
            }

            console.log(`${PREFIX} [启动任务] #${i + 1}: ${tasks[i]}`);
            try {
                await bot.execCommand(tasks[i]);
            } catch (err) {
                console.error(`${PREFIX} [启动任务] #${i + 1} 失败: ${err}`);
                // 失败继续下一个任务
            }
        }

        console.log(`${PREFIX} [启动任务] 全部完成`);
    }

    let menuItems = [];

    // 共享的 use_item/arm_animation 阻断机制，防止嵌套 monkey-patch 导致永久阻断
    function blockUseItemPackets(timeoutMs = 5000) {
        // 保存真实的原始 write（仅首次）
        if (!bot._realClientWrite) {
            bot._realClientWrite = bot._client.write.bind(bot._client);
        }
        // 如果已有阻断定时器，只延长超时，不重复 patch
        if (bot._packetBlockTimeout) {
            clearTimeout(bot._packetBlockTimeout);
        } else {
            bot._client.write = function (name, params) {
                if (name === 'use_item' || name === 'arm_animation') {
                    console.log(`${PREFIX} [阻断] 已拦截: ${name}`);
                } else {
                    bot._realClientWrite(name, params);
                }
            };
        }
        bot._packetBlockTimeout = setTimeout(() => {
            bot._client.write = bot._realClientWrite;
            bot._packetBlockTimeout = null;
            console.log(`${PREFIX} [阻断] 超时未传送，恢复发包`);
        }, timeoutMs);
    }

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

            blockUseItemPackets();
            bot.clickWindow(target.slot, 0, 0);
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
        // 清理启动任务等待
        if (pendingStartupTimeout) {
            clearTimeout(pendingStartupTimeout);
            pendingStartupTimeout = null;
        }
        pendingStartupTasks = null;
        // 清理 activateItem 定时器
        if (bot.activateItemInterval) {
            clearInterval(bot.activateItemInterval);
            bot.activateItemInterval = null;
        }
        // 清理阻断发包定时器，恢复真实 write（防止 monkey-patch 残留）
        if (bot._packetBlockTimeout) {
            clearTimeout(bot._packetBlockTimeout);
            bot._packetBlockTimeout = null;
        }
        if (bot._realClientWrite) {
            bot._client.write = bot._realClientWrite;
            bot._realClientWrite = null;
        }
        // 清理合成站
        if (craftStationActive) cleanupStation();
        // 清理洗盒站
        if (washStationActive) cleanupWashStation();
        // 清理所有收集的 setInterval（AI 频率记录、对话记忆清理等）
        for (const id of bot._intervals) {
            clearInterval(id);
        }
        bot._intervals = [];
        // 从注册表中移除自身
        const myLowerUser = (username || '').toLowerCase();
        if (options.botRegistry) {
            options.botRegistry.delete(myLowerUser);
        }
        // Buddy Watch 链式传播：检查是否有其他 bot 在监视自己
        checkBuddyWatchChain(botName, username, options.botRegistry);
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

        // 命令输出捕获（广播到所有活跃捕获，支持并发）
        if (cmdCaptureMap.size > 0 && !isSelfEcho) {
            const MAX_CAPTURE_MESSAGES = 200; // 每个捕获最多缓存 200 条消息
            for (const [id, state] of cmdCaptureMap) {
                clearTimeout(state.timer);
                state.messages.push(message);
                // 超过上限立即 flush，避免无限增长
                if (state.messages.length >= MAX_CAPTURE_MESSAGES) {
                    flushCmdCapture(id);
                } else {
                    state.timer = setTimeout(() => flushCmdCapture(id), 5000);
                }
            }
        }

        // 登录检测
        if (autoLogin && message.includes('/login') && password) {
            safeChat(`/login ${password}`);
            console.log(`${PREFIX} 已发送登录指令`);
            // 登录指令已发送，等待服务器处理后执行启动任务
            if (pendingStartupTasks) {
                if (pendingStartupTimeout) {
                    clearTimeout(pendingStartupTimeout);
                    pendingStartupTimeout = null;
                }
                const t = pendingStartupTasks;
                pendingStartupTasks = null;
                setTimeout(() => {
                    console.log(`${PREFIX} [启动] 登录完成，开始执行启动任务`);
                    runStartupTasks(t);
                }, 2000); // 给服务器 2 秒处理登录
            }
        }

        // 跨服消息频率限制
        if (message.includes('你还要再等') && message.includes('秒才能再次发送跨服消息')) {
            queueDelay = Math.max(queueDelay, 2000);
            console.log(`${PREFIX} [限速] 检测到频率限制，消息间隔调整为 ${queueDelay}ms`);
        }
    });

    // ========== 机器人 spawn 行为 ==========
    bot.on('spawn', () => {
        if (!bot._startTime) bot._startTime = Date.now();
        console.log(`${PREFIX} 进入游戏 (第 ${spawnCount} 次 spawn)，开始挂机`);

        if (!bot.activateItemInterval) {
            bot.activateItemInterval = setInterval(() => bot.activateItem(), 50);
        }

        if (spawnCount === 1) {
            const tasks = getEffectiveStartupTasks(config);
            if (tasks && tasks.length > 0) {
                if (autoLogin && password) {
                    // 需要等待自动登录完成后再执行启动任务
                    console.log(`${PREFIX} [启动] 等待自动登录完成后再执行启动任务...`);
                    pendingStartupTasks = tasks;
                    pendingStartupTimeout = setTimeout(() => {
                        if (pendingStartupTasks) {
                            console.log(`${PREFIX} [启动] 登录等待超时（15 秒），强制执行启动任务`);
                            const t = pendingStartupTasks;
                            pendingStartupTasks = null;
                            runStartupTasks(t);
                        }
                    }, 15000);
                } else {
                    runStartupTasks(tasks);
                }
            } else {
                console.log(`${PREFIX} [启动] 未配置启动任务`);
            }
        } else if (spawnCount > 1) {
            console.log(`${PREFIX} [重生] 第 ${spawnCount} 次 spawn`);
        }
    });

// ---- Buddy Watch：监听玩家离开事件 ----
bot.on('playerLeft', (player) => {
    if (bot._buddyWatch && player.username === bot._buddyWatch) {
        console.log(`${PREFIX} [Buddy] 监视目标 ${player.username} 已离线，自动下线`);
        try { bot.end(); } catch (e) { /* ignore */ }
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

    // MAX_PAY_AMOUNT：一次转账的最大金额（防止 bot 余额被恶意消耗）
    const maxPayAmount = config.max_pay_amount || 100000;

    const commandRegistry = [];

    // 注册命令：cmd(名称, 匹配前缀数组, 触发条件, 触发对象, 帮助文本, 处理函数)
    // handler 签名: async (ctx, args) — ctx 为消息上下文，args 为命令参数
    // toolAllowed: 是否允许 AI 将此命令作为工具调用（默认 false，需显式 opt-in）
    // toolParams: 可选的结构化参数 schema，格式 { paramName: { type, description, required } }
    function cmd(name, patterns, triggers, target, help, handler, toolAllowed = false, toolParams = null) {
        commandRegistry.push({ name, patterns, triggers, target, help, handler, toolAllowed, toolParams });
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

    // captureBuffer: 可选数组，传入时 ctx.reply() 将文本存入数组而非发送消息（供 AI 工具调用捕获输出）
    function createMessageContext(type, triggerFlag, sender, content, isTrusted, captureBuffer) {
        return {
            type,          // 'chat' | 'whisper' | 'mention' | 'reply' | 'qq_at' | 'web' | 'tool'
            triggerFlag,   // 匹配的 TRIGGER 位
            sender,        // 发送者用户名
            content,       // 清洗后的消息内容（不含 @botname / >>botname 等前缀）
            isTrusted,     // 是否为可信玩家
            _captureBuffer: captureBuffer,
            // 根据消息类型原路返回
            reply(text) {
                if (this._captureBuffer) {
                    this._captureBuffer.push(text);
                    return;
                }
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

    // AI 调用频率限制（每玩家每分钟最多 30 次）
    const AI_RATE_LIMIT = 30;
    const aiCallCounts = new Map(); // sender -> { count, windowStart }

    function checkAICallLimit(sender) {
        const now = Date.now();
        let record = aiCallCounts.get(sender);
        if (!record || now - record.windowStart > 60000) {
            record = { count: 0, windowStart: now };
            aiCallCounts.set(sender, record);
        }
        record.count++;
        return record.count <= AI_RATE_LIMIT;
    }

    // 定期清理过期的 AI 频率记录（每 2 分钟）
    bot._intervals.push(setInterval(() => {
        const now = Date.now();
        for (const [sender, record] of aiCallCounts) {
            if (now - record.windowStart > 120000) aiCallCounts.delete(sender);
        }
    }, 120000));

    // ========== AI 对话记忆（每玩家多轮对话上下文） ==========
    const CONVERSATION_TTL = 15 * 60 * 1000; // 15 分钟过期
    const CONVERSATION_MAX_TURNS = 10; // 最多保留 10 轮对话（20 条消息）
    const MAX_CONVERSATION_ENTRIES = 50; // 最多保留 50 个玩家的对话
    const MAX_MESSAGE_LENGTH = 500; // 单条消息最大字符数（截断过长消息）
    const conversationMemory = new Map(); // sender -> { messages[], lastAccess }

    function getConversation(sender) {
        const now = Date.now();
        let conv = conversationMemory.get(sender);
        if (!conv || now - conv.lastAccess > CONVERSATION_TTL) {
            conv = { messages: [], lastAccess: now };
            // LRU 淘汰：超过上限时删除最久未访问的条目
            if (conversationMemory.size >= MAX_CONVERSATION_ENTRIES && !conversationMemory.has(sender)) {
                let oldestKey = null;
                let oldestTime = Infinity;
                for (const [k, v] of conversationMemory) {
                    if (v.lastAccess < oldestTime) { oldestTime = v.lastAccess; oldestKey = k; }
                }
                if (oldestKey) conversationMemory.delete(oldestKey);
            }
            conversationMemory.set(sender, conv);
        }
        conv.lastAccess = now;
        return conv;
    }

    function addToConversation(sender, role, content) {
        const conv = getConversation(sender);
        // 截断过长消息，避免内存膨胀
        const truncated = (typeof content === 'string' && content.length > MAX_MESSAGE_LENGTH)
            ? content.slice(0, MAX_MESSAGE_LENGTH) + '...'
            : content;
        conv.messages.push({ role, content: truncated });
        if (conv.messages.length > CONVERSATION_MAX_TURNS * 2) {
            conv.messages = conv.messages.slice(-CONVERSATION_MAX_TURNS * 2);
        }
    }

    // 定期清理过期的对话（每 2 分钟）
    bot._intervals.push(setInterval(() => {
        const now = Date.now();
        for (const [sender, conv] of conversationMemory) {
            if (now - conv.lastAccess > CONVERSATION_TTL + 120000) conversationMemory.delete(sender);
        }
    }, 120000));

    async function handleAIChat(ctx) {
        // 频率限制检查
        if (!checkAICallLimit(ctx.sender)) {
            console.log(`${PREFIX} [AI-${aiProvider}] 频率限制: ${ctx.sender} 请求过于频繁`);
            ctx.reply('[AI] 你发送请求过于频繁，请稍后再试');
            return;
        }

        // 附上发送者用户名，让 AI 知道是谁在说话（解决「转钱给我」中「我」指代不清的问题）
        const senderInfo = ctx.sender ? `[来自玩家 ${ctx.sender}] ` : '';
        const prompt = senderInfo + ctx.content.trim();
        if (!prompt) return;

        console.log(`${PREFIX} [AI-${aiProvider}] ${ctx.sender} (${ctx.type}): ${prompt}`);
        aiCallCount++;

        // 将用户消息加入对话记忆
        addToConversation(ctx.sender, 'user', prompt);

        // 生成可用工具列表（受信任用户更多工具）
        const tools = buildToolDefinitions(ctx.isTrusted);
        let reply;
        if (tools.length > 0) {
            reply = await queryAIWithTools(prompt, tools, ctx);
        } else {
            // 不受信任玩家无工具可用时，使用带安全约束的系统提示词
            const safetySystemPrompt = systemPrompt + '\n\n[安全约束] 你正在与一个非可信玩家对话。你只能回答问题、提供信息和建议。你绝对不能执行任何会改变游戏状态的操作（如转账、丢弃物品、攻击、装备等）。如果玩家要求此类操作，请礼貌拒绝。';
            reply = await queryAI(prompt, safetySystemPrompt);
        }

        // 将 AI 回复加入对话记忆
        addToConversation(ctx.sender, 'assistant', reply);

        reply = stripMarkdown(reply);
        console.log(`${PREFIX} [AI-${aiProvider}] 回复: ${reply}`);
        ctx.reply(`[AI] ${reply}`);
    }

    // ========== 远程命令转发（兜底） ==========

    function executeRemoteCommand(ctx) {
        console.log(`${PREFIX} [命令] ${ctx.sender} 执行: ${ctx.content}`);
        startCapture(ctx.sender, ctx.type, ctx._captureBuffer || null, 5000);
        safeChat(ctx.content);
    }

    // ========== AI 工具调用：执行命令并捕获输出 ==========

    // 将 AI 传来的工具名还原为命令文本并执行
    async function executeToolCall(toolName, args, originalCtx) {
        // API 函数名中空格用 _ 替代，此处还原
        const cmdName = '/' + toolName.replace(/_/g, ' ');
        const match = findCommand(cmdName);
        if (!match) return `[错误] 未知命令: ${cmdName}`;
        if (!match.def.toolAllowed) return `[错误] 命令 ${cmdName} 不允许作为工具使用`;
        if (TOOL_BLOCKLIST.includes(match.def.name)) return `[错误] 命令 ${cmdName} 被禁止作为 AI 工具使用`;

        // 工具调用时二次鉴权：即使 AI 工具列表中已过滤，此处作为纵深防御再检查一次
        if (match.def.target === TARGET.TRUSTED && !originalCtx.isTrusted) {
            return `[错误] 你没有权限使用命令 ${cmdName}`;
        }

        // 清除旧的捕获状态，避免污染
        for (const [id, state] of cmdCaptureMap) {
            clearTimeout(state.timer);
            flushCmdCapture(id, '[工具] 前一个命令已超时');
        }

        const captureBuffer = [];
        const cmdText = args ? `${cmdName} ${args}` : cmdName;
        const toolCtx = createMessageContext('tool', 0, originalCtx.sender, cmdText, originalCtx.isTrusted, captureBuffer);

        try {
            console.log(`${PREFIX} [工具] ${originalCtx.sender} → ${match.def.name} ${args || ''}`);
            // 记录 handler 执行前的活跃捕获 ID，以便之后识别新创建的捕获
            const existingIds = new Set(cmdCaptureMap.keys());
            await match.def.handler(toolCtx, args || '');

            // 查找 handler 执行期间新创建的、使用我们 captureBuffer 的捕获并等待其完成
            for (const [id, state] of cmdCaptureMap) {
                if (!existingIds.has(id) && state._capture === captureBuffer) {
                    await new Promise(resolve => {
                        state._onFlush = resolve;
                    });
                    break;
                }
            }
        } catch (err) {
            console.error(`${PREFIX} [工具错误] ${match.def.name}:`, err.message);
            return `[错误] 命令执行失败: ${err.message}`;
        }

        const result = captureBuffer.join('\n') || `[工具] ${match.def.name} 执行完毕（无输出）`;
        // 截断过长结果，避免 token 爆炸
        return result.length > 2000 ? result.slice(0, 2000) + '\n...(结果已截断)' : result;
    }

    // ========== 生成 OpenAI 工具定义 ==========

    const TOOL_BLOCKLIST = ['/menu', '/confirm', '/trust', '/trust add', '/trust remove',
        '/bot add', '/bot del', '/bot enable'];

    function buildToolDefinitions(isTrusted) {
        const tools = [];
        for (const def of commandRegistry) {
            if (!def.toolAllowed) continue;
            if (TOOL_BLOCKLIST.includes(def.name)) continue;
            if (def.target === TARGET.TRUSTED && !isTrusted) continue;

            // 工具名：去掉 /
            const toolName = def.name.replace(/^\//, '');

            // 从 help 文本提取描述
            const helpText = def.help || '';
            const descMatch = helpText.match(/[—\-]\s*(.+)/);
            const description = descMatch ? descMatch[1].trim() : helpText;

            if (def.toolParams) {
                // 使用结构化参数 schema
                const properties = {};
                const required = [];
                for (const [paramName, paramDef] of Object.entries(def.toolParams)) {
                    const prop = { type: paramDef.type, description: paramDef.description || paramName };
                    if (paramDef.minimum !== undefined) prop.minimum = paramDef.minimum;
                    if (paramDef.maximum !== undefined) prop.maximum = paramDef.maximum;
                    properties[paramName] = prop;
                    if (paramDef.required) required.push(paramName);
                }
                tools.push({
                    type: 'function',
                    function: {
                        name: toolName.replace(/\s+/g, '_'),  // API 要求无空格
                        description: description,
                        parameters: {
                            type: 'object',
                            properties,
                            required,
                        },
                    },
                });
            } else {
                // 回退到通用 args 字符串参数
                let argsDesc = '命令参数（通常不需要）';
                const angleMatch = helpText.match(/<([^>]+)>/);
                if (angleMatch) argsDesc = `必需参数: ${angleMatch[1]}`;
                else {
                    const bracketMatch = helpText.match(/\[([^\]]+)\]/);
                    if (bracketMatch) argsDesc = `可选参数: ${bracketMatch[1]}`;
                }

                tools.push({
                    type: 'function',
                    function: {
                        name: toolName.replace(/\s+/g, '_'),  // API 要求无空格
                        description: description,
                        parameters: {
                            type: 'object',
                            properties: {
                                args: {
                                    type: 'string',
                                    description: argsDesc,
                                },
                            },
                            required: [],
                        },
                    },
                });
            }
        }
        return tools;
    }

    // ========== 统一 AI API 调用（返回完整 message 对象，支持 tools） ==========

    async function callAIApi(messages, tools) {
        const isDeepSeek = aiProvider !== 'mimo';
        const apiKey = isDeepSeek ? aiCfg.deepseekApiKey : aiCfg.mimoApiKey;
        const apiUrl = isDeepSeek ? aiCfg.DEEPSEEK_API_URL : aiCfg.MIMO_API_URL;
        const model = isDeepSeek ? aiCfg.DEEPSEEK_MODEL : aiCfg.MIMO_MODEL;
        const providerName = isDeepSeek ? 'DeepSeek' : 'MiMo';

        if (!apiKey) {
            throw new Error(`[${providerName}] 未在 config.json 中设置 API 密钥`);
        }

        const body = { model, messages, max_tokens: 1024, temperature: 0.7 };
        if (tools && tools.length > 0) {
            body.tools = tools;
            body.tool_choice = 'auto';
        }

        const res = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`[${providerName}] API 错误 ${res.status}: ${errText}`);
        }

        const data = await res.json();
        const message = data.choices?.[0]?.message;
        if (!message) throw new Error(`[${providerName}] 空响应`);
        return message;
    }

    // ========== 支持工具调用的 AI 对话（多轮工具调用循环） ==========

    async function queryAIWithTools(userMessage, tools, ctx) {
        // 提示 AI 可以主动使用工具（基座部分，所有玩家通用）
        let toolHint = ' 重要规则：你拥有函数工具（function tools），每个工具对应一个可在Minecraft服务器上实际执行的命令。'
            + '当玩家询问金币余额等游戏内信息，你必须调用对应的工具函数来获取/执行，然后根据工具返回的真实结果回复。'
            + '严禁直接回复"我无法查看"等否定表述——工具赋予了你这些能力，直接使用即可。'
            + '注意：当玩家问"我有多少钱"或"查看XX的金币"时，必须将玩家ID作为参数传入money工具（如 money("玩家ID")），而不是无参调用。'
            + '【关键规则】你必须严格根据工具返回的结果回复玩家，不得编造或假设结果。如果工具返回错误信息，如实告知玩家具体错误。'
            + '【自身状态查询工具】所有玩家均可使用以下工具查询机器人的自身属性（这些直接读取 bot 本地数据，无需调用服务器命令，结果实时准确）：'
            + 'health = /health（查看血量、饥饿、护甲值等生命状态），effects = /effects（查看当前所有药水效果/buff/debuff），armor = /armor（查看当前装备），xp = /xp（查看经验等级和进度），oxygen = /oxygen（查看水下氧气剩余）。'
            + '当玩家问"你多少血""你有什么buff""身上的装备""经验多少""水下氧气"等问题时，直接调用对应工具获取数据后再回复。'
            + '【Residence 领地查询工具】（所有玩家可用）：res_info = /res info [领地名]（查询领地信息），res_list = /res list [玩家名]（查看领地列表），res_listall = /res listall（列出全部领地）。'
            + '当玩家问"查看领地""有哪些领地""这个领地是谁的"等请求时使用。注意这些工具会向服务器发送命令并等待响应，结果可能稍有延迟。';

        // 可信玩家专属工具说明
        if (ctx.isTrusted) {
            toolHint += '工具函数名与命令的对应关系：money = /money [玩家名]（查金币），pay = /pay 玩家名 金额（转账），inventory = /inv（查看背包物品）等。'
                + 'minechunk = /minechunk（挖掘当前区块所有可挖方块，自动切换背包中最优工具），当玩家说"挖矿""挖掘""帮我挖""把这里挖开"等请求时使用。'
                + 'bot_kill = /bot kill 用户名（下线指定机器人，包括自己下线），当玩家说"下线""关掉XX机器人""停止XX""让自己下线"等请求时使用。'
                + 'bot_spawn = /bot spawn 用户名（启动/上线指定机器人），当玩家说"启动XX机器人""上线XX""把XX打开"等请求时使用。'
                + 'server = /server 服务器名（通过菜单切换到指定子服，支持模糊匹配如"主服""S1""S3"），当玩家说"去XX服""切换到XX""换服""去主服/S1/S3"等请求时使用。'
                + '使用 minechunk 时，可传入半径参数控制挖掘范围，如 minechunk(3) 挖掘3格半径内的方块。'
                + 'attackloop = /attackloop [实体名] [范围]（持续攻击，默认攻击所有敌对生物，范围6格），当玩家说"挂机攻击""帮我清怪""刷袭击""打猪灵"等请求时使用。使用 /stop 停止。'
                + '【Residence 领地传送工具】（仅可信玩家可用）：res_tp = /res tp 领地名（传送到指定领地），res_tpa = /res tpa 领地名 玩家名（请求玩家传送到某领地）。'
                + '当玩家说"传送到XX领地""带我去XX领地""把YY传送到XX领地"等请求时使用。'
                + '【动作姿态工具】（仅可信玩家可用，均为切换式命令——调用一次进入姿态，再次调用同一工具即可恢复站立）：'
                + 'sit = /sit（坐下/站起），crawl = /crawl（趴下/站起），lay = /lay（躺下/站起），spin = /spin（旋转/停止），bellyflop = /bellyflop（肚子着地/站起）。'
                + '当玩家说"坐下""趴下""躺下""转圈""跳舞"等请求时使用对应工具。'
                + 'taunt = /taunt（连续快速蹲起约15次，持续约2秒，用作挑衅/嘲讽）。当玩家说"挑衅""嘲讽""蹲起"等请求时使用。'
                + '【取消姿态】sneak = /sneak（机器人自己按 Shift 再松开，可一键解除所有 GSit 姿势恢复站立）。'
                + '当玩家说"站起来""起来""恢复站立""取消坐下""别转圈了""停下"等请求时，直接调用 sneak() 或再次调用同一个工具即可。绝对不要叫玩家自己按 Shift——机器人自己会按。'
                + '注意：调用一次 spin() 后，机器人做出旋转动作，工具返回"已切换旋转状态"；如果此时玩家说"别转了"，你需要再调用一次 spin() 切回来，或者直接调用 sneak() 也可恢复站立。'
                + '【AFK挂机工具】（仅可信玩家可用）：afk = /afk [消息]（切换AFK状态，可选自定义消息）。'
                + '当玩家说"挂机""暂离""AFK"等请求时使用。'
                + '【重要安全保证】该账号免疫所有伤害（无敌），且始终在领地内操作（不会违规），并且一定已开启双击空格飞行。'
                + '但飞行会降低挖掘速度——机器人已优化为仅在目标高度差超过3格时才启动飞行，其余情况保持地面行走。'
                + '因此你无需担心跌落、岩浆、怪物等问题——大胆使用 minechunk 挖掘全部方块，不要畏手畏脚。';
        }
        // 注入对话记忆（仅文本消息，不含工具调用内部消息）
        const conv = getConversation(ctx.sender);
        const historyMessages = conv.messages.slice(-CONVERSATION_MAX_TURNS * 2);
        // 过滤掉工具调用轮次中的内部消息（只保留纯 user/assistant 对话）
        const pureHistory = [];
        for (const h of historyMessages) {
            if (h.role === 'user' || h.role === 'assistant') {
                pureHistory.push(h);
            }
        }

        const messages = [
            { role: 'system', content: systemPrompt + toolHint },
            ...pureHistory.slice(-CONVERSATION_MAX_TURNS * 2), // 对话历史
            { role: 'user', content: userMessage },
        ];

        let maxTurns = 20;

        while (maxTurns-- > 0) {
            let response;
            try {
                response = await callAIApi(messages, tools);
            } catch (err) {
                console.error(`${PREFIX} [AI-${aiProvider}] 工具调用循环中出错:`, err.message);
                return `[AI] 请求失败: ${err.message}`;
            }

            // 无 tool_calls → 最终回复
            if (!response.tool_calls || response.tool_calls.length === 0) {
                return response.content || '';
            }

            // 追加 assistant 消息（含 tool_calls）
            messages.push({
                role: 'assistant',
                content: response.content || null,
                tool_calls: response.tool_calls,
            });

            // 逐个执行工具调用
            for (const tc of response.tool_calls) {
                if (tc.type !== 'function') continue;

                const toolName = tc.function.name;
                let toolArgs = '';
                try {
                    const parsed = JSON.parse(tc.function.arguments);
                    // 查找匹配的命令定义以判断是否有结构化参数
                    const cmdName = '/' + toolName.replace(/_/g, ' ');
                    const cmdMatch = findCommand(cmdName);
                    if (cmdMatch && cmdMatch.def.toolParams) {
                        // 结构化参数：按 schema 顺序序列化为空格分隔的参数字符串
                        const parts = [];
                        for (const key of Object.keys(cmdMatch.def.toolParams)) {
                            if (parsed[key] !== undefined && parsed[key] !== null) {
                                parts.push(String(parsed[key]));
                            }
                        }
                        toolArgs = parts.join(' ');
                    } else {
                        toolArgs = parsed.args || '';
                    }
                } catch (e) {
                    toolArgs = tc.function.arguments || '';
                }

                console.log(`${PREFIX} [工具调用] ${toolName}(${toolArgs || '无参数'})`);
                const result = await executeToolCall(toolName, toolArgs, ctx);
                const shortResult = result.length > 150 ? result.slice(0, 150) + '...' : result;
                console.log(`${PREFIX} [工具结果] ${shortResult}`);

                messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: result,
                });
            }
        }

        return '[AI] 工具调用次数过多，已自动终止。请稍后再试。';
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
        // AI 工具调用未匹配任何命令 → 直接返回（避免回退到 handleAIChat 导致递归）
        if (ctx.type === 'tool') return;

        // 私聊 / @提及 / >>回复 / QQ群@ → 一律进入 AI 对话
        await handleAIChat(ctx);
    }

    // ================================================================
    //  合成站自动化 — 状态机 & 阶段函数
    // ================================================================

    // ---- 预检清理（重启时清理上次中断残留） ----

    async function runPreflightCleanup(inputName, outputName) {
        if (!bot.entity) return;
        const logParts = [];
        let totalDeposited = 0;
        let totalCrafted = 0;

        // Step 1: 检查背包中是否有产物 → 存入产物盒
        let outputItems = bot.inventory.items().filter(i => i.name === outputName);
        if (outputItems.length > 0) {
            const totalOutput = outputItems.reduce((sum, i) => sum + i.count, 0);

            const dest = findDestChest();
            if (dest) {
                try {
                    const cw = await bot.openChest(dest);
                    outputItems = bot.inventory.items().filter(i => i.name === outputName);
                    for (const item of outputItems) {
                        try { await cw.deposit(item.type, item.metadata, item.count); totalDeposited += item.count; } catch (e) { /* 盒子满 */ }
                    }
                    await cw.close();
                    if (totalDeposited > 0) logParts.push(`存入 ${totalDeposited} 个产物`);
                } catch (err) {
                    // 开产物盒失败，跳过
                }
            }
        }

        // Step 2: 检查背包中是否有原材料 → 合成
        let inputItems = bot.inventory.items().filter(i => i.name === inputName);
        if (inputItems.length >= 9) {
            const totalInput = inputItems.reduce((sum, i) => sum + i.count, 0);

            const table = findCraftingTable();
            if (table) {
                craftStationTablePos = table.position;
                try {
                    const window = await new Promise((resolve, reject) => {
                        const timeout = setTimeout(() => {
                            bot.off('windowOpen', onWindow);
                            reject(new Error('打开工作台超时'));
                        }, 5000);
                        const onWindow = (win) => { clearTimeout(timeout); resolve(win); };
                        bot.once('windowOpen', onWindow);
                        bot.activateBlock(table);
                    });

                    if (!isCraftingTableWindow(window)) {
                        try { bot.closeWindow(window); } catch (e) { /* ignore */ }
                    } else {
                        const GRID_START = 1;
                        const RESULT_SLOT = 0;
                        let batches = 0;
                        while (true) {
                            const invStart = window.inventoryStart ?? window.slots.length;
                            const srcSlots = [];
                            for (let i = invStart; i < window.slots.length; i++) {
                                const item = window.slots[i];
                                if (item && item.name === inputName && item.count > 0) {
                                    srcSlots.push({ slot: i, count: item.count });
                                }
                            }
                            srcSlots.sort((a, b) => b.count - a.count);
                            if (srcSlots.length < 9) break;

                            const batch = srcSlots.slice(0, 9);
                            const minCount = batch[8].count;
                            for (let gi = 0; gi < 9; gi++) {
                                await bot.clickWindow(batch[gi].slot, 0, 0);
                                await bot.clickWindow(GRID_START + gi, 0, 0);
                            }
                            await sleep(200);
                            await bot.clickWindow(RESULT_SLOT, 0, 1);
                            totalCrafted += minCount;
                            batches++;
                            await sleep(100);
                        }
                        try { bot.closeWindow(window); } catch (e) { /* ignore */ }
                        if (totalCrafted > 0) {
                            logParts.push(`合成 ${totalCrafted} 个产物（${batches} 批）`);
                            craftStationTotalCrafted += totalCrafted;
                        }
                    }
                } catch (err) {
                    // 合成失败，跳过
                }
            }
        }

        // Step 3: 存入新合成的产物
        if (totalCrafted > 0) {
            outputItems = bot.inventory.items().filter(i => i.name === outputName);
            if (outputItems.length > 0) {
                const dest = findDestChest();
                if (dest) {
                    try {
                        const cw = await bot.openChest(dest);
                        let depCount = 0;
                        for (const item of outputItems) {
                            try { await cw.deposit(item.type, item.metadata, item.count); depCount += item.count; } catch (e) { /* ignore */ }
                        }
                        await cw.close();
                        if (depCount > 0) logParts.push(`再存入 ${depCount} 个产物`);
                    } catch (err) {
                        // 再存产物失败
                    }
                }
            }
        }

        // Step 4: 汇报预检结果
        if (logParts.length > 0 && craftStationSender) {
            safeWhisper(craftStationSender, `[合成站-预检] ${logParts.join('，')}`);
        }
        if (logParts.length > 0) {
            console.log(`${PREFIX} [合成站-预检] ${logParts.join('，')}`);
        }
    }

    // ---- 主控 ----

    async function startCraftStation(inputName, outputName, cycles, sender) {
        if (!bot.entity) return '[合成站] 机器人尚未完全加载';
        // 如果已有运行中的合成站，先停掉
        if (craftStationActive) stopCraftStation(true);

        // 先设置状态变量（预检需要用到 sender 和 outputName 等）
        craftStationInputName = inputName;
        craftStationOutputName = outputName;
        craftStationCycles = cycles || 0; // 0 = infinite
        craftStationSender = sender;
        craftStationActive = true;
        craftStationPendingStop = false;
        craftStationCycleCount = 0;
        craftStationTotalCrafted = 0;
        craftStationRetries = 0;
        craftStationStartTime = Date.now();
        craftStationSourcePos = null;
        // 停掉 anti-AFK 右键（避免干扰 GUI）
        if (bot.activateItemInterval) {
            clearInterval(bot.activateItemInterval);
            bot.activateItemInterval = null;
        }

        // ---- 预检清理：恢复上次中断的残留物品 ----
        try {
            await runPreflightCleanup(inputName, outputName);
        } catch (err) {
            console.error(`${PREFIX} [合成站-预检] 预检异常:`, err.message);
        }

        // 检查背包空位：单次循环需要 27 组原材料空间，不足则警告
        const invStart = bot.inventory.inventoryStart ?? 9;
        const invEnd = bot.inventory.inventoryEnd ?? 44;
        const totalSlots = invEnd - invStart + 1; // 通常 36
        const emptySlots = bot.inventory.slots.slice(invStart, invEnd + 1).filter(s => !s).length;
        const needSlots = 27;
        let spaceWarning = '';
        if (emptySlots < needSlots) {
            spaceWarning = ` ⚠️ 背包仅 ${emptySlots}/${totalSlots} 空位（建议 ≥${needSlots}），可能导致物品掉落!`;
            console.warn(`${PREFIX} [合成站] ${spaceWarning}`);
        }

        craftStationState = 'FIND_CHESTS';
        scheduleTick(500);
        return `[合成站] 已启动: ${inputName} → ${outputName}${cycles > 0 ? ' (最大 ' + cycles + ' 循环)' : ' (无限循环)'}${spaceWarning}`;
    }

    function stopCraftStation(immediate) {
        if (!craftStationActive) return '[合成站] 当前未运行';
        if (immediate) {
            cleanupStation('[合成站] 已强制停止');
            if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow); } catch (e) { /* ignore */ } }
            if (!bot.activateItemInterval && bot._startTime) {
                bot.activateItemInterval = setInterval(() => bot.activateItem(), 50);
            }
            return '[合成站] 已强制停止';
        }
        craftStationPendingStop = true;
        return '[合成站] 将在当前循环结束后停止';
    }

    function cleanupStation(reportMsg) {
        craftStationActive = false;
        craftStationAwaitingWindow = false;
        craftStationState = 'IDLE';
        if (craftStationLoopTimer) { clearTimeout(craftStationLoopTimer); craftStationLoopTimer = null; }
        const durSec = craftStationStartTime > 0 ? Math.round((Date.now() - craftStationStartTime) / 1000) : 0;
        const durStr = durSec >= 3600 ? `${Math.floor(durSec/3600)}h${Math.floor((durSec%3600)/60)}m`
            : durSec >= 60 ? `${Math.floor(durSec/60)}m${durSec%60}s` : `${durSec}s`;
        if (reportMsg) {
            const summary = `${reportMsg} | 合成 ${craftStationTotalCrafted} 个产物 | ${craftStationCycleCount} 循环 | 运行 ${durStr}`;
            console.log(`${PREFIX} ${summary}`);
            if (craftStationSender) safeWhisper(craftStationSender, summary);
        }
        if (!bot.activateItemInterval && bot._startTime) {
            bot.activateItemInterval = setInterval(() => bot.activateItem(), 50);
        }
    }

    function failStation(msg) {
        console.error(`${PREFIX} ${msg}`);
        cleanupStation(msg);
    }

    function scheduleTick(delay) {
        if (!craftStationActive) return;
        if (craftStationLoopTimer) clearTimeout(craftStationLoopTimer);
        craftStationLoopTimer = setTimeout(() => { craftStationLoopTimer = null; executeState(); }, delay);
    }

    function executeState() {
        if (!craftStationActive) return;
        switch (craftStationState) {
            case 'FIND_CHESTS': phaseFindChests(); break;
            case 'WITHDRAW':    phaseWithdraw();   break;
            case 'CRAFT':       phaseCraft();      break;
            case 'DEPOSIT':     phaseDeposit();    break;
            case 'CHECK':       phaseCheck();      break;
            case 'STOPPING':    cleanupStation('[合成站] 已完成'); break;
            default:            failStation('[合成站] 未知状态，已停止');
        }
    }

    // ---- 窗口类型判断 ----

    function isCraftingTableWindow(window) {
        const type = String(window.type || '').toLowerCase();
        return type.includes('craft') || type.includes('crafting');
    }

    // ---- FIND_CHESTS 阶段 ----

    // 重试日志节流：仅第 1、5、10+ 次输出，避免刷屏
    function shouldLogRetry(retries) {
        return retries === 1 || retries === 5 || retries >= 10;
    }

    function phaseFindChests() {
        const src = findSourceChest();
        const dst = findDestChest();
        if (!src || !dst) {
            craftStationRetries++;
            if (craftStationRetries > 10) {
                failStation(`[合成站] 探测箱子超时: 左=${src ? 'OK' : '缺失'} 右=${dst ? 'OK' : '缺失'}，盒子耗尽`);
                return;
            }
            scheduleTick(3000);
            return;
        }
        craftStationRetries = 0;
        craftStationSourcePos = src.position;
        craftStationDestPos = dst.position;
        craftStationState = 'WITHDRAW';
        scheduleTick(200);
    }

    // ---- WITHDRAW 阶段 ----

    async function phaseWithdraw() {
        // 优先用已缓存的坐标精确定位，避免误触其他方块
        let chest = null;
        if (craftStationSourcePos) {
            chest = bot.blockAt(craftStationSourcePos);
            // 检查是不是盒子被拆了（机器在换盒）—— 不 fallback，原地等
            if (!chest || !isContainerBlock(chest.name)) {
                craftStationRetries++;
                if (craftStationRetries > 10) { failStation('[合成站] 左侧盒子缺失，原材料耗尽'); return; }
                // 不清空坐标 —— 机器换盒后会放在同一位置
                scheduleTick(3000);
                return;
            }
        } else {
            chest = findSourceChest();
            if (!chest) {
                craftStationRetries++;
                if (craftStationRetries > 10) { failStation('[合成站] 未找到左侧盒子，原材料耗尽'); return; }
                scheduleTick(3000);
                return;
            }
            // 记住位置，后续重试都用这个坐标
            craftStationSourcePos = chest.position;
        }

        // 打开前再次确认方块存在且是容器（防止异步期间被拆除）
        const verifyBlock = bot.blockAt(chest.position);
        if (!verifyBlock || !isContainerBlock(verifyBlock.name)) {
            craftStationRetries++;
            if (craftStationRetries > 10) { failStation('[合成站] 左侧盒子在打开前被移除，原材料耗尽'); return; }
            scheduleTick(1500);
            return;
        }

        try {
            const cw = await bot.openChest(verifyBlock);
            let totalWithdrawn = 0;
            // 兼容不同 mineflayer 版本: Chest 可能直接有 inventoryStart/slots，也可能通过 .window 暴露
            const win = (cw.inventoryStart !== undefined) ? cw : (cw.window || cw);
            const end = win.inventoryStart ?? win.slots?.length ?? 0;
            const slots = win.slots ?? [];
            for (let s = 0; s < end; s++) {
                const item = slots[s];
                if (item && item.name === craftStationInputName) {
                    try {
                        await cw.withdraw(item.type, item.metadata, item.count);
                        totalWithdrawn += item.count;
                    } catch (e) { /* slot withdraw fail, try next */ }
                }
            }
            await cw.close();
            if (totalWithdrawn === 0) {
                craftStationRetries++;
                if (craftStationRetries > 10) { failStation('[合成站] 左侧盒子持续为空，原材料耗尽'); return; }
                scheduleTick(3000);
                return;
            }
            craftStationRetries = 0;
            craftStationState = 'CRAFT';
            scheduleTick(300);
        } catch (err) {
            craftStationRetries++;
            if (craftStationRetries > 10) { failStation(`[合成站] 开左侧盒子失败: ${err.message}`); return; }
            scheduleTick(3000);
        }
    }

    // ---- CRAFT 阶段 ----

    function phaseCraft() {
        const table = findCraftingTable();
        if (!table) {
            failStation('[合成站] 未找到工作台');
            return;
        }
        craftStationTablePos = table.position;
        craftStationAwaitingWindow = true;
        // 设置超时：5 秒内未收到窗口打开事件则失败
        const timeoutId = setTimeout(() => {
            if (craftStationAwaitingWindow && craftStationState === 'CRAFT') {
                craftStationAwaitingWindow = false;
                failStation('[合成站] 打开工作台超时');
            }
        }, 5000);
        // 保存 timeoutId 以便在窗口打开时清除
        craftStationLoopTimer = timeoutId;
        bot.activateBlock(table);
        // activateBlock 之后 windowOpen 事件会触发 → handleCraftingWindow()
    }

    // ---- CRAFT 窗口处理（由 windowOpen 事件调用） ----

    async function handleCraftingWindow(window) {
        // 清除超时
        if (craftStationLoopTimer) { clearTimeout(craftStationLoopTimer); craftStationLoopTimer = null; }
        craftStationAwaitingWindow = false;

        if (!isCraftingTableWindow(window)) {
            try { bot.closeWindow(window); } catch (e) { /* ignore */ }
            failStation('[合成站] 打开工作台时收到非合成窗口，已停止');
            return;
        }

        const GRID_START = 1;
        const GRID_END = 9;
        const RESULT_SLOT = 0;
        let batchesDone = 0;

        try {
            // 持续合成直到原材料不足 9 组
            while (craftStationActive) {
                // 扫描背包中原材料槽位（按数量降序，优先取大堆）
                const invStart = window.inventoryStart ?? window.slots.length;
                const srcSlots = [];
                for (let i = invStart; i < window.slots.length; i++) {
                    const item = window.slots[i];
                    if (item && item.name === craftStationInputName && item.count > 0) {
                        srcSlots.push({ slot: i, count: item.count });
                    }
                }
                srcSlots.sort((a, b) => b.count - a.count);

                if (srcSlots.length < 9) {
                    // 不足 9 个槽位 → 无法继续批处理
                    break;
                }

                // 取前 9 个最大堆
                const batch = srcSlots.slice(0, 9);
                const minCount = batch[8].count; // 9 堆中最少的决定产出数

                // 逐格填写：左键取整组 → 左键放入格子
                for (let gi = 0; gi < 9; gi++) {
                    await bot.clickWindow(batch[gi].slot, 0, 0);  // 拿起整组
                    await bot.clickWindow(GRID_START + gi, 0, 0);  // 放入格子
                }

                // 等待服务端计算配方
                await sleep(200);

                // Shift+左键取走产物（全部产出直接进背包）
                await bot.clickWindow(RESULT_SLOT, 0, 1);

                batchesDone++;
                craftStationTotalCrafted += minCount;

                // 小延时让服务端同步
                await sleep(100);
            }

        } catch (err) {
            console.error(`${PREFIX} [合成站] 合成过程异常:`, err.message);
        }

        // 关闭工作台
        try { bot.closeWindow(window); } catch (e) { /* ignore */ }

        // 进入存物阶段
        craftStationState = 'DEPOSIT';
        scheduleTick(300);
    }

    // ---- DEPOSIT 阶段 ----

    async function phaseDeposit() {
        // 先检查背包是否还有产物
        const remaining = bot.inventory.items().filter(i => i.name === craftStationOutputName);
        if (remaining.length === 0) {
            craftStationState = 'CHECK';
            scheduleTick(200);
            return;
        }

        // 优先用已缓存的坐标精确定位，避免误触其他方块
        let chest = null;
        if (craftStationDestPos) {
            chest = bot.blockAt(craftStationDestPos);
            if (!chest || !isContainerBlock(chest.name)) {
                craftStationRetries++;
                if (craftStationRetries > 10) { failStation('[合成站] 右侧盒子缺失，产物盒耗尽'); return; }
                // 不清空坐标 —— 机器换盒后会放在同一位置
                scheduleTick(3000);
                return;
            }
        } else {
            chest = findDestChest();
            if (!chest) {
                craftStationRetries++;
                if (craftStationRetries > 10) { failStation('[合成站] 未找到右侧盒子，产物盒耗尽'); return; }
                scheduleTick(3000);
                return;
            }
            craftStationDestPos = chest.position;
        }

        // 打开前再次确认方块存在（防止异步期间被拆除）
        const verifyBlock = bot.blockAt(chest.position);
        if (!verifyBlock || !isContainerBlock(verifyBlock.name)) {
            craftStationRetries++;
            if (craftStationRetries > 10) { failStation('[合成站] 右侧盒子在打开前被移除，产物盒耗尽'); return; }
            scheduleTick(1500);
            return;
        }

        try {
            const cw = await bot.openChest(verifyBlock);
            const outputItems = bot.inventory.items().filter(i => i.name === craftStationOutputName);
            let totalDeposited = 0;
            if (outputItems.length > 0) {
                for (const item of outputItems) {
                    try {
                        await cw.deposit(item.type, item.metadata, item.count);
                        totalDeposited += item.count;
                    } catch (e) {
                        // 箱子满 or 物品无法存入 → 试下一个
                    }
                }
            }
            await cw.close();

            // 检查是否还有产物残留（盒子满了，部分物品没存进去）
            const stillRemaining = bot.inventory.items().filter(i => i.name === craftStationOutputName);
            if (stillRemaining.length > 0 && totalDeposited === 0) {
                // 一点都没存进去 → 盒子满或不存在，等待换盒
                craftStationRetries++;
                if (craftStationRetries > 10) { failStation('[合成站] 右侧盒子持续无法存入，产物盒耗尽'); return; }
                scheduleTick(3000);
                return;
            }
            if (stillRemaining.length > 0) {
                // 存了一部分但盒子满了 → 继续等新盒子
                scheduleTick(2000);
                return;
            }

            // 全部存完
            craftStationRetries = 0;
            craftStationState = 'CHECK';
            scheduleTick(200);
        } catch (err) {
            craftStationRetries++;
            if (craftStationRetries > 10) { failStation(`[合成站] 开右侧盒子失败: ${err.message}`); return; }
            scheduleTick(3000);
        }
    }

    // ---- CHECK 阶段 ----

    function phaseCheck() {
        craftStationCycleCount++;

        if (craftStationPendingStop) {
            cleanupStation(`[合成站] 已按请求停止`);
            return;
        }
        if (craftStationCycles > 0 && craftStationCycleCount >= craftStationCycles) {
            cleanupStation(`[合成站] 已完成 ${craftStationCycles} 次循环`);
            return;
        }
        craftStationState = 'FIND_CHESTS';
        scheduleTick(500);
    }

    // ================================================================
    //  洗潜影盒自动化
    // ================================================================

    /** 洗盒专用走向目标（独立于采矿状态） */
    function walkToWashTarget(targetPos, minDist = 3.0) {
        return new Promise((resolve) => {
            if (!targetPos) return resolve(false);
            const maxTime = 25000;
            const startTime = Date.now();

            const stopMove = () => {
                for (const ctrl of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
                    bot.setControlState(ctrl, false);
                }
            };

            function step() {
                if (!washStationActive) { stopMove(); return resolve(false); }

                const myPos = bot.entity.position;
                const dist = myPos.distanceTo(targetPos);
                if (dist <= minDist) { stopMove(); return resolve(true); }

                if (Date.now() - startTime > maxTime) { stopMove(); return resolve(false); }

                const dx = targetPos.x - myPos.x;
                const dz = targetPos.z - myPos.z;
                const horizDist = Math.sqrt(dx * dx + dz * dz);
                if (horizDist > 0.3) {
                    bot.lookAt(targetPos.offset(0, 0.5, 0), false);
                }

                bot.setControlState('forward', true);
                if (dist > 6) bot.setControlState('sprint', true);
                else bot.setControlState('sprint', false);

                setTimeout(step, 150);
            }

            step();
        });
    }

    /** 确保靠近目标位置 */
    async function ensureNearPos(pos, label, minDist = 3.5) {
        if (!pos) { console.error(`${PREFIX} [洗盒] ${label} 坐标未配置`); return false; }
        const dist = bot.entity.position.distanceTo(pos);
        if (dist <= minDist) return true;
        console.log(`${PREFIX} [洗盒] 距离 ${label} 约 ${dist.toFixed(1)} 格，走过去...`);
        const ok = await walkToWashTarget(pos, minDist);
        if (!ok) {
            console.log(`${PREFIX} [洗盒] 无法到达 ${label} @ (${pos.x}, ${pos.y}, ${pos.z})，距离 ${dist.toFixed(1)} 格`);
        }
        return ok;
    }

    /** 在炼药锅上执行一次交互（需先装备好手中物品） */
    async function interactCauldron() {
        const cauldronBlock = bot.blockAt(washStationCauldronPos);
        if (!cauldronBlock) throw new Error('炼药锅方块不存在');
        // 检查手持物品
        const held = bot.heldItem;
        if (!held) {
            console.log(`${PREFIX} [洗盒] interactCauldron: 手上无物品，跳过`);
            throw new Error('手上无物品，无法与炼药锅交互');
        }
        if (!isWaterBucket(held.name) && !isDyedShulkerBox(held.name)) {
            console.log(`${PREFIX} [洗盒] interactCauldron: 手上物品不是水桶或染色盒子 (${held.name})，跳过`);
            throw new Error(`手上物品 ${held.name} 不能与炼药锅交互`);
        }
        const levelBefore = getCauldronWaterLevel(washStationCauldronPos);
        // 确保视角朝向炼药锅（增加成功率）
        bot.lookAt(washStationCauldronPos.offset(0.5, 0.5, 0.5), true);
        await sleep(150);
        bot.activateBlock(cauldronBlock);
        await sleep(500); // 等待服务端处理 + 区块更新
        // 验证交互结果
        const levelAfter = getCauldronWaterLevel(washStationCauldronPos, true);
        console.log(`${PREFIX} [洗盒] 炼药锅交互: ${cauldronBlock.name} 水位 ${levelBefore}→${levelAfter} (手持: ${held.name})`);
    }

    /** 与水方块交互（填充空桶），支持水源方块和含水方块。返回 true=成功装水 */
    async function interactWaterSource() {
        // 记录交互前手持物品
        const heldBefore = bot.heldItem;
        if (!heldBefore) throw new Error('手上没有物品，无法装水');
        if (!isEmptyBucket(heldBefore.name)) {
            console.log(`${PREFIX} [洗盒] 手上不是空桶 (${heldBefore.name})，无法装水`);
            return false;
        }

        // 确定实际用水源方块 — 指定坐标 + 附近搜索回退
        let waterBlock = bot.blockAt(washStationWaterPos);
        const configuredBlock = waterBlock;
        if (!waterBlock || !isWaterSourceBlock(waterBlock)) {
            if (configuredBlock) {
                console.log(`${PREFIX} [洗盒] 指定水源坐标 "${configuredBlock.name}" 不是水源 (props=${JSON.stringify(configuredBlock.properties || {})})，搜索附近水源...`);
            } else {
                console.log(`${PREFIX} [洗盒] 指定水源坐标无方块，搜索附近水源...`);
            }
            const nearby = findNearbyWater(washStationWaterPos, 5);
            if (nearby) {
                console.log(`${PREFIX} [洗盒] 在附近 (${nearby.position.x}, ${nearby.position.y}, ${nearby.position.z}) 找到水源: ${nearby.name}`);
                waterBlock = nearby;
            } else {
                console.log(`${PREFIX} [洗盒] 指定坐标半径5格内未找到水源方块，请用 -water 指定正确的水源坐标`);
                return false;
            }
        }

        const waterPos = waterBlock.position;
        const myPos = bot.entity.position;
        const dist = myPos.distanceTo(waterPos);
        console.log(`${PREFIX} [洗盒] 水源方块: ${waterBlock.name} @ (${waterPos.x},${waterPos.y},${waterPos.z})，bot距离 ${dist.toFixed(1)} 格`);

        // 如果距离超过4格，走近水源
        if (dist > 3.5) {
            console.log(`${PREFIX} [洗盒] 距离水源 ${dist.toFixed(1)} 格，走过去...`);
            if (!(await walkToWashTarget(waterPos, 2.0))) {
                console.log(`${PREFIX} [洗盒] 无法走到水源旁边`);
                return false;
            }
            // 重新获取方块引用（走过之后引用可能失效）
            waterBlock = bot.blockAt(waterPos);
            if (!waterBlock) {
                console.log(`${PREFIX} [洗盒] 走到水源旁后找不到方块了`);
                return false;
            }
        }

        // 尝试交互 — 看水源方块的面
        bot.lookAt(waterPos.offset(0.5, 0.5, 0.5), true);
        await sleep(200);
        console.log(`${PREFIX} [洗盒] 右键水源方块: ${waterBlock.name}`);
        bot.activateBlock(waterBlock);
        await sleep(500);

        // 验证手持物品是否变成水桶
        let heldAfter = bot.heldItem;
        if (heldAfter && isWaterBucket(heldAfter.name)) {
            console.log(`${PREFIX} [洗盒] 装水成功: 空桶 → 水桶 (水源: ${waterBlock.name} @ ${waterPos.x},${waterPos.y},${waterPos.z})`);
            return true;
        }

        // 第一次没成功，回退：尝试 activateItem（有些服务器/版本需要这种方式）
        console.log(`${PREFIX} [洗盒] activateBlock 未成功 (手持=${heldAfter ? heldAfter.name : '空手'})，尝试 activateItem...`);
        // 重新装备空桶确保手持正确
        const emptyInInv = bot.inventory.items().find(i => isEmptyBucket(i.name));
        if (emptyInInv) {
            await bot.equip(emptyInInv, 'hand');
            await sleep(200);
        }
        bot.lookAt(waterPos.offset(0.5, 0.5, 0.5), true);
        await sleep(150);
        bot.activateItem();  // 某些情况需要 activateItem 而不是 activateBlock
        await sleep(500);

        heldAfter = bot.heldItem;
        if (heldAfter && isWaterBucket(heldAfter.name)) {
            console.log(`${PREFIX} [洗盒] activateItem 装水成功: 空桶 → 水桶`);
            return true;
        }

        // 装水失败
        console.log(`${PREFIX} [洗盒] 装水失败: activateBlock + activateItem 都未成功。交互前=${heldBefore.name}，最终手持=${heldAfter ? heldAfter.name : '空手'}`);
        return false;
    }

    // ---- 洗盒预检 ----

    async function runWashPreflight() {
        if (!bot.entity) return;
        const logParts = [];

        // Step 1: 检查背包是否有无色盒子 → 存入 E
        let undyedItems = bot.inventory.items().filter(i => isUndyedShulkerBox(i.name));
        if (undyedItems.length > 0) {
            const total = undyedItems.reduce((s, i) => s + i.count, 0);
            console.log(`${PREFIX} [洗盒-预检] 背包有 ${total} 个无色盒子，先存入 E`);
            if (washStationUndyedPos) {
                const chest = bot.blockAt(washStationUndyedPos);
                if (chest && isContainerBlock(chest.name)) {
                    try {
                        const cw = await bot.openChest(chest);
                        undyedItems = bot.inventory.items().filter(i => isUndyedShulkerBox(i.name));
                        let depCount = 0;
                        for (const item of undyedItems) {
                            try { await cw.deposit(item.type, item.metadata, item.count); depCount += item.count; } catch (e) { /* ignore */ }
                        }
                        await cw.close();
                        if (depCount > 0) logParts.push(`存入 ${depCount} 个无色盒子`);
                    } catch (err) {
                        console.log(`${PREFIX} [洗盒-预检] 开E容器失败: ${err.message}`);
                    }
                } else {
                    console.log(`${PREFIX} [洗盒-预检] E容器坐标方块不是容器，跳过存盒`);
                }
            }
        }

        // Step 2: 检查背包是否有空桶 → 去A装水
        const emptyBuckets = bot.inventory.items().filter(i => isEmptyBucket(i.name));
        if (emptyBuckets.length > 0 && washStationWaterPos) {
            console.log(`${PREFIX} [洗盒-预检] 背包有 ${emptyBuckets.length} 个空桶，去水源装水`);
            if (await ensureNearPos(washStationWaterPos, '水源A')) {
                let filled = 0;
                for (const bucket of emptyBuckets) {
                    try {
                        await bot.equip(bucket, 'hand');
                        await sleep(200);
                        const ok = await interactWaterSource();
                        if (ok) filled++;
                    } catch (err) {
                        console.log(`${PREFIX} [洗盒-预检] 装水失败: ${err.message}`);
                    }
                }
                if (filled > 0) {
                    console.log(`${PREFIX} [洗盒-预检] 成功装水 ${filled}/${emptyBuckets.length} 个桶`);
                } else {
                    console.log(`${PREFIX} [洗盒-预检] 装水全部失败，请检查水源坐标 (${washStationWaterPos.x}, ${washStationWaterPos.y}, ${washStationWaterPos.z}) 是否为可装水的方块`);
                }
            }
        }

        // Step 3: 验证水源（如果配置了 -water）— 检查并搜索附近备选
        if (washStationWaterPos) {
            const waterBlock = bot.blockAt(washStationWaterPos);
            if (!waterBlock) {
                console.log(`${PREFIX} [洗盒-预检] 水源坐标 (${washStationWaterPos.x}, ${washStationWaterPos.y}, ${washStationWaterPos.z}) 处无方块（区块未加载?）`);
            } else {
                const props = JSON.stringify(waterBlock.properties || {});
                const isWater = isWaterSourceBlock(waterBlock);
                console.log(`${PREFIX} [洗盒-预检] 水源方块: ${waterBlock.name} properties=${props} isWaterSource=${isWater}`);
                if (!isWater) {
                    const nearby = findNearbyWater(washStationWaterPos, 5);
                    if (nearby) {
                        console.log(`${PREFIX} [洗盒-预检] ⚠ 指定坐标不是水源，但在附近 (${nearby.position.x}, ${nearby.position.y}, ${nearby.position.z}) 找到: ${nearby.name} — 运行时会自动使用`);
                        logParts.push(`水源: ${waterBlock.name} ✗ → 自动用附近 ${nearby.name} @ (${nearby.position.x},${nearby.position.y},${nearby.position.z})`);
                    } else {
                        console.log(`${PREFIX} [洗盒-预检] ⚠ 指定坐标不是水源，且半径5格内无可用水源！请用 -water 重新指定`);
                        logParts.push(`水源: ${waterBlock.name} ✗ (附近5格无水!)`);
                    }
                } else {
                    logParts.push(`水源: ${waterBlock.name} ✓`);
                }
            }
        } else {
            console.log(`${PREFIX} [洗盒-预检] 未配置水源(-water)，将只能用水桶补水`);
        }

        // 验证C容器（如果配置了 -bucket）
        if (washStationBucketPos) {
            const bucketChest = bot.blockAt(washStationBucketPos);
            if (!bucketChest) {
                console.log(`${PREFIX} [洗盒-预检] C容器坐标 (${washStationBucketPos.x}, ${washStationBucketPos.y}, ${washStationBucketPos.z}) 处无方块！`);
            } else if (!isContainerBlock(bucketChest.name)) {
                console.log(`${PREFIX} [洗盒-预检] C容器坐标处不是容器！当前方块: ${bucketChest.name}`);
            } else {
                logParts.push(`C容器有效: ${bucketChest.name}`);
            }
        }

        // Step 4: 检查炼药锅水位，装满
        if (washStationCauldronPos) {
            const cauldronBlock = bot.blockAt(washStationCauldronPos);
            console.log(`${PREFIX} [洗盒-预检] 炼药锅坐标方块: ${cauldronBlock ? cauldronBlock.name + ' properties=' + JSON.stringify(cauldronBlock.properties || {}) + ' metadata=' + cauldronBlock.metadata : 'null(区块未加载?)'}`);
            getCauldronWaterLevel(washStationCauldronPos, true); // 诊断输出
            const level = getCauldronWaterLevel(washStationCauldronPos);
            if (level >= 0 && level < 3) {
                console.log(`${PREFIX} [洗盒-预检] 炼药锅水位 ${level}/3，补满`);
                await fillCauldronToFull();
                const newLevel = getCauldronWaterLevel(washStationCauldronPos);
                washStationCauldronLevel = Math.max(0, newLevel);
                if (washStationCauldronLevel >= 3) logParts.push(`炼药锅已补满 (${washStationCauldronLevel}/3)`);
            } else if (level >= 3) {
                washStationCauldronLevel = level;
                logParts.push(`炼药锅已满 (${level}/3)`);
            } else {
                console.log(`${PREFIX} [洗盒-预检] 炼药锅状态异常 level=${level}，请检查坐标是否正确`);
            }
        }

        // Step 5: 检查背包是否有染色盒子（上次中断残留） → 直接洗完
        let dyedItems = bot.inventory.items().filter(i => isDyedShulkerBox(i.name));
        if (dyedItems.length > 0) {
            const total = dyedItems.reduce((s, i) => s + i.count, 0);
            console.log(`${PREFIX} [洗盒-预检] 背包有 ${total} 个染色盒子（中断残留），先洗完`);
            if (washStationCauldronPos && washStationCauldronLevel > 0) {
                await ensureNearPos(washStationCauldronPos, '炼药锅B');
                let washedCount = 0;
                // 逐个洗涤，每洗完一个重新扫描（染色→无色改变物品）
                while (washStationActive) {
                    dyedItems = bot.inventory.items().filter(i => isDyedShulkerBox(i.name));
                    if (dyedItems.length === 0) break;
                    try {
                        await washOneBox(dyedItems[0]);
                        washedCount++;
                    } catch (err) {
                        console.log(`${PREFIX} [洗盒-预检] 洗盒失败: ${err.message}`);
                        break;
                    }
                    await sleep(200);
                }
                if (washedCount > 0) logParts.push(`预洗 ${washedCount} 个染色盒子`);
            } else if (washStationCauldronLevel <= 0) {
                console.log(`${PREFIX} [洗盒-预检] 炼药锅无水，跳过预洗残留染色盒`);
            }
            // 把洗完的存入 E
            undyedItems = bot.inventory.items().filter(i => isUndyedShulkerBox(i.name));
            if (undyedItems.length > 0 && washStationUndyedPos) {
                const chest = bot.blockAt(washStationUndyedPos);
                if (chest && isContainerBlock(chest.name)) {
                    try {
                        const cw = await bot.openChest(chest);
                        let depCount = 0;
                        for (const item of undyedItems) {
                            try { await cw.deposit(item.type, item.metadata, item.count); depCount += item.count; } catch (e) { /* ignore */ }
                        }
                        await cw.close();
                        if (depCount > 0) logParts.push(`预洗后存入 ${depCount} 个无色盒子`);
                    } catch (err) {
                        console.log(`${PREFIX} [洗盒-预检] 存盒失败: ${err.message}`);
                    }
                }
            }
        }

        if (logParts.length > 0 && washStationSender) {
            safeWhisper(washStationSender, `[洗盒-预检] ${logParts.join('，')}`);
        }
        if (logParts.length > 0) {
            console.log(`${PREFIX} [洗盒-预检] ${logParts.join('，')}`);
        }
    }

    /** 将炼药锅装满水（从水源取水），返回 true=成功装满 */
    async function fillCauldronToFull() {
        if (!washStationActive) return false;
        let level = getCauldronWaterLevel(washStationCauldronPos);
        if (level < 0 || level === -2) {
            console.log(`${PREFIX} [洗盒] 炼药锅状态异常 (level=${level})，无法装水`);
            return false;
        }
        const needed = 3 - level;
        if (needed <= 0) return true; // 已满

        // 确保靠近炼药锅
        if (!(await ensureNearPos(washStationCauldronPos, '炼药锅B'))) return false;

        // 收集背包中的水桶
        let waterBuckets = bot.inventory.items().filter(i => isWaterBucket(i.name));
        let fills = 0;

        for (const bucket of waterBuckets) {
            if (!washStationActive) break;
            if (fills >= needed) break;
            try {
                await bot.equip(bucket, 'hand');
                await sleep(200);
                await interactCauldron();
                fills++;
            } catch (err) {
                console.log(`${PREFIX} [洗盒] 装水失败: ${err.message}`);
                break;
            }
        }

        if (fills > 0) {
            console.log(`${PREFIX} [洗盒] 炼药锅加水 ${fills} 次`);
            washStationCauldronLevel = Math.min(3, level + fills);
        }

        // 如果还需要更多水 → 去水源取水
        if (fills < needed) {
            const remaining = needed - fills;
            console.log(`${PREFIX} [洗盒] 还需要 ${remaining} 次加水，去水源取水`);
            if (await fetchAndFillWater(remaining)) {
                washStationCauldronLevel = 3;
                return true;
            }
        }

        // 最终验证水位
        const finalLevel = getCauldronWaterLevel(washStationCauldronPos);
        washStationCauldronLevel = Math.max(0, finalLevel);
        return washStationCauldronLevel >= 3;
    }

    /** 去水源A取水并返回炼药锅加水，最多 fillCount 次 */
    async function fetchAndFillWater(fillCount) {
        if (!washStationActive) return false;
        let fills = 0;

        // 先检查背包是否有水桶/空桶；没有则去C拿
        let waterBuckets = bot.inventory.items().filter(i => isWaterBucket(i.name));
        let emptyBuckets = bot.inventory.items().filter(i => isEmptyBucket(i.name));

        // 如果既没水桶也没空桶，去 C 容器拿
        if (waterBuckets.length === 0 && emptyBuckets.length === 0) {
            if (!washStationBucketPos) {
                console.log(`${PREFIX} [洗盒] 背包无桶且未配置C容器(-bucket)，无法补水！`);
                return false;
            }
            console.log(`${PREFIX} [洗盒] 背包无桶，去C容器取水桶 @ (${washStationBucketPos.x}, ${washStationBucketPos.y}, ${washStationBucketPos.z})`);
            if (!(await ensureNearPos(washStationBucketPos, 'C容器'))) {
                console.log(`${PREFIX} [洗盒] 无法到达C容器`);
                return false;
            }
            const chest = bot.blockAt(washStationBucketPos);
            if (!chest || !isContainerBlock(chest.name)) {
                console.log(`${PREFIX} [洗盒] C容器坐标处不是容器，当前方块: ${chest ? chest.name : 'null'}`);
                return false;
            }
            try {
                const cw = await bot.openChest(chest);
                const allBuckets = (cw.inventoryStart !== undefined ? cw : (cw.window || cw));
                const slots = allBuckets.slots ?? [];
                const end = allBuckets.inventoryStart ?? slots.length;
                let tookWater = 0, tookEmpty = 0;
                for (let s = 0; s < end; s++) {
                    const item = slots[s];
                    if (!item) continue;
                    if (isWaterBucket(item.name)) {
                        try { await cw.withdraw(item.type, item.metadata, item.count); tookWater += item.count; } catch (e) { /* ignore */ }
                    } else if (isEmptyBucket(item.name)) {
                        try { await cw.withdraw(item.type, item.metadata, item.count); tookEmpty += item.count; } catch (e) { /* ignore */ }
                    }
                }
                await cw.close();
                waterBuckets = bot.inventory.items().filter(i => isWaterBucket(i.name));
                emptyBuckets = bot.inventory.items().filter(i => isEmptyBucket(i.name));
                console.log(`${PREFIX} [洗盒] 从C取出: 水桶 x${tookWater} 空桶 x${tookEmpty}（背包现有: 水桶 ${waterBuckets.length} 空桶 ${emptyBuckets.length}）`);
            } catch (err) {
                console.log(`${PREFIX} [洗盒] 开C容器失败: ${err.message}`);
                return false;
            }
        }

        if (waterBuckets.length === 0 && emptyBuckets.length === 0) {
            console.log(`${PREFIX} [洗盒] C容器中无桶，无法补水！请在C中放入水桶或空桶`);
            return false;
        }

        // 先用水桶直接装炼药锅
        for (const bucket of waterBuckets) {
            if (!washStationActive) return false;
            if (fills >= fillCount) break;
            if (getCauldronWaterLevel(washStationCauldronPos) >= 3) break;
            try {
                if (!(await ensureNearPos(washStationCauldronPos, '炼药锅B'))) break;
                await bot.equip(bucket, 'hand');
                await sleep(200);
                await interactCauldron();
                fills++;
                console.log(`${PREFIX} [洗盒] 用水桶加水 (${fills}/${fillCount})`);
            } catch (err) {
                console.log(`${PREFIX} [洗盒] 水桶加水失败: ${err.message}`);
                break;
            }
        }
        let level = getCauldronWaterLevel(washStationCauldronPos);
        washStationCauldronLevel = Math.max(0, level);
        if (washStationCauldronLevel >= 3) {
            console.log(`${PREFIX} [洗盒] 炼药锅已满 (${washStationCauldronLevel}/3)`);
            return true;
        }

        // 仍有需要 → 去水源取水
        emptyBuckets = bot.inventory.items().filter(i => isEmptyBucket(i.name));
        if (emptyBuckets.length === 0) {
            if (fills > 0) {
                console.log(`${PREFIX} [洗盒] 背包无空桶可去水源取水（已用水桶加 ${fills} 次），炼药锅水位 ${washStationCauldronLevel}/3`);
            } else {
                console.log(`${PREFIX} [洗盒] 背包无空桶且无水桶，无法补水！`);
            }
            return fills > 0;
        }

        if (!washStationWaterPos) {
            console.log(`${PREFIX} [洗盒] 未配置水源坐标(-water)，无法装水！`);
            return fills > 0;
        }

        console.log(`${PREFIX} [洗盒] 带 ${emptyBuckets.length} 个空桶去水源装水`);
        for (const bucket of emptyBuckets) {
            if (!washStationActive) return false;
            if (fills >= fillCount) break;
            if (getCauldronWaterLevel(washStationCauldronPos) >= 3) break;

            // 走到水源A → 装水 → 验证 → 走回炼药锅B → 加水
            if (!(await ensureNearPos(washStationWaterPos, '水源A'))) {
                console.log(`${PREFIX} [洗盒] 无法到达水源A，停止取水`);
                break;
            }
            try {
                await bot.equip(bucket, 'hand');
                await sleep(200);
                console.log(`${PREFIX} [洗盒] 在水源A装水...`);
                const fillOk = await interactWaterSource();
                if (!fillOk) {
                    console.log(`${PREFIX} [洗盒] 水源装水失败，跳过此桶`);
                    continue; // 尝试下一个空桶
                }
                await sleep(200);
                // 走回炼药锅B
                if (!(await ensureNearPos(washStationCauldronPos, '炼药锅B'))) {
                    console.log(`${PREFIX} [洗盒] 无法到达炼药锅B，停止加水`);
                    break;
                }
                // 再次确认手持的是水桶
                const heldBeforeCauldron = bot.heldItem;
                if (!heldBeforeCauldron || !isWaterBucket(heldBeforeCauldron.name)) {
                    console.log(`${PREFIX} [洗盒] 到达炼药锅时手上不是水桶 (${heldBeforeCauldron ? heldBeforeCauldron.name : '空手'})，跳过`);
                    continue;
                }
                console.log(`${PREFIX} [洗盒] 对炼药锅加水...`);
                await interactCauldron();
                fills++;
                level = getCauldronWaterLevel(washStationCauldronPos);
                washStationCauldronLevel = Math.max(0, level);
                console.log(`${PREFIX} [洗盒] 取水+加水完成 (${fills}/${fillCount})，炼药锅水位 ${washStationCauldronLevel}/3`);
                if (washStationCauldronLevel >= 3) break;
            } catch (err) {
                console.log(`${PREFIX} [洗盒] 取水循环失败: ${err.message}`);
                break;
            }
        }

        return fills > 0;
    }

    /** 洗一个染色盒子（假设已手持染色盒子，靠近炼药锅） */
    async function washOneBox(item) {
        if (!washStationCauldronPos) throw new Error('炼药锅坐标未配置');
        // 炼药锅必须有水
        if (!(await ensureCauldronHasWater())) {
            throw new Error('炼药锅无水且补水失败');
        }
        // 确保手持染色盒子
        await bot.equip(item, 'hand');
        await sleep(200);
        // 执行洗涤
        await interactCauldron();
        // 更新水位
        const newLevel = getCauldronWaterLevel(washStationCauldronPos);
        washStationCauldronLevel = Math.max(0, newLevel);
        washStationTotalWashed++;
    }

    /** 确保炼药锅有水（无水则补充），返回 true=有水可用 */
    async function ensureCauldronHasWater() {
        const level = getCauldronWaterLevel(washStationCauldronPos);
        washStationCauldronLevel = Math.max(0, level);
        if (washStationCauldronLevel <= 0) {
            console.log(`${PREFIX} [洗盒] 炼药锅无水，尝试补充...`);
            const ok = await fillCauldronToFull();
            if (!ok) {
                console.log(`${PREFIX} [洗盒] 炼药锅补水失败！检查水源(-water)和桶容器(-bucket)配置`);
                return false;
            }
            const newLevel = getCauldronWaterLevel(washStationCauldronPos);
            washStationCauldronLevel = Math.max(0, newLevel);
            if (washStationCauldronLevel <= 0) {
                console.log(`${PREFIX} [洗盒] 炼药锅补水后仍无水，请检查坐标是否正确`);
                return false;
            }
        }
        return true;
    }

    /** 将背包中所有无色盒子存入 E 容器 */
    async function depositAllUndyed() {
        if (!washStationUndyedPos) return 0;
        const undyedItems = bot.inventory.items().filter(i => isUndyedShulkerBox(i.name));
        if (undyedItems.length === 0) return 0;

        if (!(await ensureNearPos(washStationUndyedPos, 'E容器'))) return 0;

        let totalDeposited = 0;
        const chest = bot.blockAt(washStationUndyedPos);
        if (!chest || !isContainerBlock(chest.name)) {
            console.log(`${PREFIX} [洗盒] E容器不存在或不是容器`);
            return 0;
        }

        try {
            const cw = await bot.openChest(chest);
            const toDeposit = bot.inventory.items().filter(i => isUndyedShulkerBox(i.name));
            for (const item of toDeposit) {
                try {
                    await cw.deposit(item.type, item.metadata, item.count);
                    totalDeposited += item.count;
                } catch (e) { /* 盒子满 */ }
            }
            await cw.close();
            if (totalDeposited > 0) {
                console.log(`${PREFIX} [洗盒] 存入 ${totalDeposited} 个无色盒子到E`);
            }
        } catch (err) {
            console.log(`${PREFIX} [洗盒] 开E容器失败: ${err.message}`);
        }
        return totalDeposited;
    }

    // ---- 洗盒主状态机 ----

    function cleanupWashStation(reportMsg) {
        washStationActive = false;
        washStationState = 'IDLE';
        washStationSubState = '';
        if (washStationLoopTimer) { clearTimeout(washStationLoopTimer); washStationLoopTimer = null; }
        const durSec = washStationStartTime > 0 ? Math.round((Date.now() - washStationStartTime) / 1000) : 0;
        const durStr = durSec >= 3600 ? `${Math.floor(durSec / 3600)}h${Math.floor((durSec % 3600) / 60)}m`
            : durSec >= 60 ? `${Math.floor(durSec / 60)}m${durSec % 60}s` : `${durSec}s`;
        if (reportMsg && washStationSender) {
            const summary = `${reportMsg} | 洗涤 ${washStationTotalWashed} 个盒子 | ${washStationCycleCount} 循环 | 运行 ${durStr}`;
            safeWhisper(washStationSender, summary);
        }
        if (!bot.activateItemInterval && bot._startTime) {
            bot.activateItemInterval = setInterval(() => bot.activateItem(), 50);
        }
    }

    function failWashStation(msg) {
        console.error(`${PREFIX} ${msg}`);
        cleanupWashStation(msg);
    }

    function washScheduleTick(delay) {
        if (!washStationActive) return;
        if (washStationLoopTimer) clearTimeout(washStationLoopTimer);
        washStationLoopTimer = setTimeout(() => { washStationLoopTimer = null; executeWashState(); }, delay);
    }

    function executeWashState() {
        if (!washStationActive) return;
        switch (washStationState) {
            case 'PREFLIGHT':      phaseWashPreflight(); break;
            case 'CAULDRON_CHECK': phaseWashCauldronCheck(); break;
            case 'WITHDRAW':       phaseWashWithdraw(); break;
            case 'WASH':           phaseWashBoxes(); break;
            case 'DEPOSIT':        phaseWashDeposit(); break;
            case 'TRANSFER_UNDYED':phaseWashTransferUndyed(); break;
            case 'CHECK':          phaseWashCheck(); break;
            case 'STOPPING':       cleanupWashStation('[洗盒] 已完成'); break;
            default:               failWashStation('[洗盒] 未知状态，已停止');
        }
    }

    // ---- PREFLIGHT 阶段 ----

    async function phaseWashPreflight() {
        try {
            await runWashPreflight();
        } catch (err) {
            console.error(`${PREFIX} [洗盒-预检] 异常:`, err.message);
        }
        washStationState = 'CAULDRON_CHECK';
        washScheduleTick(300);
    }

    // ---- CAULDRON_CHECK 阶段 ----

    async function phaseWashCauldronCheck() {
        if (!washStationCauldronPos) {
            failWashStation('[洗盒] 炼药锅坐标B未配置');
            return;
        }
        // 确保靠近炼药锅
        if (!(await ensureNearPos(washStationCauldronPos, '炼药锅B'))) {
            washStationRetries++;
            if (washStationRetries > 10) { failWashStation('[洗盒] 无法到达炼药锅B'); return; }
            if (shouldLogRetry(washStationRetries)) {
                console.log(`${PREFIX} [洗盒] 无法到达炼药锅B (重试 ${washStationRetries}/10)`);
            }
            washScheduleTick(3000);
            return;
        }
        washStationRetries = 0;

        // 检查并确保炼药锅有水
        if (!(await ensureCauldronHasWater())) {
            washStationRetries++;
            if (washStationRetries > 10) { failWashStation('[洗盒] 炼药锅补水失败，已重试10次'); return; }
            if (shouldLogRetry(washStationRetries)) {
                console.log(`${PREFIX} [洗盒] 炼药锅补水失败 (重试 ${washStationRetries}/10)`);
            }
            washScheduleTick(3000);
            return;
        }
        washStationRetries = 0;
        washStationState = 'WITHDRAW';
        washScheduleTick(200);
    }

    // ---- WITHDRAW 阶段 ----

    async function phaseWashWithdraw() {
        if (!washStationDyedPos) {
            failWashStation('[洗盒] 染色盒子容器坐标D未配置');
            return;
        }

        // 确保靠近 D
        if (!(await ensureNearPos(washStationDyedPos, 'D容器'))) {
            washStationRetries++;
            if (washStationRetries > 10) { failWashStation('[洗盒] 无法到达D容器'); return; }
            if (shouldLogRetry(washStationRetries)) {
                console.log(`${PREFIX} [洗盒] 无法到达D容器 (重试 ${washStationRetries}/10)`);
            }
            washScheduleTick(3000);
            return;
        }
        washStationRetries = 0;

        const chest = bot.blockAt(washStationDyedPos);
        if (!chest || !isContainerBlock(chest.name)) {
            washStationRetries++;
            if (washStationRetries > 10) { failWashStation('[洗盒] D容器不存在，染色盒耗尽'); return; }
            if (shouldLogRetry(washStationRetries)) {
                console.log(`${PREFIX} [洗盒] D容器不存在 @ (${washStationDyedPos.x}, ${washStationDyedPos.y}, ${washStationDyedPos.z}) (重试 ${washStationRetries}/10)`);
            }
            washScheduleTick(3000);
            return;
        }

        try {
            const cw = await bot.openChest(chest);
            let totalDyed = 0;

            // 先收集染色盒子
            const win = (cw.inventoryStart !== undefined) ? cw : (cw.window || cw);
            const end = win.inventoryStart ?? win.slots?.length ?? 0;
            const slots = win.slots ?? [];
            for (let s = 0; s < end; s++) {
                const item = slots[s];
                if (item && isDyedShulkerBox(item.name)) {
                    try {
                        await cw.withdraw(item.type, item.metadata, item.count);
                        totalDyed += item.count;
                    } catch (e) { /* ignore */ }
                }
            }

            await cw.close();

            if (totalDyed === 0) {
                // 没有染色盒子了 → 检查是否需要转移无色盒子
                washStationState = 'TRANSFER_UNDYED';
                washScheduleTick(200);
                return;
            }

            washStationRetries = 0;
            if (washStationLogCycleCounter % 20 === 0) {
                console.log(`${PREFIX} [洗盒] 取出 ${totalDyed} 个染色盒子`);
            }
            washStationState = 'WASH';
            washScheduleTick(300);
        } catch (err) {
            washStationRetries++;
            if (washStationRetries > 10) { failWashStation(`[洗盒] 开D容器失败: ${err.message}`); return; }
            if (shouldLogRetry(washStationRetries)) {
                console.log(`${PREFIX} [洗盒] 开D容器失败 (重试 ${washStationRetries}/10): ${err.message}`);
            }
            washScheduleTick(3000);
        }
    }

    // ---- WASH 阶段 ----

    async function phaseWashBoxes() {
        // 每轮重新扫描背包，因为洗涤会改变物品（染色→无色）
        let dyedItems = bot.inventory.items().filter(i => isDyedShulkerBox(i.name));
        if (dyedItems.length === 0) {
            washStationState = 'DEPOSIT';
            washScheduleTick(200);
            return;
        }

        // 确保靠近炼药锅
        if (!(await ensureNearPos(washStationCauldronPos, '炼药锅B'))) {
            washStationRetries++;
            if (washStationRetries > 10) { failWashStation('[洗盒] 无法到达炼药锅B进行洗涤'); return; }
            if (shouldLogRetry(washStationRetries)) {
                console.log(`${PREFIX} [洗盒] 无法到达炼药锅B (重试 ${washStationRetries}/10)`);
            }
            washScheduleTick(3000);
            return;
        }
        washStationRetries = 0;

        let washedCount = 0;

        // 逐个洗涤，每洗完一个重新扫描物品栏（因为染色盒子变成了无色盒子）
        while (washStationActive) {
            dyedItems = bot.inventory.items().filter(i => isDyedShulkerBox(i.name));
            if (dyedItems.length === 0) break;

            const item = dyedItems[0];

            // 洗涤前确保炼药锅有水
            if (!(await ensureCauldronHasWater())) {
                console.log(`${PREFIX} [洗盒] 炼药锅补水失败，稍后重试`);
                washScheduleTick(3000);
                return;
            }

            try {
                await washOneBox(item);
                washedCount++;
            } catch (err) {
                console.error(`${PREFIX} [洗盒] 洗涤失败: ${err.message}`);
                // 单个盒子失败不中断，继续下一个
            }

            // 小延时避免过快发包 + 等待物品栏同步
            await sleep(200);
        }

        if (washedCount > 0 && washStationLogCycleCounter % 5 === 0) {
            console.log(`${PREFIX} [洗盒] 本轮洗涤 ${washedCount} 个盒子`);
        }

        // 洗完后进入存物阶段
        washStationState = 'DEPOSIT';
        washScheduleTick(300);
    }

    // ---- DEPOSIT 阶段 ----

    async function phaseWashDeposit() {
        const deposited = await depositAllUndyed();

        // 检查是否还有残留的无色盒子
        const stillRemaining = bot.inventory.items().filter(i => isUndyedShulkerBox(i.name));
        if (stillRemaining.length > 0 && deposited === 0) {
            // 一点都没存进去 → E 可能满了
            washStationRetries++;
            if (washStationRetries > 10) { failWashStation('[洗盒] E容器持续无法存入，可能已满'); return; }
            if (shouldLogRetry(washStationRetries)) {
                console.log(`${PREFIX} [洗盒] E容器无法存入，背包有 ${stillRemaining.reduce((s, i) => s + i.count, 0)} 个无色盒子 (重试 ${washStationRetries}/10)`);
            }
            washScheduleTick(3000);
            return;
        }
        washStationRetries = 0;

        // 检查背包是否还有染色盒子（WASH阶段可能因炼药锅缺水中断）
        const dyedItems = bot.inventory.items().filter(i => isDyedShulkerBox(i.name));
        if (dyedItems.length > 0) {
            // 还有染色盒子没洗完 → 回到WASH
            washStationState = 'CAULDRON_CHECK';
            washScheduleTick(200);
            return;
        }

        washStationState = 'TRANSFER_UNDYED';
        washScheduleTick(200);
    }

    // ---- TRANSFER_UNDYED 阶段：将D中的无色盒子转移到E ----

    async function phaseWashTransferUndyed() {
        if (!washStationDyedPos || !washStationUndyedPos) {
            washStationState = 'CHECK';
            washScheduleTick(200);
            return;
        }

        if (!(await ensureNearPos(washStationDyedPos, 'D容器'))) {
            // 无法到达就跳过转移
            washStationState = 'CHECK';
            washScheduleTick(200);
            return;
        }

        const chest = bot.blockAt(washStationDyedPos);
        if (!chest || !isContainerBlock(chest.name)) {
            washStationState = 'CHECK';
            washScheduleTick(200);
            return;
        }

        try {
            const cw = await bot.openChest(chest);
            const win = (cw.inventoryStart !== undefined) ? cw : (cw.window || cw);
            const end = win.inventoryStart ?? win.slots?.length ?? 0;
            const slots = win.slots ?? [];

            // 找无色盒子
            let totalUndyed = 0;
            for (let s = 0; s < end; s++) {
                const item = slots[s];
                if (item && isUndyedShulkerBox(item.name)) {
                    try {
                        await cw.withdraw(item.type, item.metadata, item.count);
                        totalUndyed += item.count;
                    } catch (e) { /* ignore */ }
                }
            }
            await cw.close();

            if (totalUndyed > 0) {
                console.log(`${PREFIX} [洗盒] 从D转移 ${totalUndyed} 个无色盒子到E`);
                // 确保靠近E再存
                const deposited = await depositAllUndyed();
                if (deposited === 0) {
                    console.log(`${PREFIX} [洗盒] 转移的无色盒子无法存入E，E可能已满`);
                }
            } else {
                // D 中既无染色盒也无无色盒 → 源头耗尽
                washStationSourceDepleted = true;
                console.log(`${PREFIX} [洗盒] D容器已无盒子（染色+无色均空），源头耗尽`);
            }
        } catch (err) {
            console.log(`${PREFIX} [洗盒] 转移无色盒子失败: ${err.message}`);
        }

        washStationState = 'CHECK';
        washScheduleTick(200);
    }

    // ---- CHECK 阶段 ----

    function phaseWashCheck() {
        washStationCycleCount++;
        washStationLogCycleCounter++;

        // 每 20 循环输出汇总
        if (washStationLogCycleCounter % 20 === 0) {
            const durSec = washStationStartTime > 0 ? Math.round((Date.now() - washStationStartTime) / 1000) : 0;
            const durStr = durSec >= 3600 ? `${Math.floor(durSec / 3600)}h${Math.floor((durSec % 3600) / 60)}m`
                : durSec >= 60 ? `${Math.floor(durSec / 60)}m${durSec % 60}s` : `${durSec}s`;
            console.log(`${PREFIX} [洗盒] 第 ${washStationCycleCount} 循环 | 累计洗涤 ${washStationTotalWashed} 个盒子 | 运行 ${durStr}`);
        }

        if (washStationPendingStop) {
            cleanupWashStation('[洗盒] 已按请求停止');
            return;
        }
        if (washStationCycles > 0 && washStationCycleCount >= washStationCycles) {
            cleanupWashStation(`[洗盒] 已完成 ${washStationCycles} 次循环`);
            return;
        }
        if (washStationSourceDepleted) {
            cleanupWashStation('[洗盒] D容器已无盒子，自动停止');
            return;
        }

        // 回到炼药锅检查 → 继续下一轮
        washStationState = 'CAULDRON_CHECK';
        washScheduleTick(500);
    }

    /** 启动洗潜影盒自动化 */
    async function startWashStation(waterPos, cauldronPos, bucketPos, dyedPos, undyedPos, cycles, sender) {
        if (!bot.entity) return '[洗盒] 机器人尚未完全加载';
        // 如果已有运行中的洗盒站，先停掉
        if (washStationActive) stopWashStation(true);

        // 验证必要参数
        if (!cauldronPos) return '[洗盒] 必须提供炼药锅坐标 (-cauldron x y z)';
        if (!dyedPos) return '[洗盒] 必须提供染色盒子容器坐标 (-dyed x y z)';
        if (!undyedPos) return '[洗盒] 必须提供无色盒子容器坐标 (-undyed x y z)';

        washStationWaterPos = waterPos;
        washStationCauldronPos = cauldronPos;
        washStationBucketPos = bucketPos;
        washStationDyedPos = dyedPos;
        washStationUndyedPos = undyedPos;
        washStationSender = sender;
        washStationCycles = cycles || 0;
        washStationActive = true;
        washStationPendingStop = false;
        washStationCycleCount = 0;
        washStationTotalWashed = 0;
        washStationRetries = 0;
        washStationCauldronLevel = 0;
        washStationStartTime = Date.now();
        washStationLogCycleCounter = 0;
        washStationSubState = '';
        washStationSourceDepleted = false;

        // 报告所有坐标
        const fmtPos = (p) => p ? `(${p.x}, ${p.y}, ${p.z})` : '(未配置)';
        console.log(`${PREFIX} [洗盒] ===== 坐标配置 =====`);
        console.log(`${PREFIX} [洗盒]   水源   (-water)  : ${fmtPos(waterPos)}`);
        console.log(`${PREFIX} [洗盒]   炼药锅 (-cauldron): ${fmtPos(cauldronPos)}`);
        console.log(`${PREFIX} [洗盒]   桶容器 (-bucket)  : ${fmtPos(bucketPos)}`);
        console.log(`${PREFIX} [洗盒]   染色盒 (-dyed)    : ${fmtPos(dyedPos)}`);
        console.log(`${PREFIX} [洗盒]   无色盒 (-undyed)  : ${fmtPos(undyedPos)}`);
        console.log(`${PREFIX} [洗盒]   循环次数: ${washStationCycles > 0 ? washStationCycles : '无限'}`);
        console.log(`${PREFIX} [洗盒]   当前站位: (${Math.floor(bot.entity.position.x)}, ${Math.floor(bot.entity.position.y)}, ${Math.floor(bot.entity.position.z)})`);

        // 停掉 anti-AFK 右键（避免干扰）
        if (bot.activateItemInterval) {
            clearInterval(bot.activateItemInterval);
            bot.activateItemInterval = null;
        }

        // 进入预检阶段
        washStationState = 'PREFLIGHT';
        washScheduleTick(500);

        return `[洗盒] 已启动${cycles > 0 ? ' (最大 ' + cycles + ' 循环)' : ' (无限循环)'}`;
    }

    function stopWashStation(immediate) {
        if (!washStationActive) return '[洗盒] 当前未运行';
        if (immediate) {
            cleanupWashStation('[洗盒] 已强制停止');
            if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow); } catch (e) { /* ignore */ } }
            if (!bot.activateItemInterval && bot._startTime) {
                bot.activateItemInterval = setInterval(() => bot.activateItem(), 50);
            }
            return '[洗盒] 已强制停止';
        }
        washStationPendingStop = true;
        return '[洗盒] 将在当前循环结束后停止';
    }

    // ================================================================
    //  命令定义（按类别分组）
    // ================================================================

    // ---- 公共命令（所有人可用） ----

    cmd('/ping', ['/ping', 'ping'],
        TRIGGER.WEB | TRIGGER.CHAT | TRIGGER.WHISPER | TRIGGER.MENTION | TRIGGER.REPLY | TRIGGER.QQ_AT,
        TARGET.ALL,
        '/ping — 测试机器人是否在线',
        (ctx) => { ctx.reply('pong!'); }, true);

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
        }, true);

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
            if (items.length === 0) { ctx.reply(`[${bot.username} 物品栏] 物品栏为空`); return; }
            const hotbarSlot = bot.quickBarSlot;
            const lines = items.map(item => {
                const name = formatItemName(item);
                const slot = item.slot;
                const isHotbar = slot >= 36 && slot <= 44;
                const marker = isHotbar ? (slot - 36 === hotbarSlot ? ' [当前手持]' : ' [快捷栏]') : '';
                return `栏${slot} ${name} x${item.count}${marker}`;
            });
            ctx.reply(`[${bot.username} 物品栏] 共 ${items.length} 种物品:\n${lines.join('\n')}`);
        }, true);

    cmd('/hotbar', ['/hotbar'],
        TRIGGER.WEB | TRIGGER.WHISPER,
        TARGET.TRUSTED,
        '/hotbar <1-9> — 切换快捷栏',
        (ctx, args) => {
            const slot = parseInt(args);
            if (isNaN(slot) || slot < 1 || slot > 9) { ctx.reply('[切换] 用法: /hotbar <1-9>'); return; }
            bot.setQuickBarSlot(slot - 1);
            ctx.reply(`[切换] 已切换到快捷栏 ${slot}: ${formatItemName(bot.heldItem)}`);
        }, true, {
            slot: { type: 'integer', description: '快捷栏栏位编号 (1-9)', minimum: 1, maximum: 9, required: true },
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
        }, true, {
            itemName: { type: 'string', description: '要丢弃的物品名称（部分匹配）', required: true },
            count: { type: 'integer', description: '丢弃数量（可选，默认为 1）', minimum: 1, required: false },
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
        }, true);

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
        }, true, {
            itemName: { type: 'string', description: '要装备到手中的物品名称', required: true },
        });

    // ---- 攻击 ----

    // 判断实体是否为敌对生物（兼容 kind=hostile 和 type=mob 但名称匹配的情况）
    const HOSTILE_NAME_PATTERNS = [
        'zombie', 'skeleton', 'creeper', 'spider', 'witch',
        'pillager', 'evoker', 'vindicator', 'ravager', 'vex', 'illusioner',
        'phantom', 'drowned', 'husk', 'stray', 'wither_skeleton',
        'blaze', 'ghast', 'magma_cube', 'slime',
        'enderman', 'endermite', 'silverfish', 'cave_spider',
        'guardian', 'elder_guardian', 'shulker',
        'hoglin', 'piglin', 'piglin_brute', 'zoglin',
        'warden', 'breeze', 'bogged',
        'raid', 'raider',
    ];

    function isHostileMob(entity) {
        if (!entity || !entity.name) return false;
        if (entity.kind === 'hostile') return true;
        if (entity.type !== 'mob') return false;
        const name = (entity.name || '').toLowerCase();
        return HOSTILE_NAME_PATTERNS.some(p => name.includes(p));
    }

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
                target = bot.nearestEntity(e => isHostileMob(e));
                if (!target) { ctx.reply('[攻击] 附近没有敌对生物'); return; }
            }
            try {
                bot.attack(target);
                ctx.reply(`[攻击] 正在攻击: ${target.displayName || target.name}${target.username ? ' (' + target.username + ')' : ''}`);
            } catch (err) {
                ctx.reply(`[攻击] 失败: ${err.message}`);
            }
        }, true, {
            entityName: { type: 'string', description: '要攻击的实体名称（可选，不填则攻击最近敌对生物）', required: false },
        });

    cmd('/attackloop', ['/attackloop'],
        TRIGGER.WEB | TRIGGER.WHISPER,
        TARGET.TRUSTED,
        '/attackloop <实体名列表> [范围] — 持续攻击。多个实体名用 / 分隔，如 pillager/evoker/witch。使用 /stop 停止',
        (ctx, args) => {
            if (!bot.entity) { ctx.reply('[持续攻击] 机器人尚未完全加载'); return; }

            // 停止已有的攻击循环
            if (botAttackLoopInterval) {
                clearInterval(botAttackLoopInterval);
                botAttackLoopInterval = null;
            }

            const trimmed = (args || '').trim();
            if (!trimmed) { ctx.reply('[持续攻击] 必须指定至少一个实体名（多个用 / 分隔，如 pillager/evoker/witch）'); return; }

            const parts = trimmed.split(/\s+/).filter(p => p);
            // 最后一个参数如果是纯数字则当作范围
            const rangeStr = parts.length > 1 && /^\d+(\.\d+)?$/.test(parts[parts.length - 1])
                ? parts.pop() : '6';
            // 剩下的合并后用 / 拆分为多个实体名
            const nameStr = parts.join(' ');
            const rawNames = nameStr.split('/').map(s => s.trim().toLowerCase()).filter(s => s);
            const scanRange = parseFloat(rangeStr) || 6;

            // @e 表示攻击范围内所有非玩家实体
            const useAtE = rawNames.includes('@e');
            const targetNames = useAtE ? [] : rawNames;

            botAttackingActive = true;
            let attackCount = 0;
            let lastReport = Date.now();

            ctx.reply(useAtE
                ? `[持续攻击] 目标: @e（范围内所有非玩家实体，范围 ${scanRange}m），使用 /stop 停止`
                : `[持续攻击] 目标: ${targetNames.join('/')}（范围 ${scanRange}m），使用 /stop 停止`);

            // 检查实体是否为有效攻击目标
            const ATTACKABLE_TYPES = ['mob', 'hostile', 'player'];

            function isValidTarget(entity) {
                if (!entity || !entity.position) return false;
                // 排除无效/非攻击实体：物品、经验球、画、船、矿车等
                if (!entity.name) return false;
                if (entity.name === 'item' || entity.name === 'experience_orb' ||
                    entity.name === 'arrow' || entity.name === 'painting' ||
                    entity.name === 'item_frame' || entity.name === 'glow_item_frame' ||
                    entity.name === 'boat' || entity.name === 'chest_boat' ||
                    entity.name === 'minecart' || entity.name === 'chest_minecart' ||
                    entity.name === 'area_effect_cloud' || entity.name === 'marker') return false;
                return true;
            }

            function nameMatches(entity, lowerNames) {
                if (useAtE) {
                    // @e 模式：攻击范围内所有可攻击的实体，排除玩家和机器人自己
                    if (entity.type === 'player' || entity.username === bot.username) return false;
                    if (!ATTACKABLE_TYPES.includes(entity.type) && entity.type !== 'object') return false;
                    // entity.type 'object' 中的有效目标（如 falling_block, tnt 不算）
                    if (entity.type === 'object' && entity.name !== 'falling_block' && entity.name !== 'tnt') return false;
                    return true;
                }
                const name = (entity.name || '').toLowerCase();
                const displayName = (typeof entity.displayName === 'string'
                    ? entity.displayName : (entity.displayName ? JSON.stringify(entity.displayName) : '')).toLowerCase();
                const customName = (typeof entity.customName === 'string'
                    ? entity.customName : (entity.customName ? JSON.stringify(entity.customName) : '')).toLowerCase();
                return lowerNames.some(kw =>
                    name.includes(kw) || displayName.includes(kw) || customName.includes(kw)
                );
            }

            // 从 bot.entity.attributes 读取服务端下发的实际攻击速度
            function getAttackCooldown() {
                try {
                    const attr = bot.entity?.attributes?.['generic.attack_speed'];
                    if (attr && typeof attr.value === 'number' && attr.value > 0) {
                        return Math.ceil(1000 / attr.value); // 攻速 → 冷却毫秒
                    }
                } catch (e) { /* fallthrough */ }
                return 650; // 属性不可用时的安全回退
            }

            let attackCooldown = getAttackCooldown();
            let lastAttackTime = 0;

            function attackLoop() {
                if (!botAttackingActive) {
                    botAttackLoopInterval = null;
                    return;
                }

                // 检查手持物品是否变化，更新冷却时间
                const cd = getAttackCooldown();
                if (cd !== attackCooldown) {
                    attackCooldown = cd;
                    console.log(`${PREFIX} [攻击] 武器切换，攻击冷却调整为 ${cd}ms`);
                }

                const pos = bot.entity.position;
                if (!pos) {
                    botAttackLoopInterval = setTimeout(attackLoop, 200);
                    return;
                }

                // 在范围内查找所有匹配实体，选最近的
                let bestTarget = null;
                let bestDist = Infinity;
                for (const entity of Object.values(bot.entities)) {
                    if (!isValidTarget(entity)) continue;
                    const dist = pos.distanceTo(entity.position);
                    if (dist > scanRange) continue;
                    if (dist >= bestDist) continue;
                    if (nameMatches(entity, targetNames)) {
                        bestDist = dist;
                        bestTarget = entity;
                    }
                }

                if (!bestTarget) {
                    // 无目标，快速扫描
                    botAttackLoopInterval = setTimeout(attackLoop, 200);
                    return;
                }

                // 检查冷却是否就绪
                const now = Date.now();
                const elapsed = now - lastAttackTime;
                if (elapsed < attackCooldown) {
                    // 冷却中，看目标但不攻击
                    botAttackLoopInterval = setTimeout(attackLoop, Math.max(50, attackCooldown - elapsed));
                    return;
                }

                // 再次验证目标仍然存在且有效（防止攻击已消失的实体）
                try {
                    const refreshed = bot.entities[bestTarget.id || bestTarget.uuid];
                    if (!refreshed || !refreshed.position) {
                        botAttackLoopInterval = setTimeout(attackLoop, 200);
                        return;
                    }
                } catch (e) {
                    botAttackLoopInterval = setTimeout(attackLoop, 200);
                    return;
                }

                try {
                    // 看向目标并攻击
                    bot.lookAt(bestTarget.position.offset(0, bestTarget.height ? bestTarget.height * 0.5 : 1, 0), true);
                    bot.attack(bestTarget);
                    lastAttackTime = Date.now();
                    attackCount++;

                    // 每 30 秒或每 50 次攻击汇报一次
                    if (Date.now() - lastReport > 30000 || attackCount % 50 === 0) {
                        const targetName = bestTarget.displayName || bestTarget.name || '(未知)';
                        if (ctx.type === 'whisper') {
                            safeWhisper(ctx.sender, `[持续攻击进度] 已攻击 ${attackCount} 次，当前目标: ${targetName}`);
                        }
                        lastReport = Date.now();
                    }
                } catch (err) {
                    // 攻击失败静默跳过
                }

                // 按冷却时间调度下一次攻击
                botAttackLoopInterval = setTimeout(attackLoop, Math.max(50, attackCooldown - (Date.now() - lastAttackTime)));
            }

            // 启动攻击循环
            botAttackLoopInterval = setTimeout(attackLoop, 100);
        }, true, {
            names: { type: 'string', description: '要攻击的实体名列表，多个用 / 分隔，如 pillager/evoker/vindicator/witch/ravager/vex', required: true },
            range: { type: 'number', description: '扫描范围（可选，默认6格）', minimum: 1, maximum: 30, required: false },
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
        }, true);

    cmd('/use hold', ['/use hold'],
        TRIGGER.WEB | TRIGGER.WHISPER,
        TARGET.TRUSTED,
        '/use hold — 开始持续右键',
        (ctx) => {
            if (bot.activateItemInterval) clearInterval(bot.activateItemInterval);
            bot.activateItemInterval = setInterval(() => bot.activateItem(), 50);
            ctx.reply('[使用] 已开始持续右键');
        }, true);

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
        }, true);

    // ---- 动作控制 ----

    cmd('/stop', ['/stop'],
        TRIGGER.MENTION | TRIGGER.WEB | TRIGGER.WHISPER | TRIGGER.QQ_AT,
        TARGET.TRUSTED,
        '/stop — 停止所有机器人动作（跟随、持续右键、移动等）',
        (ctx) => {
            // 停止跟随
            if (botFollowInterval) {
                clearInterval(botFollowInterval);
                botFollowInterval = null;
            }
            botFollowTarget = null;
            for (const ctrl of ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']) {
                bot.setControlState(ctrl, false);
            }
            // 停止持续右键（但不影响 spawn 时自动启动的 activateItemInterval）
            if (bot.activateItemInterval) {
                clearInterval(bot.activateItemInterval);
                bot.activateItemInterval = null;
            }
            // 停止使用物品
            if (bot.usingHeldItem) {
                bot.deactivateItem();
            }
            // 停止挖掘
            botMiningActive = false;
            // 停止持续攻击
            botAttackingActive = false;
            if (botAttackLoopInterval) {
                clearInterval(botAttackLoopInterval);
                botAttackLoopInterval = null;
            }
            // 停止合成站
            if (craftStationActive) stopCraftStation(true);
            ctx.reply('[动作] 已停止所有动作');
        }, true);

    cmd('/follow', ['/follow'],
        TRIGGER.MENTION | TRIGGER.WEB | TRIGGER.WHISPER | TRIGGER.QQ_AT,
        TARGET.TRUSTED,
        '/follow <玩家名> — 跟随指定玩家',
        (ctx, args) => {
            const targetName = args.trim();
            if (!targetName) { ctx.reply('[跟随] 用法: /follow <玩家名>'); return; }
            const target = bot.players[targetName];
            if (!target || !target.entity) {
                ctx.reply(`[跟随] 未在附近找到玩家 "${targetName}"`);
                return;
            }

            // 停止已有跟随
            if (botFollowInterval) {
                clearInterval(botFollowInterval);
                botFollowInterval = null;
            }
            botFollowTarget = targetName;

            const FOLLOW_DISTANCE = 3;
            const FOLLOW_INTERVAL = 500;

            botFollowInterval = setInterval(() => {
                const player = bot.players[botFollowTarget];
                if (!player || !player.entity) {
                    // 目标丢失，停止移动
                    for (const ctrl of ['forward', 'back', 'left', 'right', 'sprint']) {
                        bot.setControlState(ctrl, false);
                    }
                    return;
                }

                const dist = bot.entity.position.distanceTo(player.entity.position);
                bot.lookAt(player.entity.position.offset(0, 1.6, 0), true);

                if (dist > FOLLOW_DISTANCE + 1) {
                    bot.setControlState('forward', true);
                    bot.setControlState('sprint', dist > 8);
                } else {
                    bot.setControlState('forward', false);
                    bot.setControlState('sprint', false);
                }
            }, FOLLOW_INTERVAL);

            ctx.reply(`[跟随] 正在跟随 ${targetName}。使用 /stopfollow 或 /stop 停止`);
        }, true, {
            player: { type: 'string', description: '要跟随的玩家名称', required: true },
        });

    cmd('/stopfollow', ['/stopfollow'],
        TRIGGER.MENTION | TRIGGER.WEB | TRIGGER.WHISPER | TRIGGER.QQ_AT,
        TARGET.TRUSTED,
        '/stopfollow — 停止跟随当前目标',
        (ctx) => {
            if (botFollowInterval) {
                clearInterval(botFollowInterval);
                botFollowInterval = null;
            }
            botFollowTarget = null;
            for (const ctrl of ['forward', 'back', 'left', 'right', 'sprint']) {
                bot.setControlState(ctrl, false);
            }
            ctx.reply('[跟随] 已停止跟随');
        }, true);

    cmd('/collect', ['/collect'],
        TRIGGER.MENTION | TRIGGER.WEB | TRIGGER.WHISPER | TRIGGER.QQ_AT,
        TARGET.TRUSTED,
        '/collect — 收集附近掉落物品（10 格范围，30 秒超时）',
        (ctx) => {
            const pos = bot.entity?.position;
            if (!pos) { ctx.reply('[收集] 机器人尚未完全加载'); return; }

            const items = Object.values(bot.entities)
                .filter(e => e.name === 'item' && e.position && pos.distanceTo(e.position) <= 10)
                .sort((a, b) => pos.distanceTo(a.position) - pos.distanceTo(b.position));

            if (items.length === 0) {
                ctx.reply('[收集] 附近没有掉落物品');
                return;
            }

            ctx.reply(`[收集] 发现 ${items.length} 个掉落物品，正在收集...`);

            let collectIndex = 0;
            const COLLECT_INTERVAL = 500;
            const collectInterval = setInterval(() => {
                if (collectIndex >= items.length) {
                    clearInterval(collectInterval);
                    for (const ctrl of ['forward', 'back', 'left', 'right', 'sprint']) {
                        bot.setControlState(ctrl, false);
                    }
                    return;
                }

                const item = items[collectIndex];
                if (!item || !item.position) {
                    collectIndex++;
                    return;
                }

                const dist = bot.entity.position.distanceTo(item.position);
                if (dist < 2) {
                    collectIndex++;
                    return;
                }

                bot.lookAt(item.position, true);
                bot.setControlState('forward', true);
            }, COLLECT_INTERVAL);

            // 30 秒安全超时
            setTimeout(() => {
                clearInterval(collectInterval);
                for (const ctrl of ['forward', 'back', 'left', 'right', 'sprint']) {
                    bot.setControlState(ctrl, false);
                }
            }, 30000);
        }, true);

    // ---- 挖掘（AI 核心能力） ----

    cmd('/minechunk', ['/minechunk'],
        TRIGGER.MENTION | TRIGGER.WEB | TRIGGER.WHISPER | TRIGGER.QQ_AT,
        TARGET.TRUSTED,
        '/minechunk [半径] [Y轴下限] [Y轴上限] — 挖掘当前区块所有可挖方块，自动切换背包中最优工具。参数均可选，默认挖掘整个区块',
        async (ctx, args) => {
            // 解析可选参数
            const parts = (args || '').trim().split(/\s+/).filter(p => p);
            const radius = parts.length > 0 ? parseFloat(parts[0]) : null;
            const yMin = parts.length > 1 ? parseInt(parts[1]) : null;
            const yMax = parts.length > 2 ? parseInt(parts[2]) : null;

            if (!bot.entity) { ctx.reply('[挖掘] 机器人尚未完全加载'); return; }

            const pos = bot.entity.position;
            const bounds = getChunkBounds(pos);

            // 确定 Y 轴范围（默认全高度，适应飞行）
            const effectiveYMin = yMin ?? -64;
            const effectiveYMax = yMax ?? 320;

            // 扫描可挖掘方块
            ctx.reply(`[挖掘] 正在扫描区块 [${bounds.chunkX}, ${bounds.chunkZ}] Y:${effectiveYMin}~${effectiveYMax} 的可挖掘方块...`);

            botMiningActive = true; // 必须先设置，否则扫描循环会立即退出

            const HARD_MAX_BLOCKS = 20000;
            const blocks = [];
            const scanMax = radius ? Math.min(Math.ceil(radius * radius * (effectiveYMax - effectiveYMin) * 4), HARD_MAX_BLOCKS) : Math.min(5000, HARD_MAX_BLOCKS);

            if (radius) {
                // 半径模式：只扫描半径范围内的方块
                for (let x = Math.floor(pos.x - radius); x <= Math.ceil(pos.x + radius) && blocks.length < scanMax; x++) {
                    for (let z = Math.floor(pos.z - radius); z <= Math.ceil(pos.z + radius) && blocks.length < scanMax; z++) {
                        for (let y = effectiveYMin; y <= effectiveYMax && blocks.length < scanMax; y++) {
                            if (!botMiningActive) break;
                            const block = bot.blockAt(new Vec3(x, y, z));
                            if (!isMineableBlock(block)) continue;
                            const dist = pos.distanceTo(block.position);
                            blocks.push({ x, y, z, dist });
                        }
                    }
                }
            } else {
                // 全区块模式
                for (let x = bounds.minX; x <= bounds.maxX && blocks.length < scanMax; x++) {
                    for (let z = bounds.minZ; z <= bounds.maxZ && blocks.length < scanMax; z++) {
                        for (let y = effectiveYMin; y <= effectiveYMax && blocks.length < scanMax; y++) {
                            if (!botMiningActive) break;
                            const block = bot.blockAt(new Vec3(x, y, z));
                            if (!isMineableBlock(block)) continue;
                            const dist = pos.distanceTo(block.position);
                            blocks.push({ x, y, z, dist });
                        }
                    }
                }
            }

            if (!botMiningActive) { ctx.reply('[挖掘] 已被取消'); return; }

            if (blocks.length === 0) {
                ctx.reply('[挖掘] 当前区域没有可挖掘的方块');
                botMiningActive = false;
                return;
            }

            // 按距离排序（近到远）
            blocks.sort((a, b) => a.dist - b.dist);

            const total = blocks.length;
            ctx.reply(`[挖掘] 发现 ${total} 个可挖掘方块，开始挖掘...（使用 /stop 可随时停止）`);
            let mined = 0;
            let skipped = 0;
            let lastReport = Date.now();

            for (let i = 0; i < blocks.length; i++) {
                if (!botMiningActive) break;

                const bi = blocks[i];

                // 每 30 秒或每 50 个方块报告一次进度
                if (Date.now() - lastReport > 30000 || mined > 0 && mined % 50 === 0) {
                    const pct = Math.round((mined / total) * 100);
                    ctx.reply(`[挖掘进度] ${mined}/${total} (${pct}%) 已跳过 ${skipped} 个`);
                    lastReport = Date.now();
                }

                const success = await mineSingleBlock(bi);
                if (success) {
                    mined++;
                } else {
                    skipped++;
                }

                // 挖掘间隔（避免被服务器踢）
                await new Promise(r => setTimeout(r, 100));
            }

            // 停止所有移动
            for (const ctrl of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
                bot.setControlState(ctrl, false);
            }

            if (botMiningActive) {
                ctx.reply(`[挖掘完成] 共挖掘 ${mined} 个方块，跳过 ${skipped} 个（总计 ${total}）`);
            } else {
                ctx.reply(`[挖掘中止] 已挖掘 ${mined}/${total} 个方块，跳过 ${skipped} 个`);
            }
            botMiningActive = false;
        }, true, {
            radius: { type: 'number', description: '挖掘半径（可选，不填则挖掘整个当前区块 16×16）', minimum: 1, maximum: 16, required: false },
            yMin: { type: 'integer', description: 'Y 轴下限（可选，默认机器人脚下 -1）', required: false },
            yMax: { type: 'integer', description: 'Y 轴上限（可选，默认机器人头顶 +8）', required: false },
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

            // minecraft-data 中不同类型实体的 type 字段不一致：
            // 潜影贝是 "mob"，但僵尸/末影人等是 "hostile"，动物是 "animal" 等
            const LIVING_TYPES = ['mob', 'hostile', 'animal', 'passive', 'ambient', 'water_creature', 'living'];
            const mobs = Object.values(bot.entities).filter(e =>
                LIVING_TYPES.includes(e.type) && e.name && e.position && pos.distanceTo(e.position) <= 30
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
        }, true);

    cmd('/playerlist', ['/playerlist'],
        TRIGGER.MENTION | TRIGGER.WEB | TRIGGER.WHISPER | TRIGGER.QQ_AT,
        TARGET.TRUSTED,
        '/playerlist — 查看全服在线玩家（自动包含本子服详情 + 全局各子服玩家列表）',
        (ctx) => {
            const players = Object.values(bot.players);
            const header = (bot.tablist?.header?.toString() || '').trim();
            const footer = (bot.tablist?.footer?.toString() || '').trim();

            // 第一部分：本子服玩家详情
            const lines = [];
            if (header) lines.push(`[当前子服] ${header}`);
            if (players.length > 0) {
                lines.push(`--- 本子服玩家 (${players.length}) ---`);
                const sorted = [...players].sort((a, b) => (a.ping || 0) - (b.ping || 0));
                const gmNames = ['生存', '创造', '冒险', '旁观'];
                sorted.forEach(p => {
                    const gm = gmNames[p.gamemode] || `模式${p.gamemode}`;
                    const ping = p.ping !== undefined ? `${p.ping}ms` : '?';
                    const loaded = p.entity ? '✓' : '✗';
                    lines.push(`${p.username} | ${gm} | Ping:${ping} | 视野内:${loaded}`);
                });
            } else {
                lines.push('--- 本子服无其他玩家 ---');
            }

            // 第二部分：发送 /glist 查询全局各子服玩家
            console.log(`${PREFIX} [查询] ${ctx.sender} 查询全服玩家列表`);
            // 预加载本地数据到捕获缓冲区，glist 的服务器响应会追加在后面
            startCapture(ctx.sender, ctx.type, ctx._captureBuffer || null, 5000, [...lines, '', '=== 全服玩家 (glist) ===']);
            safeChat('/glist');
        }, true);

    cmd('/glist', ['/glist'],
        TRIGGER.MENTION | TRIGGER.WEB | TRIGGER.WHISPER | TRIGGER.QQ_AT,
        TARGET.TRUSTED,
        '/glist — 仅查询 BungeeCord/Velocity 全局各子服玩家（不含本子服详情）',
        (ctx) => {
            console.log(`${PREFIX} [查询] ${ctx.sender} 查询全局玩家列表`);
            startCapture(ctx.sender, ctx.type, ctx._captureBuffer || null, 5000);
            safeChat('/glist');
        }, true);

    cmd('/where', ['/where'],
        TRIGGER.MENTION | TRIGGER.WEB | TRIGGER.WHISPER | TRIGGER.QQ_AT,
        TARGET.TRUSTED,
        '/where — 查看机器人当前位置、朝向和状态',
        (ctx) => {
            const entity = bot.entity;
            if (!entity) { ctx.reply('[位置] 机器人尚未完全加载'); return; }
            const pos = entity.position;
            const lines = [];
            lines.push('=== 机器人状态 ===');
            lines.push(`坐标: ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`);
            lines.push(`朝向: yaw=${entity.yaw.toFixed(1)}° pitch=${entity.pitch.toFixed(1)}°`);
            const gmNames = ['生存', '创造', '冒险', '旁观'];
            lines.push(`模式: ${gmNames[bot.game.gameMode] || bot.game.gameMode}`);
            lines.push(`维度: ${bot.game.dimension || 'overworld'}`);
            lines.push(`生命: ${Math.round(entity.health)}/${Math.round(entity.maxHealth || 20)}`);
            lines.push(`饥饿: ${bot.food ?? '?'}/20`);
            lines.push(`天气: ${bot.thunderState > 0 ? '⛈ 雷雨' : bot.rainState > 0 ? '🌧 下雨' : '☀ 晴朗'}`);
            ctx.reply(lines.join('\n'));
        }, true);

    cmd('/status', ['/status'],
        TRIGGER.MENTION | TRIGGER.WEB | TRIGGER.WHISPER | TRIGGER.QQ_AT,
        TARGET.ALL,
        '/status — 查看机器人运行状态和诊断信息',
        (ctx) => {
            const entity = bot.entity;
            if (!entity) { ctx.reply('[状态] 机器人尚未完全加载'); return; }
            const pos = entity.position;
            const uptimeMs = Date.now() - (bot._startTime || Date.now());
            const uptimeH = Math.floor(uptimeMs / 3600000);
            const uptimeM = Math.floor((uptimeMs % 3600000) / 60000);
            const uptimeS = Math.floor((uptimeMs % 60000) / 1000);
            const mem = process.memoryUsage();
            const memMB = (mem.heapUsed / 1024 / 1024).toFixed(1);

            const lines = [
                '=== 机器人运行状态 ===',
                `在线时长: ${uptimeH}h ${uptimeM}m ${uptimeS}s`,
                `坐标: ${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`,
                `生命/饥饿: ${Math.round(entity.health)}/${Math.round(entity.maxHealth || 20)} | ${bot.food ?? '?'}/20`,
                `维度: ${bot.game.dimension || 'overworld'}`,
                `天气: ${bot.thunderState > 0 ? '⛈ 雷雨' : bot.rainState > 0 ? '🌧 下雨' : '☀ 晴朗'}`,
                `AI 调用次数: ${aiCallCount}`,
                `内存占用: ${memMB} MB`,
                `消息队列: ${messageQueue.length} 条待发送`,
            ];
            ctx.reply(lines.join('\n'));
        }, true);

    cmd('/weather', ['/weather'],
        TRIGGER.MENTION | TRIGGER.WEB | TRIGGER.WHISPER | TRIGGER.QQ_AT,
        TARGET.ALL,
        '/weather — 查看当前游戏天气',
        (ctx) => {
            const weather = bot.thunderState > 0 ? '⛈ 雷雨'
                : bot.rainState > 0 ? '🌧 下雨'
                : '☀ 晴朗';
            ctx.reply(`[天气] 当前天气: ${weather}`);
        }, true);

    cmd('/time', ['/time'],
        TRIGGER.MENTION | TRIGGER.WEB | TRIGGER.WHISPER | TRIGGER.QQ_AT,
        TARGET.ALL,
        '/time — 查看当前游戏时间',
        (ctx) => {
            const timeOfDay = bot.time.timeOfDay;
            const hours = Math.floor((timeOfDay / 1000) + 6) % 24;
            const minutes = Math.floor(((timeOfDay % 1000) / 1000) * 60);
            const period = hours >= 6 && hours < 18 ? '☀ 白天' : '🌙 夜晚';
            const ticks = timeOfDay % 24000;
            ctx.reply(`[时间] ${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')} (${period}) | Tick: ${ticks}`);
        }, true);

    // ---- 经济系统 ----

    cmd('/money', ['/money'],
        TRIGGER.WHISPER | TRIGGER.MENTION | TRIGGER.REPLY | TRIGGER.QQ_AT | TRIGGER.WEB,
        TARGET.ALL,
        '/money [玩家名] — 查看金币数量（不填则查 bot 自己的余额）',
        (ctx, args) => {
            const target = args.trim();
            const cmdText = target ? `/money ${target}` : '/money';
            console.log(`${PREFIX} [经济] ${ctx.sender} 查询金币${target ? ' (目标: ' + target + ')' : ''}`);
            startCapture(ctx.sender, ctx.type, ctx._captureBuffer || null, 5000);
            safeChat(cmdText);
        }, true, {
            player: { type: 'string', description: '要查询的玩家名称（可选，不填则查机器人自身余额）', required: false },
        });

    cmd('/pay', ['/pay'],
        TRIGGER.WHISPER | TRIGGER.QQ_AT | TRIGGER.WEB,
        TARGET.TRUSTED,
        '/pay <玩家名> <金额> — 转账金币给指定玩家',
        (ctx, args) => {
            const parts = args.trim().split(/\s+/);
            if (parts.length < 2) { ctx.reply('[转账] 用法: /pay <玩家名> <金额>'); return; }
            const target = parts[0];
            const amount = parseFloat(parts[1]);
            if (isNaN(amount) || amount <= 0) { ctx.reply('[转账] 金额必须为正数'); return; }
            if (amount > maxPayAmount) { ctx.reply(`[转账] 金额超过单次转账上限 ${maxPayAmount}，请分多次转账`); return; }
            console.log(`${PREFIX} [经济] ${ctx.sender} 转账 ${amount} 金币给 ${target}`);
            startCapture(ctx.sender, ctx.type, ctx._captureBuffer || null, 5000);
            safeChat(`/pay ${target} ${amount}`);
        }, true, {
            player: { type: 'string', description: '接收金币的玩家名称', required: true },
            amount: { type: 'number', description: '转账金额，支持小数', minimum: 0.01, required: true },
        });

    // ---- 传送系统 ----

    cmd('/tpa', ['/tpa'],
        TRIGGER.WHISPER | TRIGGER.QQ_AT | TRIGGER.WEB,
        TARGET.TRUSTED,
        '/tpa <玩家名> — 向指定玩家发送传送请求（传送到对方位置）',
        (ctx, args) => {
            const target = args.trim();
            if (!target) { ctx.reply('[传送] 用法: /tpa <玩家名>'); return; }
            console.log(`${PREFIX} [传送] ${ctx.sender} 请求传送到 ${target}`);
            startCapture(ctx.sender, ctx.type, ctx._captureBuffer || null, 5000);
            safeChat(`/tpa ${target}`);
        }, true, {
            player: { type: 'string', description: '要传送到的目标玩家名称', required: true },
        });

    cmd('/tpahere', ['/tpahere'],
        TRIGGER.WHISPER | TRIGGER.QQ_AT | TRIGGER.WEB,
        TARGET.TRUSTED,
        '/tpahere <玩家名> — 请求指定玩家传送到你的位置',
        (ctx, args) => {
            const target = args.trim();
            if (!target) { ctx.reply('[传送] 用法: /tpahere <玩家名>'); return; }
            console.log(`${PREFIX} [传送] ${ctx.sender} 请求 ${target} 传送到自己`);
            startCapture(ctx.sender, ctx.type, ctx._captureBuffer || null, 5000);
            safeChat(`/tpahere ${target}`);
        }, true, {
            player: { type: 'string', description: '请求传送到你的位置的玩家名称', required: true },
        });

    cmd('/tpaccept', ['/tpaccept'],
        TRIGGER.WHISPER | TRIGGER.QQ_AT | TRIGGER.WEB,
        TARGET.TRUSTED,
        '/tpaccept — 同意当前的传送请求',
        (ctx) => {
            console.log(`${PREFIX} [传送] ${ctx.sender} 同意传送请求`);
            startCapture(ctx.sender, ctx.type, ctx._captureBuffer || null, 5000);
            safeChat('/tpaccept');
        }, true);

    // ---- 服务器切换 ----

    cmd('/server', ['/server'],
        TRIGGER.WEB | TRIGGER.WHISPER | TRIGGER.MENTION | TRIGGER.QQ_AT,
        TARGET.TRUSTED,
        '/server <服务器名> — 通过菜单切换到指定子服（匹配菜单物品名，如"主服""S1""S3"等）',
        async (ctx, args) => {
            const serverName = args.trim();
            if (!serverName) { ctx.reply('[服务器切换] 用法: /server <服务器名>（支持模糊匹配，如 /server 主服 或 /server S1）'); return; }
            console.log(`${PREFIX} [服务器] ${ctx.sender} 通过菜单切换服务器: "${serverName}"`);
            try {
                const result = await switchServer(serverName);
                ctx.reply(result);
            } catch (err) {
                ctx.reply(typeof err === 'string' ? err : err.message || '[服务器切换] 切换失败');
            }
        }, true, {
            serverName: { type: 'string', description: '目标服务器名称（支持模糊匹配菜单物品名，如"主服""S1""S3"等）', required: true },
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

            blockUseItemPackets();
            bot.clickWindow(pc.slot, 0, 0);

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
        '/bot kill <用户名> — 下线机器人（可下线自己或其他机器人）',
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
                // 如果是 AI 工具调用自 kill，ctx.reply 存入 captureBuffer 供 AI 读取结果
                ctx.reply(`[Bot管理] 正在下线自己 (${bot.username})...`);
            } else {
                try { targetBot.end(); } catch (e) {}
                botRegistry.delete(lowerTarget);
                ctx.reply(`[Bot管理] 机器人 ${targetUser} 已下线`);
                console.log(`${PREFIX} [Bot管理] ${ctx.sender} 将机器人 ${targetUser} 下线`);
            }
        }, true, {
            username: { type: 'string', description: '要下线的机器人用户名（可以是自己或其他在线的机器人）', required: true },
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
        }, true, {
            username: { type: 'string', description: '要启动的机器人用户名（必须在配置中存在）', required: true },
        });

    // ========== 自身属性查询（无需可信，直接读取 bot.entity API） ==========

    // 药水效果 ID → 名称映射
    const EFFECT_NAMES = {
        1: '速度', 2: '缓慢', 3: '急迫', 4: '挖掘疲劳', 5: '力量',
        6: '瞬间治疗', 7: '瞬间伤害', 8: '跳跃提升', 9: '反胃',
        10: '生命恢复', 11: '抗性提升', 12: '防火', 13: '水下呼吸',
        14: '隐身', 15: '失明', 16: '夜视', 17: '饥饿', 18: '虚弱',
        19: '中毒', 20: '凋零', 21: '生命提升', 22: '伤害吸收',
        23: '饱和', 24: '发光', 25: '飘浮', 26: '幸运', 27: '霉运',
        28: '缓降', 29: '潮涌能量', 30: '海豚的恩惠', 31: '不祥之兆',
        32: '村庄英雄', 33: '黑暗',
    };

    cmd('/health', ['/health'],
        TRIGGER.MENTION | TRIGGER.WEB | TRIGGER.WHISPER | TRIGGER.QQ_AT,
        TARGET.ALL,
        '/health — 查看机器人的详细生命状态（血量、吸收值、生命提升）',
        (ctx) => {
            const entity = bot.entity;
            if (!entity) { ctx.reply('[生命] 机器人尚未完全加载'); return; }
            const health = Math.round(entity.health * 10) / 10;
            const maxHealth = Math.round((entity.maxHealth || 20) * 10) / 10;
            const lines = [
                `=== 生命状态 ===`,
                `血量: ${health}/${maxHealth}`,
                `饥饿: ${bot.food ?? '?'}/20`,
                `饱和度: ${typeof bot.foodSaturation === 'number' ? bot.foodSaturation.toFixed(1) : '?'}`,
            ];
            // 检查属性：最大生命值（生命提升）、护甲值、盔甲韧性
            if (entity.attributes) {
                const maxHpAttr = entity.attributes['generic.max_health'];
                if (maxHpAttr && maxHpAttr.value) {
                    lines.push(`基础最大生命: ${Math.round(maxHpAttr.value * 10) / 10} (含生命提升)`);
                }
                const armorAttr = entity.attributes['generic.armor'];
                if (armorAttr && armorAttr.value > 0) {
                    lines.push(`护甲值: ${armorAttr.value}`);
                }
                const armorToughness = entity.attributes['generic.armor_toughness'];
                if (armorToughness && armorToughness.value > 0) {
                    lines.push(`盔甲韧性: ${armorToughness.value}`);
                }
            }
            ctx.reply(lines.join('\n'));
        }, true);

    cmd('/effects', ['/effects', '/buffs'],
        TRIGGER.MENTION | TRIGGER.WEB | TRIGGER.WHISPER | TRIGGER.QQ_AT,
        TARGET.ALL,
        '/effects — 查看机器人当前的所有药水效果（buff/debuff）',
        (ctx) => {
            const entity = bot.entity;
            if (!entity) { ctx.reply('[效果] 机器人尚未完全加载'); return; }
            const effects = entity.effects;
            if (!effects || Object.keys(effects).length === 0) {
                ctx.reply('[效果] 当前无任何药水效果');
                return;
            }
            const lines = ['=== 当前药水效果 ==='];
            for (const [id, effect] of Object.entries(effects)) {
                const name = EFFECT_NAMES[id] || `效果#${id}`;
                const level = (effect.amplifier || 0) + 1; // amplifier 0 = 等级1
                const durationSec = Math.round((effect.duration || 0) / 20); // ticks → 秒
                const isNegative = [2, 4, 7, 9, 15, 17, 18, 19, 20, 25, 27, 31, 33].includes(Number(id));
                const icon = isNegative ? '⚠' : '✦';
                const durText = durationSec > 0
                    ? `${Math.floor(durationSec / 60)}分${durationSec % 60}秒`
                    : '永久';
                lines.push(`${icon} ${name} Lv.${level} (剩余: ${durText})`);
            }
            ctx.reply(lines.join('\n'));
        }, true);

    cmd('/armor', ['/armor', '/equipment'],
        TRIGGER.MENTION | TRIGGER.WEB | TRIGGER.WHISPER | TRIGGER.QQ_AT,
        TARGET.ALL,
        '/armor — 查看机器人当前装备（盔甲、手持、副手）',
        (ctx) => {
            const entity = bot.entity;
            if (!entity) { ctx.reply('[装备] 机器人尚未完全加载'); return; }
            const eq = entity.equipment;
            const slotNames = ['手持', '副手', '靴子', '护腿', '胸甲', '头盔'];
            const lines = ['=== 当前装备 ==='];
            let hasAny = false;
            for (let i = 0; i < slotNames.length; i++) {
                const item = eq && eq[i];
                if (item) {
                    hasAny = true;
                    const name = item.displayName || item.name || '(未知)';
                    const durability = item.durabilityUsed !== undefined
                        ? ` [耐久: ${((1 - item.durabilityUsed) * 100).toFixed(0)}%]`
                        : '';
                    lines.push(`${slotNames[i]}: ${name}${durability}`);
                } else {
                    lines.push(`${slotNames[i]}: (空)`);
                }
            }
            ctx.reply(lines.join('\n'));
        }, true);

    cmd('/xp', ['/xp', '/experience'],
        TRIGGER.MENTION | TRIGGER.WEB | TRIGGER.WHISPER | TRIGGER.QQ_AT,
        TARGET.ALL,
        '/xp — 查看机器人当前经验值',
        (ctx) => {
            const entity = bot.entity;
            if (!entity) { ctx.reply('[经验] 机器人尚未完全加载'); return; }
            const level = bot.experience?.level ?? 0;
            const points = bot.experience?.points ?? 0;
            const progress = bot.experience?.progress ?? 0;
            const neededForNext = Math.round(points / (progress > 0 ? progress : 1));
            const lines = [
                '=== 经验状态 ===',
                `等级: ${level}`,
                `经验点: ${points}`,
                `升级进度: ${(progress * 100).toFixed(1)}%`,
            ];
            if (level > 0 && points > 0) {
                lines.push(`距下一级还需约: ${neededForNext - points} 点`);
            }
            ctx.reply(lines.join('\n'));
        }, true);

    cmd('/oxygen', ['/oxygen', '/air'],
        TRIGGER.MENTION | TRIGGER.WEB | TRIGGER.WHISPER | TRIGGER.QQ_AT,
        TARGET.ALL,
        '/oxygen — 查看机器人水下氧气剩余',
        (ctx) => {
            const entity = bot.entity;
            if (!entity) { ctx.reply('[氧气] 机器人尚未完全加载'); return; }
            const oxygen = entity.oxygen !== undefined ? entity.oxygen : (entity.metadata && entity.metadata[1] !== undefined ? entity.metadata[1] : null);
            if (oxygen === null || oxygen === undefined) {
                ctx.reply('[氧气] 无法获取氧气数据（可能不在水中或数据不可用）');
                return;
            }
            const maxOxygen = 300; // 默认最大氧气值（15秒 × 20 ticks）
            const pct = Math.round((oxygen / maxOxygen) * 100);
            ctx.reply(`[氧气] 剩余氧气: ${oxygen}/${maxOxygen} (${pct}%)`);
        }, true);

    // ========== 视图距离控制 ==========

    // 视图距离等级映射
    const VIEW_DISTANCE_LEVELS = {
        'tiny': 2, 'short': 4, 'medium': 8, 'far': 16, 'extreme': 32,
    };

    // 将视图距离值转换为友好名称
    function getViewDistanceName(vd) {
        for (const [name, val] of Object.entries(VIEW_DISTANCE_LEVELS)) {
            if (val === vd) return name;
        }
        return String(vd);
    }

    // 尝试实时更新视图距离（发送 settings 包通知服务器）
    function applyViewDistance(newVD) {
        const numeric = typeof newVD === 'string' ? (VIEW_DISTANCE_LEVELS[newVD.toLowerCase()] || parseInt(newVD)) : newVD;
        if (isNaN(numeric) || numeric < 2 || numeric > 32) return false;

        // 更新 mineflayer 内部记录
        if (bot.settings) {
            bot.settings.viewDistance = numeric;
        }

        // 向服务器发送更新后的客户端设置（使用 mineflayer 内置方法以确保正确的数据包格式和字段名）
        try {
            if (typeof bot.setSettings === 'function') {
                bot.setSettings({ viewDistance: numeric });
            } else {
                // 兜底：直接写入 settings 数据包（1.20.4 的正确数据包名为 settings 而非 client_information）
                const locale = bot.settings?.locale || 'zh_CN';
                const chatFlags = bot.settings?.chat === 'commandsOnly' ? 1 : (bot.settings?.chat === 'disabled' ? 2 : 0);
                const chatColors = bot.settings?.colorsEnabled ?? true;
                const skinParts = typeof bot.settings?.skinParts === 'object'
                    ? ((bot.settings.skinParts.showCape ? 1 : 0) << 0 |
                       (bot.settings.skinParts.showJacket ? 1 : 0) << 1 |
                       (bot.settings.skinParts.showLeftSleeve ? 1 : 0) << 2 |
                       (bot.settings.skinParts.showRightSleeve ? 1 : 0) << 3 |
                       (bot.settings.skinParts.showLeftPants ? 1 : 0) << 4 |
                       (bot.settings.skinParts.showRightPants ? 1 : 0) << 5 |
                       (bot.settings.skinParts.showHat ? 1 : 0) << 6)
                    : 0x7f;
                const mainHand = bot.settings?.mainHand === 'left' ? 0 : 1;
                const enableTextFiltering = bot.settings?.enableTextFiltering ?? false;
                const enableServerListing = bot.settings?.enableServerListing ?? true;

                bot._client.write('settings', {
                    locale,
                    viewDistance: numeric,
                    chatFlags,
                    chatColors,
                    skinParts,
                    mainHand,
                    enableTextFiltering,
                    enableServerListing,
                });
            }
            return true;
        } catch (err) {
            console.error(`${PREFIX} [视图] 发送 settings 失败:`, err.message);
            return false;
        }
    }

    cmd('/viewdistance', ['/viewdistance', '/vd', '/renderdistance', '/rd'],
        TRIGGER.WHISPER | TRIGGER.MENTION | TRIGGER.REPLY | TRIGGER.QQ_AT | TRIGGER.WEB,
        TARGET.TRUSTED,
        '/viewdistance [tiny|short|medium|far|2-32] — 查看或设置 bot 视图距离（越小加载区块越少，服务器压力越低）',
        (ctx, args) => {
            const currentVD = bot.settings?.viewDistance ?? viewDistance;
            const currentName = getViewDistanceName(currentVD);
            // 当前区块加载数：视图距离为 d 时，加载 (2d+1)² 个区块
            const curNumeric = typeof currentVD === 'string' ? (VIEW_DISTANCE_LEVELS[currentVD.toLowerCase()] || parseInt(currentVD)) : currentVD;
            const chunkCount = isNaN(curNumeric) ? '?' : (2 * curNumeric + 1) ** 2;

            if (!args || !args.trim()) {
                // 无参数：显示当前设置
                const levels = Object.entries(VIEW_DISTANCE_LEVELS)
                    .map(([name, val]) => {
                        const chunks = (2 * val + 1) ** 2;
                        return `${name}(${val}区块=${chunks}个)`;
                    })
                    .join(' / ');
                ctx.reply(`[视图距离] 当前: ${currentName} (${curNumeric} 区块半径 ≈ ${chunkCount} 个区块加载)\n可用等级: ${levels}\n用法: /viewdistance <等级或数字> 来修改`);
                return;
            }

            const input = args.trim().toLowerCase();
            let newVD = VIEW_DISTANCE_LEVELS[input] || parseInt(input);

            if (isNaN(newVD) || newVD < 2 || newVD > 32) {
                ctx.reply(`[视图距离] 无效值 "${args.trim()}"。可用: tiny(2)/short(4)/medium(8)/far(16)/extreme(32) 或直接 2-32 的数字`);
                return;
            }

            const newName = getViewDistanceName(newVD);
            const newChunks = (2 * newVD + 1) ** 2;

            // 尝试实时应用
            const applied = applyViewDistance(newVD);
            if (applied) {
                const oldChunks = (2 * curNumeric + 1) ** 2;
                ctx.reply(`[视图距离] 已从 ${currentName}(${oldChunks}区块) 更新为 ${newName}(${newChunks}区块)\n⚠ 注意：实时更新后服务器可能需要几秒重新计算区块。如需完全生效，建议重启 bot。`);
            } else {
                ctx.reply(`[视图距离] 无法实时更新，请修改 config.json 中 defaults.view_distance 为 "${newName}" 后重启 bot。`);
            }
        }, true);

    // ========== Residence 插件命令 ==========
    // 查询类命令（所有玩家可用）

    cmd('/res info', ['/res info'],
        TRIGGER.WHISPER | TRIGGER.MENTION | TRIGGER.REPLY | TRIGGER.QQ_AT | TRIGGER.WEB,
        TARGET.ALL,
        '/res info [领地名] — 查看当前所在领地（或指定领地）的信息',
        (ctx, args) => {
            const target = args.trim();
            const cmdText = target ? `/res info ${target}` : '/res info';
            console.log(`${PREFIX} [Residence] ${ctx.sender} 查询领地信息${target ? ' (目标: ' + target + ')' : ''}`);
            startCapture(ctx.sender, ctx.type, ctx._captureBuffer || null, 5000);
            safeChat(cmdText);
        }, true, {
            residence: { type: 'string', description: '要查询的领地名称（可选，不填则查询当前所在领地）', required: false },
        });

    cmd('/res list', ['/res list'],
        TRIGGER.WHISPER | TRIGGER.MENTION | TRIGGER.REPLY | TRIGGER.QQ_AT | TRIGGER.WEB,
        TARGET.ALL,
        '/res list [玩家名] — 查看领地列表（不填则列出服务器的领地）',
        (ctx, args) => {
            const target = args.trim();
            const cmdText = target ? `/res list ${target}` : '/res list';
            console.log(`${PREFIX} [Residence] ${ctx.sender} 查询领地列表${target ? ' (玩家: ' + target + ')' : ''}`);
            startCapture(ctx.sender, ctx.type, ctx._captureBuffer || null, 5000);
            safeChat(cmdText);
        }, true, {
            player: { type: 'string', description: '要查询的玩家名称（可选）', required: false },
        });

    cmd('/res listall', ['/res listall'],
        TRIGGER.WHISPER | TRIGGER.MENTION | TRIGGER.REPLY | TRIGGER.QQ_AT | TRIGGER.WEB,
        TARGET.ALL,
        '/res listall — 列出服务器全部领地',
        (ctx) => {
            console.log(`${PREFIX} [Residence] ${ctx.sender} 查询全部领地列表`);
            startCapture(ctx.sender, ctx.type, ctx._captureBuffer || null, 5000);
            safeChat('/res listall');
        }, true);

    // Residence TP 命令（仅可信玩家可用——会改变 bot 位置）

    cmd('/res tp', ['/res tp'],
        TRIGGER.WHISPER | TRIGGER.QQ_AT | TRIGGER.WEB,
        TARGET.TRUSTED,
        '/res tp <领地名> — 传送到指定领地',
        (ctx, args) => {
            const target = args.trim();
            if (!target) { ctx.reply('[Residence] 用法: /res tp <领地名>'); return; }
            console.log(`${PREFIX} [Residence] ${ctx.sender} 传送到领地 ${target}`);
            startCapture(ctx.sender, ctx.type, ctx._captureBuffer || null, 5000);
            safeChat(`/res tp ${target}`);
        }, true, {
            residence: { type: 'string', description: '要传送到的领地名称', required: true },
        });

    cmd('/res tpa', ['/res tpa'],
        TRIGGER.WHISPER | TRIGGER.QQ_AT | TRIGGER.WEB,
        TARGET.TRUSTED,
        '/res tpa <领地名> <玩家名> — 请求指定玩家传送到某个领地',
        (ctx, args) => {
            const parts = args.trim().split(/\s+/);
            if (parts.length < 2) { ctx.reply('[Residence] 用法: /res tpa <领地名> <玩家名>'); return; }
            const resName = parts[0];
            const playerName = parts.slice(1).join(' ');
            console.log(`${PREFIX} [Residence] ${ctx.sender} 请求 ${playerName} 传送到领地 ${resName}`);
            startCapture(ctx.sender, ctx.type, ctx._captureBuffer || null, 5000);
            safeChat(`/res tpa ${resName} ${playerName}`);
        }, true, {
            residence: { type: 'string', description: '目标领地名称', required: true },
            player: { type: 'string', description: '要传送的玩家名称', required: true },
        });

    // ========== GSit 动作命令（仅可信玩家可用——改变 bot 姿态） ==========

    cmd('/sit', ['/sit'],
        TRIGGER.WHISPER | TRIGGER.QQ_AT | TRIGGER.WEB,
        TARGET.TRUSTED,
        '/sit — 切换机器人坐下/站起（重复调用可恢复站立；也可用 /sneak 解除）',
        (ctx) => {
            console.log(`${PREFIX} [GSit] ${ctx.sender} 切换机器人坐下状态`);
            safeChat('/sit');
            ctx.reply('[动作] 已切换坐姿');
        }, true);

    cmd('/crawl', ['/crawl'],
        TRIGGER.WHISPER | TRIGGER.QQ_AT | TRIGGER.WEB,
        TARGET.TRUSTED,
        '/crawl — 切换机器人趴下/站起（重复调用可恢复站立；也可用 /sneak 解除）',
        (ctx) => {
            console.log(`${PREFIX} [GSit] ${ctx.sender} 切换机器人趴下状态`);
            safeChat('/crawl');
            ctx.reply('[动作] 已切换匍匐姿态');
        }, true);

    cmd('/lay', ['/lay'],
        TRIGGER.WHISPER | TRIGGER.QQ_AT | TRIGGER.WEB,
        TARGET.TRUSTED,
        '/lay — 切换机器人躺下/站起（重复调用可恢复站立；也可用 /sneak 解除）',
        (ctx) => {
            console.log(`${PREFIX} [GSit] ${ctx.sender} 切换机器人躺下状态`);
            safeChat('/lay');
            ctx.reply('[动作] 已切换躺姿');
        }, true);

    cmd('/spin', ['/spin'],
        TRIGGER.WHISPER | TRIGGER.QQ_AT | TRIGGER.WEB,
        TARGET.TRUSTED,
        '/spin — 切换机器人旋转/停止（重复调用可停止旋转；也可用 /sneak 解除）',
        (ctx) => {
            console.log(`${PREFIX} [GSit] ${ctx.sender} 切换机器人旋转状态`);
            safeChat('/spin');
            ctx.reply('[动作] 已切换旋转状态');
        }, true);

    cmd('/bellyflop', ['/bellyflop'],
        TRIGGER.WHISPER | TRIGGER.QQ_AT | TRIGGER.WEB,
        TARGET.TRUSTED,
        '/bellyflop — 切换机器人肚子着地/站起（重复调用可恢复站立；也可用 /sneak 解除）',
        (ctx) => {
            console.log(`${PREFIX} [GSit] ${ctx.sender} 切换机器人肚子着地状态`);
            safeChat('/bellyflop');
            ctx.reply('[动作] 已切换肚子着地姿态');
        }, true);

    // ========== 潜行（Shift）命令 —— 恢复站立的万能方法 ==========

    cmd('/sneak', ['/sneak', '/shift'],
        TRIGGER.WHISPER | TRIGGER.QQ_AT | TRIGGER.WEB,
        TARGET.TRUSTED,
        '/sneak — 让机器人按一下 Shift 潜行键再松开（可解除 GSit 坐/躺/趴/旋转等所有姿势，恢复到正常站立）',
        (ctx) => {
            console.log(`${PREFIX} [动作] ${ctx.sender} 让机器人按 Shift 潜行`);
            bot.setControlState('sneak', true);
            setTimeout(() => {
                bot.setControlState('sneak', false);
            }, 150);
            ctx.reply('[动作] 已按 Shift 潜行后再松开，姿势已恢复站立');
        }, true);

    // ========== 挑衅动作（连续快速蹲起） ==========

    cmd('/taunt', ['/taunt'],
        TRIGGER.WHISPER | TRIGGER.QQ_AT | TRIGGER.WEB,
        TARGET.TRUSTED,
        '/taunt — 让机器人连续快速蹲起（约15次，持续约2秒），用作挑衅/嘲讽动作',
        (ctx) => {
            console.log(`${PREFIX} [动作] ${ctx.sender} 让机器人挑衅`);
            const count = 15;
            const interval = 140; // 每 140ms 切换一次 → 2.1 秒
            let i = 0;
            const timer = setInterval(() => {
                bot.setControlState('sneak', i % 2 === 0);
                i++;
                if (i >= count) {
                    clearInterval(timer);
                    bot.setControlState('sneak', false); // 确保最终松开
                }
            }, interval);
            ctx.reply('[动作] 正在挑衅！（连续蹲起）');
        }, true);

    // ========== AFK 挂机命令（仅可信玩家可用） ==========

    // ---- 定时与延时 ----

    cmd('/sleep', ['/sleep'],
        TRIGGER.WHISPER | TRIGGER.QQ_AT | TRIGGER.WEB,
        TARGET.TRUSTED,
        '/sleep <毫秒> — 让机器人等待指定毫秒后执行下一条指令（心跳包正常发送）',
        async (ctx, args) => {
            const msStr = args.trim();
            const ms = parseInt(msStr, 10);
            if (!msStr || isNaN(ms) || ms < 0) {
                ctx.reply('[sleep] 用法: /sleep <毫秒>（例: /sleep 5000 等待 5 秒）');
                return;
            }
            const cappedMs = Math.min(ms, 60000); // 最长 60 秒
            console.log(`${PREFIX} [sleep] ${ctx.sender} 等待 ${cappedMs}ms${cappedMs !== ms ? ' (已截断，原值: ' + ms + ')' : ''}`);
            await new Promise(resolve => setTimeout(resolve, cappedMs));
            ctx.reply(`[sleep] 等待完成 (${cappedMs}ms)`);
        });

    cmd('/afk', ['/afk'],
        TRIGGER.WHISPER | TRIGGER.QQ_AT | TRIGGER.WEB,
        TARGET.TRUSTED,
        '/afk [消息] — 切换机器人 AFK 状态（可选自定义 AFK 消息）',
        (ctx, args) => {
            const afkMsg = args.trim();
            const cmdText = afkMsg ? `/afk ${afkMsg}` : '/afk';
            console.log(`${PREFIX} [AFK] ${ctx.sender} 切换机器人 AFK 状态${afkMsg ? ' (消息: ' + afkMsg + ')' : ''}`);
            safeChat(cmdText);
            ctx.reply(`[AFK] 已切换 AFK 状态${afkMsg ? ' (消息: ' + afkMsg + ')' : ''}`);
        }, true, {
            message: { type: 'string', description: '自定义 AFK 消息（可选）', required: false },
        });

    // ---- 合成站命令 ----

    cmd('/craftstation', ['/craftstation'],
        TRIGGER.WHISPER | TRIGGER.WEB | TRIGGER.QQ_AT,
        TARGET.TRUSTED,
        '/craftstation <输入物品名> <输出物品名> [循环次数|infinite] [-src x y z] [-table x y z] [-dst x y z] — 启动9合1合成站。从左侧箱子取原材料，用工作台批量合成（9组→1组），存入右侧箱子。可选指定坐标。用 /craftstation stop 停止',
        async (ctx, args) => {
            const trimmed = args.trim();

            // 子命令: stop / force / status
            const firstWord = trimmed.split(/\s+/)[0];
            if (firstWord === 'stop') { ctx.reply(stopCraftStation(false)); return; }
            if (firstWord === 'force') { ctx.reply(stopCraftStation(true)); return; }
            if (firstWord === 'status') {
                ctx.reply(craftStationActive
                    ? `[合成站] 运行中 | ${craftStationInputName} → ${craftStationOutputName} | 第 ${craftStationCycleCount} 循环 | 已合成 ${craftStationTotalCrafted} 个产物 | 状态: ${craftStationState}`
                    : '[合成站] 当前未运行');
                return;
            }

            // 解析标志: -src x y z  -table x y z  -dst x y z
            let inputName = '', outputName = '', cycles = 0;
            let srcPos = null, tablePos = null, dstPos = null;

            // 用正则匹配各标志及其坐标
            const srcMatch = trimmed.match(/-src\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/);
            const tableMatch = trimmed.match(/-table\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/);
            const dstMatch = trimmed.match(/-dst\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/);

            if (srcMatch) srcPos = new Vec3(parseInt(srcMatch[1]), parseInt(srcMatch[2]), parseInt(srcMatch[3]));
            if (tableMatch) tablePos = new Vec3(parseInt(tableMatch[1]), parseInt(tableMatch[2]), parseInt(tableMatch[3]));
            if (dstMatch) dstPos = new Vec3(parseInt(dstMatch[1]), parseInt(dstMatch[2]), parseInt(dstMatch[3]));

            // 去掉标志部分，剩下的就是 input output [cycles]
            const remaining = trimmed
                .replace(/-src\s+-?\d+\s+-?\d+\s+-?\d+/g, '')
                .replace(/-table\s+-?\d+\s+-?\d+\s+-?\d+/g, '')
                .replace(/-dst\s+-?\d+\s+-?\d+\s+-?\d+/g, '')
                .trim();
            const parts = remaining.split(/\s+/);

            if (parts.length < 2) {
                ctx.reply('[合成站] 用法: /craftstation <输入物品名> <输出物品名> [循环次数] [-src x y z] [-table x y z] [-dst x y z]');
                ctx.reply('[合成站] 例如: /craftstation gold_nugget gold_ingot');
                ctx.reply('[合成站] 例如: /craftstation gold_ingot gold_block 5 -src 100 64 -50 -table 101 63 -50 -dst 102 64 -50');
                ctx.reply('[合成站] 子命令: stop | force | status');
                return;
            }

            inputName = parts[0];
            outputName = parts[1];
            if (parts.length > 2) {
                const third = parts[2].toLowerCase();
                if (third === 'infinite' || third === 'inf' || third === '0') cycles = 0;
                else {
                    cycles = parseInt(third);
                    if (isNaN(cycles) || cycles < 0) { ctx.reply('[合成站] 循环次数必须为非负整数或 infinite'); return; }
                }
            }

            // 设置手动坐标配置
            if (srcPos || dstPos) {
                craftStationConfigPos = { source: srcPos, dest: dstPos };
            } else {
                craftStationConfigPos = null; // 未指定则清除旧配置，回退到自动探测
            }
            if (tablePos) {
                craftStationTablePos = tablePos;
            } else {
                craftStationTablePos = null; // 未指定则清除旧缓存
            }

            const msg = await startCraftStation(inputName, outputName, cycles, ctx.sender);
            ctx.reply(msg);
        }, true, {
            input: { type: 'string', description: '输入物品名称（如 gold_nugget）', required: true },
            output: { type: 'string', description: '输出物品名称（如 gold_ingot）', required: true },
            cycles: { type: 'string', description: '循环次数或 infinite（可选，默认无限）', required: false },
        });

    // ---- 洗潜影盒命令 ----

    cmd('/washbox', ['/washbox'],
        TRIGGER.WHISPER | TRIGGER.WEB | TRIGGER.QQ_AT,
        TARGET.TRUSTED,
        '/washbox [-water x y z] [-cauldron x y z] [-bucket x y z] [-dyed x y z] [-undyed x y z] [循环次数|infinite] — 洗潜影盒自动化。子命令: stop | force | status',
        async (ctx, args) => {
            const trimmed = args.trim();

            // 子命令
            const firstWord = trimmed.split(/\s+/)[0];
            if (firstWord === 'stop') { ctx.reply(stopWashStation(false)); return; }
            if (firstWord === 'force') { ctx.reply(stopWashStation(true)); return; }
            if (firstWord === 'status') {
                if (washStationActive) {
                    const lvl = washStationCauldronLevel;
                    const durSec = washStationStartTime > 0 ? Math.round((Date.now() - washStationStartTime) / 1000) : 0;
                    const durStr = durSec >= 3600 ? `${Math.floor(durSec / 3600)}h${Math.floor((durSec % 3600) / 60)}m`
                        : durSec >= 60 ? `${Math.floor(durSec / 60)}m${durSec % 60}s` : `${durSec}s`;
                    ctx.reply(`[洗盒] 运行中 | 状态: ${washStationState} | 第 ${washStationCycleCount} 循环 | 已洗 ${washStationTotalWashed} 个盒子 | 炼药锅水位 ${lvl}/3 | 运行 ${durStr}`);
                } else {
                    ctx.reply('[洗盒] 当前未运行');
                }
                return;
            }

            // 解析标志: -water x y z  -cauldron x y z  -bucket x y z  -dyed x y z  -undyed x y z
            const waterMatch = trimmed.match(/-water\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/);
            const cauldronMatch = trimmed.match(/-cauldron\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/);
            const bucketMatch = trimmed.match(/-bucket\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/);
            const dyedMatch = trimmed.match(/-dyed\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/);
            const undyedMatch = trimmed.match(/-undyed\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/);

            let waterPos = null, cauldronPos = null, bucketPos = null, dyedPos = null, undyedPos = null;
            if (waterMatch) waterPos = new Vec3(parseInt(waterMatch[1]), parseInt(waterMatch[2]), parseInt(waterMatch[3]));
            if (cauldronMatch) cauldronPos = new Vec3(parseInt(cauldronMatch[1]), parseInt(cauldronMatch[2]), parseInt(cauldronMatch[3]));
            if (bucketMatch) bucketPos = new Vec3(parseInt(bucketMatch[1]), parseInt(bucketMatch[2]), parseInt(bucketMatch[3]));
            if (dyedMatch) dyedPos = new Vec3(parseInt(dyedMatch[1]), parseInt(dyedMatch[2]), parseInt(dyedMatch[3]));
            if (undyedMatch) undyedPos = new Vec3(parseInt(undyedMatch[1]), parseInt(undyedMatch[2]), parseInt(undyedMatch[3]));

            // 验证关键坐标
            const missing = [];
            if (!cauldronMatch) missing.push('-cauldron (炼药锅)');
            if (!dyedMatch) missing.push('-dyed (染色盒容器)');
            if (!undyedMatch) missing.push('-undyed (无色盒容器)');
            if (missing.length > 0) {
                ctx.reply(`[洗盒] 缺少必要坐标: ${missing.join(', ')}`);
                ctx.reply('[洗盒] 用法: /washbox -cauldron <炼药锅 x y z> -dyed <染色容器 x y z> -undyed <无色容器 x y z> [-water <水源 x y z>] [-bucket <桶容器 x y z>] [循环次数]');
                ctx.reply('[洗盒] 例如: /washbox -water 100 64 200 -cauldron 100 64 201 -bucket 100 64 202 -dyed 100 64 203 -undyed 100 64 204');
                ctx.reply('[洗盒] 子命令: stop | force | status');
                return;
            }

            // 去掉标志部分，剩下的就是 cycles
            const remaining = trimmed
                .replace(/-water\s+-?\d+\s+-?\d+\s+-?\d+/g, '')
                .replace(/-cauldron\s+-?\d+\s+-?\d+\s+-?\d+/g, '')
                .replace(/-bucket\s+-?\d+\s+-?\d+\s+-?\d+/g, '')
                .replace(/-dyed\s+-?\d+\s+-?\d+\s+-?\d+/g, '')
                .replace(/-undyed\s+-?\d+\s+-?\d+\s+-?\d+/g, '')
                .trim();
            let cycles = 0;
            if (remaining) {
                const third = remaining.split(/\s+/)[0].toLowerCase();
                if (third === 'infinite' || third === 'inf' || third === '0') cycles = 0;
                else {
                    cycles = parseInt(third);
                    if (isNaN(cycles) || cycles < 0) { ctx.reply('[洗盒] 循环次数必须为非负整数或 infinite'); return; }
                }
            }

            const msg = await startWashStation(waterPos, cauldronPos, bucketPos, dyedPos, undyedPos, cycles, ctx.sender);
            ctx.reply(msg);
        }, true, {
            water: { type: 'string', description: '水源坐标 -water x y z（可选）', required: false },
            cauldron: { type: 'string', description: '炼药锅坐标 -cauldron x y z（必填）', required: true },
            bucket: { type: 'string', description: '桶容器坐标 -bucket x y z（可选）', required: false },
            dyed: { type: 'string', description: '染色盒子容器坐标 -dyed x y z（必填）', required: true },
            undyed: { type: 'string', description: '无色盒子容器坐标 -undyed x y z（必填）', required: true },
            cycles: { type: 'string', description: '循环次数或 infinite（可选，默认无限）', required: false },
        });

    // ---- Buddy Watch 命令 ----

    cmd('/buddy', ['/buddy'],
        TRIGGER.WHISPER | TRIGGER.WEB | TRIGGER.QQ_AT,
        TARGET.TRUSTED,
        '/buddy [status|watch <玩家名>|unwatch] — 查询/设置/取消 Buddy Watch 监视',
        (ctx, args) => {
            const subCmd = args.trim().toLowerCase();

            if (!subCmd || subCmd === 'status') {
                // 查询当前监视状态
                if (bot._buddyWatch) {
                    ctx.reply(`[Buddy] 当前监视目标: ${bot._buddyWatch}（该玩家离线时本机器人将自动下线）`);
                } else {
                    ctx.reply('[Buddy] 当前未设置监视目标');
                }
                return;
            }

            if (subCmd === 'unwatch') {
                const oldTarget = bot._buddyWatch;
                bot._buddyWatch = null;
                console.log(`${PREFIX} [Buddy] ${ctx.sender} 取消了监视 ${oldTarget || '(无)'}`);
                ctx.reply(`[Buddy] 已取消监视${oldTarget ? ' ' + oldTarget : ''}`);
                return;
            }

            if (subCmd.startsWith('watch ')) {
                const target = subCmd.slice('watch '.length).trim();
                if (!target) { ctx.reply('[Buddy] 用法: /buddy watch <玩家名>'); return; }
                bot._buddyWatch = target;
                console.log(`${PREFIX} [Buddy] ${ctx.sender} 设置了监视目标: ${target}`);
                ctx.reply(`[Buddy] 已设置监视目标: ${target}（该玩家离线时本机器人将自动下线）`);
                return;
            }

            ctx.reply('[Buddy] 未知子命令。可用: status / watch <玩家名> / unwatch');
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

// ========== 全局未处理 Promise 拒绝防护 ==========
// 防止 clickWindow 等异步操作超时导致进程崩溃
process.on('unhandledRejection', (reason, promise) => {
    console.error('[进程] 未处理的 Promise 拒绝:', reason?.message || reason);
    // 不退出进程，仅记录日志
});

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
            const existingBot = botRegistry.get(lowerUser);
            // 检查 bot 是否实际已断开（mineflayer 的 ended 属性为 true 表示连接已终止）
            if (existingBot && existingBot.ended) {
                console.log(`[主进程] 机器人 ${botCfg.username} 已结束但仍在注册表中，清理并重新启动`);
                botRegistry.delete(lowerUser);
                // 继续执行下面的启动逻辑
            } else {
                return `机器人 ${botCfg.username} 已在运行中`;
            }
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

module.exports = { createBotInstance, checkBuddyWatchChain };
