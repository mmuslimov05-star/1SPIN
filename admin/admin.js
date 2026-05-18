/**
 * SPINTALK Admin Panel v2.0
 * Реальное подключение к серверу через Socket.io
 * Никаких mock-данных
 */
'use strict';

// ── СОСТОЯНИЕ ────────────────────────────────────
const state = {
  socket:    null,
  authData:  null,
  users:     [],
  sessions:  [],
  reports:   [],
  bans:      [],
  stopWords: [],
  settings:  {},
  mods:      [],
  auditLogs: [],
  logs:      [],
  liveStats: {},
  filters:   { userSearch: '', userStatus: '', reportStatus: '' },
  charts:    {},
};

// ── ИНИЦИАЛИЗАЦИЯ ────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Проверка авторизации
  const stored = sessionStorage.getItem('spintalk_admin');
  if (!stored) { window.location.href = 'login.html'; return; }

  try { state.authData = JSON.parse(stored); }
  catch (e) { window.location.href = 'login.html'; return; }

  // Заполнить инфо админа
  setEl('admin-name-display', state.authData.login);
  setEl('admin-role-display', roleLabel(state.authData.role));

  // Часы
  updateClock();
  setInterval(updateClock, 1000);

  // Подключение к серверу
  connectSocket();
});

// ── SOCKET.IO ────────────────────────────────────
function connectSocket() {
  state.socket = io({
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 2000,
  });

  state.socket.on('connect', () => {
    console.log('✅ Подключено к серверу');
    state.socket.emit('admin:auth', { token: state.authData.token });
  });

  state.socket.on('admin:auth:ok', ({ login, role }) => {
    console.log('✅ Авторизация успешна:', login, role);
    showAdminToast(`👋 Добро пожаловать, ${login}!`);
  });

  state.socket.on('admin:auth:fail', () => {
    sessionStorage.removeItem('spintalk_admin');
    showAdminToast('❌ Сессия истекла, войдите снова');
    setTimeout(() => window.location.href = 'login.html', 1500);
  });

  // Получение начальных данных
  state.socket.on('admin:data', (data) => {
    state.users     = data.users     || [];
    state.sessions  = data.sessions  || [];
    state.reports   = data.reports   || [];
    state.bans      = data.bans      || [];
    state.stopWords = data.stopWords || [];
    state.settings  = data.settings  || {};
    state.mods      = data.mods      || [];
    state.auditLogs = data.auditLogs || [];

    renderAll();
    initCharts();
  });

  // Live статистика
  state.socket.on('admin:stats', (stats) => {
    state.liveStats = stats;
    updateLiveStats(stats);
  });

  // Live пользователи и сессии
  state.socket.on('admin:users', ({ users, sessions }) => {
    state.users    = users    || [];
    state.sessions = sessions || [];
    renderUsers();
    renderSessions();
  });

  // Новая жалоба
  state.socket.on('admin:report', (report) => {
    state.reports.unshift(report);
    renderReports();
    renderRecentReports();
    showAdminToast('🚩 Новая жалоба!');
    playNotificationSound();
  });

  // Лог события
  state.socket.on('admin:log', (log) => {
    state.logs.unshift(log);
    if (state.logs.length > 300) state.logs.pop();
    addLogToStream(log);
  });

  // Подтверждения админских действий
  state.socket.on('admin:ban:ok',       ({ target }) => showAdminToast(`🔨 ${target} заблокирован`));
  state.socket.on('admin:settings:saved', () =>        showAdminToast('💾 Настройки сохранены'));
  state.socket.on('admin:stopword:added', ({ word }) => showAdminToast(`🚫 "${word}" добавлено`));
  state.socket.on('admin:stopword:removed', () =>      showAdminToast('✅ Стоп-слово удалено'));
  state.socket.on('admin:mod:added',    ({ login }) => { showAdminToast(`✅ Модератор ${login} добавлен`); refreshData(); });
  state.socket.on('admin:mod:removed',  ({ login }) => { showAdminToast(`🗑️ ${login} удалён`); refreshData(); });
  state.socket.on('admin:broadcast:sent', () =>        showAdminToast('📢 Сообщение отправлено всем'));
  state.socket.on('admin:maintenance:state', ({ enabled }) => {
    showAdminToast(enabled ? '🔧 Техобслуживание ВКЛЮЧЕНО' : '✅ Сайт снова доступен');
    state.settings.maintenance = enabled;
    const checkbox = document.getElementById('maintenance-toggle');
    if (checkbox) checkbox.checked = enabled;
  });

  state.socket.on('admin:error', ({ msg }) => showAdminToast('❌ ' + msg));
  state.socket.on('admin:logs', (logs) => {
    state.logs = logs;
    renderLogStream();
  });
  state.socket.on('admin:audit', (audits) => {
    state.auditLogs = audits;
    renderAudit();
  });
  state.socket.on('admin:bans', (bans) => { state.bans = bans; renderBans(); });
  state.socket.on('admin:reports', (reports) => { state.reports = reports; renderReports(); });

  state.socket.on('disconnect', () => {
    showAdminToast('⚠️ Соединение потеряно — переподключение...');
  });
}

