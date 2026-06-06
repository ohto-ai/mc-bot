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

    // ESC 关闭弹窗
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeCmdModal();
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
function connectSSE() {
    const es = new EventSource(`/api/events?token=${encodeURIComponent(getToken())}`);

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
