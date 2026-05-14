/* =============================================
   SPINTALK — Admin Panel JavaScript
   ============================================= */
'use strict';

// ── MOCK DATA ──────────────────────────────────
const mockUsers = Array.from({ length: 48 }, (_, i) => ({
  id: `sess_${Math.random().toString(36).slice(2, 10)}`,
  ip: `${rand(1,254)}.${rand(1,254)}.${rand(1,254)}.${rand(1,254)}`,
  country: ['🇷🇺 Россия','🇩🇪 Германия','🇺🇸 США','🇺🇦 Украина','🇵🇱 Польша','🇫🇷 Франция','🇮🇹 Италия','🇧🇷 Бразилия'][rand(0,7)],
  status: ['online','online','online','warned','banned'][rand(0,4)],
  chats: rand(1, 120),
  reports: rand(0, 5),
  joined: new Date(Date.now() - rand(0, 86400000)).toLocaleTimeString('ru-RU'),
}));

const mockSessions = Array.from({ length: 12 }, (_, i) => ({
  id: `chat_${Math.random().toString(36).slice(2,8)}`,
  user1: `${rand(1,254)}.x.x.${rand(1,254)}`,
  user2: `${rand(1,254)}.x.x.${rand(1,254)}`,
  mode: ['video','text'][rand(0,1)],
  duration: `${rand(0,30)}:${String(rand(0,59)).padStart(2,'0')}`,
  messages: rand(0, 80),
}));

const mockReports = Array.from({ length: 16 }, (_, i) => ({
  id: `rep_${i+1}`,
  type: ['Неприемлемый контент','Несовершеннолетний','Мошенничество / спам','Насилие / угрозы'][rand(0,3)],
  from: `${rand(1,254)}.x.x.${rand(1,254)}`,
  against: `${rand(1,254)}.x.x.${rand(1,254)}`,
  time: `${String(rand(0,23)).padStart(2,'0')}:${String(rand(0,59)).padStart(2,'0')}`,
  status: ['pending','pending','pending','resolved','dismissed'][rand(0,4)],
  desc: ['Демонстрировал неприемлемый контент на камеру', 'Выглядит как несовершеннолетний', 'Рассылает ссылки в чате', 'Угрожал и оскорблял', ''][rand(0,4)],
}));

const mockBans = Array.from({ length: 20 }, (_, i) => ({
  target: `${rand(1,254)}.${rand(1,254)}.${rand(1,254)}.${rand(1,254)}`,
  reason: ['Неприемлемый контент','Несовершеннолетний','Спам','Насилие'][rand(0,3)],
  type: ['auto','manual'][rand(0,1)],
  date: new Date(Date.now() - rand(0, 2592000000)).toLocaleDateString('ru-RU'),
  until: ['Навсегда','24ч','7 дней','30 дней'][rand(0,3)],
  by: ['AutoMod','Иван А.','Система'][rand(0,2)],
}));

const mockModerators = [
  { login: 'ivan_mod', role: 'Старший модератор', online: true },
  { login: 'anna_admin', role: 'Администратор', online: true },
  { login: 'sergey_m', role: 'Модератор', online: false },
];

const stopWords = ['spam', 'casino', '18+', 'click here', 'free money', 'telegram'];

let currentPage = 1;
const usersPerPage = 12;
let filteredUsers = [...mockUsers];

// ── INIT ───────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  updateClock();
  setInterval(updateClock, 1000);

  updateBadges();
  renderDashboard();
  renderUsers();
  renderSessions();
  renderReports();
  renderBans();
  renderModerators();
  renderStopWords();
  renderLogs();
  initCharts();

  // Live updates simulation
  setInterval(() => {
    liveUpdate();
  }, 3000);

  // Log stream
  setInterval(() => {
    addLiveLog();
  }, 2500);
});

