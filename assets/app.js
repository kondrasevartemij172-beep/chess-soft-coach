import { Chess } from '../vendor/chess.js';

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const PROMOTION_PIECE = 'q';   // превращение только в ферзя, без выбора
const $ = (id) => document.getElementById(id);

const ui = {
  board: $('board'), squares: $('squares'), pieces: $('pieces'), arrows: $('arrows'),
  sideBtn: $('sideBtn'), turnBadge: $('turnBadge'), thinking: $('thinking'),
  engineState: $('engineState'), hintState: $('hintState'), hintNote: $('hintNote'),
  bestSan: $('bestSan'), bestScore: $('bestScore'), bestLine: $('bestLine'), playBest: $('playBest'),
  bothSides: $('bothSides'), depthSel: $('depthSel'), moves: $('moves'), plyCount: $('plyCount'),
  evalWhite: $('evalWhite'), undoBtn: $('undoBtn'), flipBtn: $('flipBtn'), newBtn: $('newBtn'),
  fenBtn: $('fenBtn'), toast: $('toast')
};

const state = {
  game: new Chess(),
  userColor: 'w',
  orientation: 'w',
  depth: Number(ui.depthSel.value) || 22,
  bothSides: false,
  best: null,          // { depth, cp, mate, pv: [uci, ...] }
  selected: null,      // выбранное поле
  lastMove: null,      // { from, to }
  drag: null           // { from, el, x0, y0, moved, pointerId }
};

/* ================================================================== */
/*  Движок Stockfish в воркере: только один (лучший) ход              */
/* ================================================================== */

class Stockfish {
  constructor() {
    this.worker = null;
    this.ready = false;
    this.searching = false;
    this.stale = 0;          // сколько «чужих» bestmove ещё прилетит после stop
    this.best = null;
    this.watchdog = 0;
    this.waiters = [];
    this.onUpdate = null;    // (best) => void
    this.onDone = null;      // (best) => void
    this.onError = null;
  }

  send(cmd) {
    if (this.worker) this.worker.postMessage(cmd);
  }

  waitFor(test, ms) {
    return new Promise((resolve, reject) => {
      const waiter = { test, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) { this.waiters.splice(i, 1); reject(new Error('timeout: ' + test)); }
      }, ms);
    });
  }

  async init() {
    this.worker = new Worker('vendor/stockfish.js');
    this.worker.onmessage = (ev) => this.handle(ev.data);
    this.worker.onerror = (ev) => {
      this.ready = false;
      if (this.onError) this.onError(ev.message || 'engine error');
    };

    this.send('uci');
    await this.waitFor((line) => line === 'uciok', 20000);
    // намеренно без MultiPV: нужен ровно один — лучший ход
    this.send('setoption name Hash value 64');
    this.send('isready');
    await this.waitFor((line) => line === 'readyok', 20000);
    this.send('ucinewgame');
    this.ready = true;
  }

  handle(data) {
    const text = typeof data === 'string' ? data : String(data);
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      for (const w of this.waiters.slice()) {
        if (w.test(line)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(line);
        }
      }
      if (line.startsWith('info ')) this.onInfoLine(line);
      else if (line.startsWith('bestmove')) this.onBestMove(line);
    }
  }

  onInfoLine(line) {
    // «info depth 20 ... score cp 34 ... pv e2e4 e7e5 ...»
    const pvM = / pv ([a-h][1-8][a-h][1-8][qrbn]?(?: [a-h][1-8][a-h][1-8][qrbn]?)*)/.exec(line);
    if (!pvM) return;                       // score-only строки пропускаем
    if (/ multipv (\d+)/.test(line) && !/ multipv 1 /.test(' ' + line + ' ')) return;

    const depthM = /(?:^|\s)depth (\d+)/.exec(line);
    const cpM = /score cp (-?\d+)/.exec(line);
    const mateM = /score mate (-?\d+)/.exec(line);

    this.best = {
      depth: depthM ? Number(depthM[1]) : 0,
      cp: cpM ? Number(cpM[1]) : null,
      mate: mateM ? Number(mateM[1]) : null,
      pv: pvM[1].split(' ')
    };
    if (this.onUpdate) this.onUpdate(this.best);
  }

  onBestMove(line) {
    if (this.stale > 0) { this.stale -= 1; return; }  // ответ остановленного поиска
    this.searching = false;
    clearTimeout(this.watchdog);
    if (/^bestmove\s+\(none\)/.test(line) || /^bestmove\s*$/.test(line)) this.best = null;
    if (this.onDone) this.onDone(this.best);
  }

  analyze(fen, depth) {
    this.stopSearch();
    this.best = null;
    this.searching = true;
    this.send('position fen ' + fen);
    this.send('go depth ' + depth);

    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.searching = false;
      if (this.onDone) this.onDone(this.best);
    }, 15000 + depth * 3000);
  }

  stopSearch() {
    if (this.searching) {
      this.send('stop');
      this.searching = false;
      this.stale += 1;
    }
    clearTimeout(this.watchdog);
  }

  clear() {
    this.stopSearch();
    this.best = null;
  }
}

