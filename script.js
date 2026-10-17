import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getDatabase, ref, set, get, onValue, update, remove, onDisconnect, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

/* ========== 🔧 FIREBASE CONFIG — ЗАМЕНИ НА СВОЙ ========== */
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:xxxxxxxxxxxxxxxx"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

/* ========== КОНСТАНТЫ ========== */
const SIZE = 10;
const FLEET = [
  { len: 4, count: 1 },
  { len: 3, count: 2 },
  { len: 2, count: 3 },
  { len: 1, count: 4 }
];

/* ========== СОСТОЯНИЕ ========== */
const state = {
  playerId: null,        // 'player1' | 'player2'
  roomCode: null,
  myBoard: [],           // 0=empty, 1=ship
  enemyBoardView: [],    // 0=unknown, 1=miss, 2=hit, 3=sunk
  myShotsOnEnemy: [],    // [y][x] = 0/1/2/3
  enemyShotsOnMe: [],
  ships: [],             // {len, cells:[{x,y}], sunk:false}
  placingShip: null,     // индекс выбранного корабля
  horizontal: true,
  ready: false,
  enemyReady: false,
  gameState: 'waiting',
  myTurn: false,
  roomRef: null,
  enemyId: null,
  shotHistory: []
};

/* ========== УТИЛИТЫ ========== */
const $ = id => document.getElementById(id);
const rand = n => Math.floor(Math.random() * n);
const randomCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[rand(chars.length)];
  return s;
};

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

/* ========== ЗВУКИ (Web Audio) ========== */
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function beep(freq, dur = 0.1, type = 'sine', vol = 0.1) {
  try {
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

/* ========== МЕНЮ ========== */
$('btn-create').onclick = async () => {
  const code = randomCode();
  state.roomCode = code;
  state.playerId = 'player1';
  state.enemyId = 'player2';
  state.roomRef = ref(db, 'rooms/' + code);

  await set(state.roomRef, {
    state: 'waiting',
    turn: 'player1',
    winner: null,
    createdAt: serverTimestamp(),
    player1: { ready: false, board: null, shots: null, connected: true },
    player2: { ready: false, board: null, shots: null, connected: false }
  });

  onDisconnect(ref(db, `rooms/${code}/player1/connected`)).set(false);

  $('room-code-display').textContent = code;
  $('room-info').classList.remove('hidden');
  subscribeRoom();
};

$('btn-join').onclick = async () => {
  const code = $('input-code').value.trim().toUpperCase();
  if (code.length !== 6) return alert('Введите 6-символьный код');

  const roomSnap = await get(ref(db, 'rooms/' + code));
  if (!roomSnap.exists()) return alert('Комната не найдена');

  const room = roomSnap.val();
  if (room.player2 && room.player2.connected) return alert('Комната занята');

  state.roomCode = code;
  state.playerId = 'player2';
  state.enemyId = 'player1';
  state.roomRef = ref(db, 'rooms/' + code);

  await update(ref(db, `rooms/${code}/player2`), { connected: true });
  await update(ref(db, `rooms/${code}`), { state: 'placing' });

  onDisconnect(ref(db, `rooms/${code}/player2/connected`)).set(false);

  subscribeRoom();
};

$('btn-copy').onclick = () => {
  navigator.clipboard.writeText(state.roomCode);
  $('btn-copy').textContent = '✅ Скопировано';
  setTimeout(() => $('btn-copy').textContent = '📋 Копировать код', 1500);
};

/* ========== ПОДПИСКА НА КОМНАТУ ========== */
function subscribeRoom() {
  onValue(state.roomRef, snap => {
    const room = snap.val();
    if (!room) return;

    // Ожидание второго игрока
    if (state.playerId === 'player1') {
      if (room.player2 && room.player2.connected) {
        $('room-status').textContent = '✅ Соперник подключён!';
        setTimeout(() => startPlacing(), 500);
      } else {
        $('room-status').textContent = '⏳ Ожидание соперника...';
      }
    } else if (state.playerId === 'player2' && room.state === 'placing') {
      startPlacing();
    }

    // Проверка готовности обоих
    if (room.player1?.ready && room.player2?.ready && room.state !== 'playing' && room.state !== 'finished') {
      update(ref(db, `rooms/${state.roomCode}`), { state: 'playing' });
    }

    // Обработка выстрелов соперника
    if (room.state === 'playing' || room.state === 'finished') {
      if (!state.gameState || state.gameState === 'waiting' || state.gameState === 'placing') {
        enterBattle(room);
      }
      syncBattle(room);
    }

    if (room.state === 'finished' && state.gameState !== 'finished') {
      state.gameState = 'finished';
      showResult(room.winner === state.playerId);
    }
  });
}

/* ========== РАССТАНОВКА ========== */
function startPlacing() {
  if (state.gameState === 'placing') return;
  state.gameState = 'placing';
  showScreen('screen-place');
  initMyBoard();
  buildShipsList();
  renderOwnBoard();
  renderPreviewBoard();
  $('btn-ready').disabled = true;
}

function initMyBoard() {
  state.myBoard = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  state.ships = [];
  state.placingShip = null;
  state.horizontal = true;
  state.placedHistory = [];
}

function buildShipsList() {
  const container = $('ships-container');
  container.innerHTML = '';
  let idx = 0;
  FLEET.forEach(group => {
    for (let i = 0; i < group.count; i++) {
      const ship = { len: group.len, id: idx, placed: false };
      state.ships.push(ship);
      const div = document.createElement('div');
      div.className = 'ship-item';
      div.dataset.id = idx;
      div.innerHTML = `
        ${Array(ship.len).fill('<div class="cell-dot"></div>').join('')}
        <span class="count">×${group.count - i}</span>
      `;
      div.onclick = () => selectShip(idx);
      container.appendChild(div);
      idx++;
    }
  });
  // убираем count справа — упростим
  container.querySelectorAll('.count').forEach(el => el.remove());
  // Первый корабль выбран автоматически
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
    if (cx >= SIZE || cy >= SIZE) return false;
    if (board[cy][cx] !== 0) return false;
    // проверка соседей (включая углы)
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

  // Автовыбор следующего
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
      cell.dataset.x = x;
      cell.dataset.y = y;
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
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      board.appendChild(cell);
    }
  }
}