// ── NAVIGATION ─────────────────────────────────
function navigate(el, section) {
  if (el) {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    el.classList.add('active');
  }
  document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(`section-${section}`);
  if (target) target.classList.add('active');
  const titles = {
    dashboard: 'Дашборд',
    users: 'Пользователи',
    sessions: 'Активные сессии',
    reports: 'Жалобы',
    bans: 'Блокировки',
    moderation: 'Модерация',
    analytics: 'Аналитика',
    settings: 'Настройки',
    logs: 'Системные логи',
  };
  const titleEl = document.getElementById('page-title');
  if (titleEl) titleEl.textContent = titles[section] || section;
  return false;
}

function toggleSidebar() {
  const sidebar = document.getElementById('admin-sidebar');
  if (window.innerWidth <= 900) {
    sidebar.classList.toggle('mobile-open');
  } else {
    sidebar.classList.toggle('collapsed');
  }
}

// ── CLOCK ──────────────────────────────────────
function updateClock() {
  const el = document.getElementById('topbar-time');
  if (el) el.textContent = new Date().toLocaleTimeString('ru-RU');
}

// ── BADGES ─────────────────────────────────────
function updateBadges() {
  const pending = mockReports.filter(r => r.status === 'pending').length;
  const online = mockUsers.filter(u => u.status === 'online').length;
  setEl('badge-reports', pending);
  setEl('badge-users', online);
}

// ── DASHBOARD ─────────────────────────────────
function renderDashboard() {
  renderRecentReports();
  renderCountries();
}

