/**
 * SPINTALK Frontend v3.0
 * - Никнейм, пол, возраст
 * - Stop/Start логика
 * - Spectator mode (анонимное наблюдение для модераторов)
 */
'use strict';

const state = {
  chatMode: null, connected: false, chatStartTime: null, timerInterval: null,
  localStream: null, pc: null, socket: null, role: null,
  camEnabled: true, micEnabled: true, chatId: null,
  profile: { nickname: '', gender: '', age: 0, lookGender: 'any', lookAge: 'any' },
  isStopped: false,
  spectatorPCs: new Map(),
};

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

document.addEventListener('DOMContentLoaded', () => {
  loadTheme();
  loadProfile();
  connectSocket();
});

// ── SOCKET.IO ─────────────────────────────────────
function connectSocket() {
  state.socket = io({ transports: ['websocket'], reconnection: true, reconnectionAttempts: 10, reconnectionDelay: 2000 });

  state.socket.on('connect', () => console.log('✅ Подключено'));

  state.socket.on('disconnect', () => {
    if (state.connected) handlePartnerLeft({ reason: 'server_disconnect' });
    setStatus('disconnected', 'Переподключение...');
  });

  state.socket.on('matched', async ({ role, mode, chatId, partner }) => {
    state.role = role; state.chatId = chatId; state.connected = true; state.isStopped = false;
    handleMatched(mode, partner);
    if (mode === 'video') {
      await initPeerConnection();
      if (role === 'caller') await createOffer();
    }
  });

  state.socket.on('signal', handleSignal);

  state.socket.on('message', ({ text, ts, from }) => addMessage(text, 'stranger', from));

  state.socket.on('partner:left', ({ reason }) => handlePartnerLeft({ reason }));

  state.socket.on('status', ({ state: s, position }) => {
    if (s === 'waiting') setStatus('searching', `Поиск... (${position} в очереди)`);
    if (s === 'maintenance') {
      showToast('🔧 Сервер на техобслуживании');
      setTimeout(goHome, 2000);
    }
  });

  state.socket.on('stopped', () => {
    state.connected = false; state.isStopped = true;
    closePeer();
    setStatus('disconnected', 'Остановлено');
    hidePlaceholder(false);
    setPlaceholderText('Нажмите "Старт" чтобы продолжить');
    hideStrangerBadge();
    stopTimer();
    disableReport(true);
    updateStopStartBtn();
  });

  state.socket.on('banned', ({ reason }) => {
    closePeer(); stopStream(); showPage('landing-page');
    setTimeout(() => alert(`🚫 ${reason}`), 300);
  });

  state.socket.on('terminated', ({ reason }) => { showToast('⛔ ' + reason); skipPartner(); });
  state.socket.on('warning', ({ message }) => { showToast('⚠️ ' + message); });
  state.socket.on('announcement', ({ message }) => {
    showToast('📢 ' + message); addSystemMessage('📢 Объявление: ' + message);
  });
  state.socket.on('report:ack', () => {
    showToast('✅ Жалоба отправлена');
    setTimeout(() => showPage('chat-page'), 1500);
  });
  state.socket.on('error', ({ msg }) => showToast('⚠️ ' + msg));

  // ── SPECTATOR: входящий запрос от наблюдателя ───
  state.socket.on('spectator:join', async ({ spectatorId }) => {
    if (!state.localStream) return; // нечего транслировать
    await createSpectatorConnection(spectatorId);
  });

  state.socket.on('spectator:signal', async ({ spectatorId, data }) => {
    let pc = state.spectatorPCs.get(spectatorId);
    if (!pc) return;
    try {
      if (data.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data));
      } else if (data.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(data));
      }
    } catch (e) {}
  });

  state.socket.on('spectator:leave', ({ spectatorId }) => {
    const pc = state.spectatorPCs.get(spectatorId);
    if (pc) { pc.close(); state.spectatorPCs.delete(spectatorId); }
  });
}