// ── НАВИГАЦИЯ ────────────────────────────────────
function navigate(el, section) {
  if (el) {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    el.classList.add('active');
  }
  document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
  document.getElementById(`section-${section}`)?.classList.add('active');

  const titles = {
    dashboard: 'Дашборд', users: 'Пользователи', sessions: 'Активные сессии',
    reports: 'Жалобы', bans: 'Блокировки', moderation: 'Модерация',
    analytics: 'Аналитика', settings: 'Настройки', logs: 'Системные логи',
    audit: 'Аудит действий',
  };
  setEl('page-title', titles[section] || section);

  // Загрузка свежих данных при переходе
  if (section === 'logs') state.socket?.emit('admin:logs:get', { limit: 300 });
  if (section === 'audit') state.socket?.emit('admin:audit:get', { limit: 200 });
  if (section === 'reports') state.socket?.emit('admin:reports:get');
  if (section === 'bans') state.socket?.emit('admin:bans:get');
  return false;
}

function toggleSidebar() {
  const sidebar = document.getElementById('admin-sidebar');
  if (window.innerWidth <= 900) sidebar.classList.toggle('mobile-open');
  else sidebar.classList.toggle('collapsed');
}

// ── РЕНДЕР ВСЕГО ─────────────────────────────────
function renderAll() {
  renderUsers();
  renderSessions();
  renderReports();
  renderBans();
  renderStopWords();
  renderModerators();
  renderSettings();
  renderRecentReports();
  renderCountries();
  renderAudit();
  updateBadges();
}

// ── ДАШБОРД ──────────────────────────────────────
function updateLiveStats(stats) {
  setEl('kpi-online', (stats.online || 0).toLocaleString('ru-RU'));
  setEl('kpi-chats', (stats.chatsToday || 0).toLocaleString('ru-RU'));
  setEl('kpi-reports', stats.pendingReports || 0);
  setEl('kpi-bans', stats.totalBans || 0);

  setEl('badge-users', stats.online || 0);
  setEl('badge-reports', stats.pendingReports || 0);

  // KPI deltas
  const onlineDelta = document.querySelector('#section-dashboard .kpi-card:nth-child(1) .kpi-delta');
  if (onlineDelta) onlineDelta.textContent = `Очередь: ${stats.queueVideo || 0} видео, ${stats.queueText || 0} текст`;

  const chatsDelta = document.querySelector('#section-dashboard .kpi-card:nth-child(2) .kpi-delta');
  if (chatsDelta) chatsDelta.textContent = `Активных: ${stats.activeChats || 0}`;
}

function updateBadges() {
  const pending = state.reports.filter(r => r.status === 'pending').length;
  const online  = state.users.filter(u => u.status === 'in_chat' || u.status === 'idle').length;
  setEl('badge-reports', pending);
  setEl('badge-users', online);
}

