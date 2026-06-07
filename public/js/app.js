/* ================================================================
 *  MC Bot Web 管理面板 — 前端逻辑
 * ================================================================ */

// ========== 鉴权 ==========
function getToken() {
    return localStorage.getItem('mc_bot_token') || '';
}

function isAuthenticated() {
    return !!getToken();
}

function logout() {
    fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + getToken() },
    }).finally(() => {
        localStorage.removeItem('mc_bot_token');
        window.location.replace('/login.html');
    });
}

// ========== 状态 ==========
let botsData = [];
let currentModalBot = null;
let logsVisible = true;

// ========== DOM 引用 ==========
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const botGrid = $('#botGrid');
const logContainer = $('#logContainer');
const logPanel = $('#logPanel');
const logFilter = $('#logFilter');
const connectionStatus = $('#connectionStatus');
const cmdModal = $('#cmdModal');

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', () => {
    // 未登录则跳转
    if (!isAuthenticated()) {
        window.location.replace('/login.html');
        return;
    }
    fetchBots();
    fetchLogs();
    connectSSE();
    bindEvents();
});

// ========== 事件绑定 ==========
function bindEvents() {
    $('#refreshBtn').addEventListener('click', () => {
        fetchBots();
        fetchLogs();
    });

    $('#toggleLogsBtn').addEventListener('click', toggleLogs);
    $('#hideLogsBtn').addEventListener('click', () => toggleLogs(false));
    $('#clearLogsBtn').addEventListener('click', clearLogs);

    logFilter.addEventListener('change', () => {
        renderLogs(logContainer._allLogs || []);
    });

    // 指令弹窗
    $('#cmdModalClose').addEventListener('click', closeCmdModal);
    $('#cmdCancelBtn').addEventListener('click', closeCmdModal);
    $('#cmdSendBtn').addEventListener('click', sendCommand);

    // 点击遮罩关闭
    cmdModal.addEventListener('click', (e) => {
        if (e.target === cmdModal) closeCmdModal();
    });

    // 退出登录
    $('#logoutBtn').addEventListener('click', () => {
        if (confirm('确定要退出登录吗？')) logout();
    });

    // 设置抽屉
    $('#settingsBtn').addEventListener('click', openSettings);
    $('#settingsCloseBtn').addEventListener('click', closeSettings);
    $('#settingsOverlay').addEventListener('click', (e) => {
        if (e.target === $('#settingsOverlay')) closeSettings();
    });

    // ESC 关闭弹窗 / 设置抽屉
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if ($('#settingsOverlay').style.display === 'flex') {
                closeSettings();
            } else {
                closeCmdModal();
            }
        }
    });

    // 指令输入框回车发送
    $('#cmdInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendCommand();
        }
    });
}

// ========== SSE 连接 ==========
async function connectSSE() {
    // 获取短期 SSE 令牌（避免长期 JWT 出现在 URL 中）
    let sseToken;
    try {
        const res = await apiCall('POST', '/api/auth/sse-token');
        if (res.error) {
            console.error('获取 SSE 令牌失败:', res.error);
            // 回退到直接使用 JWT（兼容旧版本）
            sseToken = getToken();
        } else {
            sseToken = res.token;
        }
    } catch (err) {
        console.error('SSE 令牌请求失败，回退到 JWT:', err);
        sseToken = getToken();
    }

    const es = new EventSource(`/api/events?token=${encodeURIComponent(sseToken)}`);

    es.addEventListener('status', (e) => {
        try {
            botsData = JSON.parse(e.data);
            renderBots();
        } catch (err) {
            console.error('SSE status 解析失败:', err);
        }
    });

    es.addEventListener('log', (e) => {
        try {
            const entry = JSON.parse(e.data);
            if (!logContainer._allLogs) logContainer._allLogs = [];
            logContainer._allLogs.push(entry);
            if (logContainer._allLogs.length > 500) logContainer._allLogs.shift();
            renderLogs(logContainer._allLogs);
        } catch (err) {
            console.error('SSE log 解析失败:', err);
        }
    });

    es.onopen = () => {
        connectionStatus.textContent = '● 已连接';
        connectionStatus.classList.remove('disconnected');
    };

    es.onerror = () => {
        connectionStatus.textContent = '● 已断开（自动重连中）';
        connectionStatus.classList.add('disconnected');
    };
}