const engine = new Stockfish();

/* ================================================================== */
/*  Геометрия доски                                                    */
/* ================================================================== */

function squareAt(row, col) {
  const white = state.orientation === 'w';
  const file = FILES[white ? col : 7 - col];
  const rank = white ? 8 - row : row + 1;
  return file + rank;
}

function posOf(square) {
  const file = FILES.indexOf(square[0]);
  const rank = Number(square[1]) - 1;
  const white = state.orientation === 'w';
  return { row: white ? 7 - rank : rank, col: white ? file : 7 - file };
}

function squareFromPoint(clientX, clientY) {
  const r = ui.board.getBoundingClientRect();
  const col = Math.floor((clientX - r.left) / (r.width / 8));
  const row = Math.floor((clientY - r.top) / (r.height / 8));
  if (col < 0 || col > 7 || row < 0 || row > 7) return null;
  return squareAt(row, col);
}

/* ================================================================== */
/*  Отрисовка                                                          */
/* ================================================================== */

function buildSquares() {
  ui.squares.innerHTML = '';
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const square = squareAt(row, col);
      const fileIdx = FILES.indexOf(square[0]);
      const rankIdx = Number(square[1]) - 1;
      const d = document.createElement('div');
      d.className = 'sq ' + ((fileIdx + rankIdx) % 2 === 0 ? 'light' : 'dark');
      d.dataset.square = square;

      if (row === 7) {
        const f = document.createElement('span');
        f.className = 'coord file';
        f.textContent = square[0];
        d.appendChild(f);
      }
      if (col === 0) {
        const rk = document.createElement('span');
        rk.className = 'coord rank';
        rk.textContent = square[1];
        d.appendChild(rk);
      }
      ui.squares.appendChild(d);
    }
  }
}

function squareEl(square) {
  return ui.squares.querySelector('.sq[data-square="' + square + '"]');
}

function renderPieces() {
  ui.pieces.innerHTML = '';
  const canMove = !state.game.isGameOver();
  for (const row of state.game.board()) {
    for (const cell of row) {
      if (!cell) continue;
      const { row: r, col: c } = posOf(cell.square);
      const d = document.createElement('div');
      d.className = 'piece';
      d.style.left = c * 12.5 + '%';
      d.style.top = r * 12.5 + '%';
      d.style.backgroundImage = 'url("vendor/pieces/' + cell.color + cell.type.toUpperCase() + '.svg")';
      d.dataset.square = cell.square;
      if (canMove && cell.color === state.game.turn()) d.classList.add('movable');
      ui.pieces.appendChild(d);
    }
  }
}