// ── ПРОФИЛЬ ───────────────────────────────────────
function selectGender(btn, kind) {
  const parent = btn.parentElement;
  parent.querySelectorAll('.gender-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const value = btn.dataset.gender;
  if (kind === 'me') state.profile.gender = value;
  else state.profile.lookGender = value;
}

function selectAge(btn) {
  btn.parentElement.querySelectorAll('.age-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  state.profile.lookAge = btn.dataset.age;
}

function loadProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem('spintalk_profile') || '{}');
    if (saved.nickname) document.getElementById('nickname-input').value = saved.nickname;
    if (saved.age) document.getElementById('age-input').value = saved.age;
    if (saved.gender) {
      const btn = document.querySelector(`.gender-btn[data-gender="${saved.gender}"]`);
      if (btn && btn.parentElement.querySelectorAll('.gender-btn').length === 2) {
        selectGender(btn, 'me');
      }
    }
  } catch (e) {}
}

function saveProfile() {
  localStorage.setItem('spintalk_profile', JSON.stringify(state.profile));
}

// ── СТАРТ ЧАТА ────────────────────────────────────
async function startChat(mode) {
  if (!document.getElementById('age-check')?.checked) { showToast('⚠️ Подтвердите возраст'); return; }
  if (!state.socket?.connected) { showToast('⚠️ Нет связи с сервером'); return; }

  const nickname = document.getElementById('nickname-input').value.trim();
  const age      = parseInt(document.getElementById('age-input').value);

  if (!nickname || nickname.length < 2) { showToast('⚠️ Введите никнейм (мин. 2 символа)'); return; }
  if (!state.profile.gender) { showToast('⚠️ Выберите ваш пол'); return; }
  if (!age || age < 18 || age > 99) { showToast('⚠️ Возраст 18-99'); return; }

  state.profile.nickname = nickname;
  state.profile.age = age;
  saveProfile();

  state.chatMode = mode;

  if (mode === 'text') {
    document.getElementById('chat-layout').classList.add('text-mode');
  } else {
    document.getElementById('chat-layout').classList.remove('text-mode');
    await initCamera();
  }

  showPage('chat-page');
  clearMessages();
  beginSearch();
}

function beginSearch() {
  closePeer();
  setStatus('searching', 'Поиск собеседника...');
  hidePlaceholder(false);
  setPlaceholderText('Ищем собеседника...');
  stopTimer();
  disableReport(true);
  hideStrangerBadge();
  state.isStopped = false;
  updateStopStartBtn();

  state.socket.emit('find', {
    mode:       state.chatMode,
    nickname:   state.profile.nickname,
    gender:     state.profile.gender,
    age:        state.profile.age,
    lookGender: state.profile.lookGender,
    lookAge:    state.profile.lookAge,
  });
}

function handleMatched(mode, partner) {
  setStatus('connected', 'Собеседник найден');
  hidePlaceholder(true);
  if (partner) {
    const info = `👤 ${escapeHtml(partner.nickname || 'Аноним')} · ${partner.gender === 'male' ? '♂' : '♀'} ${partner.age || ''}`;
    document.getElementById('partner-info').innerHTML = info;
  }
  showStrangerBadge();
  startTimer();
  disableReport(false);
  addSystemMessage(`Собеседник подключился: ${partner?.nickname || 'Аноним'} 👋`);
}

function handlePartnerLeft({ reason }) {
  if (!state.connected && reason !== 'server_disconnect') return;
  state.connected = false;
  closePeer();
  stopTimer();
  disableReport(true);
  hidePlaceholder(false);
  hideStrangerBadge();

  if (state.isStopped) return;

  addSystemMessage(reason === 'skip' ? 'Собеседник пропустил.' : 'Собеседник отключился.');
  setStatus('searching', 'Ищем следующего...');
  setPlaceholderText('Ищем следующего...');
  setTimeout(() => beginSearch(), 1000);
}

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
  state.isStopped = false;
  updateStopStartBtn();
  state.socket.emit('skip');
}

