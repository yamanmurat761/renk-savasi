// Renk Savaşı — PeerJS (WebRTC) ile 4 kişilik çok oyunculu alan kapma oyunu.
// Odayı kuran oyuncu "host" olur: oyunu simüle eder, diğerleri girdilerini gönderir.

const PREFIX = 'renksavasi-v1-';
const W = 40, H = 26;
const GAME_TIME = 90;
const TICK_MS = 1000 / 30;
const SPEED = 6, BOOST_SPEED = 10, BOOST_TIME = 4;
const BOMB_RADIUS = 3.2;
const MAX_PICKUPS = 3;
const COLORS = ['#ff4d6d', '#4dabff', '#4dff88', '#ffd84d'];
const SPAWNS = [[2.5, 2.5], [W - 2.5, H - 2.5], [W - 2.5, 2.5], [2.5, H - 2.5]];
const BOT_NAMES = ['Bot Ayşe', 'Bot Mehmet', 'Bot Zeynep', 'Bot Can'];

const $ = (id) => document.getElementById(id);

let peer = null;
let isHost = false;
let myIndex = -1;
let hostConn = null;      // istemci tarafı: host bağlantısı
let roomCode = '';

// Host durumu
let slots = [null, null, null, null]; // {kind:'local'|'remote'|'bot', name, conn, input}
let game = null;
let tickTimer = null;

// Ekranda çizilen durum (host ve istemci için aynı)
let view = null;

// ---------- Ekranlar ----------
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  if (id === 'game') resize();
}

function myName() {
  const n = $('nameInput').value.trim().slice(0, 12) || 'Oyuncu';
  try { localStorage.setItem('rs-name', n); } catch (e) {}
  return n;
}

function setMsg(id, text) { $(id).textContent = text; }

function randomCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < 4; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

function resetAll() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  if (peer) { try { peer.destroy(); } catch (e) {} }
  peer = null; hostConn = null; isHost = false; myIndex = -1;
  slots = [null, null, null, null]; game = null; view = null;
  $('endOverlay').classList.add('hidden');
  show('menu');
}

// ---------- Host ----------
function createRoom(attempt = 0) {
  if (typeof Peer === 'undefined') return setMsg('menuMsg', 'PeerJS yüklenemedi, internet bağlantını kontrol et.');
  setMsg('menuMsg', 'Oda kuruluyor...');
  roomCode = randomCode();
  peer = new Peer(PREFIX + roomCode);
  peer.on('open', () => {
    isHost = true;
    myIndex = 0;
    slots = [{ kind: 'local', name: myName(), input: { dx: 0, dy: 0 } }, null, null, null];
    setMsg('menuMsg', '');
    enterLobby();
    broadcastLobby();
  });
  peer.on('connection', onIncoming);
  peer.on('error', (err) => {
    if (err.type === 'unavailable-id' && attempt < 5) {
      peer.destroy();
      createRoom(attempt + 1);
    } else if (!isHost) {
      setMsg('menuMsg', 'Bağlantı hatası: ' + err.type);
    }
  });
}

function onIncoming(conn) {
  conn.on('data', (msg) => {
    if (msg.t === 'hello') {
      const free = slots.findIndex((s) => s === null || s.kind === 'bot');
      if (game || free === -1) {
        conn.send({ t: 'reject', reason: game ? 'Oyun zaten başladı.' : 'Oda dolu.' });
        setTimeout(() => conn.close(), 300);
        return;
      }
      slots[free] = { kind: 'remote', name: String(msg.name || 'Oyuncu').slice(0, 12), conn, input: { dx: 0, dy: 0 } };
      broadcastLobby();
    } else if (msg.t === 'input') {
      const s = slots.find((x) => x && x.conn === conn);
      if (s) s.input = { dx: clamp(+msg.dx || 0, -1, 1), dy: clamp(+msg.dy || 0, -1, 1) };
    }
  });
  conn.on('close', () => {
    const i = slots.findIndex((x) => x && x.conn === conn);
    if (i === -1) return;
    if (game) {
      // Oyun sırasında çıkan oyuncunun yerine bot geçer
      slots[i] = { kind: 'bot', name: slots[i].name + ' (bot)', input: { dx: 0, dy: 0 } };
      game.players[i].name = slots[i].name;
    } else {
      slots[i] = null;
      broadcastLobby();
    }
  });
}