// ========== API 调用 ==========
async function fetchBots() {
    try {
        botsData = await apiCall('GET', '/api/bots');
        renderBots();
    } catch (err) {
        console.error('获取 bot 列表失败:', err);
    }
}

async function fetchLogs() {
    try {
        const source = logFilter.value;
        const url = source ? `/api/logs?source=${encodeURIComponent(source)}` : '/api/logs';
        const logs = await apiCall('GET', url);
        logContainer._allLogs = logs;
        renderLogs(logs);
    } catch (err) {
        console.error('获取日志失败:', err);
    }
}

async function apiCall(method, url, body) {
    const token = getToken();
    const opts = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token,
        },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    if (res.status === 401) {
        // Token 过期或无效，跳转登录页
        localStorage.removeItem('mc_bot_token');
        window.location.replace('/login.html');
        return { error: '未登录' };
    }
    return res.json();
}

// ========== 渲染 Bot 卡片 ==========
function renderBots() {
    if (!botsData || botsData.length === 0) {
        botGrid.innerHTML = '<div class="empty-state"><p>没有配置任何机器人</p></div>';
        return;
    }

    botGrid.innerHTML = botsData.map(bot => {
        const online = bot.online;
        const statusClass = online ? 'online' : 'offline';
        const statusText = online ? '在线' : '离线';
        const avatarLetter = (bot.name || bot.username || '?')[0].toUpperCase();
        const uptime = online && bot.uptime ? formatUptime(bot.uptime) : null;

        return `
        <div class="bot-card ${statusClass}" data-bot-name="${escHtml(bot.name)}">
            <div class="card-header">
                <div class="bot-avatar ${statusClass}">${avatarLetter}</div>
                <div class="bot-info">
                    <div class="bot-name">${escHtml(bot.name)}</div>
                    <div class="bot-username">@${escHtml(bot.username)}</div>
                </div>
                <div class="bot-status">
                    <span class="status-dot ${statusClass}"></span>
                    ${statusText}
                </div>
            </div>
            <div class="card-body">
                <div class="card-meta">
                    <span>🌐 ${escHtml(bot.host)}:${bot.port}</span>
                    ${uptime ? `<span>⏱ ${uptime}</span>` : ''}
                    ${bot.enabled ? '<span>🔵 默认启动</span>' : ''}
                </div>
            </div>
            <div class="card-actions">
                ${online
                    ? `<button class="btn btn-danger btn-stop" data-bot="${escHtml(bot.name)}">⬇ 下线</button>`
                    : `<button class="btn btn-success btn-start" data-bot="${escHtml(bot.name)}">⬆ 上线</button>`
                }
                <button class="btn btn-cmd" data-bot="${escHtml(bot.name)}" ${online ? '' : 'disabled'}>💬 指令</button>
            </div>
            <div class="toggle-row">
                <span class="toggle-label">默认启动</span>
                <label class="toggle-switch">
                    <input type="checkbox" class="toggle-enable" data-bot="${escHtml(bot.name)}"
                        ${bot.enabled ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>
        </div>`;
    }).join('');

    // 绑定卡片内的事件
    botGrid.querySelectorAll('.btn-start').forEach(btn => {
        btn.addEventListener('click', () => startBot(btn.dataset.bot));
    });
    botGrid.querySelectorAll('.btn-stop').forEach(btn => {
        btn.addEventListener('click', () => stopBot(btn.dataset.bot));
    });
    botGrid.querySelectorAll('.btn-cmd').forEach(btn => {
        btn.addEventListener('click', () => openCmdModal(btn.dataset.bot));
    });
    botGrid.querySelectorAll('.toggle-enable').forEach(toggle => {
        toggle.addEventListener('change', () => toggleEnable(toggle.dataset.bot, toggle.checked));
    });

    // 更新日志过滤器选项
    updateLogFilter();
}