function toggleStopStart() {
  if (state.isStopped) {
    // Старт — продолжить поиск
    state.socket.emit('start');
    beginSearch();
  } else {
    // Стоп
    state.socket.emit('stop');
    state.connected = false;
    state.isStopped = true;
    closePeer();
    stopTimer();
    disableReport(true);
    hideStrangerBadge();
    setStatus('disconnected', 'Остановлено');
    hidePlaceholder(false);
    setPlaceholderText('Нажмите "Старт" чтобы продолжить');
    updateStopStartBtn();
  }
}

function updateStopStartBtn() {
  const btn = document.getElementById('btn-stop-start');
  if (!btn) return;
  if (state.isStopped) {
    btn.innerHTML = '▶️ Старт';
    btn.classList.remove('btn-stop');
    btn.classList.add('btn-start');
  } else {
    btn.innerHTML = '⏹ Стоп';
    btn.classList.add('btn-stop');
    btn.classList.remove('btn-start');
  }
}

function goHome() {
  state.connected = false;
  state.isStopped = false;
  closePeer();
  stopTimer();
  stopStream();
  state.socket.emit('stop');
  showPage('landing-page');
  updateStopStartBtn();
}

// ── КАМЕРА ────────────────────────────────────────
async function initCamera() {
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    document.getElementById('local-video').srcObject = state.localStream;
  } catch (err) {
    showToast('📷 Камера недоступна');
    try { state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) {}
  }
}

function toggleCamera() {
  if (!state.localStream) return;
  state.camEnabled = !state.camEnabled;
  state.localStream.getVideoTracks().forEach(t => t.enabled = state.camEnabled);
  const btn = document.getElementById('btn-cam');
  btn.textContent = state.camEnabled ? '📷' : '🚫';
  btn.classList.toggle('muted', !state.camEnabled);
}

function toggleMic() {
  if (!state.localStream) return;
  state.micEnabled = !state.micEnabled;
  state.localStream.getAudioTracks().forEach(t => t.enabled = state.micEnabled);
  const btn = document.getElementById('btn-mic');
  btn.textContent = state.micEnabled ? '🎤' : '🔇';
  btn.classList.toggle('muted', !state.micEnabled);
}

function stopStream() {
  if (state.localStream) { state.localStream.getTracks().forEach(t => t.stop()); state.localStream = null; }
  const lv = document.getElementById('local-video');
  if (lv) lv.srcObject = null;
}

// ── WEBRTC ────────────────────────────────────────
async function initPeerConnection() {
  closePeer();
  state.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, iceCandidatePoolSize: 10 });

  if (state.localStream) {
    state.localStream.getTracks().forEach(t => state.pc.addTrack(t, state.localStream));
  }

  state.pc.ontrack = (e) => {
    const rv = document.getElementById('remote-video');
    if (rv && e.streams[0]) { rv.srcObject = e.streams[0]; hidePlaceholder(true); }
  };

  state.pc.onicecandidate = (e) => {
    if (e.candidate) state.socket.emit('signal', e.candidate);
  };

  state.pc.oniceconnectionstatechange = () => {
    if (state.pc?.iceConnectionState === 'failed') state.pc.restartIce();
  };
}

async function createOffer() {
  try {
    const offer = await state.pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true });
    await state.pc.setLocalDescription(offer);
    state.socket.emit('signal', state.pc.localDescription);
  } catch (e) {}
}

async function handleSignal(data) {
  if (!state.pc) await initPeerConnection();
  try {
    if (data.type === 'offer') {
      await state.pc.setRemoteDescription(new RTCSessionDescription(data));
      const answer = await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);
      state.socket.emit('signal', state.pc.localDescription);
    } else if (data.type === 'answer') {
      await state.pc.setRemoteDescription(new RTCSessionDescription(data));
    } else if (data.candidate) {
      await state.pc.addIceCandidate(new RTCIceCandidate(data));
    }
  } catch (e) { console.error('Signal:', e); }
}

