/* ========== СПИСОК СЕРВЕРОВ (если один падает, переключается на другой) ========== */
const PEER_SERVERS = [
  { host: '0.peerjs.com', port: 443, path: '/', secure: true },
  { host: 'pe1.peerjs.com', port: 443, path: '/', secure: true },
  { host: 'pe2.peerjs.com', port: 443, path: '/', secure: true },
  { host: 'peerjs-server.onrender.com', port: 443, path: '/', secure: true },
];

/* ========== КОНСТАНТЫ ИГРЫ ========== */
const SIZE = 10;
const FLEET = [
  { len: 4, count: 1 },
  { len: 3, count: 2 },
  { len: 2, count: 3 },
  { len: 1, count: 4 }
];

/* ========== СОСТОЯНИЕ ========== */
const state = {
  peer: null,
  conn: null,
  isHost: false,
  myId: null,
  roomCode: null,
  myBoard: [],
  myShotsOnEnemy: [],
  enemyShotsOnMe: [],
  ships: [],
  placingShip: null,
  horizontal: true,
  placedHistory: [],
  myReady: false,
  enemyReady: false,
  gameState: 'menu',
  myTurn: false,
  pendingShot: null,
  heartbeatTimer: null,
  reconnectAttempts: 0,
  currentServerIdx: 0
};

/* ========== УТИЛИТЫ ========== */
const $ = id => document.getElementById(id);
const rand = n => Math.floor(Math.random() * n);

const generateCode = () => {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[rand(chars.length)];
  return s;
};

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

function log(msg, type = 'info') {
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

function setServerStatus(text, color = '#95a5a6') {
  const el = $('server-status');
  if (el) {
    el.textContent = text;
    el.style.color = color;
  }
}

function setConnStatus(ok) {
  const els = [$('conn-indicator'), $('conn-indicator-battle')];
  els.forEach(el => {
    if (!el) return;
    el.textContent = ok ? '🟢 Онлайн' : '🔴 Соединение потеряно!';
    el.style.color = ok ? '#2ecc71' : '#e74c3c';
    el.style.backgroundColor = ok ? 'rgba(46,204,113,0.1)' : 'rgba(231,76,60,0.1)';
  });
}

/* ========== ЗВУКИ ========== */
let audioCtx;
function beep(freq, dur = 0.1, type = 'sine', vol = 0.1) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + dur);
  } catch (e) {}
}

const sfx = {
  shot: () => beep(180, 0.08, 'square', 0.15),
  hit: () => { beep(80, 0.2, 'sawtooth', 0.2); setTimeout(() => beep(60, 0.25, 'sawtooth', 0.15), 80); },
  miss: () => beep(400, 0.15, 'sine', 0.1),
  sunk: () => {
    beep(120, 0.15, 'square', 0.2);
    setTimeout(() => beep(90, 0.2, 'square', 0.2), 100);
    setTimeout(() => beep(60, 0.4, 'sawtooth', 0.2), 250);
  },
  win: () => [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => beep(f, 0.2, 'sine', 0.15), i * 150)),
  lose: () => [392, 330, 262, 196].forEach((f, i) => setTimeout(() => beep(f, 0.25, 'sine', 0.15), i * 200))
};