function renderHighlights() {
  ui.squares.querySelectorAll('.sq').forEach((s) => {
    s.classList.remove('last', 'sel', 'check', 'hint-from', 'hint-to');
    s.querySelectorAll('.dot, .ring').forEach((n) => n.remove());
  });

  if (state.lastMove) {
    squareEl(state.lastMove.from)?.classList.add('last');
    squareEl(state.lastMove.to)?.classList.add('last');
  }
  if (state.selected) squareEl(state.selected)?.classList.add('sel');

  if (state.game.isCheck()) {
    for (const row of state.game.board()) {
      for (const cell of row) {
        if (cell && cell.type === 'k' && cell.color === state.game.turn()) {
          squareEl(cell.square)?.classList.add('check');
        }
      }
    }
  }

  if (state.selected) {
    const moves = state.game.moves({ square: state.selected, verbose: true });
    for (const m of moves) {
      const target = squareEl(m.to);
      if (!target) continue;
      const mark = document.createElement('span');
      mark.className = state.game.get(m.to) ? 'ring' : 'dot';
      target.appendChild(mark);
    }
  }

  const uci = visibleBest()?.pv?.[0];
  if (uci && uci.length >= 4) {
    squareEl(uci.slice(0, 2))?.classList.add('hint-from');
    squareEl(uci.slice(2, 4))?.classList.add('hint-to');
  }
}

function visibleBest() {
  if (!state.best) return null;
  if (state.bothSides) return state.best;
  return state.game.turn() === state.userColor ? state.best : null;
}

function renderArrow() {
  const svg = ui.arrows;
  svg.innerHTML = '';
  const best = visibleBest();
  const uci = best?.pv?.[0];
  if (!uci || uci.length < 4) return;

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.setAttribute('id', 'arrowHead');
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '6');
  marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '4');
  marker.setAttribute('markerHeight', '4');
  marker.setAttribute('orient', 'auto-start-reverse');
  const head = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  head.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
  head.setAttribute('fill', '#ffe66d');
  marker.appendChild(head);
  defs.appendChild(marker);
  svg.appendChild(defs);

  const a = posOf(uci.slice(0, 2));
  const b = posOf(uci.slice(2, 4));
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', a.col + 0.5);
  line.setAttribute('y1', a.row + 0.5);
  line.setAttribute('x2', b.col + 0.5);
  line.setAttribute('y2', b.row + 0.5);
  line.setAttribute('stroke', '#ffe66d');
  line.setAttribute('stroke-width', '0.13');
  line.setAttribute('opacity', '0.95');
  line.setAttribute('marker-end', 'url(#arrowHead)');
  svg.appendChild(line);
}

function fmtScore(best) {
  if (!best) return '';
  if (best.mate !== null && best.mate !== undefined) {
    return (best.mate > 0 ? '+#' : '−#') + Math.abs(best.mate);
  }
  const cp = best.cp ?? 0;
  return (cp > 0 ? '+' : '') + (cp / 100).toFixed(2);
}

function sanOf(fen, uci) {
  if (!uci || uci.length < 4) return '—';
  try {
    const probe = new Chess(fen);
    const move = probe.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined
    });
    return move.san;
  } catch (e) {
    return uci;
  }
}

function pvToSan(fen, pv) {
  try {
    const probe = new Chess(fen);
    const out = [];
    for (const uci of pv.slice(0, 7)) {
      const move = probe.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci[4] : undefined
      });
      out.push(move.san);
    }
    return out.join(' ');
  } catch (e) {
    return pv.slice(0, 4).join(' ');
  }
}

function renderBest() {
  const g = state.game;
  const best = visibleBest();
  const yourTurn = g.turn() === state.userColor;

  ui.bestSan.classList.add('empty');
  ui.playBest.disabled = true;

  if (g.isGameOver()) {
    ui.bestSan.textContent = '—';
    ui.bestScore.textContent = '';
    ui.bestLine.textContent = g.isCheckmate() ? 'Мат — подсказывать нечего.' : 'Партия окончена.';
    ui.hintState.textContent = '—';
    ui.hintState.classList.remove('you');
    return;
  }

  if (!best) {
    ui.bestSan.textContent = '—';
    ui.bestScore.textContent = '';
    ui.hintState.classList.remove('you');

    if (!state.bothSides && !yourTurn) {
      ui.hintState.textContent = 'соперник';
      ui.bestLine.textContent = 'Ход соперника — подсказка скрыта. Сделай его ход, чтобы снова получить подсказку.';
    } else if (!engine.ready) {
      ui.hintState.textContent = 'загрузка';
      ui.bestLine.textContent = 'Движок загружается…';
    } else {
      ui.hintState.textContent = 'думаю';
      ui.bestLine.textContent = 'Считаю лучший ход…';
    }
    return;
  }

  const fen = g.fen();
  ui.bestSan.classList.remove('empty');
  ui.bestSan.textContent = sanOf(fen, best.pv[0]);
  ui.bestScore.textContent = fmtScore(best) + (best.depth ? ' · d' + best.depth : '');
  ui.bestLine.textContent = 'Вариант: ' + pvToSan(fen, best.pv);
  ui.hintState.textContent = state.bothSides ? 'обе стороны' : 'твой ход';
  ui.hintState.classList.add('you');
  ui.playBest.disabled = false;
}