function lobbyInfo() {
  return slots.map((s) => (s ? { name: s.name, kind: s.kind === 'local' ? 'host' : s.kind } : null));
}

function broadcastLobby() {
  const players = lobbyInfo();
  slots.forEach((s, i) => {
    if (s && s.kind === 'remote' && s.conn.open) s.conn.send({ t: 'lobby', players, you: i, code: roomCode });
  });
  renderLobby(players);
}

function sendAll(msg) {
  slots.forEach((s) => { if (s && s.kind === 'remote' && s.conn.open) s.conn.send(msg); });
}

function addBot() {
  const i = slots.indexOf(null);
  if (i === -1) return;
  slots[i] = { kind: 'bot', name: BOT_NAMES[i], input: { dx: 0, dy: 0 } };
  broadcastLobby();
}

function removeSlot(i) {
  const s = slots[i];
  if (!s || s.kind === 'local') return;
  if (s.kind === 'remote') { s.conn.send({ t: 'reject', reason: 'Odadan çıkarıldın.' }); setTimeout(() => s.conn.close(), 300); }
  slots[i] = null;
  broadcastLobby();
}

function startGame() {
  const active = slots.filter(Boolean).length;
  if (active < 2) return setMsg('lobbyMsg', 'En az 2 oyuncu gerekli (bot ekleyebilirsin).');
  game = {
    grid: new Uint8Array(W * H),
    changed: [],
    pickups: [],
    pickupTimer: 2,
    timeLeft: GAME_TIME,
    players: slots.map((s, i) => s && {
      x: SPAWNS[i][0], y: SPAWNS[i][1], boost: 0, name: s.name,
      bot: { tx: SPAWNS[i][0], ty: SPAWNS[i][1], t: 0 },
    }),
  };
  slots.forEach((s) => { if (s) s.input = { dx: 0, dy: 0 }; });
  const msg = { t: 'start', grid: Array.from(game.grid), players: game.players.map((p) => p && { name: p.name, x: p.x, y: p.y }) };
  sendAll(msg);
  handleMessage(msg);
  let last = performance.now();
  tickTimer = setInterval(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    tick(dt);
  }, TICK_MS);
}

function paint(i, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= W || ty >= H) return;
  const idx = ty * W + tx;
  if (game.grid[idx] !== i + 1) {
    game.grid[idx] = i + 1;
    game.changed.push(idx, i + 1);
  }
}

function tick(dt) {
  const g = game;
  g.timeLeft -= dt;

  // Güçlendirici üret
  g.pickupTimer -= dt;
  if (g.pickupTimer <= 0 && g.pickups.length < MAX_PICKUPS) {
    g.pickupTimer = 3 + Math.random() * 3;
    g.pickups.push({ x: 3 + Math.random() * (W - 6), y: 3 + Math.random() * (H - 6), k: Math.random() < 0.5 ? 'b' : 'h' });
  }

  g.players.forEach((p, i) => {
    if (!p) return;
    const s = slots[i];
    let { dx, dy } = s.kind === 'bot' ? botInput(p, i, dt) : s.input;
    const len = Math.hypot(dx, dy);
    if (len > 0) { dx /= len; dy /= len; }
    p.boost = Math.max(0, p.boost - dt);
    const sp = p.boost > 0 ? BOOST_SPEED : SPEED;
    p.x = clamp(p.x + dx * sp * dt, 0.4, W - 0.4);
    p.y = clamp(p.y + dy * sp * dt, 0.4, H - 0.4);
  });

  // Oyuncular birbirini iter
  for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
    const p = g.players[a], q = g.players[b];
    if (!p || !q) continue;
    const dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy);
    if (d > 0 && d < 0.9) {
      const push = (0.9 - d) / 2;
      p.x -= dx / d * push; p.y -= dy / d * push;
      q.x += dx / d * push; q.y += dy / d * push;
    }
  }

  g.players.forEach((p, i) => {
    if (!p) return;
    paint(i, Math.floor(p.x), Math.floor(p.y));
    for (let k = g.pickups.length - 1; k >= 0; k--) {
      const pk = g.pickups[k];
      if (Math.hypot(pk.x - p.x, pk.y - p.y) < 0.9) {
        g.pickups.splice(k, 1);
        if (pk.k === 'h') p.boost = BOOST_TIME;
        else {
          const r = Math.ceil(BOMB_RADIUS);
          for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
            if (x * x + y * y <= BOMB_RADIUS * BOMB_RADIUS) paint(i, Math.floor(p.x) + x, Math.floor(p.y) + y);
          }
        }
      }
    }
  });

  const scores = [0, 0, 0, 0];
  for (let k = 0; k < g.grid.length; k++) if (g.grid[k]) scores[g.grid[k] - 1]++;

  const msg = {
    t: 'state',
    p: g.players.map((p) => p && [round2(p.x), round2(p.y), p.boost > 0 ? 1 : 0, p.name]),
    d: g.changed,
    pk: g.pickups.map((pk) => [round2(pk.x), round2(pk.y), pk.k]),
    tl: Math.max(0, g.timeLeft),
    sc: scores,
  };
  g.changed = [];
  sendAll(msg);
  handleMessage(msg);

  if (g.timeLeft <= 0) {
    clearInterval(tickTimer);
    tickTimer = null;
    const end = { t: 'end', sc: scores, names: g.players.map((p) => p && p.name) };
    game = null;
    sendAll(end);
    handleMessage(end);
  }
}