/* ========== СОЗДАНИЕ PEER С FALLBACK ========== */
function createPeer(id = null) {
  return new Promise((resolve, reject) => {
    const tryServer = (idx) => {
      if (idx >= PEER_SERVERS.length) {
        reject(new Error('Все серверы недоступны. Попробуйте позже или используйте VPN.'));
        return;
      }

      const server = PEER_SERVERS[idx];
      setServerStatus(`🔌 Сервер ${idx + 1}/${PEER_SERVERS.length}: ${server.host}`, '#f39c12');
      log(`Пробуем сервер: ${server.host}`);

      const peer = id ? new Peer(id, server) : new Peer(server);

      const timeout = setTimeout(() => {
        peer.destroy();
        log(`Таймаут: ${server.host}`, 'warn');
        tryServer(idx + 1);
      }, 8000);

      peer.on('open', (peerId) => {
        clearTimeout(timeout);
        state.myId = peerId;
        state.currentServerIdx = idx;
        setServerStatus(`✅ Сервер: ${server.host}`, '#2ecc71');
        log(`Подключено к ${server.host} как ${peerId}`);
        resolve(peer);
      });

      peer.on('error', (err) => {
        clearTimeout(timeout);
        log(`Ошибка ${server.host}: ${err.type} - ${err.message}`, 'error');

        const fatalErrors = ['network', 'server-error', 'ssl-unavailable', 'socket-error', 'socket-closed'];
        if (fatalErrors.includes(err.type) || err.type === 'unavailable-id') {
          peer.destroy();
          setTimeout(() => tryServer(idx + 1), 500);
        } else {
          // Не фатальная ошибка - оставляем peer
          state.myId = peer.id;
          state.currentServerIdx = idx;
          setServerStatus(`✅ Сервер: ${server.host}`, '#2ecc71');
          resolve(peer);
        }
      });
    };

    tryServer(0);
  });
}

/* ========== HEARTBEAT (проверка связи) ========== */
function startHeartbeat() {
  stopHeartbeat();
  state.heartbeatTimer = setInterval(() => {
    if (state.conn && state.conn.open) {
      try {
        state.conn.send({ type: 'ping', t: Date.now() });
      } catch (e) {
        handleDisconnect();
      }
    } else {
      handleDisconnect();
    }
  }, 4000);
}

function stopHeartbeat() {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}

let disconnectShown = false;
function handleDisconnect() {
  if (disconnectShown) return;
  disconnectShown = true;
  stopHeartbeat();
  setConnStatus(false);
  log('Соединение потеряно!', 'error');

  if (state.gameState === 'placing' || state.gameState === 'battle') {
    setTimeout(() => {
      if (confirm('❌ Соединение с соперником потеряно.\nВернуться в меню?')) {
        location.reload();
      } else {
        disconnectShown = false;
      }
    }, 300);
  }
}

/* ========== МЕНЮ: СОЗДАНИЕ ========== */
$('btn-create').onclick = async () => {
  $('btn-create').disabled = true;
  $('btn-join').disabled = true;

  const code = generateCode();
  state.isHost = true;
  state.roomCode = code;

  setServerStatus('🔌 Поиск сервера...', '#f39c12');
  $('room-code-display').textContent = code.toUpperCase();
  $('room-info').classList.remove('hidden');

  try {
    // Создаём peer с ID комнаты (с fallback)
    state.peer = await createPeer('bs-' + code);

    $('room-status').textContent = '⏳ Ожидание соперника...';

    state.peer.on('connection', (conn) => {
      if (state.conn) { conn.close(); return; }
      state.conn = conn;
      setupConn(conn);
      $('room-status').textContent = '✅ Соперник найден!';
    });

    state.peer.on('error', (err) => {
      log(`Peer error: ${err.type}`, 'error');

      if (err.type === 'unavailable-id') {
        state.peer.destroy();
        setTimeout(() => $('btn-create').click(), 100);
      } else if (err.type === 'peer-unavailable') {
        // Игнорируем
      } else if (err.type === 'network' || err.type === 'disconnected') {
        // Попробуем переподключиться
        if (!state.conn || !state.conn.open) {
          reconnectPeer();
        }
      }
    });

    state.peer.on('disconnected', () => {
      log('Peer отключился, переподключаемся...', 'warn');
      if (state.peer && !state.peer.destroyed) {
        setTimeout(() => {
          if (state.peer && !state.peer.destroyed) {
            state.peer.reconnect();
          }
        }, 1000);
      }
    });

  } catch (err) {
    alert('❌ Ошибка подключения:\n' + err.message);
    $('btn-create').disabled = false;
    $('btn-join').disabled = false;
    $('room-info').classList.add('hidden');
    setServerStatus('❌ Ошибка', '#e74c3c');
  }
};