function renderRecentReports() {
  const list = document.getElementById('recent-reports-list');
  if (!list) return;
  const recent = state.reports.filter(r => r.status === 'pending').slice(0, 5);
  if (recent.length === 0) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)">Нет новых жалоб</div>';
    return;
  }
  list.innerHTML = recent.map(r => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border-solid)">
      <div>
        <div style="font-size:13px;font-weight:600">${escapeHtml(r.type)}</div>
        <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono)">${formatTime(r.createdAt)}</div>
      </div>
      <span class="status-pill pending">Новая</span>
    </div>
  `).join('');
}

function renderCountries() {
  const list = document.getElementById('countries-list');
  if (!list) return;
  // Группируем пользователей по странам
  const byCountry = {};
  state.users.forEach(u => {
    const c = u.country || '🌍';
    byCountry[c] = (byCountry[c] || 0) + 1;
  });
  const sorted = Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = sorted[0]?.[1] || 1;

  if (sorted.length === 0) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)">Пока нет пользователей</div>';
    return;
  }

  list.innerHTML = sorted.map(([country, count]) => `
    <div class="country-row">
      <div class="country-name">${escapeHtml(country)}</div>
      <div class="country-bar-wrap"><div class="country-bar" style="width:${(count/max)*100}%"></div></div>
      <div class="country-count">${count}</div>
    </div>
  `).join('');
}

// ── ПОЛЬЗОВАТЕЛИ ─────────────────────────────────
let currentUserPage = 1;
const USERS_PER_PAGE = 15;

function renderUsers() {
  const tbody = document.getElementById('users-tbody');
  if (!tbody) return;

  const query  = (document.getElementById('user-search')?.value || '').toLowerCase();
  const status = document.getElementById('user-filter-status')?.value || '';

  let filtered = state.users.filter(u => {
    const matchQ = !query || u.id.toLowerCase().includes(query) || u.ip.toLowerCase().includes(query) || (u.country || '').toLowerCase().includes(query);
    const matchS = !status || u.status === status;
    return matchQ && matchS;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:40px;color:var(--text-muted)">
      ${state.users.length === 0 ? '👻 Нет онлайн-пользователей' : '🔍 Ничего не найдено'}
    </td></tr>`;
    setEl('users-pagination', '');
    return;
  }

  const start = (currentUserPage - 1) * USERS_PER_PAGE;
  const pageUsers = filtered.slice(start, start + USERS_PER_PAGE);

  tbody.innerHTML = pageUsers.map(u => {
    const genderIcon = u.gender === 'male' ? '♂' : u.gender === 'female' ? '♀' : '·';
    const statusLabel = u.status === 'in_chat' ? '💬 В чате' : u.status === 'searching' ? '🔍 Ищет' : '⏳ Ожидает';
    const statusClass = u.status === 'in_chat' ? 'online' : u.status === 'searching' ? 'warned' : 'dismissed';
    return `
    <tr>
      <td><input type="checkbox" class="user-checkbox" value="${escapeHtml(u.ipFull || u.ip)}"/></td>
      <td><strong style="font-size:13px">${escapeHtml(u.nickname || 'Аноним')}</strong><br/><span style="font-size:10px;color:var(--text-muted)">${genderIcon} ${u.age || '—'}</span></td>
      <td><code style="font-size:12px">${escapeHtml(u.ip)}</code></td>
      <td><span class="status-pill ${statusClass}">${statusLabel}</span></td>
      <td style="font-size:12px">${u.mode || '—'}</td>
      <td style="font-family:var(--font-mono);font-size:11px">${formatTimeAgo(u.connectedAt)}</td>
      <td>
        <div style="display:flex;gap:6px">
          <button class="btn-sm-action" onclick="warnUserById('${escapeHtml(u.id)}')" title="Предупредить">⚠️</button>
          <button class="btn-sm-action" onclick="kickUserById('${escapeHtml(u.id)}')" title="Кикнуть">👢</button>
          <button class="btn-sm-action" style="border-color:var(--danger);color:var(--danger)" onclick="banUserByIP('${escapeHtml(u.ipFull || u.ip)}')" title="Бан по IP">🔨</button>
        </div>
      </td>
    </tr>
  `;}).join('');

  // Пагинация
  const totalPages = Math.ceil(filtered.length / USERS_PER_PAGE);
  const pg = document.getElementById('users-pagination');
  if (pg) {
    pg.innerHTML = totalPages > 1 ? Array.from({ length: totalPages }, (_, i) =>
      `<button class="page-btn ${i+1 === currentUserPage ? 'active' : ''}" onclick="goToUserPage(${i+1})">${i+1}</button>`
    ).join('') : '';
  }
}

function filterUsers() { currentUserPage = 1; renderUsers(); }
function goToUserPage(p) { currentUserPage = p; renderUsers(); }

function toggleSelectAll() {
  const all = document.getElementById('select-all-users')?.checked;
  document.querySelectorAll('.user-checkbox').forEach(cb => cb.checked = all);
}