function botInput(p, i, dt) {
  const b = p.bot;
  b.t -= dt;
  if (b.t <= 0 || Math.hypot(b.tx - p.x, b.ty - p.y) < 0.5) {
    b.t = 1 + Math.random() * 1.5;
    if (game.pickups.length && Math.random() < 0.35) {
      const pk = game.pickups[Math.floor(Math.random() * game.pickups.length)];
      b.tx = pk.x; b.ty = pk.y;
    } else {
      // Yakındaki, kendi rengi olmayan bir kare seç
      let best = null, bestD = Infinity;
      for (let n = 0; n < 12; n++) {
        const tx = Math.floor(Math.random() * W), ty = Math.floor(Math.random() * H);
        if (game.grid[ty * W + tx] === i + 1) continue;
        const d = Math.hypot(tx - p.x, ty - p.y) + Math.random() * 6;
        if (d < bestD) { bestD = d; best = [tx + 0.5, ty + 0.5]; }
      }
      if (best) { b.tx = best[0]; b.ty = best[1]; }
    }
  }
  return { dx: b.tx - p.x, dy: b.ty - p.y };
}

// ---------- İstemci ----------
function joinRoom(code) {
  if (typeof Peer === 'undefined') return setMsg('menuMsg', 'PeerJS yüklenemedi, internet bağlantını kontrol et.');
  code = code.trim().toUpperCase();
  if (code.length !== 4) return setMsg('menuMsg', 'Oda kodu 4 harf olmalı.');
  setMsg('menuMsg', 'Bağlanılıyor...');
  roomCode = code;
  peer = new Peer();
  let opened = false;
  peer.on('open', () => {
    hostConn = peer.connect(PREFIX + code, { reliable: true });
    hostConn.on('open', () => {
      opened = true;
      hostConn.send({ t: 'hello', name: myName() });
    });
    hostConn.on('data', handleMessage);
    hostConn.on('close', () => {
      if (!peer) return;
      resetAll();
      setMsg('menuMsg', opened ? 'Odayla bağlantı koptu.' : 'Odaya bağlanılamadı.');
    });
  });
  peer.on('error', (err) => {
    const text = err.type === 'peer-unavailable' ? 'Bu kodla bir oda bulunamadı.' : 'Bağlantı hatası: ' + err.type;
    resetAll();
    setMsg('menuMsg', text);
  });
}

// ---------- Ortak mesaj işleme ----------
function handleMessage(msg) {
  switch (msg.t) {
    case 'reject':
      resetAll();
      setMsg('menuMsg', msg.reason);
      break;
    case 'lobby':
      myIndex = msg.you;
      roomCode = msg.code;
      $('endOverlay').classList.add('hidden');
      enterLobby();
      renderLobby(msg.players);
      break;
    case 'start':
      view = {
        grid: Uint8Array.from(msg.grid),
        players: msg.players.map((p) => p && { name: p.name, x: p.x, y: p.y, rx: p.x, ry: p.y, boost: 0 }),
        pickups: [], timeLeft: GAME_TIME, scores: [0, 0, 0, 0],
      };
      $('endOverlay').classList.add('hidden');
      show('game');
      break;
    case 'state':
      if (!view) return;
      for (let k = 0; k < msg.d.length; k += 2) view.grid[msg.d[k]] = msg.d[k + 1];
      msg.p.forEach((p, i) => {
        const v = view.players[i];
        if (!p || !v) return;
        v.x = p[0]; v.y = p[1]; v.boost = p[2]; v.name = p[3];
      });
      view.pickups = msg.pk;
      view.timeLeft = msg.tl;
      view.scores = msg.sc;
      break;
    case 'end':
      showEnd(msg);
      break;
  }
}