function renderRecentReports() {
  const list = document.getElementById('recent-reports-list');
  if (!list) return;
  const recent = mockReports.filter(r => r.status === 'pending').slice(0, 5);
  list.innerHTML = recent.map(r => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border-solid)">
      <div>
        <div style="font-size:13px;font-weight:600">${r.type}</div>
        <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono)">${r.from} → ${r.against} · ${r.time}</div>
      </div>
      <span class="status-pill pending">Новая</span>
    </div>
  `).join('');
}

function renderCountries() {
  const list = document.getElementById('countries-list');
  if (!list) return;
  const countries = [
    { name: '🇷🇺 Россия', count: 1842, pct: 100 },
    { name: '🇺🇦 Украина', count: 623, pct: 34 },
    { name: '🇩🇪 Германия', count: 441, pct: 24 },
    { name: '🇺🇸 США', count: 387, pct: 21 },
    { name: '🇵🇱 Польша', count: 298, pct: 16 },
    { name: '🇧🇾 Беларусь', count: 214, pct: 12 },
  ];
  list.innerHTML = countries.map(c => `
    <div class="country-row">
      <div class="country-name">${c.name}</div>
      <div class="country-bar-wrap"><div class="country-bar" style="width:${c.pct}%"></div></div>
      <div class="country-count">${c.count}</div>
    </div>
  `).join('');
}

// ── USERS ──────────────────────────────────────
function renderUsers() {
  const tbody = document.getElementById('users-tbody');
  if (!tbody) return;

  const start = (currentPage - 1) * usersPerPage;
  const pageUsers = filteredUsers.slice(start, start + usersPerPage);

  tbody.innerHTML = pageUsers.map(u => `
    <tr>
      <td><input type="checkbox" class="user-checkbox" value="${u.id}"/></td>
      <td><code style="font-size:11px;color:var(--accent)">${u.id}</code></td>
      <td><code style="font-size:12px">${u.ip}</code></td>
      <td>${u.country}</td>
      <td><span class="status-pill ${u.status}">${statusLabel(u.status)}</span></td>
      <td>${u.chats}</td>
      <td style="color:${u.reports > 2 ? 'var(--danger)' : 'inherit'}">${u.reports}</td>
      <td>
        <div style="display:flex;gap:6px">
          <button class="btn-sm-action" onclick="warnUser('${u.id}')">⚠️ Предупредить</button>
          <button class="btn-sm-action" style="border-color:var(--danger);color:var(--danger)" onclick="banUser('${u.id}')">🔨 Бан</button>
        </div>
      </td>
    </tr>
  `).join('');

  renderPagination();
}

function filterUsers() {
  const query = document.getElementById('user-search')?.value?.toLowerCase() || '';
  const status = document.getElementById('user-filter-status')?.value || '';
  filteredUsers = mockUsers.filter(u => {
    const matchQuery = !query || u.id.includes(query) || u.ip.includes(query) || u.country.toLowerCase().includes(query);
    const matchStatus = !status || u.status === status;
    return matchQuery && matchStatus;
  });
  currentPage = 1;
  renderUsers();
}

function renderPagination() {
  const total = Math.ceil(filteredUsers.length / usersPerPage);
  const pg = document.getElementById('users-pagination');
  if (!pg) return;
  pg.innerHTML = Array.from({ length: total }, (_, i) =>
    `<button class="page-btn ${i+1 === currentPage ? 'active' : ''}" onclick="goToPage(${i+1})">${i+1}</button>`
  ).join('');
}

function goToPage(p) {
  currentPage = p;
  renderUsers();
}

function toggleSelectAll() {
  const all = document.getElementById('select-all-users')?.checked;
  document.querySelectorAll('.user-checkbox').forEach(cb => cb.checked = all);
}

function banSelected() {
  const selected = [...document.querySelectorAll('.user-checkbox:checked')].map(cb => cb.value);
  if (!selected.length) { showAdminToast('⚠️ Выберите пользователей'); return; }
  selected.forEach(id => {
    const u = mockUsers.find(u => u.id === id);
    if (u) u.status = 'banned';
  });
  renderUsers();
  showAdminToast(`🔨 Заблокировано ${selected.length} пользователей`);
}

function warnUser(id) {
  const u = mockUsers.find(u => u.id === id);
  if (u) u.status = 'warned';
  renderUsers();
  showAdminToast('⚠️ Предупреждение выдано');
}

function banUser(id) {
  const u = mockUsers.find(u => u.id === id);
  if (u) u.status = 'banned';
  renderUsers();
  showAdminToast('🔨 Пользователь заблокирован');
}

// ── SESSIONS ───────────────────────────────────
function renderSessions() {
  const tbody = document.getElementById('sessions-tbody');
  const countEl = document.getElementById('active-sessions-count');
  if (!tbody) return;
  if (countEl) countEl.textContent = mockSessions.length;

  tbody.innerHTML = mockSessions.map(s => `
    <tr>
      <td><code style="font-size:11px;color:var(--accent)">${s.id}</code></td>
      <td><code style="font-size:12px">${s.user1}</code></td>
      <td><code style="font-size:12px">${s.user2}</code></td>
      <td><span class="status-pill ${s.mode === 'video' ? 'online' : 'warned'}">${s.mode === 'video' ? '📹 Видео' : '💬 Текст'}</span></td>
      <td style="font-family:var(--font-mono)">${s.duration}</td>
      <td>${s.messages}</td>
      <td>
        <button class="btn-sm-action" style="border-color:var(--danger);color:var(--danger)" onclick="terminateSession('${s.id}')">⏹ Завершить</button>
      </td>
    </tr>
  `).join('');
}

function terminateSession(id) {
  const idx = mockSessions.findIndex(s => s.id === id);
  if (idx !== -1) mockSessions.splice(idx, 1);
  renderSessions();
  showAdminToast('⏹ Сессия завершена');
}

function terminateAllSessions() {
  mockSessions.length = 0;
  renderSessions();
  showAdminToast('⏹ Все сессии завершены');
}

// ── REPORTS ────────────────────────────────────
function renderReports() {
  const list = document.getElementById('reports-list');
  if (!list) return;
  const filter = document.getElementById('report-filter')?.value || '';
  const toShow = filter ? mockReports.filter(r => r.status === filter) : mockReports;

  list.innerHTML = toShow.map(r => `
    <div class="report-card ${r.status}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
        <div class="report-type">🚩 ${r.type}</div>
        <span class="status-pill ${r.status}">${reportStatusLabel(r.status)}</span>
      </div>
      <div class="report-meta">От: ${r.from} · На: ${r.against} · ${r.time}</div>
      ${r.desc ? `<div class="report-desc">"${r.desc}"</div>` : ''}
      <div class="report-actions">
        <button class="btn-admin sm danger" onclick="resolveReport('${r.id}','ban')">🔨 Забанить</button>
        <button class="btn-admin sm" onclick="resolveReport('${r.id}','resolve')">✅ Решить</button>
        <button class="btn-cancel-sm" onclick="resolveReport('${r.id}','dismiss')">Отклонить</button>
      </div>
    </div>
  `).join('');
}

function filterReports() { renderReports(); }

function resolveReport(id, action) {
  const r = mockReports.find(r => r.id === id);
  if (r) r.status = action === 'dismiss' ? 'dismissed' : 'resolved';
  renderReports();
  updateBadges();
  renderDashboard();
  showAdminToast(action === 'ban' ? '🔨 Пользователь забанен' : '✅ Жалоба обработана');
}

function resolveAllReports() {
  mockReports.forEach(r => { if (r.status === 'pending') r.status = 'resolved'; });
  renderReports();
  updateBadges();
  showAdminToast('✅ Все жалобы закрыты');
}

// ── BANS ───────────────────────────────────────
function renderBans() {
  const tbody = document.getElementById('bans-tbody');
  if (!tbody) return;
  tbody.innerHTML = mockBans.map((b, i) => `
    <tr>
      <td><code style="font-size:12px">${b.target}</code></td>
      <td>${b.reason}</td>
      <td><span class="status-pill ${b.type === 'auto' ? 'warned' : 'banned'}">${b.type === 'auto' ? 'Авто' : 'Ручной'}</span></td>
      <td style="font-family:var(--font-mono);font-size:12px">${b.date}</td>
      <td style="color:${b.until === 'Навсегда' ? 'var(--danger)' : 'inherit'}">${b.until}</td>
      <td style="font-size:12px;color:var(--text-secondary)">${b.by}</td>
      <td>
        <button class="btn-sm-action" onclick="unban(${i})">✓ Разбанить</button>
      </td>
    </tr>
  `).join('');
}

function unban(i) {
  mockBans.splice(i, 1);
  renderBans();
  showAdminToast('✅ Блокировка снята');
}

function showAddBanModal() { document.getElementById('ban-modal').style.display = 'flex'; }
function closeBanModal() { document.getElementById('ban-modal').style.display = 'none'; }

function executeBan() {
  const target = document.getElementById('ban-target')?.value;
  const reason = document.getElementById('ban-reason')?.value;
  const duration = document.getElementById('ban-duration')?.value;
  if (!target) { showAdminToast('⚠️ Введите IP или ID'); return; }
  const durations = { '1h': '1 час', '24h': '24 часа', '7d': '7 дней', '30d': '30 дней', 'perm': 'Навсегда' };
  mockBans.unshift({ target, reason, type: 'manual', date: new Date().toLocaleDateString('ru-RU'), until: durations[duration], by: 'Вы' });
  renderBans();
  closeBanModal();
  showAdminToast('🔨 Блокировка добавлена');
}

// ── MODERATION ─────────────────────────────────
function toggleMod(feature, input) {
  showAdminToast(`${input.checked ? '✅' : '❌'} ${feature} ${input.checked ? 'включён' : 'выключен'}`);
}

function renderStopWords() {
  const list = document.getElementById('stopwords-list');
  if (!list) return;
  list.innerHTML = stopWords.map(w =>
    `<span class="stopword-tag">${w}<em class="stopword-remove" onclick="removeStopWord('${w}')">×</em></span>`
  ).join('');
}

function addStopWord() {
  const input = document.getElementById('stopword-input');
  const word = input?.value?.trim().toLowerCase();
  if (word && !stopWords.includes(word)) {
    stopWords.push(word);
    renderStopWords();
    if (input) input.value = '';
    showAdminToast(`🚫 "${word}" добавлено в стоп-слова`);
  }
}

function removeStopWord(w) {
  const idx = stopWords.indexOf(w);
  if (idx !== -1) stopWords.splice(idx, 1);
  renderStopWords();
}

// ── MODERATORS ─────────────────────────────────
function renderModerators() {
  const list = document.getElementById('moderators-list');
  if (!list) return;
  list.innerHTML = mockModerators.map(m => `
    <div class="mod-list-item">
      <div class="mod-item-info">
        <div class="mod-item-name">${m.login} <span style="width:7px;height:7px;display:inline-block;border-radius:50%;background:${m.online ? 'var(--accent)' : 'var(--text-muted)'}"></span></div>
        <div class="mod-item-role">${m.role}</div>
      </div>
      <div class="mod-item-actions">
        <button class="btn-sm-action">Изменить</button>
        <button class="btn-sm-action" onclick="removeModerator('${m.login}')">Удалить</button>
      </div>
    </div>
  `).join('');
}

function showAddModeratorModal() { document.getElementById('mod-modal').style.display = 'flex'; }
function closeModModal() { document.getElementById('mod-modal').style.display = 'none'; }

function addModerator() {
  const login = document.getElementById('mod-login')?.value?.trim();
  const role = document.getElementById('mod-role');
  const roleText = role?.options[role.selectedIndex]?.text;
  if (!login) { showAdminToast('⚠️ Введите логин'); return; }
  mockModerators.push({ login, role: roleText, online: false });
  renderModerators();
  closeModModal();
  showAdminToast('✅ Модератор добавлен');
}

function removeModerator(login) {
  const idx = mockModerators.findIndex(m => m.login === login);
  if (idx !== -1) mockModerators.splice(idx, 1);
  renderModerators();
  showAdminToast('🗑️ Модератор удалён');
}

// ── SETTINGS ───────────────────────────────────
function saveSettings() { showAdminToast('💾 Настройки сохранены'); }
function saveNotifications() { showAdminToast('💾 Уведомления сохранены'); }
function toggleMaintenance(input) {
  showAdminToast(input.checked ? '🔧 Режим техобслуживания включён' : '✅ Сайт снова доступен');
}

// ── LOGS ───────────────────────────────────────
const logTypes = [
  { t: 'join', labels: ['Пользователь подключился', 'Новое соединение', 'Сессия начата'] },
  { t: 'ban', labels: ['IP заблокирован', 'Авто-бан применён', 'Пользователь забанен'] },
  { t: 'warn', labels: ['Предупреждение выдано', 'Подозрительная активность', 'Жалоба получена'] },
  { t: 'error', labels: ['Ошибка WebRTC', 'Соединение прервано', 'Таймаут подключения'] },
  { t: 'info', labels: ['Модерация запущена', 'Кэш очищен', 'Резервная копия создана'] },
];

function renderLogs() {
  const stream = document.getElementById('log-stream');
  if (!stream) return;
  for (let i = 0; i < 30; i++) addLiveLog(true);
}

function addLiveLog(initial = false) {
  const stream = document.getElementById('log-stream');
  if (!stream) return;
  const type = logTypes[rand(0, logTypes.length - 1)];
  const label = type.labels[rand(0, type.labels.length - 1)];
  const ip = `${rand(1,254)}.${rand(1,254)}.${rand(1,254)}.${rand(1,254)}`;
  const time = new Date().toLocaleTimeString('ru-RU');

  const div = document.createElement('div');
  div.className = 'log-entry';
  div.innerHTML = `
    <span class="log-time">${time}</span>
    <span class="log-type ${type.t}">[${type.t.toUpperCase()}]</span>
    <span class="log-msg">${label} · ${ip}</span>
  `;

  if (initial) {
    stream.appendChild(div);
  } else {
    stream.prepend(div);
    if (stream.children.length > 200) stream.lastChild.remove();
  }
}

function exportLogs() {
  showAdminToast('⬇️ Логи экспортированы в logs.csv');
}

// ── CHARTS ─────────────────────────────────────
function initCharts() {
  Chart.defaults.color = '#7a93b5';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.06)';

  // Activity chart
  const actCtx = document.getElementById('activity-chart');
  if (actCtx) {
    new Chart(actCtx, {
      type: 'line',
      data: {
        labels: Array.from({ length: 24 }, (_, i) => `${i}:00`),
        datasets: [
          {
            label: 'Онлайн',
            data: Array.from({ length: 24 }, () => rand(1800, 5200)),
            borderColor: '#00e5c4',
            backgroundColor: 'rgba(0,229,196,0.08)',
            fill: true,
            tension: 0.4,
            pointRadius: 3,
          },
          {
            label: 'Чаты',
            data: Array.from({ length: 24 }, () => rand(600, 2800)),
            borderColor: '#3498db',
            backgroundColor: 'rgba(52,152,219,0.08)',
            fill: true,
            tension: 0.4,
            pointRadius: 3,
          }
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.04)' } },
          y: { grid: { color: 'rgba(255,255,255,0.04)' } }
        }
      }
    });
  }

  // Hourly chart
  const hrCtx = document.getElementById('hourly-chart');
  if (hrCtx) {
    new Chart(hrCtx, {
      type: 'bar',
      data: {
        labels: Array.from({ length: 24 }, (_, i) => `${i}:00`),
        datasets: [{
          label: 'Пользователи',
          data: Array.from({ length: 24 }, (_, i) => {
            const peak = i >= 20 && i <= 23 ? rand(4000, 5500) : rand(500, 3500);
            return peak;
          }),
          backgroundColor: 'rgba(0,229,196,0.6)',
          borderColor: '#00e5c4',
          borderWidth: 1,
          borderRadius: 4,
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false } },
          y: { grid: { color: 'rgba(255,255,255,0.04)' } }
        }
      }
    });
  }

  // Countries donut
  const cCtx = document.getElementById('countries-chart');
  if (cCtx) {
    new Chart(cCtx, {
      type: 'doughnut',
      data: {
        labels: ['🇷🇺 Россия', '🇺🇦 Украина', '🇩🇪 Германия', '🇺🇸 США', '🇵🇱 Польша', 'Другие'],
        datasets: [{
          data: [42, 14, 10, 9, 7, 18],
          backgroundColor: ['#00e5c4','#3498db','#f39c12','#e74c3c','#9b59b6','#555'],
          borderWidth: 2,
          borderColor: '#0e1520',
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'right' } }
      }
    });
  }

  // Devices donut
  const dCtx = document.getElementById('devices-chart');
  if (dCtx) {
    new Chart(dCtx, {
      type: 'doughnut',
      data: {
        labels: ['📱 Мобильные', '💻 Десктоп', '📟 Планшет'],
        datasets: [{
          data: [54, 38, 8],
          backgroundColor: ['#00e5c4', '#3498db', '#f39c12'],
          borderWidth: 2,
          borderColor: '#0e1520',
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'right' } }
      }
    });
  }
}

function updateAnalytics() { showAdminToast('📈 Период обновлён'); }

// ── LIVE UPDATES ───────────────────────────────
function liveUpdate() {
  const onlineEl = document.getElementById('kpi-online');
  if (onlineEl) {
    const curr = parseInt(onlineEl.textContent.replace(/\s/g,'')) || 4291;
    const next = Math.max(3800, Math.min(5500, curr + rand(-15, 25)));
    onlineEl.textContent = next.toLocaleString('ru-RU');
  }

  const chatsEl = document.getElementById('kpi-chats');
  if (chatsEl) {
    const curr = parseInt(chatsEl.textContent.replace(/\s/g,'')) || 1284051;
    chatsEl.textContent = (curr + rand(2, 12)).toLocaleString('ru-RU');
  }
}

function refreshData() {
  liveUpdate();
  showAdminToast('↻ Данные обновлены');
}

// ── TOAST ──────────────────────────────────────
let toastTimer;
function showAdminToast(msg) {
  const t = document.getElementById('admin-toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

// ── AUTH ───────────────────────────────────────
function logout() {
  if (confirm('Выйти из панели управления?')) {
    window.location.href = '../index.html';
  }
}

// ── HELPERS ────────────────────────────────────
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function setEl(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

function statusLabel(s) {
  const labels = { online: 'Онлайн', banned: 'Забанен', warned: 'Предупреждён' };
  return labels[s] || s;
}

function reportStatusLabel(s) {
  const labels = { pending: 'Новая', resolved: 'Решена', dismissed: 'Отклонена' };
  return labels[s] || s;
}
