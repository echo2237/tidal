// 潮汐秘境助手 · 网页版 —— 界面逻辑
// 只做：上传截图 → 本地识别 → 概率建议 → 手动校对重算。不含任何点击屏幕/模拟操作。
(function () {
  'use strict';

  var CORE = window.CX_CORE;
  var $ = function (id) { return document.getElementById(id); };

  var els = {
    file: $('fileInput'),
    size: $('sizeSelect'),
    status: $('status'),
    resultCard: $('resultCard'),
    canvas: $('canvas'),
    metaLine: $('metaLine'),
    rankCard: $('rankCard'),
    rankList: $('rankList'),
    sumCard: $('sumCard'),
    sumBox: $('sumBox'),
    fixCard: $('fixCard'),
    bgrid: $('bgrid')
  };
  var ctx = els.canvas.getContext('2d');

  var CYCLE = ['?', '.', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'X', 'G'];

  var state = {
    img: null,        // {data,width,height}
    srcCanvas: null,  // 原图（用于重绘）
    N: 0,
    grid: null,
    board: null,
    probs: null,
    forcedN: 0,
    calibrated: false,
    cost: 0
  };

  function setStatus(msg, cls) {
    els.status.className = 'hint' + (cls ? ' ' + cls : '');
    els.status.textContent = msg;
  }

  function show(el, on) { el.classList.toggle('hidden', !on); }

  // ---------- 选择图片 ----------
  els.file.addEventListener('change', function () {
    var f = els.file.files && els.file.files[0];
    if (!f) return;
    setStatus('正在读取图片…');
    var url = URL.createObjectURL(f);
    var im = new Image();
    im.onload = function () {
      var w = im.naturalWidth, h = im.naturalHeight;
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      var c2 = cv.getContext('2d');
      c2.drawImage(im, 0, 0);
      URL.revokeObjectURL(url);
      var idata;
      try {
        idata = c2.getImageData(0, 0, w, h);
      } catch (e) {
        setStatus('无法读取这张图片（可能是格式不支持），换一张试试。', 'err');
        return;
      }
      state.img = { data: idata.data, width: w, height: h };
      state.srcCanvas = cv;
      els.file.value = '';
      analyze();
    };
    im.onerror = function () {
      URL.revokeObjectURL(url);
      setStatus('图片加载失败，换一张试试（建议用 PNG/JPG 截图）。', 'err');
    };
    im.src = url;
  });

  els.size.addEventListener('change', function () {
    var v = parseInt(els.size.value, 10);
    state.forcedN = v > 0 ? v : 0;
    if (state.img) analyze();
  });

  // ---------- 识别 ----------
  function analyze() {
    if (!state.img) return;
    setStatus('正在分析…');
    show(els.resultCard, false);
    show(els.rankCard, false);
    show(els.sumCard, false);
    show(els.fixCard, false);
    // 让界面先把"正在分析"画出来，再干重活
    setTimeout(runAnalyze, 30);
  }

  function runAnalyze() {
    var forced = state.forcedN || null;
    state.forcedN = 0;
    var t0 = Date.now();
    var res;
    try {
      res = CORE.analyzeBoard(state.img, null, forced);
    } catch (e) {
      setStatus('识别出错：' + (e && e.message ? e.message : e), 'err');
      return;
    }
    state.cost = Date.now() - t0;
    if (!res) {
      setStatus('没能识别出棋盘。请确认截图里棋盘完整、没有裁掉边缘；' +
        '也可以在上方手动指定棋盘尺寸后重试。', 'err');
      return;
    }
    state.N = res.N;
    state.grid = res.grid;
    state.board = res.board;
    state.probs = res.probs;
    state.calibrated = !!res.calibrated;

    if (res.calibrated) {
      setStatus('识别完成。详见图上的概率标注，若要修正识别结果往下拉。', 'ok');
    } else {
      setStatus('识别完成，但这次没能自动校准棋盘位置（用的是按分辨率估算的' +
        '位置）。请重点核对下方的识别结果，有错格请点一下手动修正。', 'warn');
    }
    renderAll(true);
    show(els.resultCard, true);
    show(els.rankCard, true);
    show(els.sumCard, true);
    show(els.fixCard, true);
  }

  // ---------- 从 grid 统计 ----------
  function statsFromGrid() {
    var N = state.N, grid = state.grid;
    var found = 0, unknown = 0;
    for (var r = 0; r < N; r++) {
      for (var c = 0; c < N; c++) {
        var ch = grid[r][c];
        if (ch === 'G') found++;
        else if (!(ch >= '0' && ch <= '9')) unknown++;
      }
    }
    var total = CORE.GEM_TOTAL[N];
    return { found: found, unknown: unknown, total: total, K: total - found };
  }

  // ---------- 渲染 ----------
  function renderAll(rebuildBoard) {
    var st = statsFromGrid();
    els.metaLine.textContent = '棋盘 ' + state.N + '×' + state.N +
      '　｜　定位 ' + (state.calibrated ? '自动校准' : '分辨率估算') +
      '　｜　钻石 ' + st.found + '/' + st.total +
      '　｜　剩余待找 ' + st.K +
      '　｜　未知格 ' + st.unknown +
      '　｜　识别用时 ' + (state.cost / 1000).toFixed(1) + 's';
    renderCanvas();
    renderRank();
    renderSum(st);
    if (rebuildBoard) renderBoard();
  }

  function renderCanvas() {
    var img = state.img, N = state.N, b = state.board;
    els.canvas.width = img.width;
    els.canvas.height = img.height;
    ctx.clearRect(0, 0, img.width, img.height);
    if (state.srcCanvas) ctx.drawImage(state.srcCanvas, 0, 0);

    var x0 = b.x0, y0 = b.y0, pitch = b.pitch;
    var s = Math.floor(pitch) - 4;
    ctx.textBaseline = 'alphabetic';
    state.probs.forEach(function (p, k) {
      var r = Math.floor(k / N), c = k % N;
      var color = null, thick = 3, fill = false;
      if (p >= 0.999) { color = '#00d992'; thick = 4; fill = true; }
      else if (p >= 0.6) { color = '#fb565b'; }
      else if (p >= 0.4) { color = '#ffba00'; }
      else return;

      var xa = Math.round(x0 + c * pitch);
      var ya = Math.round(y0 + r * pitch);
      if (fill) {
        ctx.fillStyle = 'rgba(0,217,146,0.35)';
        ctx.fillRect(xa + 2, ya + 2, s - 2, s - 2);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = thick;
      ctx.strokeRect(xa + 2 + thick / 2, ya + 2 + thick / 2, s - 2 - thick, s - 2 - thick);

      var label = Math.round(p * 100) + '%';
      var fs = Math.max(11, Math.round(pitch * 0.34));
      ctx.font = '600 ' + fs + 'px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = Math.max(2, fs * 0.2);
      var tx = xa + 3, ty = ya + Math.round(pitch * 0.75);
      ctx.strokeText(label, tx, ty);
      ctx.fillStyle = color;
      ctx.fillText(label, tx, ty);
    });
  }

  function renderRank() {
    var N = state.N;
    var list = CORE.topMoves(state.probs, 10);
    els.rankList.innerHTML = '';
    if (!list.length) {
      els.rankList.innerHTML = '<li><span class="cell dim">没有需要猜的格子了</span></li>';
      return;
    }
    list.forEach(function (item, i) {
      var k = item[0], p = item[1];
      var r = Math.floor(k / N), c = k % N;
      var cls = p >= 0.6 ? 'hi' : (p >= 0.4 ? 'mid' : 'low');
      var li = document.createElement('li');
      li.className = cls;
      var pos = document.createElement('span');
      pos.className = 'pos';
      pos.textContent = (i + 1);
      var cell = document.createElement('span');
      cell.className = 'cell';
      cell.textContent = '第 ' + (r + 1) + ' 行第 ' + (c + 1) + ' 列';
      var pct = document.createElement('span');
      pct.className = 'pct';
      pct.textContent = (p * 100).toFixed(1) + '%';
      li.appendChild(pos); li.appendChild(cell); li.appendChild(pct);
      els.rankList.appendChild(li);
    });
  }

  function renderSum(st) {
    var N = state.N;
    var sure = [], zero = 0;
    state.probs.forEach(function (p, k) {
      var r = Math.floor(k / N), c = k % N;
      if (p >= 0.999) sure.push('第' + (r + 1) + '行第' + (c + 1) + '列');
      if (p <= 0.001) zero++;
    });
    function line(k, v, cls) {
      return '<div class="line"><span class="k">' + k + '</span><span class="v' +
        (cls ? ' ' + cls : '') + '">' + v + '</span></div>';
    }
    var html = '';
    html += line('钻石（已找到 / 总数）', st.found + ' / ' + st.total);
    html += line('剩余待找', st.K);
    html += line('未知格', st.unknown);
    html += line('确定是钻石（100%）', sure.length ? sure.join('、') : '无', sure.length ? 'ok' : '');
    html += line('确定安全（0%）', zero + ' 格', zero ? 'ok' : '');
    els.sumBox.innerHTML = html;
  }

  function renderBoard() {
    var N = state.N;
    els.bgrid.style.setProperty('--n', N);
    els.bgrid.innerHTML = '';
    for (var r = 0; r < N; r++) {
      for (var c = 0; c < N; c++) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.r = r;
        btn.dataset.c = c;
        paintCell(btn, state.grid[r][c]);
        els.bgrid.appendChild(btn);
      }
    }
  }

  function paintCell(btn, ch) {
    btn.textContent = ch;
    var cls = 'c-q';
    if (ch === 'G') cls = 'c-g';
    else if (ch === '.') cls = 'c-dot';
    else if (ch === 'X') cls = 'c-x';
    else if (ch === '0') cls = 'c-z';
    else if (ch >= '1' && ch <= '9') cls = 'c-d';
    btn.className = cls;
  }

  // ---------- 手动校对 ----------
  els.bgrid.addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('button') : null;
    if (!btn || !btn.dataset.r) return;
    var r = parseInt(btn.dataset.r, 10), c = parseInt(btn.dataset.c, 10);
    var cur = state.grid[r][c];
    var i = CYCLE.indexOf(cur);
    var next = CYCLE[(i + 1) % CYCLE.length];
    state.grid[r][c] = next;
    paintCell(btn, next);
    recompute();
  });

  function recompute() {
    var N = state.N;
    var input = CORE.gridToSolverInput(state.grid, N);
    try {
      state.probs = CORE.solve(N, N, input.numbers, input.gems, CORE.GEM_TOTAL[N]);
    } catch (e) {
      setStatus('现在的状态算不通：' + (e && e.message ? e.message : e) +
        '　（棋盘上可能有格子标错了，继续点格子修正）', 'err');
      return;
    }
    setStatus('已按你的修改重新计算。', 'ok');
    renderAll(false);
  }

})();