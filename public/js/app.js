/**
 * SPINTALK — Frontend Application
 * Полное подключение к серверу через Socket.io + WebRTC
 */
'use strict';

// ── СОСТОЯНИЕ ─────────────────────────────────────
const state = {
  chatMode:      null,
  connected:     false,
  chatStartTime: null,
  timerInterval: null,
  localStream:   null,
  pc:            null,       // RTCPeerConnection
  socket:        null,       // Socket.io
  role:          null,       // 'caller' | 'callee'
  interests:     [],
  camEnabled:    true,
  micEnabled:    true,
  chatId:        null,
  messageCount:  0,
};

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

// ── ИНИЦИАЛИЗАЦИЯ ─────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  animateCounters();
  setupTagInput();
  loadTheme();
  connectSocket();
  startOnlineCounter();
});

// ── SOCKET.IO ПОДКЛЮЧЕНИЕ ─────────────────────────
function connectSocket() {
  state.socket = io({
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 2000,
  });

  state.socket.on('connect', () => {
    console.log('✅ Подключено к серверу:', state.socket.id);
    showToast('✅ Подключено к серверу');
  });

  state.socket.on('disconnect', () => {
    console.log('❌ Отключено от сервера');
    if (state.connected) {
      handlePartnerLeft({ reason: 'server_disconnect' });
    }
    setStatus('disconnected', 'Переподключение...');
  });

  state.socket.on('connect_error', (err) => {
    console.error('Ошибка подключения:', err.message);
    setStatus('disconnected', 'Ошибка соединения');
  });

  // Найден собеседник
  state.socket.on('matched', async ({ role, mode, chatId }) => {
    console.log('🎯 Matched! role:', role, 'mode:', mode);
    state.role   = role;
    state.chatId = chatId;
    state.connected = true;

    handleMatched(mode);

    if (mode === 'video') {
      await initPeerConnection();
      if (role === 'caller') await createOffer();
    }
  });

  // WebRTC сигналинг
  state.socket.on('signal', async (data) => {
    await handleSignal(data);
  });

  // Сообщение от собеседника
  state.socket.on('message', ({ text, ts }) => {
    addMessage(text, 'stranger');
  });

  // Собеседник ушёл / пропустил
  state.socket.on('partner:left', ({ reason }) => {
    handlePartnerLeft({ reason });
  });

  // Статус очереди
  state.socket.on('status', ({ state: s, position }) => {
    if (s === 'waiting') {
      setStatus('searching', `Поиск... (${position} в очереди)`);
    }
  });

  // Бан
  state.socket.on('banned', ({ reason }) => {
    closePeer();
    stopStream();
    showPage('landing-page');
    setTimeout(() => alert(`🚫 Вы заблокированы.\nПричина: ${reason}`), 300);
  });

  // Принудительное завершение модератором
  state.socket.on('terminated', ({ reason }) => {
    showToast('⛔ ' + reason);
    skipPartner();
  });

  // Перезапуск сервера
  state.socket.on('server:shutdown', ({ message }) => {
    showToast('⚠️ ' + message);
  });

  // Жалоба принята
  state.socket.on('report:ack', () => {
    showToast('✅ Жалоба отправлена. Спасибо!');
    setTimeout(() => showPage('chat-page'), 1500);
  });
}

// ── НАЧАЛО ЧАТА ───────────────────────────────────
async function startChat(mode) {
  const ageCheck = document.getElementById('age-check');
  if (!ageCheck?.checked) {
    showToast('⚠️ Подтвердите возраст, чтобы продолжить');
    return;
  }
  if (!state.socket?.connected) {
    showToast('⚠️ Нет соединения с сервером. Подождите...');
    return;
  }

  state.chatMode = mode;

  const layout = document.getElementById('chat-layout');
  if (mode === 'text') {
    layout.classList.add('text-mode');
  } else {
    layout.classList.remove('text-mode');
    await initCamera();
  }

  showPage('chat-page');
  clearMessages();
  beginSearch();
}

// ── ПОИСК СОБЕСЕДНИКА ─────────────────────────────
function beginSearch() {
  closePeer();
  setStatus('searching', 'Поиск собеседника...');
  hidePlaceholder(false);
  setPlaceholderText('Ищем собеседника...');
  stopTimer();
  disableReport(true);
  hideStrangerBadge();

  state.socket.emit('find', {
    mode:      state.chatMode,
    interests: state.interests,
  });
}

// ── КОГДА НАШЛИ СОБЕСЕДНИКА ───────────────────────
function handleMatched(mode) {
  setStatus('connected', 'Собеседник найден!');
  hidePlaceholder(true);
  showStrangerBadge('🌍');
  startTimer();
  disableReport(false);
  addSystemMessage('Собеседник подключился! 👋 Начните общение.');
}