// ========== Bot 操作 ==========
async function startBot(name) {
    const btn = botGrid.querySelector(`.btn-start[data-bot="${escHtml(name)}"]`);
    if (btn) btn.disabled = true;
    const result = await apiCall('POST', `/api/bots/${encodeURIComponent(name)}/start`);
    if (btn) btn.disabled = false;
    if (result.error) alert(`启动失败: ${result.error}`);
}

async function stopBot(name) {
    if (!confirm(`确定要下线机器人 "${name}" 吗？`)) return;
    const btn = botGrid.querySelector(`.btn-stop[data-bot="${escHtml(name)}"]`);
    if (btn) btn.disabled = true;
    const result = await apiCall('POST', `/api/bots/${encodeURIComponent(name)}/stop`);
    if (btn) btn.disabled = false;
    if (result.error) alert(`停止失败: ${result.error}`);
}

async function toggleEnable(name, enabled) {
    const action = enabled ? 'enable' : 'disable';
    await apiCall('POST', `/api/bots/${encodeURIComponent(name)}/${action}`);
}

// ========== 指令弹窗 ==========
function openCmdModal(botName) {
    currentModalBot = botName;
    $('#cmdModalTitle').textContent = `发送指令 — ${botName}`;
    $('#cmdInput').value = '';
    $('#cmdResult').className = 'cmd-result';
    $('#cmdResult').textContent = '';
    cmdModal.style.display = 'flex';
    setTimeout(() => $('#cmdInput').focus(), 100);
}

function closeCmdModal() {
    cmdModal.style.display = 'none';
    currentModalBot = null;
}

async function sendCommand() {
    if (!currentModalBot) return;

    const type = $('#cmdType').value;
    const input = $('#cmdInput').value.trim();
    if (!input) return;

    const $sendBtn = $('#cmdSendBtn');
    $sendBtn.disabled = true;
    $sendBtn.textContent = '发送中...';

    // exec = Bot内部指令（优先匹配注册命令，未匹配则发到服务器）
    // cmd  = 直接发送服务器命令
    // chat = 公聊消息
    const endpoint = type === 'exec' ? 'exec' : type === 'cmd' ? 'cmd' : 'chat';
    const bodyKey = (type === 'exec' || type === 'cmd') ? 'command' : 'message';
    const result = await apiCall('POST',
        `/api/bots/${encodeURIComponent(currentModalBot)}/${endpoint}`,
        { [bodyKey]: input }
    );

    $sendBtn.disabled = false;
    $sendBtn.textContent = '发送';

    const $result = $('#cmdResult');
    if (result.error) {
        $result.className = 'cmd-result error';
        $result.textContent = `❌ ${result.error}`;
    } else {
        $result.className = 'cmd-result success';
        const replyText = result.reply ? `\n📩 回复: ${result.reply}` : '';
        $result.textContent = `✅ ${result.message}${replyText}`;
        $('#cmdInput').value = '';
    }
}

// ========== 日志渲染 ==========
function renderLogs(logs) {
    if (!logs || logs.length === 0) {
        logContainer.innerHTML = '<div class="log-empty">暂无日志</div>';
        return;
    }

    const sourceFilter = logFilter.value;
    const filtered = sourceFilter
        ? logs.filter(l => l.source === sourceFilter)
        : logs;

    logContainer.innerHTML = filtered.map(l => {
        const time = l.time ? new Date(l.time).toLocaleTimeString('zh-CN', { hour12: false }) : '';
        const source = escHtml(l.source || '');
        const text = escHtml(l.message || '');
        return `<div class="log-line log-level-${l.level || 'info'}">
            <span class="log-time">${time}</span>
            <span class="log-source">[${source}]</span>
            <span class="log-text">${text}</span>
        </div>`;
    }).join('');

    // 自动滚动到底部
    logContainer.scrollTop = logContainer.scrollHeight;
}

function updateLogFilter() {
    const currentVal = logFilter.value;
    const sources = new Set(['server']);
    botsData.forEach(b => sources.add(b.name));

    logFilter.innerHTML = '<option value="">全部来源</option>' +
        [...sources].map(s => `<option value="${escHtml(s)}" ${s === currentVal ? 'selected' : ''}>${escHtml(s)}</option>`).join('');
}