function banSelected() {
  const selected = [...document.querySelectorAll('.user-checkbox:checked')].map(cb => cb.value);
  if (!selected.length) { showAdminToast('⚠️ Выберите пользователей'); return; }
  if (!confirm(`Заблокировать ${selected.length} пользователей?`)) return;

  selected.forEach(ip => {
    state.socket.emit('admin:ban', { target: ip, reason: 'Массовый бан', durationMs: null });
  });
}

function warnUserById(userId) {
  const msg = prompt('Текст предупреждения:', 'Соблюдайте правила сервиса');
  if (msg) state.socket.emit('admin:warn', { userId, message: msg });
}

function kickUserById(userId) {
  if (!confirm('Принудительно отключить пользователя?')) return;
  state.socket.emit('admin:kick', { userId });
}

function banUserByIP(ip) {
  const reason = prompt('Причина бана:', 'Нарушение правил');
  if (!reason) return;
  state.socket.emit('admin:ban', { target: ip, reason, durationMs: null });
}

// ── СЕССИИ ───────────────────────────────────────
function renderSessions() {
  const tbody    = document.getElementById('sessions-tbody');
  const countEl  = document.getElementById('active-sessions-count');
  if (!tbody) return;
  if (countEl) countEl.textContent = state.sessions.length;

  if (state.sessions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-muted)">Нет активных сессий</td></tr>';
    return;
  }

  tbody.innerHTML = state.sessions.map(s => {
    const u1 = typeof s.user1 === 'object' ? s.user1 : { nickname: 'User1', ip: s.user1 };
    const u2 = typeof s.user2 === 'object' ? s.user2 : { nickname: 'User2', ip: s.user2 };
    return `
    <tr>
      <td><code style="font-size:11px;color:var(--accent)">${escapeHtml(s.chatId.slice(0, 18))}</code></td>
      <td><strong>${escapeHtml(u1.nickname)}</strong><br/><code style="font-size:10px;color:var(--text-muted)">${escapeHtml(u1.ip)}</code></td>
      <td><strong>${escapeHtml(u2.nickname)}</strong><br/><code style="font-size:10px;color:var(--text-muted)">${escapeHtml(u2.ip)}</code></td>
      <td><span class="status-pill ${s.mode === 'video' ? 'online' : 'warned'}">${s.mode === 'video' ? '📹 Видео' : '💬 Текст'}</span></td>
      <td style="font-family:var(--font-mono)">${formatDuration(s.duration)}</td>
      <td>${s.msgs}</td>
      <td>
        <div style="display:flex;gap:6px">
          <button class="btn-admin sm" onclick="spectateChat('${escapeHtml(s.chatId)}')" title="Наблюдать анонимно">👁️ Смотреть</button>
          <button class="btn-sm-action" style="border-color:var(--danger);color:var(--danger)" onclick="terminateSession('${escapeHtml(s.chatId)}')" title="Завершить чат">⏹</button>
        </div>
      </td>
    </tr>
  `;}).join('');
}

function terminateSession(chatId) {
  if (!confirm('Принудительно завершить чат?')) return;
  state.socket.emit('admin:terminate', { chatId });
}

function terminateAllSessions() {
  if (!confirm('Завершить ВСЕ активные сессии?')) return;
  state.sessions.forEach(s => state.socket.emit('admin:terminate', { chatId: s.chatId }));
}

// ── ЖАЛОБЫ ───────────────────────────────────────
function renderReports() {
  const list = document.getElementById('reports-list');
  if (!list) return;
  const filter = document.getElementById('report-filter')?.value || '';
  const toShow = filter ? state.reports.filter(r => r.status === filter) : state.reports;

  if (toShow.length === 0) {
    list.innerHTML = '<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--text-muted)">Нет жалоб</div>';
    return;
  }

  list.innerHTML = toShow.map(r => `
    <div class="report-card ${r.status}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
        <div class="report-type">🚩 ${escapeHtml(r.type)}</div>
        <span class="status-pill ${r.status}">${reportStatusLabel(r.status)}</span>
      </div>
      <div class="report-meta">${formatTime(r.createdAt)}</div>
      ${r.description ? `<div class="report-desc">"${escapeHtml(r.description)}"</div>` : ''}
      ${r.againstIP ? `<div class="report-meta">IP: ${escapeHtml(r.againstIP.replace(/\.\d+$/, '.x'))}</div>` : ''}
      <div class="report-actions">
        ${r.status === 'pending' ? `
          <button class="btn-admin sm danger" onclick="resolveReport('${r._id}','ban','${escapeHtml(r.againstIP || '')}')">🔨 Забанить</button>
          <button class="btn-admin sm" onclick="resolveReport('${r._id}','resolve')">✅ Решить</button>
          <button class="btn-cancel-sm" onclick="resolveReport('${r._id}','dismiss')">Отклонить</button>
        ` : `<button class="btn-cancel-sm" onclick="resolveReport('${r._id}','pending')">↩️ Открыть</button>`}
      </div>
    </div>
  `).join('');
}