/* ========== МЕНЮ: ПРИСОЕДИНЕНИЕ ========== */
$('btn-join').onclick = async () => {
  const code = $('input-code').value.trim().toLowerCase();
  if (code.length !== 6) {
    alert('Введите 6-символьный код');
    return;
  }

  $('btn-create').disabled = true;
  $('btn-join').disabled = true;
  state.isHost = false;
  state.roomCode = code;

  setServerStatus('🔌 Поиск сервера...', '#f39c12');
  $('room-code-display').textContent = code.toUpperCase();
  $('room-info').classList.remove('hidden');
  $('room-status').textContent = '🔄 Подключение...';

  try {
    state.peer = await createPeer();

    $('room-status').textContent = '🔄 Ищем комнату...';

    // Подключаемся с retry
    const tryConnect = async (attempt = 1) => {
      try {
        state.conn = state.peer.connect('bs-' + code, { reliable: true });
        setupConn(state.conn);

        // Таймаут ожидания ответа
        await new Promise((resolve) => {
          const t = setTimeout(() => {
            if (!state.conn.open && attempt < 3) {
              log(`Попытка ${attempt} неудачна, пробуем ещё раз...`, 'warn');
              state.conn.close();
              tryConnect(attempt + 1);
            }
            resolve();
          }, 5000);

          state.conn.once('open', () => {
            clearTimeout(t);
            resolve();
          });
        });
      } catch (e) {
        log(`Ошибка подключения: ${e}`, 'error');
        if (attempt < 3) tryConnect(attempt + 1);
      }
    };

    await tryConnect();

    state.peer.on('error', (err) => {
      log(`Peer error: ${err.type}`, 'error');

      if (err.type === 'peer-unavailable') {
        alert('❌ Комната не найдена. Проверь код.');
        $('btn-create').disabled = false;
        $('btn-join').disabled = false;
        $('room-info').classList.add('hidden');
      } else if (err.type === 'network' || err.type === 'disconnected') {
        if (!state.conn || !state.conn.open) {
          reconnectPeer();
        }
      }
    });

    state.peer.on('disconnected', () => {
      log('Peer отключился, переподключаемся...', 'warn');
      if (state.peer && !state.peer.destroyed) {
        setTimeout(() => {
          if (state.peer && !state.peer.destroyed) {
            state.peer.reconnect();
          }
        }, 1000);
      }
    });

  } catch (err) {
    alert('❌ Ошибка подключения:\n' + err.message);
    $('btn-create').disabled = false;
    $('btn-join').disabled = false;
    $('room-info').classList.add('hidden');
    setServerStatus('❌ Ошибка', '#e74c3c');
  }
};

/* ========== ПЕРЕПОДКЛЮЧЕНИЕ ========== */
async function reconnectPeer() {
  if (state.reconnectAttempts >= 5) {
    handleDisconnect();
    return;
  }
  state.reconnectAttempts++;
  log(`Переподключение #${state.reconnectAttempts}...`, 'warn');
  setServerStatus(`🔄 Переподключение #${state.reconnectAttempts}...`, '#f39c12');

  setTimeout(() => {
    if (state.peer && !state.peer.destroyed) {
      state.peer.reconnect();
    }
  }, 2000 * state.reconnectAttempts);
}

$('btn-copy').onclick = () => {
  navigator.clipboard.writeText(state.roomCode.toUpperCase());
  $('btn-copy').textContent = '✅ Скопировано';
  setTimeout(() => $('btn-copy').textContent = '📋 Копировать код', 1500);
};