function renderEval() {
  let whiteCp = 0;
  const best = state.best;
  if (best) {
    let cp = best.cp ?? 0;
    if (best.mate !== null && best.mate !== undefined) cp = best.mate > 0 ? 10000 : -10000;
    whiteCp = state.game.turn() === 'w' ? cp : -cp;
  }
  const p = 1 / (1 + Math.pow(10, -whiteCp / 400));
  ui.evalWhite.style.height = Math.round(p * 100) + '%';
}

function renderMoves() {
  const hist = state.game.history();
  ui.moves.innerHTML = '';
  const lastIdx = hist.length - 1;
  for (let i = 0; i < hist.length; i += 2) {
    const row = document.createElement('div');
    row.className = 'mrow';
    const no = document.createElement('span');
    no.className = 'mno';
    no.textContent = i / 2 + 1 + '.';
    const w = document.createElement('span');
    w.className = 'mv' + (i === lastIdx ? ' hl' : '');
    w.textContent = hist[i] || '';
    const b = document.createElement('span');
    b.className = 'mv' + (i + 1 === lastIdx ? ' hl' : '');
    b.textContent = hist[i + 1] || '';
    row.append(no, w, b);
    ui.moves.appendChild(row);
  }
  if (!hist.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-hints';
    empty.textContent = 'Партия ещё не начата.';
    ui.moves.appendChild(empty);
  }
  ui.plyCount.textContent = String(hist.length);
  ui.moves.scrollTop = ui.moves.scrollHeight;
}

function renderTurn() {
  const g = state.game;
  ui.turnBadge.classList.remove('you', 'over');

  if (g.isGameOver()) {
    ui.turnBadge.classList.add('over');
    if (g.isCheckmate()) {
      ui.turnBadge.textContent = 'Мат! Победили ' + (g.turn() === 'w' ? 'чёрные' : 'белые');
    } else if (g.isDraw()) {
      ui.turnBadge.textContent = 'Ничья';
    } else {
      ui.turnBadge.textContent = 'Партия окончена';
    }
    return;
  }

  let text = 'Ход ' + (g.turn() === 'w' ? 'белых' : 'чёрных');
  if (g.isCheck()) text += ' · шах';
  ui.turnBadge.textContent = text;
  if (g.turn() === state.userColor) ui.turnBadge.classList.add('you');
}

function renderAll() {
  renderPieces();
  renderHighlights();
  renderArrow();
  renderBest();
  renderEval();
  renderMoves();
  renderTurn();
}

/* ================================================================== */
/*  Ходы                                                               */
/* ================================================================== */

function isPromotion(from, to) {
  const piece = state.game.get(from);
  if (!piece || piece.type !== 'p') return false;
  return (piece.color === 'w' && to[1] === '8') || (piece.color === 'b' && to[1] === '1');
}

function tryMove(from, to, opts = {}) {
  if (!from || !to) return;
  if (from === to) { clearSelection(); return; }
  const g = state.game;
  if (g.isGameOver()) return;

  const piece = g.get(from);
  if (!piece || piece.color !== g.turn()) { clearSelection(); return; }

  const legal = g.moves({ square: from, verbose: true }).some((m) => m.to === to);
  if (!legal) {
    if (opts.fromDrag) showToast('Так ходить нельзя');
    clearSelection();
    return;
  }

  // пешка всегда превращается в ферзя — без диалога
  if (isPromotion(from, to)) {
    applyMove({ from, to, promotion: PROMOTION_PIECE });
    showToast('Пешка на ' + to + ' стала ферзём');
    return;
  }
  applyMove({ from, to });
}