// ── КОГДА СОБЕСЕДНИК УШЁЛ ─────────────────────────
function handlePartnerLeft({ reason }) {
  if (!state.connected && reason !== 'server_disconnect') return;

  state.connected = false;
  closePeer();
  stopTimer();
  disableReport(true);
  hidePlaceholder(false);
  hideStrangerBadge();

  if (reason === 'skip') {
    addSystemMessage('Собеседник пропустил. Ищем следующего...');
    setStatus('searching', 'Ищем следующего...');
    setPlaceholderText('Ищем следующего...');
    setTimeout(() => beginSearch(), 1000);
  } else {
    addSystemMessage('Собеседник отключился. Ищем следующего...');
    setStatus('searching', 'Ищем следующего...');
    setPlaceholderText('Ищем следующего...');
    setTimeout(() => beginSearch(), 1500);
  }
}

// ── ПРОПУСТИТЬ ────────────────────────────────────
function skipPartner() {
  state.connected = false;
  closePeer();
  stopTimer();
  disableReport(true);
  hideStrangerBadge();
  clearMessages();
  setStatus('searching', 'Ищем следующего...');
  hidePlaceholder(false);
  setPlaceholderText('Ищем следующего...');

  state.socket.emit('skip');
}

// ── СТОП ──────────────────────────────────────────
function stopChat() {
  state.connected = false;
  closePeer();
  stopTimer();
  stopStream();
  disableReport(true);
  state.socket.emit('skip'); // уведомить сервер
}

function goHome() {
  stopChat();
  showPage('landing-page');
}

// ── КАМЕРА И МИК ──────────────────────────────────
async function initCamera() {
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 },
    });
    const localVideo = document.getElementById('local-video');
    if (localVideo) localVideo.srcObject = state.localStream;
    console.log('✅ Камера и микрофон подключены');
  } catch (err) {
    console.warn('⚠️ Камера недоступна:', err.message);
    showToast('📷 Камера недоступна — режим без видео');
    // Пробуем только аудио
    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      console.warn('Аудио тоже недоступно');
    }
  }
}

function toggleCamera() {
  if (!state.localStream) return;
  state.camEnabled = !state.camEnabled;
  state.localStream.getVideoTracks().forEach(t => t.enabled = state.camEnabled);
  const btn = document.getElementById('btn-cam');
  if (btn) {
    btn.textContent = state.camEnabled ? '📷' : '🚫';
    btn.classList.toggle('muted', !state.camEnabled);
  }
  showToast(state.camEnabled ? '📷 Камера включена' : '🚫 Камера выключена');
}

function toggleMic() {
  if (!state.localStream) return;
  state.micEnabled = !state.micEnabled;
  state.localStream.getAudioTracks().forEach(t => t.enabled = state.micEnabled);
  const btn = document.getElementById('btn-mic');
  if (btn) {
    btn.textContent = state.micEnabled ? '🎤' : '🔇';
    btn.classList.toggle('muted', !state.micEnabled);
  }
  showToast(state.micEnabled ? '🎤 Микрофон включён' : '🔇 Микрофон выключен');
}

function stopStream() {
  if (state.localStream) {
    state.localStream.getTracks().forEach(t => t.stop());
    state.localStream = null;
  }
  const lv = document.getElementById('local-video');
  if (lv) lv.srcObject = null;
}

// ── WebRTC ────────────────────────────────────────
async function initPeerConnection() {
  closePeer();

  state.pc = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    iceCandidatePoolSize: 10,
  });

  // Добавить локальные треки
  if (state.localStream) {
    state.localStream.getTracks().forEach(track => {
      state.pc.addTrack(track, state.localStream);
    });
  }

  // Получить удалённый поток
  state.pc.ontrack = (event) => {
    console.log('📹 Получен удалённый поток');
    const remoteVideo = document.getElementById('remote-video');
    if (remoteVideo && event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      hidePlaceholder(true);
    }
  };

  // ICE кандидаты
  state.pc.onicecandidate = (event) => {
    if (event.candidate) {
      state.socket.emit('signal', event.candidate);
    }
  };

  // Состояние ICE
  state.pc.oniceconnectionstatechange = () => {
    const s = state.pc?.iceConnectionState;
    console.log('ICE state:', s);
    if (s === 'failed') {
      console.log('ICE failed — перезапуск...');
      state.pc?.restartIce();
    }
    if (s === 'disconnected') {
      setTimeout(() => {
        if (state.pc?.iceConnectionState === 'disconnected') {
          handlePartnerLeft({ reason: 'ice_disconnect' });
        }
      }, 5000);
    }
  };

  // Состояние соединения
  state.pc.onconnectionstatechange = () => {
    const s = state.pc?.connectionState;
    console.log('Connection state:', s);
    if (s === 'connected') {
      console.log('✅ WebRTC P2P соединение установлено!');
    }
    if (s === 'failed') {
      handlePartnerLeft({ reason: 'webrtc_failed' });
    }
  };
}