/* ========== УПРАВЛЕНИЕ РАССТАНОВКОЙ ========== */
$('btn-rotate').onclick = () => { state.horizontal = !state.horizontal; };
document.addEventListener('keydown', e => {
  if (e.key.toLowerCase() === 'r' && state.gameState === 'placing') {
    state.horizontal = !state.horizontal;
  }
});

$('btn-random').onclick = () => {
  initMyBoard();
  // Сброс UI
  document.querySelectorAll('.ship-item').forEach(el => el.classList.remove('placed'));
  state.placingShip = null;

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
          state.ships.push({ len: group.len, placed: true, cells });
          placed = true;
        }
      }
    }
  });

  // Восстанавливаем ссылки на ships-элементы
  state.ships.forEach((s, i) => {
    const el = document.querySelector(`.ship-item[data-id="${i}"]`);
    if (el) el.classList.add('placed');
  });

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
  initMyBoard();
  document.querySelectorAll('.ship-item').forEach(el => el.classList.remove('placed'));
  selectShip(0);
  renderOwnBoard();
  checkReady();
};

$('btn-ready').onclick = async () => {
  if (!state.ships.every(s => s.placed)) return;
  $('btn-ready').disabled = true;
  $('place-status').textContent = '⏳ Ожидание соперника...';

  await update(ref(db, `rooms/${state.roomCode}/${state.playerId}`), {
    ready: true,
    board: state.myBoard,
    ships: state.ships.map(s => s.cells)
  });
};