function applyMove(move) {
  try {
    const made = state.game.move(move);
    if (!made) return;
    state.lastMove = { from: made.from, to: made.to };
  } catch (e) {
    return;
  }
  state.selected = null;
  cancelDrag();
  renderAll();
  scheduleAnalysis();
}

function clearSelection() {
  state.selected = null;
  renderHighlights();
}

function scheduleAnalysis() {
  const g = state.game;

  if (!engine.ready) {
    state.best = null;
    renderBest(); renderArrow(); renderHighlights(); renderEval();
    return;
  }

  if (g.isGameOver()) {
    engine.clear();
    state.best = null;
    ui.thinking.hidden = true;
    renderAll();
    return;
  }

  const shouldHint = state.bothSides || g.turn() === state.userColor;
  if (!shouldHint) {
    engine.clear();
    state.best = null;
    ui.thinking.hidden = true;
    renderAll();
    return;
  }

  state.best = null;          // чтобы на новой позиции не висела старая стрелка
  ui.thinking.hidden = false;
  renderBest(); renderArrow(); renderHighlights(); renderEval();
  engine.analyze(g.fen(), state.depth);
}

/* ================================================================== */
/*  Ввод                                                               */
/* ================================================================== */

function cancelDrag() {
  if (!state.drag) return;
  const d = state.drag;
  state.drag = null;
  if (d.el) {
    d.el.classList.remove('dragging');
    d.el.style.transform = '';
  }
  try { ui.board.releasePointerCapture(d.pointerId); } catch (e) { /* уже отпущен */ }
}

ui.board.addEventListener('pointerdown', (ev) => {
  if (ev.button !== undefined && ev.button !== 0) return;
  if (state.drag) return;
  if (state.game.isGameOver()) return;

  const square = squareFromPoint(ev.clientX, ev.clientY);
  if (!square) return;

  const piece = state.game.get(square);
  const own = piece && piece.color === state.game.turn();

  if (own) {
    state.selected = square;
    renderHighlights();

    const el = ui.pieces.querySelector('.piece[data-square="' + square + '"]');
    if (el) {
      state.drag = { from: square, el, x0: ev.clientX, y0: ev.clientY, moved: false, pointerId: ev.pointerId };
      el.classList.add('dragging');
      try { ui.board.setPointerCapture(ev.pointerId); } catch (e) { /* не критично */ }
    }
    ev.preventDefault();
    return;
  }

  if (state.selected) {
    tryMove(state.selected, square);
    ev.preventDefault();
  }
});

ui.board.addEventListener('pointermove', (ev) => {
  const d = state.drag;
  if (!d || d.pointerId !== ev.pointerId) return;
  const dx = ev.clientX - d.x0;
  const dy = ev.clientY - d.y0;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
  if (d.el) d.el.style.transform = 'translate(' + dx + 'px, ' + dy + 'px) scale(1.1)';
});

ui.board.addEventListener('pointerup', (ev) => {
  const d = state.drag;
  if (!d || d.pointerId !== ev.pointerId) return;

  const target = squareFromPoint(ev.clientX, ev.clientY);
  const from = d.from;
  const moved = d.moved;
  cancelDrag();

  if (target && target !== from) tryMove(from, target, { fromDrag: moved });
  else if (!moved) { /* клик по своей фигуре — оставляем выделение */ }
});

ui.board.addEventListener('pointercancel', cancelDrag);

document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  clearSelection();
});

/* ================================================================== */
/*  Кнопки                                                             */
/* ================================================================== */

function updateSideBtn() {
  const white = state.userColor === 'w';
  ui.sideBtn.textContent = white ? 'Я играю за белых' : 'Я играю за чёрных';
  ui.sideBtn.classList.toggle('is-black', !white);
  ui.sideBtn.title = white ? 'Нажми, чтобы играть за чёрных' : 'Нажми, чтобы играть за белых';
}