async function createOffer() {
  if (!state.pc) return;
  try {
    const offer = await state.pc.createOffer({
      offerToReceiveVideo: true,
      offerToReceiveAudio: true,
    });
    await state.pc.setLocalDescription(offer);
    state.socket.emit('signal', state.pc.localDescription);
    console.log('📤 Offer отправлен');
  } catch (err) {
    console.error('Ошибка создания offer:', err);
  }
}

async function handleSignal(data) {
  if (!state.pc) await initPeerConnection();

  try {
    if (data.type === 'offer') {
      await state.pc.setRemoteDescription(new RTCSessionDescription(data));
      const answer = await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);
      state.socket.emit('signal', state.pc.localDescription);
      console.log('📤 Answer отправлен');
    } else if (data.type === 'answer') {
      await state.pc.setRemoteDescription(new RTCSessionDescription(data));
      console.log('✅ Answer получен');
    } else if (data.candidate) {
      await state.pc.addIceCandidate(new RTCIceCandidate(data));
    }
  } catch (err) {
    console.error('Ошибка обработки сигнала:', err);
  }
}

function closePeer() {
  if (state.pc) {
    state.pc.close();
    state.pc = null;
  }
  const rv = document.getElementById('remote-video');
  if (rv) rv.srcObject = null;
}

// ── СООБЩЕНИЯ ─────────────────────────────────────
function sendMessage() {
  const input = document.getElementById('msg-input');
  const text  = input?.value?.trim();
  if (!text) return;
  if (!state.socket?.connected) { showToast('⚠️ Нет соединения'); return; }

  // Показать у себя сразу
  addMessage(text, 'own');
  input.value = '';
  state.messageCount++;

  // Отправить реальному собеседнику через сервер
  state.socket.emit('message', { text });
}

function addMessage(text, side) {
  const wrap = document.getElementById('messages-wrap');
  if (!wrap) return;

  const div  = document.createElement('div');
  div.className = `message ${side}`;
  const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  div.innerHTML = `
    <div class="message-bubble">${escapeHtml(text)}</div>
    <div class="message-time">${time}</div>
  `;
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
}

function addSystemMessage(text) {
  const wrap = document.getElementById('messages-wrap');
  if (!wrap) return;
  const div  = document.createElement('div');
  div.className  = 'system-msg';
  div.textContent = text;
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
}

function clearMessages() {
  const wrap = document.getElementById('messages-wrap');
  if (wrap) wrap.innerHTML = '';
}

function handleMsgKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

// ── ЖАЛОБА ────────────────────────────────────────
function reportUser() {
  showPage('report-page');
}

function submitReport() {
  const typeEl = document.querySelector('#report-page select');
  const descEl = document.querySelector('#report-page textarea');
  const type   = typeEl?.value || 'Неприемлемый контент';
  const description = descEl?.value || '';

  state.socket.emit('report', { type, description });
}

// ── UI ХЕЛПЕРЫ ────────────────────────────────────
function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const t = document.getElementById(pageId);
  if (t) t.classList.add('active');
}

function setStatus(type, text) {
  const dot   = document.getElementById('status-dot');
  const label = document.getElementById('status-text');
  if (dot)   dot.className = `status-dot ${type}`;
  if (label) label.textContent = text;
}

function hidePlaceholder(hide) {
  const ph = document.getElementById('remote-placeholder');
  if (ph) ph.style.display = hide ? 'none' : 'flex';
}

function setPlaceholderText(text) {
  const el = document.getElementById('placeholder-text');
  if (el) el.textContent = text;
}

function showStrangerBadge(flag) {
  const badge  = document.getElementById('stranger-badge');
  const flagEl = document.getElementById('stranger-country');
  if (badge)  badge.style.display = 'flex';
  if (flagEl) flagEl.textContent  = flag;
}

function hideStrangerBadge() {
  const badge = document.getElementById('stranger-badge');
  if (badge) badge.style.display = 'none';
}

function disableReport(disabled) {
  const btn = document.getElementById('btn-report');
  if (btn) btn.disabled = disabled;
}

// ── ТАЙМЕР ────────────────────────────────────────
function startTimer() {
  stopTimer();
  state.chatStartTime = Date.now();
  state.timerInterval = setInterval(updateTimer, 1000);
}