/* ========== БОЙ ========== */
function enterBattle(room) {
  state.gameState = 'playing';
  // Инициализация представлений
  state.enemyBoardView = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  state.myShotsOnEnemy = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  state.enemyShotsOnMe = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  state.shotHistory = [];
  showScreen('screen-battle');
  renderEnemyBoard();
  renderSelfBoard();
  updateTurnIndicator(room);
}

function syncBattle(room) {
  // Обновляем выстрелы
  const enemyShots = room[state.enemyId]?.shots || {};
  const myShots = room[state.playerId]?.shots || {};

  // Применяем выстрелы врага на своё поле
  Object.entries(enemyShots).forEach(([key, val]) => {
    const [y, x] = key.split(',').map(Number);
    if (state.enemyShotsOnMe[y][x] !== val) {
      state.enemyShotsOnMe[y][x] = val;
      renderSelfBoard();
      if (val === 2) { sfx.hit(); animateCell('board-self', x, y, 'shake'); }
      else if (val === 1) sfx.miss();
    }
  });

  // Обновляем свои выстрелы (на случай переподключения)
  Object.entries(myShots).forEach(([key, val]) => {
    const [y, x] = key.split(',').map(Number);
    if (state.myShotsOnEnemy[y][x] !== val) {
      state.myShotsOnEnemy[y][x] = val;
      state.enemyBoardView[y][x] = val;
      renderEnemyBoard();
    }
  });

  // Проверка победы
  if (room.state === 'finished' && state.gameState !== 'finished') {
    state.gameState = 'finished';
    showResult(room.winner === state.playerId);
    return;
  }

  updateTurnIndicator(room);
}

function updateTurnIndicator(room) {
  state.myTurn = room.turn === state.playerId;
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
  const board = $(boardId);
  const cell = board.children[y * SIZE + x];
  if (cell) {
    cell.classList.add(cls);
    setTimeout(() => cell.classList.remove(cls), 600);
  }
}

async function fire(x, y) {
  if (!state.myTurn) return;
  if (state.myShotsOnEnemy[y][x] !== 0) return;

  sfx.shot();

  // Проверяем попадание — читаем доску врага из БД
  const enemySnap = await get(ref(db, `rooms/${state.roomCode}/${state.enemyId}/board`));
  const enemyBoard = enemySnap.val();
  if (!enemyBoard) return;

  const hit = enemyBoard[y][x] === 1;

  // Определяем, потоплен ли корабль
  let sunk = false;
  let sunkCells = [];
  if (hit) {
    // Находим все клетки корабля, в который попали
    const shipCells = findShipCells(enemyBoard, x, y);
    // Проверяем, все ли они уже поражены (включая текущий выстрел)
    const allHit = shipCells.every(c => {
      if (c.x === x && c.y === y) return true;
      return state.myShotsOnEnemy[c.y][c.x] === 2 || state.myShotsOnEnemy[c.y][c.x] === 3;
    });
    if (allHit) {
      sunk = true;
      sunkCells = shipCells;
    }
  }

  // Значение для ячейки: 1=miss, 2=hit, 3=sunk
  const shotValue = hit ? (sunk ? 3 : 2) : 1;

  // Обновляем локально
  state.myShotsOnEnemy[y][x] = shotValue;
  state.enemyBoardView[y][x] = shotValue;

  // Если sunk — помечаем все клетки корабля как 3
  if (sunk) {
    sunkCells.forEach(c => {
      state.myShotsOnEnemy[c.y][c.x] = 3;
      state.enemyBoardView[c.y][c.x] = 3;
    });
  }

  renderEnemyBoard();

  // Эффекты
  if (hit) {
    sfx.hit();
    animateCell('board-enemy', x, y, 'shake');
    if (sunk) {
      sfx.sunk();
      showSunkRing(x, y);
      sunkCells.forEach(c => {
        setTimeout(() => animateCell('board-enemy', c.x, c.y, 'shake'), 100);
      });
      addLog(`💥 Уничтожен ${sunkCells.length}-палубный корабль!`);
    } else {
      addLog(`💥 Попадание в (${x+1},${y+1})`);
    }
  } else {
    sfx.miss();
    addLog(`💧 Промах в (${x+1},${y+1})`);
  }

  // Отправляем в БД
  const updates = {};
  updates[`rooms/${state.roomCode}/${state.playerId}/shots/${y},${x}`] = shotValue;
  if (sunk) {
    sunkCells.forEach(c => {
      updates[`rooms/${state.roomCode}/${state.playerId}/shots/${c.y},${c.x}`] = 3;
    });
  }

  // Проверка победы: все ли корабли врага потоплены?
  const enemyShipsSnap = await get(ref(db, `rooms/${state.roomCode}/${state.enemyId}/ships`));
  const enemyShips = enemyShipsSnap.val() || [];
  const allEnemySunk = enemyShips.every(shipCells =>
    shipCells.every(c => {
      const v = state.myShotsOnEnemy[c.y][c.x];
      return v === 2 || v === 3;
    })
  );

  if (allEnemySunk) {
    updates[`rooms/${state.roomCode}/state`] = 'finished';
    updates[`rooms/${state.roomCode}/winner`] = state.playerId;
  } else {
    // При попадании ход остаётся, при промахе — переходит
    if (!hit) {
      updates[`rooms/${state.roomCode}/turn`] = state.enemyId;
    }
  }

  await update(ref(db), updates);
}