/* ========== СОЕДИНЕНИЕ ========== */
function setupConn(conn) {
  conn.on('open', () => {
    $('room-status').textContent = '✅ Подключено!';
    state.reconnectAttempts = 0;
    disconnectShown = false;
    setConnStatus(true);
    startHeartbeat();
    setTimeout(() => startPlacing(), 400);
  });

  conn.on('data', handleMessage);

  conn.on('close', () => {
    log('Соединение закрыто', 'warn');
    handleDisconnect();
  });

  conn.on('error', (e) => {
    log(`Ошибка соединения: ${e}`, 'error');
    handleDisconnect();
  });
}

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'ping':
      if (state.conn && state.conn.open) {
        try { state.conn.send({ type: 'pong', t: msg.t }); } catch (e) {}
      }
      break;
    case 'pong':
      // heartbeat ok
      break;
    case 'ready':
      state.enemyReady = true;
      checkBothReady();
      break;
    case 'shot':
      handleIncomingShot(msg);
      break;
    case 'shot-result':
      handleShotResult(msg);
      break;
    case 'rematch':
      resetForRematch();
      break;
    case 'bye':
      log('Соперник вышел', 'warn');
      handleDisconnect();
      break;
  }
}

/* ========== РАССТАНОВКА ========== */
function startPlacing() {
  if (state.gameState === 'placing') return;
  state.gameState = 'placing';
  showScreen('screen-place');

  state.myBoard = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  state.ships = [];
  state.placingShip = null;
  state.horizontal = true;
  state.placedHistory = [];
  state.myReady = false;
  state.enemyReady = false;
  state.myTurn = state.isHost;

  buildShipsList();
  renderOwnBoard();
  renderPreviewBoard();

  $('btn-ready').disabled = true;
  $('btn-ready').textContent = '✅ Готов';
  $('place-status').textContent = state.isHost ? 'Вы — хозяин комнаты, ходите первым' : '';
}

function buildShipsList() {
  const container = $('ships-container');
  container.innerHTML = '';
  let idx = 0;
  FLEET.forEach(group => {
    for (let i = 0; i < group.count; i++) {
      state.ships.push({ len: group.len, id: idx, placed: false, cells: null });
      const div = document.createElement('div');
      div.className = 'ship-item';
      div.dataset.id = idx;
      div.innerHTML = Array(group.len).fill('<div class="cell-dot"></div>').join('');
      div.onclick = () => selectShip(idx);
      container.appendChild(div);
      idx++;
    }
  });
  selectShip(0);
}

function selectShip(idx) {
  if (state.ships[idx].placed) return;
  state.placingShip = idx;
  document.querySelectorAll('.ship-item').forEach(el => {
    el.classList.toggle('selected', +el.dataset.id === idx);
  });
}

function canPlace(board, x, y, len, horizontal) {
  for (let i = 0; i < len; i++) {
    const cx = horizontal ? x + i : x;
    const cy = horizontal ? y : y + i;
    if (cx >= SIZE || cy >= SIZE || cx < 0 || cy < 0) return false;
    if (board[cy][cx] !== 0) return false;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
        if (board[ny][nx] === 1) return false;
      }
    }
  }
  return true;
}

function placeShip(x, y) {
  if (state.placingShip === null) return;
  const ship = state.ships[state.placingShip];
  if (ship.placed) return;
  if (!canPlace(state.myBoard, x, y, ship.len, state.horizontal)) return;

  const cells = [];
  for (let i = 0; i < ship.len; i++) {
    const cx = state.horizontal ? x + i : x;
    const cy = state.horizontal ? y : y + i;
    state.myBoard[cy][cx] = 1;
    cells.push({ x: cx, y: cy });
  }
  ship.placed = true;
  ship.cells = cells;
  state.placedHistory.push(ship.id);

  document.querySelector(`.ship-item[data-id="${ship.id}"]`).classList.add('placed');
  const next = state.ships.findIndex(s => !s.placed);
  if (next >= 0) selectShip(next);
  else state.placingShip = null;

  renderOwnBoard();
  checkReady();
}

function checkReady() {
  const allPlaced = state.ships.every(s => s.placed);
  $('btn-ready').disabled = !allPlaced;
  $('place-status').textContent = allPlaced ? '✅ Все корабли расставлены!' : '';
}