function stopTimer() {
  if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }
  const el = document.getElementById('chat-timer');
  if (el) el.textContent = '00:00';
}

function updateTimer() {
  if (!state.chatStartTime) return;
  const elapsed = Math.floor((Date.now() - state.chatStartTime) / 1000);
  const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const s = String(elapsed % 60).padStart(2, '0');
  const el = document.getElementById('chat-timer');
  if (el) el.textContent = `${m}:${s}`;
}

// ── НАСТРОЙКИ ─────────────────────────────────────
function toggleSettings() {
  document.getElementById('settings-panel')?.classList.toggle('open');
}

function changeTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('spintalk-theme', theme);
}

function loadTheme() {
  const saved = localStorage.getItem('spintalk-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  const sel = document.getElementById('theme-select');
  if (sel) sel.value = saved;
}

async function loadDevices() {
  try {
    await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    const camSel  = document.getElementById('camera-select');
    const micSel  = document.getElementById('mic-select');
    if (!camSel || !micSel) return;
    devices.filter(d => d.kind === 'videoinput').forEach((d, i) => {
      camSel.add(new Option(d.label || `Камера ${i+1}`, d.deviceId));
    });
    devices.filter(d => d.kind === 'audioinput').forEach((d, i) => {
      micSel.add(new Option(d.label || `Микрофон ${i+1}`, d.deviceId));
    });
  } catch (e) {}
}

// ── ИНТЕРЕСЫ / ТЕГИ ───────────────────────────────
function setupTagInput() {
  const input = document.getElementById('interest-input');
  if (!input) return;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const val = input.value.trim().replace(/,/g, '');
      if (val) addTag(val);
      input.value = '';
    }
    if (e.key === 'Backspace' && !input.value && state.interests.length) {
      removeTag(state.interests[state.interests.length - 1]);
    }
  });
}

function addTag(text) {
  if (state.interests.includes(text) || state.interests.length >= 8) return;
  state.interests.push(text);
  renderTags();
}

function addPresetTag(el) {
  const text = el.textContent.trim();
  state.interests.includes(text) ? removeTag(text) : addTag(text);
}

function removeTag(text) {
  state.interests = state.interests.filter(t => t !== text);
  renderTags();
}

function renderTags() {
  const display = document.getElementById('tags-display');
  if (!display) return;
  display.innerHTML = state.interests.map(t =>
    `<span class="tag">${escapeHtml(t)}<em class="tag-remove" onclick="removeTag('${escapeHtml(t)}')">×</em></span>`
  ).join('');
}

// ── ВОЗРАСТ ───────────────────────────────────────
function checkAge() {}
function confirmAge() {
  document.getElementById('age-modal').style.display = 'none';
  document.getElementById('age-check').checked = true;
}
function denyAge() { window.location.href = 'https://www.google.com'; }

// ── TOAST ─────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

// ── СЧЁТЧИКИ ──────────────────────────────────────
function animateCounters() {
  const targets = { 'stat-chats': 1284051, 'stat-countries': 193, 'stat-online': 4291 };
  Object.entries(targets).forEach(([id, target]) => {
    const el = document.getElementById(id);
    if (!el) return;
    let current = 0;
    const step  = Math.ceil(target / 80);
    const iv    = setInterval(() => {
      current = Math.min(current + step, target);
      el.textContent = current.toLocaleString('ru-RU');
      if (current >= target) clearInterval(iv);
    }, 16);
  });
}

function startOnlineCounter() {
  // Обновлять реальный счётчик с сервера каждые 5 секунд
  setInterval(async () => {
    try {
      const res  = await fetch('/api/stats');
      const data = await res.json();
      const el1  = document.getElementById('online-count');
      const el2  = document.getElementById('stat-online');
      const val  = data.online || 0;
      if (el1) el1.textContent = val.toLocaleString('ru-RU');
      if (el2) el2.textContent = val.toLocaleString('ru-RU');
      const el3 = document.getElementById('stat-chats');
      if (el3 && data.chatsToday > 0) el3.textContent = data.chatsToday.toLocaleString('ru-RU');
    } catch (e) {}
  }, 5000);
}

// ── УТИЛИТЫ ───────────────────────────────────────
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// Shake анимация
const style = document.createElement('style');
style.textContent = `
  @keyframes shake {
    0%,100%{transform:translateX(0)}
    20%{transform:translateX(-6px)}
    40%{transform:translateX(6px)}
    60%{transform:translateX(-4px)}
    80%{transform:translateX(4px)}
  }
  .shake{animation:shake 0.4s ease}
`;
document.head.appendChild(style);