function findShipCells(board, x, y) {
  // BFS по горизонтали и вертикали для поиска всех клеток корабля
  const cells = [{ x, y }];
  // Влево-вправо
  for (let i = x - 1; i >= 0 && board[y][i] === 1; i--) cells.push({ x: i, y });
  for (let i = x + 1; i < SIZE && board[y][i] === 1; i++) cells.push({ x: i, y });
  // Вверх-вниз
  for (let i = y - 1; i >= 0 && board[i][x] === 1; i--) cells.push({ x, y: i });
  for (let i = y + 1; i < SIZE && board[i][x] === 1; i++) cells.push({ x, y: i });
  // Убираем дубликаты
  const uniq = [];
  const seen = new Set();
  cells.forEach(c => {
    const k = `${c.x},${c.y}`;
    if (!seen.has(k)) { seen.add(k); uniq.push(c); }
  });
  return uniq;
}

function showSunkRing(x, y) {
  const board = $('board-enemy');
  const cell = board.children[y * SIZE + x];
  if (!cell) return;
  const ring = document.createElement('div');
  ring.className = 'sunk-ring';
  ring.style.left = '50%';
  ring.style.top = '50%';
  cell.appendChild(ring);
  setTimeout(() => ring.remove(), 900);
}

function addLog(msg) {
  const log = $('battle-log');
  const div = document.createElement('div');
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  state.shotHistory.push(msg);
}

/* ========== РЕЗУЛЬТАТ ========== */
function showResult(win) {
  showScreen('screen-result');
  const title = $('result-title');
  title.textContent = win ? '🏆 Победа!' : '💀 Поражение';
  title.className = win ? 'win' : 'lose';
  $('result-text').textContent = win
    ? 'Вы уничтожили весь флот соперника!'
    : 'Ваш флот потоплен. В следующий раз повезёт!';
  win ? sfx.win() : sfx.lose();
}

$('btn-again').onclick = async () => {
  // Сброс комнаты для новой игры
  await update(ref(db, `rooms/${state.roomCode}`), {
    state: 'placing',
    turn: 'player1',
    winner: null
  });
  await update(ref(db, `rooms/${state.roomCode}/player1`), { ready: false, board: null, shots: null });
  await update(ref(db, `rooms/${state.roomCode}/player2`), { ready: false, board: null, shots: null });

  // Сброс состояния
  state.myBoard = [];
  state.enemyBoardView = [];
  state.myShotsOnEnemy = [];
  state.enemyShotsOnMe = [];
  state.ships = [];
  state.shotHistory = [];
  state.gameState = 'placing';

  startPlacing();
};

$('btn-exit').onclick = () => location.reload();