function closePeer() {
  if (state.pc) { state.pc.close(); state.pc = null; }
  state.spectatorPCs.forEach(pc => pc.close());
  state.spectatorPCs.clear();
  const rv = document.getElementById('remote-video');
  if (rv) rv.srcObject = null;
}

// ── SPECTATOR ─ Создать соединение для наблюдателя ──
async function createSpectatorConnection(spectatorId) {
  try {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    state.spectatorPCs.set(spectatorId, pc);

    // Передаём наши треки (только отправка)
    if (state.localStream) {
      state.localStream.getTracks().forEach(t => pc.addTrack(t, state.localStream));
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) state.socket.emit('spectator:signal', { spectatorId, data: e.candidate });
    };

    const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
    await pc.setLocalDescription(offer);
    state.socket.emit('spectator:signal', { spectatorId, data: pc.localDescription });
  } catch (e) {}
}

// ── СООБЩЕНИЯ ─────────────────────────────────────
function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input?.value?.trim();
  if (!text || !state.connected) return;
  addMessage(text, 'own', state.profile.nickname);
  input.value = '';
  state.socket.emit('message', { text });
}

function addMessage(text, side, from) {
  const wrap = document.getElementById('messages-wrap');
  if (!wrap) return;
  const div = document.createElement('div');
  div.className = `message ${side}`;
  const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const name = from ? `<div class="msg-author">${escapeHtml(from)}</div>` : '';
  div.innerHTML = `${name}<div class="message-bubble">${escapeHtml(text)}</div><div class="message-time">${time}</div>`;
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
}

function addSystemMessage(text) {
  const wrap = document.getElementById('messages-wrap');
  if (!wrap) return;
  const div = document.createElement('div');
  div.className = 'system-msg';
  div.textContent = text;
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
}

function clearMessages() {
  const wrap = document.getElementById('messages-wrap');
  if (wrap) wrap.innerHTML = '';
}

function handleMsgKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

function reportUser() { showPage('report-page'); }

function submitReport() {
  const type = document.getElementById('report-type')?.value || 'Неприемлемый контент';
  const description = document.getElementById('report-desc')?.value || '';
  state.socket.emit('report', { type, description });
}

// ── UI ────────────────────────────────────────────
function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}

function setStatus(type, text) {
  const dot = document.getElementById('status-dot');
  const lbl = document.getElementById('status-text');
  if (dot) dot.className = `status-dot ${type}`;
  if (lbl) lbl.textContent = text;
}

function hidePlaceholder(hide) {
  const ph = document.getElementById('remote-placeholder');
  if (ph) ph.style.display = hide ? 'none' : 'flex';
}
function setPlaceholderText(t) {
  const el = document.getElementById('placeholder-text');
  if (el) el.textContent = t;
}
function showStrangerBadge() {
  document.getElementById('stranger-badge').style.display = 'flex';
}
function hideStrangerBadge() {
  document.getElementById('stranger-badge').style.display = 'none';
}
function disableReport(d) {
  const b = document.getElementById('btn-report');
  if (b) b.disabled = d;
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
  const sec = Math.floor((Date.now() - state.chatStartTime) / 1000);
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  document.getElementById('chat-timer').textContent = `${m}:${s}`;
}

// ── НАСТРОЙКИ ─────────────────────────────────────
function toggleSettings() { document.getElementById('settings-panel')?.classList.toggle('open'); }
function changeTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('spintalk-theme', t);
}
function loadTheme() {
  const s = localStorage.getItem('spintalk-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', s);
  const sel = document.getElementById('theme-select');
  if (sel) sel.value = s;
}

let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
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