function renderOwnBoard() {
  const board = $('board-own');
  board.innerHTML = '';
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const cell = document.createElement('div');
      cell.className = 'cell' + (state.myBoard[y][x] === 1 ? ' ship' : '');
      cell.onclick = () => placeShip(x, y);
      cell.onmouseenter = () => previewHover(x, y);
      cell.onmouseleave = () => clearPreview();
      board.appendChild(cell);
    }
  }
}

function previewHover(x, y) {
  if (state.placingShip === null) return;
  const ship = state.ships[state.placingShip];
  if (ship.placed) return;
  const ok = canPlace(state.myBoard, x, y, ship.len, state.horizontal);
  for (let i = 0; i < ship.len; i++) {
    const cx = state.horizontal ? x + i : x;
    const cy = state.horizontal ? y : y + i;
    if (cx >= SIZE || cy >= SIZE) continue;
    const cell = $('board-own').children[cy * SIZE + cx];
    if (cell && !cell.classList.contains('ship')) {
      cell.classList.add(ok ? 'preview-ok' : 'preview-bad');
    }
  }
}

function clearPreview() {
  document.querySelectorAll('#board-own .preview-ok, #board-own .preview-bad')
    .forEach(c => c.classList.remove('preview-ok', 'preview-bad'));
}

function renderPreviewBoard() {
  const board = $('board-preview');
  board.innerHTML = '';
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      board.appendChild(cell);
    }
}

/* ========== УПРАВЛЕНИЕ РАССТАНОВКОЙ ========== */
$('btn-rotate').onclick = () => { state.horizontal = !state.horizontal; };
document.addEventListener('keydown', e => {
  if (e.key.toLowerCase() === 'r' && state.gameState === 'placing') state.horizontal = !state.horizontal;
});

$('btn-random').onclick = () => {
  state.myBoard = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  state.placedHistory = [];
  state.placingShip = null;
  state.ships.forEach(s => {
    s.placed = false;
    s.cells = null;
  });
  document.querySelectorAll('.ship-item').forEach(el => el.classList.remove('placed'));

  FLEET.forEach(group => {
    for (let c = 0; c < group.count; c++) {
      let placed = false, attempts = 0;
      while (!placed && attempts < 1000) {
        attempts++;
        const horizontal = Math.random() < 0.5;
        const x = rand(SIZE);
        const y = rand(SIZE);
        if (canPlace(state.myBoard, x, y, group.len, horizontal)) {
          const cells = [];
          for (let i = 0; i < group.len; i++) {
            const cx = horizontal ? x + i : x;
            const cy = horizontal ? y : y + i;
            state.myBoard[cy][cx] = 1;
            cells.push({ x: cx, y: cy });
          }
          const ship = state.ships.find(s => !s.placed && s.len === group.len);
          if (ship) {
            ship.placed = true;
            ship.cells = cells;
            state.placedHistory.push(ship.id);
          }
          placed = true;
        }
      }
    }
  });

  document.querySelectorAll('.ship-item').forEach(el => el.classList.add('placed'));
  renderOwnBoard();
  checkReady();
};

$('btn-undo').onclick = () => {
  const lastId = state.placedHistory.pop();
  if (lastId === undefined) return;
  const ship = state.ships.find(s => s.id === lastId);
  if (!ship || !ship.placed) return;
  ship.cells.forEach(c => state.myBoard[c.y][c.x] = 0);
  ship.placed = false;
  ship.cells = null;
  document.querySelector(`.ship-item[data-id="${ship.id}"]`).classList.remove('placed');
  selectShip(ship.id);
  renderOwnBoard();
  checkReady();
};

$('btn-clear').onclick = () => {
  state.myBoard = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  state.placedHistory = [];
  state.placingShip = 0;
  state.ships.forEach(s => {
    s.placed = false;
    s.cells = null;
  });
  document.querySelectorAll('.ship-item').forEach(el => el.classList.remove('placed'));
  selectShip(0);
  renderOwnBoard();
  checkReady();
};

$('btn-ready').onclick = () => {
  if (!state.ships.every(s => s.placed)) return;
  state.myReady = true;
  $('btn-ready').disabled = true;
  $('place-status').textContent = '⏳ Ожидание соперника...';
  trySend({ type: 'ready' });
  checkBothReady();
};