function filterReports() { renderReports(); }

function resolveReport(id, action, ip) {
  if (action === 'ban' && ip) {
    state.socket.emit('admin:ban', { target: ip, reason: 'Бан по жалобе', durationMs: null });
    state.socket.emit('admin:report:update', { id, status: 'resolved' });
  } else if (action === 'pending') {
    state.socket.emit('admin:report:update', { id, status: 'pending' });
  } else {
    const status = action === 'dismiss' ? 'dismissed' : 'resolved';
    state.socket.emit('admin:report:update', { id, status });
  }
  // Локально обновим
  const r = state.reports.find(r => r._id === id);
  if (r) r.status = action === 'dismiss' ? 'dismissed' : (action === 'pending' ? 'pending' : 'resolved');
  renderReports();
  updateBadges();
}

function resolveAllReports() {
  if (!confirm('Решить ВСЕ открытые жалобы?')) return;
  state.reports.filter(r => r.status === 'pending').forEach(r => {
    state.socket.emit('admin:report:update', { id: r._id, status: 'resolved' });
    r.status = 'resolved';
  });
  renderReports();
  updateBadges();
}

// ── БАНЫ ─────────────────────────────────────────
function renderBans() {
  const tbody = document.getElementById('bans-tbody');
  if (!tbody) return;

  if (state.bans.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-muted)">Нет блокировок</td></tr>';
    return;
  }

  tbody.innerHTML = state.bans.map(b => `
    <tr>
      <td><code style="font-size:12px">${escapeHtml(b.target)}</code></td>
      <td>${escapeHtml(b.reason)}</td>
      <td><span class="status-pill ${b.type === 'auto' ? 'warned' : 'banned'}">${b.type === 'auto' ? 'Авто' : 'Ручной'}</span></td>
      <td style="font-family:var(--font-mono);font-size:12px">${formatTime(b.createdAt)}</td>
      <td style="color:${!b.until ? 'var(--danger)' : 'inherit'}">${b.until ? formatDate(b.until) : 'Навсегда'}</td>
      <td style="font-size:12px;color:var(--text-secondary)">${escapeHtml(b.by || 'Система')}</td>
      <td><button class="btn-sm-action" onclick="unban('${escapeHtml(b.target)}')">✓ Разбанить</button></td>
    </tr>
  `).join('');
}

function unban(target) {
  if (!confirm('Снять блокировку?')) return;
  state.socket.emit('admin:unban', { target });
  state.bans = state.bans.filter(b => b.target !== target);
  renderBans();
  showAdminToast('✅ Бан снят');
}

function showAddBanModal() { document.getElementById('ban-modal').style.display = 'flex'; }
function closeBanModal() { document.getElementById('ban-modal').style.display = 'none'; }

function executeBan() {
  const target   = document.getElementById('ban-target')?.value?.trim();
  const reason   = document.getElementById('ban-reason')?.value;
  const duration = document.getElementById('ban-duration')?.value;
  if (!target) { showAdminToast('⚠️ Введите IP или ID'); return; }

  const durMs = { '1h': 3600000, '24h': 86400000, '7d': 604800000, '30d': 2592000000, 'perm': null };
  state.socket.emit('admin:ban', { target, reason, durationMs: durMs[duration] });
  closeBanModal();
  document.getElementById('ban-target').value = '';
}

// ── МОДЕРАЦИЯ ────────────────────────────────────
function renderStopWords() {
  const list = document.getElementById('stopwords-list');
  if (!list) return;
  if (state.stopWords.length === 0) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:13px">Нет стоп-слов</div>';
    return;
  }
  list.innerHTML = state.stopWords.map(sw =>
    `<span class="stopword-tag">${escapeHtml(sw.word)}<em class="stopword-remove" onclick="removeStopWord('${escapeHtml(sw.word)}')">×</em></span>`
  ).join('');
}