function clearLogs() {
    logContainer._allLogs = [];
    logContainer.innerHTML = '<div class="log-empty">日志已清空</div>';
}

function toggleLogs(show) {
    if (show === undefined) {
        logsVisible = !logsVisible;
    } else {
        logsVisible = show;
    }
    if (logsVisible) {
        logPanel.classList.remove('collapsed');
        $('#toggleLogsBtn').textContent = '📋 日志';
        // 重新滚动
        logContainer.scrollTop = logContainer.scrollHeight;
    } else {
        logPanel.classList.add('collapsed');
        $('#toggleLogsBtn').textContent = '📋 日志 ▸';
    }
}

// ========== 工具函数 ==========
function formatUptime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ========== 设置抽屉 ==========
let settingsConfig = null;

async function openSettings() {
    try {
        settingsConfig = await apiCall('GET', '/api/config');
    } catch (err) {
        alert('获取配置失败: ' + err.message);
        return;
    }
    renderSettingsForm(settingsConfig);
    $('#settingsOverlay').style.display = 'flex';
}

function closeSettings() {
    $('#settingsOverlay').style.display = 'none';
}

function renderSettingsForm(cfg) {
    const defaults = cfg.defaults || {};
    const ai = cfg.ai || {};
    const webAuth = cfg.web_auth || {};

    $('#settingsBody').innerHTML = `
        <!-- Web 鉴权 -->
        <div class="settings-section" id="section-web-auth">
            <h4>🔒 Web 鉴权</h4>
            <div class="form-group">
                <label>用户名</label>
                <input type="text" class="form-input" id="cfg-web-username" value="${escHtml(webAuth.username || '')}">
            </div>
            <div class="form-group">
                <label>密码</label>
                <input type="text" class="form-input" id="cfg-web-password"
                    placeholder="${escHtml(webAuth.password || '')}"
                    title="留空则不修改密码">
            </div>
            <button class="btn btn-primary btn-save-section" data-section="web_auth">💾 保存鉴权设置</button>
        </div>

        <!-- AI 配置 -->
        <div class="settings-section" id="section-ai">
            <h4>🤖 AI 配置</h4>
            <div class="form-group">
                <label>AI 提供商</label>
                <select class="form-select" id="cfg-ai-provider">
                    <option value="mimo" ${ai.provider === 'mimo' ? 'selected' : ''}>MiMo</option>
                    <option value="deepseek" ${ai.provider === 'deepseek' ? 'selected' : ''}>DeepSeek</option>
                </select>
            </div>
            <div class="form-group">
                <label>MiMo API Key</label>
                <input type="text" class="form-input" id="cfg-ai-mimo-key"
                    placeholder="${escHtml(ai.mimo?.api_key || '')}"
                    title="留空则不修改 API Key">
            </div>
            <div class="form-group">
                <label>MiMo Region</label>
                <select class="form-select" id="cfg-ai-mimo-region">
                    <option value="cn" ${(ai.mimo?.region || '') === 'cn' ? 'selected' : ''}>CN (中国)</option>
                    <option value="sgp" ${ai.mimo?.region === 'sgp' ? 'selected' : ''}>SGP (新加坡)</option>
                    <option value="ams" ${ai.mimo?.region === 'ams' ? 'selected' : ''}>AMS (阿姆斯特丹)</option>
                </select>
            </div>
            <div class="form-group">
                <label>DeepSeek API Key</label>
                <input type="text" class="form-input" id="cfg-ai-deepseek-key"
                    placeholder="${escHtml(ai.deepseek?.api_key || '')}"
                    title="留空则不修改 API Key">
            </div>
            <button class="btn btn-primary btn-save-section" data-section="ai">💾 保存 AI 配置</button>
        </div>

        <!-- 默认设置 -->
        <div class="settings-section" id="section-defaults">
            <h4>⚙️ 默认设置</h4>
            <div class="form-group">
                <label>Minecraft 版本</label>
                <input type="text" class="form-input" id="cfg-defaults-version" value="${escHtml(defaults.version || '')}">
            </div>
            <div class="form-group">
                <label>消息队列延迟 (ms)</label>
                <input type="number" class="form-input" id="cfg-defaults-queue-delay" value="${defaults.queue_delay ?? 1500}">
            </div>
            <div class="form-group">
                <label>最大消息长度</label>
                <input type="number" class="form-input" id="cfg-defaults-max-msg-len" value="${defaults.max_msg_len ?? 40}">
            </div>
            <div class="form-group">
                <label>最大转账金额</label>
                <input type="number" class="form-input" id="cfg-defaults-max-pay" value="${defaults.max_pay_amount ?? 100000}">
            </div>
            <div class="form-group">
                <label>默认服务器地址</label>
                <input type="text" class="form-input" id="cfg-defaults-server" value="${escHtml(defaults.default_server || '')}">
            </div>
            <div class="form-group">
                <label>TP 自动回复</label>
                <input type="text" class="form-input" id="cfg-defaults-tp-reply" value="${escHtml(defaults.tp_reply || '')}">
            </div>

            <div class="form-group form-toggle-row">
                <label>自动菜单</label>
                <label class="toggle-switch">
                    <input type="checkbox" id="cfg-defaults-auto-menu" ${defaults.auto_menu !== false ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>
            <div class="form-group form-toggle-row">
                <label>自动登录</label>
                <label class="toggle-switch">
                    <input type="checkbox" id="cfg-defaults-auto-login" ${defaults.auto_login !== false ? 'checked' : ''}>
                    <span class="toggle-slider"></span>
                </label>
            </div>

            <div class="form-group">
                <label>System Prompt（AI 提示词）</label>
                <textarea class="form-textarea" id="cfg-defaults-system-prompt" rows="4">${escHtml(defaults.system_prompt || '')}</textarea>
            </div>
            <button class="btn btn-primary btn-save-section" data-section="defaults">💾 保存默认设置</button>
        </div>

        <!-- 可信玩家列表 -->
        <div class="settings-section" id="section-trusted">
            <h4>👥 可信玩家列表</h4>
            <div class="tag-list" id="trustedTagList">
                ${(defaults.trusted_players || []).map(p => `
                    <span class="tag-item">
                        ${escHtml(p)}
                        <button class="tag-remove" data-player="${escHtml(p)}" title="移除">×</button>
                    </span>
                `).join('')}
            </div>
            <div class="form-group form-add-row">
                <input type="text" class="form-input" id="cfg-new-trusted-player" placeholder="输入玩家名...">
                <button class="btn btn-sm" id="btnAddTrusted">＋ 添加</button>
            </div>
            <button class="btn btn-primary btn-save-section" data-section="trusted">💾 保存可信列表</button>
        </div>
    `;

    // 绑定保存按钮
    $('#settingsBody').querySelectorAll('.btn-save-section').forEach(btn => {
        btn.addEventListener('click', () => saveSettingsSection(btn.dataset.section));
    });

    // 绑定可信列表操作
    $('#btnAddTrusted').addEventListener('click', addTrustedPlayer);
    const newPlayerInput = $('#cfg-new-trusted-player');
    if (newPlayerInput) {
        newPlayerInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); addTrustedPlayer(); }
        });
    }
    bindTagRemoveEvents();

    // 绑定回车键在 web_auth password 输入框中
    const pwInput = $('#cfg-web-password');
    if (pwInput) {
        pwInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); saveSettingsSection('web_auth'); }
        });
    }
}

