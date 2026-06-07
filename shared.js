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

// ========== Cookie 解析工具 ==========
function parseCookies(req) {
    const header = req.headers.cookie;
    if (!header) return {};
    const cookies = {};
    header.split(';').forEach(c => {
        const idx = c.indexOf('=');
        if (idx > 0) {
            cookies[c.slice(0, idx).trim()] = decodeURIComponent(c.slice(idx + 1).trim());
        }
    });
    return cookies;
}

module.exports = { loadConfig, getAIConfig, parseCookies };