ui.sideBtn.addEventListener('click', () => {
  cancelDrag();
  state.userColor = state.userColor === 'w' ? 'b' : 'w';
  state.orientation = state.userColor;
  state.selected = null;
  updateSideBtn();
  buildSquares();
  renderAll();
  scheduleAnalysis();
  showToast(state.userColor === 'w' ? 'Теперь ты за белых' : 'Теперь ты за чёрных');
});

ui.undoBtn.addEventListener('click', () => {
  if (!state.game.history().length) return;
  cancelDrag();
  state.game.undo();
  const hist = state.game.history({ verbose: true });
  const last = hist[hist.length - 1];
  state.lastMove = last ? { from: last.from, to: last.to } : null;
  state.selected = null;
  renderAll();
  scheduleAnalysis();
});

ui.flipBtn.addEventListener('click', () => {
  cancelDrag();
  state.orientation = state.orientation === 'w' ? 'b' : 'w';
  state.selected = null;
  buildSquares();
  renderAll();
});

ui.newBtn.addEventListener('click', () => {
  cancelDrag();
  engine.clear();
  state.game = new Chess();
  state.lastMove = null;
  state.selected = null;
  state.best = null;
  renderAll();
  scheduleAnalysis();
  showToast('Новая партия');
});

ui.fenBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state.game.fen());
    showToast('FEN скопирован');
  } catch (e) {
    showToast('Не удалось скопировать FEN');
  }
});

ui.playBest.addEventListener('click', () => {
  const uci = visibleBest()?.pv?.[0];
  if (!uci) return;
  tryMove(uci.slice(0, 2), uci.slice(2, 4));
});

ui.bothSides.addEventListener('change', () => {
  state.bothSides = ui.bothSides.checked;
  renderAll();
  scheduleAnalysis();
});

ui.depthSel.addEventListener('change', () => {
  state.depth = Number(ui.depthSel.value);
  showToast('Глубина анализа: ' + state.depth);
  scheduleAnalysis();
});

let toastTimer = 0;
function showToast(text) {
  ui.toast.textContent = text;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 1800);
}

/* ================================================================== */
/*  Старт                                                              */
/* ================================================================== */

buildSquares();
updateSideBtn();
renderAll();

let lastUiTick = 0;
engine.onUpdate = (best) => {
  // движок мог прислать info от прерванного поиска — на чужой ход и после мата не показываем
  if (state.game.isGameOver()) return;
  if (!state.bothSides && state.game.turn() !== state.userColor) return;
  state.best = best;
  const now = performance.now();
  if (now - lastUiTick < 100) return;   // не дёргаем DOM на каждом info
  lastUiTick = now;
  renderArrow();
  renderHighlights();
  renderBest();
  renderEval();
};

engine.onDone = (best) => {
  ui.thinking.hidden = true;
  if (state.game.isGameOver() || (!state.bothSides && state.game.turn() !== state.userColor)) {
    state.best = null;
    renderAll();
    return;
  }
  state.best = best;
  renderAll();
};

engine.onError = (msg) => {
  ui.thinking.hidden = true;
  ui.engineState.textContent = 'движок не загрузился';
  ui.engineState.classList.add('bad');
  ui.bestSan.textContent = '—';
  ui.bestLine.textContent = 'Stockfish не запустился. Открой сайт через локальный сервер (serve.bat): из file:// браузер блокирует WASM в воркере. ' + (msg || '');
};

(async () => {
  try {
    const t0 = performance.now();
    await engine.init();
    ui.engineState.textContent = 'Stockfish 19 · готов';
    ui.engineState.classList.remove('bad');
    scheduleAnalysis();
    if (location.search.includes('engine_ms')) {
      ui.engineState.textContent = 'Stockfish 19 · ' + Math.round(performance.now() - t0) + ' мс';
    }
  } catch (e) {
    engine.onError(e.message);
  }
})();

/* отладочный доступ (используется в тестах) */
window.__chess = { state, engine, applyMove, tryMove, scheduleAnalysis, visibleBest, renderAll };