function bindTagRemoveEvents() {
    $$('.tag-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            removeTrustedPlayer(btn.dataset.player);
        });
    });
}

function addTrustedPlayer() {
    const input = $('#cfg-new-trusted-player');
    if (!input) return;
    const name = input.value.trim();
    if (!name) return;
    // 检查重复
    const existing = $$('.tag-remove');
    for (const btn of existing) {
        if (btn.dataset.player.toLowerCase() === name.toLowerCase()) {
            alert('该玩家已在可信列表中');
            return;
        }
    }
    const tagList = $('#trustedTagList');
    const tag = document.createElement('span');
    tag.className = 'tag-item';
    tag.innerHTML = `${escHtml(name)}<button class="tag-remove" data-player="${escHtml(name)}" title="移除">×</button>`;
    tagList.appendChild(tag);
    tag.querySelector('.tag-remove').addEventListener('click', () => removeTrustedPlayer(name));
    input.value = '';
    input.focus();
}

function removeTrustedPlayer(name) {
    const tagList = $('#trustedTagList');
    const existing = $$('.tag-remove');
    for (const btn of existing) {
        if (btn.dataset.player === name) {
            btn.parentElement.remove();
            return;
        }
    }
}

async function saveSettingsSection(section) {
    const body = {};

    switch (section) {
        case 'web_auth': {
            body.web_auth = {};
            const username = $('#cfg-web-username')?.value?.trim();
            const password = $('#cfg-web-password')?.value?.trim();
            if (username) body.web_auth.username = username;
            if (password) body.web_auth.password = password;  // 空则不修改
            if (Object.keys(body.web_auth).length === 0) {
                alert('没有需要保存的修改');
                return;
            }
            break;
        }
        case 'ai': {
            body.ai = {
                provider: $('#cfg-ai-provider')?.value || 'mimo',
            };
            const mimoKey = $('#cfg-ai-mimo-key')?.value?.trim();
            const deepseekKey = $('#cfg-ai-deepseek-key')?.value?.trim();
            const mimoRegion = $('#cfg-ai-mimo-region')?.value || 'cn';

            body.ai.mimo = { region: mimoRegion };
            if (mimoKey) body.ai.mimo.api_key = mimoKey;
            // 不填则不覆盖现有 key

            body.ai.deepseek = {};
            if (deepseekKey) body.ai.deepseek.api_key = deepseekKey;
            // 不填则不覆盖现有 key
            break;
        }
        case 'defaults': {
            const systemPrompt = $('#cfg-defaults-system-prompt')?.value || '';
            body.defaults = {
                version: $('#cfg-defaults-version')?.value?.trim() || '1.20.4',
                queue_delay: parseInt($('#cfg-defaults-queue-delay')?.value) || 1500,
                max_msg_len: parseInt($('#cfg-defaults-max-msg-len')?.value) || 40,
                max_pay_amount: parseInt($('#cfg-defaults-max-pay')?.value) || 100000,
                auto_menu: $('#cfg-defaults-auto-menu')?.checked !== false,
                auto_login: $('#cfg-defaults-auto-login')?.checked !== false,
                default_server: $('#cfg-defaults-server')?.value?.trim() || '',
                tp_reply: $('#cfg-defaults-tp-reply')?.value?.trim() || '',
                system_prompt: systemPrompt,
            };
            break;
        }
        case 'trusted': {
            const players = [];
            $$('#trustedTagList .tag-remove').forEach(btn => {
                players.push(btn.dataset.player);
            });
            body.defaults = { trusted_players: players };
            break;
        }
        default:
            return;
    }

    // 显示保存中状态
    const saveBtn = $(`.btn-save-section[data-section="${section}"]`);
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中...';
    }

    const result = await apiCall('PUT', '/api/config', body);

    if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 保存' + getSectionLabel(section);
    }

    if (result.error) {
        alert(`保存失败: ${result.error}`);
    } else {
        // 更新本地缓存的 config
        if (section === 'trusted') {
            if (!settingsConfig.defaults) settingsConfig.defaults = {};
            const players = [];
            $$('#trustedTagList .tag-remove').forEach(btn => players.push(btn.dataset.player));
            settingsConfig.defaults.trusted_players = players;
        }

        // 短暂显示成功提示
        showSaveSuccess(saveBtn);
    }
}

function getSectionLabel(section) {
    const labels = {
        web_auth: '鉴权设置',
        ai: 'AI 配置',
        defaults: '默认设置',
        trusted: '可信列表',
    };
    return labels[section] || '';
}

function showSaveSuccess(btn) {
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = '✅ 已保存';
    btn.classList.add('btn-success');
    setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove('btn-success');
    }, 2000);
}