function checkBothReady() {
  if (state.myReady && state.enemyReady && state.gameState === 'placing') {
    state.gameState = 'battle';
    enterBattle();
  }
}

/* ========== БОЙ ========== */
function enterBattle() {
  state.myShotsOnEnemy = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  state.enemyShotsOnMe = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  showScreen('screen-battle');
  renderEnemyBoard();
  renderSelfBoard();
  updateTurnIndicator();
  addLog('⚔️ Бой начался!');
}

function updateTurnIndicator() {
  const ind = $('turn-indicator');
  if (state.myTurn) {
    ind.textContent = '🎯 Ваш ход — стреляйте!';
    ind.classList.add('my-turn');
  } else {
    ind.textContent = '⏳ Ход соперника...';
    ind.classList.remove('my-turn');
  }
}

function renderEnemyBoard() {
  const board = $('board-enemy');
  board.innerHTML = '';
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      const v = state.myShotsOnEnemy[y][x];
      if (v === 1) cell.classList.add('miss');
      else if (v === 2) cell.classList.add('hit');
      else if (v === 3) cell.classList.add('sunk');
      cell.onclick = () => fire(x, y);
      board.appendChild(cell);
    }
  }
}

function renderSelfBoard() {
  const board = $('board-self');
  board.innerHTML = '';
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      if (state.myBoard[y][x] === 1) cell.classList.add('ship');
      const v = state.enemyShotsOnMe[y][x];
      if (v === 1) cell.classList.add('miss');
      else if (v === 2) cell.classList.add('hit');
      else if (v === 3) cell.classList.add('sunk');
      board.appendChild(cell);
    }
  }
}

function animateCell(boardId, x, y, cls) {
  const cell = $(boardId).children[y * SIZE + x];
  if (cell) {
    cell.classList.add(cls);
    setTimeout(() => cell.classList.remove(cls), 600);
  }
}