// ---------- Arayüz ----------
function enterLobby() {
  show('lobby');
  $('roomCode').textContent = roomCode;
  $('hostControls').classList.toggle('hidden', !isHost);
}

function renderLobby(players) {
  const ul = $('playerList');
  ul.innerHTML = '';
  players.forEach((p, i) => {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = COLORS[i];
    li.appendChild(dot);
    if (!p) {
      li.classList.add('empty');
      li.appendChild(document.createTextNode('Boş yer'));
    } else {
      li.appendChild(document.createTextNode(p.name + (i === myIndex ? ' (sen)' : '')));
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = p.kind === 'host' ? 'kurucu' : p.kind === 'bot' ? 'bot' : 'oyuncu';
      li.appendChild(tag);
      if (isHost && p.kind !== 'host') {
        const x = document.createElement('button');
        x.className = 'kick';
        x.textContent = '✕';
        x.title = 'Çıkar';
        x.onclick = () => removeSlot(i);
        li.appendChild(x);
      }
    }
    ul.appendChild(li);
  });
  const count = players.filter(Boolean).length;
  if (isHost) {
    $('addBotBtn').disabled = count >= 4;
    $('startBtn').disabled = count < 2;
    setMsg('lobbyMsg', count < 2 ? 'Arkadaşlarına oda kodunu gönder ya da bot ekle.' : count + '/4 oyuncu hazır.');
  } else {
    setMsg('lobbyMsg', count + '/4 oyuncu — kurucunun başlatması bekleniyor...');
  }
}

function showEnd(msg) {
  const order = msg.sc.map((s, i) => ({ s, i, name: msg.names[i] })).filter((r) => r.name).sort((a, b) => b.s - a.s);
  const top = order[0];
  const tie = order.length > 1 && order[1].s === top.s;
  $('winnerText').textContent = tie ? 'Berabere!' : (top.i === myIndex ? '🏆 Kazandın!' : '🏆 ' + top.name + ' kazandı!');
  $('winnerText').style.color = tie ? '#fff' : COLORS[top.i];
  const ol = $('finalScores');
  ol.innerHTML = '';
  const total = W * H;
  order.forEach((r, n) => {
    const li = document.createElement('li');
    li.innerHTML = '<span class="dot" style="background:' + COLORS[r.i] + '"></span>';
    li.appendChild(document.createTextNode((n + 1) + '. ' + r.name));
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = r.s + ' kare (%' + Math.round(r.s / total * 100) + ')';
    li.appendChild(tag);
    ol.appendChild(li);
  });
  $('againBtn').classList.toggle('hidden', !isHost);
  $('waitHostMsg').classList.toggle('hidden', isHost);
  $('endOverlay').classList.remove('hidden');
}

// ---------- Girdi ----------
const keys = { up: false, down: false, left: false, right: false };
const KEYMAP = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
let lastInput = '';

function updateInput() {
  const dx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const dy = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
  const sig = dx + ',' + dy;
  if (sig === lastInput) return;
  lastInput = sig;
  if (isHost && slots[0]) slots[0].input = { dx, dy };
  else if (hostConn && hostConn.open) hostConn.send({ t: 'input', dx, dy });
}

window.addEventListener('keydown', (e) => {
  const k = KEYMAP[e.code];
  if (!k || document.activeElement.tagName === 'INPUT') return;
  e.preventDefault();
  keys[k] = true;
  updateInput();
});
window.addEventListener('keyup', (e) => {
  const k = KEYMAP[e.code];
  if (!k) return;
  keys[k] = false;
  updateInput();
});
window.addEventListener('blur', () => { Object.keys(keys).forEach((k) => (keys[k] = false)); updateInput(); });

document.querySelectorAll('#pad button').forEach((btn) => {
  const k = btn.dataset.k;
  const set = (v) => (e) => { e.preventDefault(); keys[k] = v; btn.classList.toggle('on', v); updateInput(); };
  btn.addEventListener('pointerdown', set(true));
  btn.addEventListener('pointerup', set(false));
  btn.addEventListener('pointercancel', set(false));
  btn.addEventListener('pointerleave', set(false));
});