function addStopWord() {
  const input = document.getElementById('stopword-input');
  const word  = input?.value?.trim().toLowerCase();
  if (!word) return;
  state.socket.emit('admin:stopword:add', { word });
  state.stopWords.push({ word });
  renderStopWords();
  if (input) input.value = '';
}

function removeStopWord(word) {
  state.socket.emit('admin:stopword:remove', { word });
  state.stopWords = state.stopWords.filter(sw => sw.word !== word);
  renderStopWords();
}

function toggleMod(feature, input) {
  state.socket.emit('admin:settings:save', { [feature]: input.checked });
  showAdminToast(`${input.checked ? '✅' : '❌'} ${feature}`);
}

// ── МОДЕРАТОРЫ ───────────────────────────────────
function renderModerators() {
  const list = document.getElementById('moderators-list');
  if (!list) return;
  if (state.mods.length === 0) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:13px">Нет модераторов</div>';
    return;
  }
  list.innerHTML = state.mods.map(m => `
    <div class="mod-list-item">
      <div class="mod-item-info">
        <div class="mod-item-name">${escapeHtml(m.login)}</div>
        <div class="mod-item-role">${roleLabel(m.role)} ${m.lastLogin ? '· последний вход ' + formatTime(m.lastLogin) : ''}</div>
      </div>
      <div class="mod-item-actions">
        ${m.login !== state.authData.login ? `<button class="btn-sm-action" onclick="removeModerator('${escapeHtml(m.login)}')">Удалить</button>` : '<span style="font-size:11px;color:var(--accent)">это вы</span>'}
      </div>
    </div>
  `).join('');
}

function showAddModeratorModal() { document.getElementById('mod-modal').style.display = 'flex'; }
function closeModModal() { document.getElementById('mod-modal').style.display = 'none'; }

function addModerator() {
  const login    = document.getElementById('mod-login')?.value?.trim();
  const password = document.getElementById('mod-password')?.value;
  const role     = document.getElementById('mod-role')?.value;
  if (!login || !password) { showAdminToast('⚠️ Заполните все поля'); return; }
  if (password.length < 6) { showAdminToast('⚠️ Пароль минимум 6 символов'); return; }

  state.socket.emit('admin:mod:add', { login, password, role });
  closeModModal();
  document.getElementById('mod-login').value = '';
  document.getElementById('mod-password').value = '';
}

function removeModerator(login) {
  if (!confirm(`Удалить модератора ${login}?`)) return;
  state.socket.emit('admin:mod:remove', { login });
}

// ── НАСТРОЙКИ ────────────────────────────────────
function renderSettings() {
  const form = document.querySelector('#section-settings');
  if (!form) return;

  // Заполняем поля настроек
  document.querySelectorAll('#section-settings input, #section-settings select').forEach(input => {
    const key = input.dataset.setting;
    if (key && state.settings[key] !== undefined) {
      if (input.type === 'checkbox') input.checked = Boolean(state.settings[key]);
      else input.value = state.settings[key];
    }
  });
}

function saveSettings() {
  const updates = {};
  document.querySelectorAll('#section-settings input, #section-settings select').forEach(input => {
    const key = input.dataset.setting;
    if (!key) return;
    if (input.type === 'checkbox') updates[key] = input.checked;
    else if (input.type === 'number') updates[key] = parseInt(input.value) || 0;
    else updates[key] = input.value;
  });
  state.socket.emit('admin:settings:save', updates);
}

function saveNotifications() { saveSettings(); }

function toggleMaintenance(input) {
  state.socket.emit('admin:maintenance', { enabled: input.checked });
}

function broadcastMessage() {
  const msg = prompt('Сообщение для всех пользователей онлайн:');
  if (msg && msg.trim()) {
    state.socket.emit('admin:broadcast', { message: msg.trim() });
  }
}

// ── ЛОГИ ─────────────────────────────────────────
function renderLogStream() {
  const stream = document.getElementById('log-stream');
  if (!stream) return;
  stream.innerHTML = '';
  state.logs.slice(0, 200).forEach(log => addLogToStream(log, false));
}