function addLog(msg) {
  const log = $('battle-log');
  const div = document.createElement('div');
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function showSunkRing(boardId, x, y) {
  const cell = $(boardId).children[y * SIZE + x];
  if (!cell) return;
  const ring = document.createElement('div');
  ring.className = 'sunk-ring';
  ring.style.left = '50%';
  ring.style.top = '50%';
  cell.appendChild(ring);
  setTimeout(() => ring.remove(), 900);
}

/* ========== БЕЗОПАСНАЯ ОТПРАВКА ========== */
function trySend(data) {
  if (!state.conn || !state.conn.open) {
    log('Не удалось отправить: соединение закрыто', 'warn');
    return false;
  }
  try {
    state.conn.send(data);
    return true;
  } catch (e) {
    log(`Ошибка отправки: ${e}`, 'error');
    handleDisconnect();
    return false;
  }
}

/* ========== ВЫСТРЕЛ ========== */
function fire(x, y) {
  if (!state.myTurn || state.pendingShot) return;
  if (state.myShotsOnEnemy[y][x] !== 0) return;

  sfx.shot();
  state.pendingShot = { x, y };
  trySend({ type: 'shot', x, y });

  $('turn-indicator').textContent = '⏳ Ждем ответа...';
  $('turn-indicator').classList.remove('my-turn');
}

function handleIncomingShot(msg) {
  const { x, y } = msg;
  const hit = state.myBoard[y][x] === 1;
  let sunk = false, sunkCells = [], allSunk = false;

  if (hit) {
    const shipCells = findShipCells(state.myBoard, x, y);
    const allHit = shipCells.every(c => {
      if (c.x === x && c.y === y) return true;
      const v = state.enemyShotsOnMe[c.y][c.x];
      return v === 2 || v === 3;
    });
    if (allHit) { sunk = true; sunkCells = shipCells; }
  }

  state.enemyShotsOnMe[y][x] = hit ? (sunk ? 3 : 2) : 1;
  if (sunk) sunkCells.forEach(c => state.enemyShotsOnMe[c.y][c.x] = 3);

  allSunk = state.ships.every(ship =>
    ship.cells.every(c => {
      const v = state.enemyShotsOnMe[c.y][c.x];
      return v === 2 || v === 3;
    })
  );

  trySend({ type: 'shot-result', x, y, hit, sunk, sunkCells, allSunk });

  renderSelfBoard();

  if (hit) {
    sfx.hit();
    animateCell('board-self', x, y, 'shake');
    state.myTurn = false;
  } else {
    sfx.miss();
    state.myTurn = true;
  }

  if (sunk) {
    sfx.sunk();
    sunkCells.forEach(c => showSunkRing('board-self', c.x, c.y));
  }

  updateTurnIndicator();

  if (allSunk) {
    state.gameState = 'finished';
    setTimeout(() => showResult(false), 900);
  }
}

function handleShotResult(msg) {
  const { x, y, hit, sunk, sunkCells, allSunk } = msg;
  state.pendingShot = null;

  state.myShotsOnEnemy[y][x] = hit ? (sunk ? 3 : 2) : 1;
  if (sunk) sunkCells.forEach(c => state.myShotsOnEnemy[c.y][c.x] = 3);

  renderEnemyBoard();

  if (hit) {
    sfx.hit();
    animateCell('board-enemy', x, y, 'shake');
    addLog(`💥 Попадание в (${x+1},${y+1})`);
  } else {
    sfx.miss();
    addLog(`💧 Промах в (${x+1},${y+1})`);
  }

  if (sunk) {
    sfx.sunk();
    sunkCells.forEach(c => setTimeout(() => showSunkRing('board-enemy', c.x, c.y), 100));
    addLog(`☠️ Уничтожен ${sunkCells.length}-палубный!`);
  }

  state.myTurn = hit;
  updateTurnIndicator();

  if (allSunk) {
    state.gameState = 'finished';
    setTimeout(() => showResult(true), 900);
  }
}

function findShipCells(board, x, y) {
  const cells = [{ x, y }];
  for (let i = x - 1; i >= 0 && board[y][i] === 1; i--) cells.push({ x: i, y });
  for (let i = x + 1; i < SIZE && board[y][i] === 1; i++) cells.push({ x: i, y });
  for (let i = y - 1; i >= 0 && board[i][x] === 1; i--) cells.push({ x, y: i });
  for (let i = y + 1; i < SIZE && board[i][x] === 1; i++) cells.push({ x, y: i });
  const uniq = [], seen = new Set();
  cells.forEach(c => {
    const k = `${c.x},${c.y}`;
    if (!seen.has(k)) { seen.add(k); uniq.push(c); }
  });
  return uniq;
}

/* ========== РЕЗУЛЬТАТ ========== */
function showResult(win) {
  stopHeartbeat();
  showScreen('screen-result');
  const title = $('result-title');
  title.textContent = win ? '🏆 Победа!' : '💀 Поражение';
  title.className = win ? 'win' : 'lose';
  $('result-text').textContent = win ? 'Вы уничтожили весь флот соперника!' : 'Ваш флот потоплен.';
  win ? sfx.win() : sfx.lose();
}

$('btn-again').onclick = () => {
  trySend({ type: 'rematch' });
  resetForRematch();
};

function resetForRematch() {
  state.myReady = false;
  state.enemyReady = false;
  state.myTurn = false;
  state.myBoard = [];
  state.myShotsOnEnemy = [];
  state.enemyShotsOnMe = [];
  state.ships = [];
  state.pendingShot = null;
  state.gameState = 'waiting';
  $('battle-log').innerHTML = '';
  startPlacing();
}

$('btn-exit').onclick = () => {
  trySend({ type: 'bye' });
  if (state.conn) state.conn.close();
  if (state.peer) state.peer.destroy();
  location.reload();
};

/* ========== ЗАКРЫТИЕ ВКЛАДКИ ========== */
window.addEventListener('beforeunload', () => {
  stopHeartbeat();
  trySend({ type: 'bye' });
});