// ---------- Çizim ----------
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
let tile = 20;

function resize() {
  const stage = $('stage');
  const r = stage.getBoundingClientRect();
  tile = Math.max(6, Math.floor(Math.min(r.width / W, r.height / H)));
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = tile * W + 'px';
  canvas.style.height = tile * H + 'px';
  canvas.width = tile * W * dpr;
  canvas.height = tile * H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (view && $('game').classList.contains('active')) draw(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function draw(dt) {
  const t = tile;
  ctx.fillStyle = '#151a2c';
  ctx.fillRect(0, 0, W * t, H * t);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = view.grid[y * W + x];
    if (c) {
      ctx.fillStyle = COLORS[c - 1];
      ctx.globalAlpha = 0.75;
      ctx.fillRect(x * t, y * t, t, t);
      ctx.globalAlpha = 1;
    } else if ((x + y) % 2) {
      ctx.fillStyle = '#1a2036';
      ctx.fillRect(x * t, y * t, t, t);
    }
  }

  // Güçlendiriciler
  const pulse = 1 + Math.sin(performance.now() / 180) * 0.08;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = Math.round(t * 1.1 * pulse) + 'px sans-serif';
  view.pickups.forEach(([x, y, k]) => {
    ctx.fillStyle = 'rgba(255,255,255,.18)';
    ctx.beginPath(); ctx.arc(x * t, y * t, t * 0.75, 0, Math.PI * 2); ctx.fill();
    ctx.fillText(k === 'h' ? '⚡' : '💣', x * t, y * t + 1);
  });

  // Oyuncular (yumuşak geçiş)
  const lerp = Math.min(1, dt * 18);
  view.players.forEach((p, i) => {
    if (!p) return;
    p.rx += (p.x - p.rx) * lerp;
    p.ry += (p.y - p.ry) * lerp;
    const cx = p.rx * t, cy = p.ry * t;
    if (p.boost) { ctx.shadowColor = COLORS[i]; ctx.shadowBlur = t; }
    ctx.fillStyle = COLORS[i];
    ctx.beginPath(); ctx.arc(cx, cy, t * 0.55, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = Math.max(2, t * 0.12);
    ctx.strokeStyle = i === myIndex ? '#fff' : '#0e1120';
    ctx.stroke();
    ctx.font = 'bold ' + Math.max(10, Math.round(t * 0.6)) + 'px system-ui, sans-serif';
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.lineWidth = 3;
    ctx.strokeText(p.name, cx, cy - t * 1.1);
    ctx.fillText(p.name, cx, cy - t * 1.1);
  });

  // HUD
  const secs = Math.ceil(view.timeLeft);
  $('timer').textContent = secs;
  $('timer').classList.toggle('low', secs <= 10);
  const sc = $('scores');
  const html = view.players.map((p, i) => p ? '<div class="score" style="border-color:' + COLORS[i] + '"><span class="dot" style="background:' + COLORS[i] + '"></span>' + escapeHtml(p.name) + ' <b>' + view.scores[i] + '</b></div>' : '').join('');
  if (sc.innerHTML !== html) sc.innerHTML = html;
}

// ---------- Yardımcılar ----------
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function round2(v) { return Math.round(v * 100) / 100; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- Düğmeler ----------
$('createBtn').onclick = () => createRoom();
$('joinBtn').onclick = () => joinRoom($('codeInput').value);
$('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom($('codeInput').value); });
$('addBotBtn').onclick = addBot;
$('startBtn').onclick = startGame;
$('leaveBtn').onclick = resetAll;
$('againBtn').onclick = () => { $('endOverlay').classList.add('hidden'); broadcastLobby(); enterLobby(); };
$('copyBtn').onclick = () => {
  const url = location.origin + location.pathname + '?oda=' + roomCode;
  navigator.clipboard.writeText(url).then(() => setMsg('lobbyMsg', 'Davet bağlantısı kopyalandı!'), () => setMsg('lobbyMsg', url));
};

try { $('nameInput').value = localStorage.getItem('rs-name') || ''; } catch (e) {}
const urlCode = new URLSearchParams(location.search).get('oda');
if (urlCode) $('codeInput').value = urlCode.toUpperCase().slice(0, 4);