function addLogToStream(log, prepend = true) {
  const stream = document.getElementById('log-stream');
  if (!stream) return;

  const div = document.createElement('div');
  div.className = 'log-entry';
  const time = log.ts ? new Date(log.ts).toLocaleTimeString('ru-RU') :
               log.createdAt ? new Date(log.createdAt).toLocaleTimeString('ru-RU') :
               new Date().toLocaleTimeString('ru-RU');
  const dataStr = typeof log.data === 'object' ? JSON.stringify(log.data) : String(log.data || '');
  div.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-type ${log.type}">[${escapeHtml(String(log.type || '').toUpperCase())}]</span>
    <span class="log-msg">${escapeHtml(dataStr).slice(0, 150)}</span>
  `;
  if (prepend) {
    stream.prepend(div);
    if (stream.children.length > 300) stream.lastChild.remove();
  } else {
    stream.appendChild(div);
  }
}

function exportLogs() {
  let csv = 'Time,Type,Data\n';
  state.logs.forEach(log => {
    const time = log.ts || log.createdAt || '';
    const data = typeof log.data === 'object' ? JSON.stringify(log.data) : String(log.data || '');
    csv += `"${time}","${log.type}","${data.replace(/"/g, '""')}"\n`;
  });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `spintalk-logs-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  showAdminToast('⬇ Логи экспортированы');
}

// ── АУДИТ ────────────────────────────────────────
function renderAudit() {
  const container = document.getElementById('audit-list');
  if (!container) return;
  if (state.auditLogs.length === 0) {
    container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">Нет записей аудита</div>';
    return;
  }
  container.innerHTML = state.auditLogs.map(a => `
    <div class="log-entry">
      <span class="log-time">${formatTime(a.createdAt)}</span>
      <span class="log-type info">[${escapeHtml(a.admin)}]</span>
      <span class="log-msg"><strong>${escapeHtml(a.action)}</strong> · ${escapeHtml(JSON.stringify(a.details || {})).slice(0, 200)}</span>
    </div>
  `).join('');
}

// ── ГРАФИКИ ──────────────────────────────────────
function initCharts() {
  if (typeof Chart === 'undefined') return;
  Chart.defaults.color = '#7a93b5';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';

  // Уничтожить старые графики если есть
  Object.values(state.charts).forEach(c => c?.destroy?.());
  state.charts = {};

  const actCtx = document.getElementById('activity-chart');
  if (actCtx) {
    state.charts.activity = new Chart(actCtx, {
      type: 'line',
      data: {
        labels: Array.from({ length: 24 }, (_, i) => `${i}:00`),
        datasets: [{
          label: 'Онлайн',
          data: Array.from({ length: 24 }, () => 0),
          borderColor: '#00e5c4',
          backgroundColor: 'rgba(0,229,196,0.08)',
          fill: true, tension: 0.4,
        }]
      },
      options: { responsive: true, plugins: { legend: { display: false } } }
    });
  }
}

// ── УТИЛИТЫ ──────────────────────────────────────
function updateClock() {
  setEl('topbar-time', new Date().toLocaleTimeString('ru-RU'));
}

function refreshData() {
  state.socket?.emit('admin:auth', { token: state.authData.token });
  showAdminToast('↻ Данные обновлены');
}

let toastTimer;
function showAdminToast(msg) {
  const t = document.getElementById('admin-toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

function playNotificationSound() {
  try {
    const audio = new Audio('data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YRAAAAAAAP////8AAP////8AAA==');
    audio.volume = 0.3;
    audio.play().catch(() => {});
  } catch (e) {}
}

function logout() {
  if (!confirm('Выйти из панели управления?')) return;
  sessionStorage.removeItem('spintalk_admin');
  window.location.href = 'login.html';
}

function setEl(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  const d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
}

function formatTime(date) {
  if (!date) return '—';
  const d = new Date(date);
  return d.toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
}

function formatDate(date) {
  if (!date) return '—';
  return new Date(date).toLocaleDateString('ru-RU');
}

function formatTimeAgo(date) {
  if (!date) return '—';
  const sec = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (sec < 60) return `${sec}с назад`;
  if (sec < 3600) return `${Math.floor(sec/60)}м назад`;
  if (sec < 86400) return `${Math.floor(sec/3600)}ч назад`;
  return `${Math.floor(sec/86400)}д назад`;
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function roleLabel(role) {
  return { admin: 'Администратор', senior_mod: 'Старший модератор', moderator: 'Модератор' }[role] || role;
}

function reportStatusLabel(s) {
  return { pending: 'Новая', resolved: 'Решена', dismissed: 'Отклонена' }[s] || s;
}

function spectateChat(chatId) {
  const url = `spectate.html?chatId=${encodeURIComponent(chatId)}`;
  window.open(url, '_blank', 'width=1400,height=900');
}

