/**
 * SPINTALK Spectator Page
 * Анонимное наблюдение за чатом пользователей
 */
'use strict';

const sp = {
  socket: null,
  chatId: null,
  users: [],
  pcs: new Map(),
  authData: null,
};

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

document.addEventListener('DOMContentLoaded', () => {
  // chatId из URL
  const params = new URLSearchParams(window.location.search);
  sp.chatId = params.get('chatId');
  if (!sp.chatId) {
    document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#ff4757">❌ chatId не указан</div>';
    return;
  }
  document.getElementById('chat-id-display').textContent = sp.chatId;

  // Проверка авторизации
  const stored = sessionStorage.getItem('spintalk_admin');
  if (!stored) {
    document.body.innerHTML = '<div style="padding:40px;text-align:center">🔒 Войдите как админ <a href="login.html" style="color:#00e5c4">→ login</a></div>';
    return;
  }
  try { sp.authData = JSON.parse(stored); }
  catch (e) {
    document.body.innerHTML = '<div style="padding:40px;text-align:center">❌ Сессия повреждена</div>';
    return;
  }

  connectSocket();
});

function connectSocket() {
  sp.socket = io({ transports: ['websocket'] });

  sp.socket.on('connect', () => {
    sp.socket.emit('admin:spectate', { chatId: sp.chatId, token: sp.authData.token });
  });

  sp.socket.on('admin:spectate:fail', ({ reason }) => {
    showSpToast('❌ ' + reason);
    setTimeout(() => window.close(), 2500);
  });

  sp.socket.on('admin:spectate:ok', ({ chatId, users, mode }) => {
    sp.users = users;
    renderUserInfo(0, users[0]);
    renderUserInfo(1, users[1]);

    if (mode === 'text') {
      // Скрыть видео для текстового режима
      document.querySelectorAll('.spectate-video-wrap').forEach(v => v.style.display = 'none');
      document.getElementById('messages-panel').style.display = 'block';
    } else {
      // Для текстового тоже показываем сообщения
      document.getElementById('messages-panel').style.display = 'block';
    }
    showSpToast('✅ Подключено к чату');
  });

  sp.socket.on('admin:spectate:ended', () => {
    showSpToast('⛔ Чат завершён');
    setTimeout(() => window.close(), 2000);
  });

  // SDP/ICE от пользователей
  sp.socket.on('admin:spectate:signal', async ({ userId, data }) => {
    let pc = sp.pcs.get(userId);

    if (data.type === 'offer') {
      // Новое предложение от пользователя — создаём PC
      if (pc) pc.close();
      pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      sp.pcs.set(userId, pc);

      pc.ontrack = (e) => {
        const idx = sp.users.findIndex(u => u.id === userId);
        if (idx === -1) return;
        const video = document.getElementById(`video-user${idx + 1}`);
        const empty = document.getElementById(`empty-user${idx + 1}`);
        if (video && e.streams[0]) {
          video.srcObject = e.streams[0];
          if (empty) empty.style.display = 'none';
        }
      };

      pc.onicecandidate = (e) => {
        if (e.candidate) sp.socket.emit('admin:spectate:signal', { userId, data: e.candidate });
      };

      try {
        await pc.setRemoteDescription(new RTCSessionDescription(data));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sp.socket.emit('admin:spectate:signal', { userId, data: pc.localDescription });
      } catch (e) { console.error('Answer error:', e); }
    } else if (data.candidate && pc) {
      try { await pc.addIceCandidate(new RTCIceCandidate(data)); }
      catch (e) {}
    }
  });

  // Сообщения чата
  sp.socket.on('admin:spectate:message', ({ text, from, fromId, ts }) => {
    addSpectateMessage({ text, from, ts });
  });
}

function renderUserInfo(idx, user) {
  if (!user) return;
  const nickEl = document.getElementById(`user${idx + 1}-nick`);
  const metaEl = document.getElementById(`user${idx + 1}-meta`);
  if (nickEl) nickEl.textContent = user.nickname || 'Аноним';
  if (metaEl) {
    const genderIcon = user.gender === 'male' ? '♂' : user.gender === 'female' ? '♀' : '·';
    metaEl.textContent = `${genderIcon} ${user.age || '—'} лет · IP ${(user.ip || '').replace(/\.\d+$/, '.x')}`;
  }
}

function addSpectateMessage({ text, from, ts }) {
  const list = document.getElementById('spectate-messages-list');
  if (!list) return;
  const div = document.createElement('div');
  div.className = 'spectate-msg';
  const time = new Date(ts || Date.now()).toLocaleTimeString('ru-RU');
  div.innerHTML = `
    <span class="spectate-msg-time">${time}</span>
    <span class="spectate-msg-nick">${escapeHtml(from)}:</span>
    <span>${escapeHtml(text)}</span>
  `;
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
}

// ── ДЕЙСТВИЯ ─────────────────────────────────────
function warnUser(idx) {
  const user = sp.users[idx];
  if (!user) return;
  const msg = prompt(`Предупреждение для ${user.nickname}:`, 'Соблюдайте правила сервиса');
  if (msg) {
    sp.socket.emit('admin:warn', { userId: user.id, message: msg });
    showSpToast('⚠️ Предупреждение отправлено');
  }
}

function kickUser(idx) {
  const user = sp.users[idx];
  if (!user) return;
  if (!confirm(`Отключить ${user.nickname}?`)) return;
  sp.socket.emit('admin:kick', { userId: user.id });
  showSpToast('👢 Пользователь отключён');
}

function banUser(idx) {
  const user = sp.users[idx];
  if (!user || !user.ip) return;
  const reason = prompt(`Причина бана IP ${user.ip}:`, 'Нарушение правил');
  if (!reason) return;
  sp.socket.emit('admin:ban', { target: user.ip, reason, durationMs: null });
  showSpToast(`🔨 IP ${user.ip.replace(/\.\d+$/, '.x')} заблокирован`);
}

// ── UTIL ─────────────────────────────────────────
let toastTimer;
function showSpToast(msg) {
  const t = document.getElementById('spectate-toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

// Очистка при закрытии
window.addEventListener('beforeunload', () => {
  if (sp.socket?.connected) sp.socket.emit('admin:spectate:stop', { chatId: sp.chatId });
  sp.pcs.forEach(pc => pc.close());
});
