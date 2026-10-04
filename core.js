// 潮汐秘境助手 · 网页版 —— 核心算法（纯 JS，无 DOM 依赖）
// 由 tidal_helper/recognize.py + solver.py 移植而来（重新实现，不共用文件）
// 浏览器使用：window.CX_CORE；Node 使用：require('./core.js')
(function (global) {
  'use strict';

  // ========================= 常量 =========================

  var GEM_TOTAL = { 8: 20, 10: 30, 12: 45 };

  // N -> { 屏幕高度H: [x0, y0, pitch] }
  var BOARD_PARAMS = {
    12: { 1920: [41.8, 754.3, 65.60], 1280: [34.91, 468.88, 54.66] },
    10: { 1920: [44.4, 756.0, 78.39], 1280: [37.00, 470.00, 65.40] },
    8:  { 1920: [44.00, 754.50, 98.40], 1280: [36.67, 468.75, 82.00] }
  };

  function InconsistentBoardError(msg) {
    this.name = 'InconsistentBoardError';
    this.message = msg || '';
  }
  InconsistentBoardError.prototype = Object.create(Error.prototype);
  InconsistentBoardError.prototype.constructor = InconsistentBoardError;

  function RuntimeError(msg) {
    this.name = 'RuntimeError';
    this.message = msg || '';
  }
  RuntimeError.prototype = Object.create(Error.prototype);
  RuntimeError.prototype.constructor = RuntimeError;

  // ========================= 数学工具 =========================
  // Python 的 round() 是"四舍六入五取偶"，JS 的 Math.round 是"五入"，
  // 为了和 Python 结果对齐，这里实现 Python 语义的 round。

  function pyRound(x) {
    var f = Math.floor(x);
    var diff = x - f;
    if (diff > 0.5) return f + 1;
    if (diff < 0.5) return f;
    return (f % 2 === 0) ? f : f + 1;
  }

  function round1(x) { return pyRound(x * 10) / 10; }

  function median(arr) {
    if (!arr.length) return NaN;
    var a = arr.slice().sort(function (p, q) { return p - q; });
    var n = a.length, mid = n >> 1;
    return (n % 2) ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  function mean(arr) {
    if (!arr.length) return NaN;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  // 组合数：普通浮点实现。C(144,45)≈1e38 超出精确整数范围，
  // 但 ~15 位有效数字对"概率取 1~3 位"完全够用。
  function comb(n, k) {
    if (k < 0 || k > n) return 0;
    if (k > n - k) k = n - k;
    var r = 1;
    for (var i = 1; i <= k; i++) r = r * (n - k + i) / i;
    return r;
  }

  // ========================= 图像基础层 =========================

  // img = { data: Uint8ClampedArray(RGBA), width, height }
  // 返回 cv2 风格的分通道视图（注意 cv2 是 BGR）
  function channels(img) {
    var d = img.data, n = img.width * img.height;
    var B = new Uint8Array(n), G = new Uint8Array(n), R = new Uint8Array(n);
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      R[i] = d[p]; G[i] = d[p + 1]; B[i] = d[p + 2];
    }
    return { w: img.width, h: img.height, B: B, G: G, R: R };
  }

  // 8 连通域标记。mask: Uint8Array(0/1)，返回 [{area,x,y,w,h,cx,cy}]
  // 等价 cv2.connectedComponentsWithStats（迭代式洪水填充，避免爆栈）
  function connectedComponents(mask, w, h) {
    var n = w * h;
    var labels = new Int32Array(n);
    var stack = new Int32Array(n);
    var out = [];
    var label = 0;
    for (var s = 0; s < n; s++) {
      if (!mask[s] || labels[s]) continue;
      label++;
      var sp = 0;
      stack[sp++] = s;
      labels[s] = label;
      var area = 0, minx = 1e9, miny = 1e9, maxx = -1, maxy = -1, sumx = 0, sumy = 0;
      while (sp > 0) {
        var p = stack[--sp];
        var py = (p / w) | 0;
        var px = p - py * w;
        area++; sumx += px; sumy += py;
        if (px < minx) minx = px;
        if (px > maxx) maxx = px;
        if (py < miny) miny = py;
        if (py > maxy) maxy = py;
        for (var dy = -1; dy <= 1; dy++) {
          var ny = py + dy;
          if (ny < 0 || ny >= h) continue;
          for (var dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            var nx = px + dx;
            if (nx < 0 || nx >= w) continue;
            var q = ny * w + nx;
            if (mask[q] && !labels[q]) { labels[q] = label; stack[sp++] = q; }
          }
        }
      }
      out.push({
        area: area, x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1,
        cx: sumx / area, cy: sumy / area
      });
    }
    return out;
  }

  // 等面积缩放（等价 cv2.resize INTER_AREA，带部分覆盖加权）
  function resizeArea(src, sw, sh, dw, dh) {
    var out = new Uint8Array(dw * dh);
    var xr = sw / dw, yr = sh / dh;
    for (var dy = 0; dy < dh; dy++) {
      var sy0 = dy * yr, sy1 = sy0 + yr;
      var iy0 = Math.floor(sy0), iy1 = Math.min(Math.ceil(sy1), sh);
      for (var dx = 0; dx < dw; dx++) {
        var sx0 = dx * xr, sx1 = sx0 + xr;
        var ix0 = Math.floor(sx0), ix1 = Math.min(Math.ceil(sx1), sw);
        var sum = 0, wsum = 0;
        for (var sy = iy0; sy < iy1; sy++) {
          var cy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
          if (cy <= 0) continue;
          for (var sx = ix0; sx < ix1; sx++) {
            var cx = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
            if (cx <= 0) continue;
            var wgt = cx * cy;
            sum += src[sy * sw + sx] * wgt;
            wsum += wgt;
          }
        }
        out[dy * dw + dx] = wsum > 0 ? Math.round(sum / wsum) : 0;
      }
    }
    return out;
  }

  // ========================= 掩码 =========================

  function blueMask(C) {
    var n = C.w * C.h, B = C.B, G = C.G, R = C.R;
    var m = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      if (B[i] > 170 && R[i] < 70 && G[i] > 90 && G[i] < 190) m[i] = 1;
    }
    return m;
  }

  function gemMask(C) {
    var n = C.w * C.h, B = C.B, G = C.G, R = C.R;
    var m = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      if (R[i] > 160 && G[i] > 90 && G[i] < 220 && B[i] < 100) m[i] = 1;
    }
    return m;
  }

  // ========================= 定位层 =========================

  var _cache = new WeakMap();   // img -> {channels, gemCenters, cellPoints}

  function _imgCache(img) {
    var c = _cache.get(img);
    if (!c) { c = {}; _cache.set(img, c); }
    return c;
  }

  function _channelsCached(img) {
    var c = _imgCache(img);
    if (!c.channels) c.channels = channels(img);
    return c.channels;
  }

  // 橙色钻石连通域中心（全部，不限棋盘范围）
  function gemCenters(img) {
    var c = _imgCache(img);
    if (c.gemCenters) return c.gemCenters;
    var C = _channelsCached(img);
    var comps = connectedComponents(gemMask(C), C.w, C.h);
    var out = [];
    for (var i = 0; i < comps.length; i++) {
      var s = comps[i];
      if (s.area > 400) out.push([s.cx, s.cy]);
    }
    c.gemCenters = out;
    return out;
  }

  // 可用于校准的格点：蓝格中心 + 钻石中心
  function cellPoints(img) {
    var c = _imgCache(img);
    if (c.cellPoints) return c.cellPoints;
    var C = _channelsCached(img);
    var H = C.h;
    var pts = [];
    var byMin = null, byMax = null;
    var blues = connectedComponents(blueMask(C), C.w, C.h);
    for (var i = 0; i < blues.length; i++) {
      var s = blues[i];
      if (s.area > 700 && s.w > 18 && s.w < 150 && s.h > 18 && s.h < 150 &&
          s.w / s.h > 0.5 && s.w / s.h < 2.0) {
        pts.push([s.cx, s.cy]);
        if (byMin === null || s.cy < byMin) byMin = s.cy;
        if (byMax === null || s.cy > byMax) byMax = s.cy;
      }
    }
    var gems = connectedComponents(gemMask(C), C.w, C.h);
    for (var j = 0; j < gems.length; j++) {
      var g = gems[j];
      // 位置过滤：默认只排除最顶部进度条上的钻石图标（约占屏高30%处以上）。
      // 但棋盘整体位于画面上部时（如只截了棋盘附近），高位钻石会被误排除，
      // 令顶部若干行没有格点、阵列起点被拟合成错位。因此额外放行
      // "落在蓝格纵向跨度内"的钻石——该条件只在棋盘靠上时才会生效，
      // 对常规整屏截图不改变任何格点，保证既有结果稳定。
      var inBlueSpan = (byMin !== null && g.cy >= byMin && g.cy <= byMax);
      if (g.area > 700 && g.w > 18 && g.w < 150 && g.h > 18 && g.h < 150 &&
          (g.cy > 0.3 * H || inBlueSpan)) {
        pts.push([g.cx, g.cy]);
      }
    }
    c.cellPoints = pts;
    return pts;
  }

  function pitchFrom(vals, lo, hi) {
    if (lo === undefined) lo = 25;
    if (hi === undefined) hi = 160;
    var a = vals.slice().sort(function (p, q) { return p - q; });
    var diffs = [];
    for (var i = 0; i + 1 < a.length; i++) {
      var d = a[i + 1] - a[i];
      if (d > lo && d < hi) diffs.push(d);
    }
    if (!diffs.length) return null;
    var hist = {}, order = [];
    for (var k = 0; k < diffs.length; k++) {
      var key = pyRound(diffs[k]);
      if (hist[key] === undefined) { hist[key] = 0; order.push(key); }
      hist[key]++;
    }
    var best = order[0];
    for (var oi = 1; oi < order.length; oi++) {
      if (hist[order[oi]] > hist[best]) best = order[oi];
    }
    var near = diffs.filter(function (d) { return Math.abs(d - best) <= 3; });
    return median(near);
  }

  // 一维坐标聚类；少于 minCount 个点的簇当作杂点丢弃
  function clusterMin(vals, gap, minCount) {
    if (minCount === undefined) minCount = 2;
    var a = vals.slice().sort(function (p, q) { return p - q; });
    var groups = [];
    for (var i = 0; i < a.length; i++) {
      var v = a[i];
      if (groups.length && v - groups[groups.length - 1][groups[groups.length - 1].length - 1] <= gap) {
        groups[groups.length - 1].push(v);
      } else {
        groups.push([v]);
      }
    }
    var out = [];
    for (var g = 0; g < groups.length; g++) {
      if (groups[g].length >= minCount) out.push(mean(groups[g]));
    }
    return out;
  }

  function refinePitch(coords, p) {
    if (coords.length < 2 || !p) return p;
    var span = coords[coords.length - 1] - coords[0];
    var k = pyRound(span / p);
    return k >= 1 ? span / k : p;
  }

  // 找格点阵列起点 origin。评分 = 命中数 - 残差和/(0.15*p)，偏离阵列的杂点被淘汰。
  function axisFit(coords, p, n, limit) {
    if (!coords.length) return { origin: null, aligned: [], hits: 0 };
    var tol = p * 0.1;
    var seen = {};
    var best = null;
    for (var i = 0; i < coords.length; i++) {
      var v = coords[i];
      for (var k = 0; k < n; k++) {
        var origin = v - (k + 0.5) * p;
        var key = round1(origin);
        if (seen[key]) continue;
        seen[key] = 1;
        if (origin < -p * 0.25 || origin + n * p > limit + 1) continue;
        var aligned = [], resid = 0;
        for (var j = 0; j < coords.length; j++) {
          var wv = coords[j];
          var kk = pyRound((wv - origin) / p - 0.5);
          if (!(kk >= 0 && kk < n)) continue;
          var d = Math.abs(wv - (origin + (kk + 0.5) * p));
          if (d < tol) { aligned.push(wv); resid += d; }
        }
        if (!aligned.length) continue;
        var score = aligned.length - resid / (0.15 * p);
        if (best === null || score > best.score) {
          best = { score: score, origin: origin, aligned: aligned };
        }
      }
    }
    if (best === null) return { origin: null, aligned: [], hits: 0 };
    return { origin: best.origin, aligned: best.aligned, hits: best.aligned.length };
  }

  // 不依赖分辨率表，从画面反推棋盘几何。失败返回 null
  function autoCalibrate(img, N) {
    var c0 = _imgCache(img);
    if (!c0.autoCalib) c0.autoCalib = {};
    if (Object.prototype.hasOwnProperty.call(c0.autoCalib, N)) return c0.autoCalib[N];
    var got = autoCalibrateCalc(img, N);
    c0.autoCalib[N] = got;
    return got;
  }

  function autoCalibrateCalc(img, N) {
    var C = _channelsCached(img);
    var W = C.w, H = C.h;
    var pts = cellPoints(img);
    if (pts.length < 4) return null;
    var xs = [], ys = [];
    for (var i = 0; i < pts.length; i++) { xs.push(pts[i][0]); ys.push(pts[i][1]); }
    var px0 = pitchFrom(xs), py0 = pitchFrom(ys);
    if (!px0 || !py0) return null;
    var p0 = (px0 + py0) / 2;
    if (!(p0 > 20 && p0 < 200)) return null;
    // minCount=2：保留原来的稳健性（单点杂簇会污染 pitch 众数估计）
    var cols = clusterMin(xs, p0 * 0.5, 2);
    var rows = clusterMin(ys, p0 * 0.5, 2);
    if (cols.length < 2 || rows.length < 2) return null;
    var fx = axisFit(cols, px0, N, W);
    var fy = axisFit(rows, py0, N, H);
    if (fx.origin === null || fy.origin === null) return null;
    var px = refinePitch(fx.aligned, px0);
    var py = refinePitch(fy.aligned, py0);
    var p = (px + py) / 2;
    var gx = axisFit(cols, p, N, W);
    var gy = axisFit(rows, p, N, H);
    if (gx.origin === null || gy.origin === null) return null;
    var x0 = gx.origin, y0 = gy.origin;
    var ok = 0;
    for (var q = 0; q < pts.length; q++) {
      var cx = pts[q][0], cy = pts[q][1];
      var kc = pyRound((cx - x0) / p - 0.5);
      var kr = pyRound((cy - y0) / p - 0.5);
      if (kc >= 0 && kc < N && kr >= 0 && kr < N &&
          Math.abs(cx - (x0 + (kc + 0.5) * p)) < p * 0.3 &&
          Math.abs(cy - (y0 + (kr + 0.5) * p)) < p * 0.3) {
        ok++;
      }
    }
    if (ok < 0.85 * pts.length) return null;
    return { x0: x0, y0: y0, pitch: p };
  }

  // 用棋盘内钻石中心做残差校验并微调平移；残差过大抛 RuntimeError
  function snapToGems(img, N, x0, y0, pitch) {
    var centers = gemCenters(img).filter(function (c) {
      return c[1] > y0 - pitch && c[1] < y0 + N * pitch + pitch;
    });
    if (centers.length >= 2) {
      var entries = [];
      for (var i = 0; i < centers.length; i++) {
        var cx = centers[i][0], cy = centers[i][1];
        var kc = pyRound((cx - x0) / pitch - 0.5);
        var kr = pyRound((cy - y0) / pitch - 0.5);
        if (kc >= 0 && kc < N && kr >= 0 && kr < N) {
          var ex = cx - (x0 + (kc + 0.5) * pitch);
          var ey = cy - (y0 + (kr + 0.5) * pitch);
          if (Math.abs(ex) < pitch / 3 && Math.abs(ey) < pitch / 3) {
            entries.push([kr, kc, ex, ey]);
          }
        }
      }
      if (entries.length >= 2) {
        var cellEx = {};   // 同一格保留残差最小的橙色块
        for (var e = 0; e < entries.length; e++) {
          var krr = entries[e][0], kcc = entries[e][1];
          var exx = entries[e][2], eyy = entries[e][3];
          var kk = krr * N + kcc;
          var d2 = exx * exx + eyy * eyy;
          if (!(kk in cellEx) || d2 < cellEx[kk][0] * cellEx[kk][0] + cellEx[kk][1] * cellEx[kk][1]) {
            cellEx[kk] = [exx, eyy];
          }
        }
        var keys = Object.keys(cellEx);
        if (keys.length >= 2) {
          var exs = keys.map(function (k) { return cellEx[k][0]; });
          var eys = keys.map(function (k) { return cellEx[k][1]; });
          var sx = median(exs), sy = median(eys);
          var inl = [];
          for (var t = 0; t < keys.length; t++) {
            var a = cellEx[keys[t]][0], b = cellEx[keys[t]][1];
            if (Math.abs(a - sx) < pitch / 8 && Math.abs(b - sy) < pitch / 8) inl.push([a, b]);
          }
          if (inl.length >= 2 && inl.length >= keys.length - 2) {
            var resid = 0;
            for (var m = 0; m < inl.length; m++) {
              resid = Math.max(resid, Math.abs(inl[m][0] - sx), Math.abs(inl[m][1] - sy));
            }
            if (resid < pitch / 4) return { x0: x0 + sx, y0: y0 + sy, pitch: pitch };
            throw new RuntimeError('棋盘定位校验失败（最大残差' + resid.toFixed(1) + 'px）');
          }
        }
      }
    }
    return { x0: x0, y0: y0, pitch: pitch };
  }

  // 定位策略：参数表 → 自动校准 → 按1920等比缩放兜底
  function detectBoard(img, N) {
    var C = _channelsCached(img);
    var H = C.h;
    var params = BOARD_PARAMS[N];
    if (params && Object.prototype.hasOwnProperty.call(params, H)) {
      var pv = params[H];
      try { return snapToGems(img, N, pv[0], pv[1], pv[2]); } catch (e) { /* 表参数失效 */ }
    }
    var got = autoCalibrate(img, N);
    if (got) {
      try { return snapToGems(img, N, got.x0, got.y0, got.pitch); } catch (e2) { /* 继续兜底 */ }
    }
    var base = params[1920];
    var scale = H / 1920.0;
    return snapToGems(img, N, base[0] * scale, base[1] * scale, base[2] * scale);
  }

  // 用未翻格列间距自动判断棋盘尺寸 8/10/12；失败返回 null
  function detectBoardSize(img) {
    var C = _channelsCached(img);
    var W = C.w, H = C.h;
    var m = blueMask(C);
    var y0 = Math.floor(0.3 * H), y1 = Math.floor(0.9 * H);
    for (var y = 0; y < y0; y++) { for (var x = 0; x < W; x++) m[y * W + x] = 0; }
    for (var y2 = y1; y2 < H; y2++) { for (var x2 = 0; x2 < W; x2++) m[y2 * W + x2] = 0; }
    var comps = connectedComponents(m, W, H);
    var cells = [];
    for (var i = 0; i < comps.length; i++) {
      if (comps[i].area > 1000) cells.push(comps[i].cx);
    }
    if (cells.length < 2) return null;
    cells.sort(function (a, b) { return a - b; });
    var cols = [cells[0]];
    for (var c = 1; c < cells.length; c++) {
      if (cells[c] - cols[cols.length - 1] > 25) cols.push(cells[c]);
    }
    var gaps = [];
    for (var g = 0; g + 1 < cols.length; g++) {
      var d = cols[g + 1] - cols[g];
      if (d < 110) gaps.push(d);
    }
    if (gaps.length < 2) return null;
    var order = [12, 10, 8];
    for (var oi = 0; oi < order.length; oi++) {
      var N = order[oi];
      var pv = BOARD_PARAMS[N];
      var t = Object.prototype.hasOwnProperty.call(pv, H) ? pv[H][2] : pv[1920][2] * H / 1920.0;
      var hit = 0;
      for (var q = 0; q < gaps.length; q++) if (Math.abs(gaps[q] - t) < 3) hit++;
      if (hit >= 2) return N;
    }
    return null;
  }

  // ========================= 识别层 =========================

  // 逐格分类。返回 { grid, digits:[{r,c,mask:{data,w,h}}] }
  function classifyCells(img, N, x0, y0, pitch) {
    var C = _channelsCached(img);
    var W = C.w, H = C.h, B = C.B, G = C.G, R = C.R;
    var ip = Math.floor(pitch);
    var mg = Math.floor(pitch * 0.2);
    var grid = [], digits = [];
    for (var r = 0; r < N; r++) {
      var row = [];
      for (var c = 0; c < N; c++) {
        var xa = pyRound(x0 + c * pitch);
        var ya = pyRound(y0 + r * pitch);
        var sx0 = xa + mg, sy0 = ya + mg;
        var sx1 = xa + ip - mg, sy1 = ya + ip - mg;
        if (sx0 < 0) sx0 = 0;
        if (sy0 < 0) sy0 = 0;
        if (sx1 > W) sx1 = W;
        if (sy1 > H) sy1 = H;
        var sw = sx1 - sx0, sh = sy1 - sy0;
        if (sw <= 0 || sh <= 0) { row.push('?'); continue; }

        var cnt = sw * sh;
        var gemN = 0, blueN = 0, whiteN = 0, graySum = 0;
        var subR = new Array(cnt);
        var whiteMask = new Uint8Array(cnt);
        var k = 0;
        for (var yy = 0; yy < sh; yy++) {
          var base = (sy0 + yy) * W;
          for (var xx = 0; xx < sw; xx++) {
            var i = base + sx0 + xx;
            var b = B[i], g = G[i], rr = R[i];
            if (rr > 160 && g > 90 && g < 220 && b < 100) gemN++;
            if (b > 170 && rr < 70 && g > 90 && g < 190) blueN++;
            if (rr > 185 && g > 185 && b > 185) { whiteN++; whiteMask[k] = 1; }
            graySum += (b + g + rr) / 3;
            subR[k] = rr;
            k++;
          }
        }
        var gemFrac = gemN / cnt, blueFrac = blueN / cnt, whiteFrac = whiteN / cnt;
        var grayMean = graySum / cnt;

        if (gemFrac > 0.2) {
          row.push('G');
        } else if (blueFrac > 0.4) {
          row.push('.');
        } else if (whiteFrac > 0.008) {
          var bgR = median(subR);
          if (bgR > 60) {
            row.push('X');
          } else {
            row.push('#');
            digits.push({ r: r, c: c, mask: { data: whiteMask, w: sw, h: sh } });
          }
        } else if (grayMean < 110) {
          row.push('0');
        } else {
          row.push('?');
        }
      }
      grid.push(row);
    }
    return { grid: grid, digits: digits };
  }

  // 白笔画 mask → 归一化 24×24 模板
  function digitToTemplate(mask, size) {
    if (size === undefined) size = 24;
    var data = mask.data, w = mask.w, h = mask.h;
    var minx = 1e9, miny = 1e9, maxx = -1, maxy = -1;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (data[y * w + x]) {
          if (x < minx) minx = x;
          if (x > maxx) maxx = x;
          if (y < miny) miny = y;
          if (y > maxy) maxy = y;
        }
      }
    }
    if (maxx < 0) return null;
    var cw = maxx - minx + 1, chh = maxy - miny + 1;
    var s = Math.max(cw, chh);
    var sq = new Uint8Array(s * s);
    var oy = (s - chh) >> 1, ox = (s - cw) >> 1;
    for (var yy = 0; yy < chh; yy++) {
      for (var xx = 0; xx < cw; xx++) {
        sq[(oy + yy) * s + (ox + xx)] = data[(miny + yy) * w + (minx + xx)];
      }
    }
    return resizeArea(sq, s, s, size, size);
  }

  function dice(a, b) {
    if (!a || !b) return 0;
    var inter = 0, sa = 0, sb = 0;
    for (var i = 0; i < a.length; i++) {
      var av = a[i] > 0, bv = b[i] > 0;
      if (av && bv) inter++;
      if (av) sa++;
      if (bv) sb++;
    }
    var s = sa + sb;
    return s ? 2.0 * inter / s : 0.0;
  }

  // ---------- 模板库 ----------

  var _tplCache = null;

  function b64decode(str) {
    if (typeof atob === 'function') {
      var bin = atob(str);
      var out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(str, 'base64'));
  }

  function loadTemplates() {
    if (_tplCache) return _tplCache;
    var T = null;
    if (global && global.CX_TEMPLATES) T = global.CX_TEMPLATES;
    if (!T && typeof require === 'function') {
      try { T = require('./templates.js'); } catch (e) { T = null; }
    }
    if (!T) throw new Error('模板库未加载（templates.js）');
    var arr = [];
    for (var i = 0; i < T.labels.length; i++) {
      var raw = b64decode(T.data[i]);
      var bin = new Uint8Array(raw.length);
      for (var j = 0; j < raw.length; j++) bin[j] = raw[j] > 0 ? 1 : 0;
      arr.push({ label: T.labels[i], bin: bin });
    }
    _tplCache = { size: T.size, items: arr };
    return _tplCache;
  }

  // 最高 Dice < thresh 返回 null
  function classifyDigit(t, thresh) {
    if (thresh === undefined) thresh = 0.80;
    if (t === null) return null;
    var tpls = loadTemplates();
    var bestD = 0, bestLb = null;
    var tb = new Uint8Array(t.length);
    for (var i = 0; i < t.length; i++) tb[i] = t[i] > 0 ? 1 : 0;
    for (var k = 0; k < tpls.items.length; k++) {
      var d = dice(tb, tpls.items[k].bin);
      if (d > bestD) { bestD = d; bestLb = tpls.items[k].label; }
    }
    return bestD >= thresh ? bestLb : null;
  }

  // 主入口：识别棋盘
  function recognize(img, N) {
    var board = detectBoard(img, N);
    var res = classifyCells(img, N, board.x0, board.y0, board.pitch);
    var grid = res.grid;
    var temps = [];
    for (var i = 0; i < res.digits.length; i++) {
      var d = res.digits[i];
      var t = digitToTemplate(d.mask);
      var lb = classifyDigit(t);
      if (lb !== null) grid[d.r][d.c] = lb;
      temps.push({ r: d.r, c: d.c, t: t });
    }
    return { grid: grid, temps: temps, board: board };
  }

  // ========================= 求解层 =========================

  function neighbors(r, c, rows, cols) {
    var out = [];
    for (var dr = -1; dr <= 1; dr++) {
      for (var dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        var nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) out.push(nr * cols + nc);
      }
    }
    return out;
  }

  function gridToSolverInput(grid, N) {
    var numbers = new Map(), gems = new Set(), unknown = new Set();
    for (var r = 0; r < N; r++) {
      for (var c = 0; c < N; c++) {
        var chh = grid[r][c];
        var key = r * N + c;
        if (chh === 'G') gems.add(key);
        else if (chh >= '0' && chh <= '9' && chh.length === 1) numbers.set(key, chh.charCodeAt(0) - 48);
        else unknown.add(key);
      }
    }
    return { numbers: numbers, gems: gems, unknown: unknown };
  }

  function conv(a, b) {
    var out = new Map();
    a.forEach(function (ca, ga) {
      b.forEach(function (cb, gb) {
        var g = ga + gb;
        out.set(g, (out.get(g) || 0) + ca * cb);
      });
    });
    return out;
  }

  function enumerateComponent(nCells, consLocal) {
    var covering = [];
    for (var i = 0; i < nCells; i++) covering.push([]);
    var states = [];
    for (var ci = 0; ci < consLocal.length; ci++) {
      var positions = consLocal[ci][1];
      states.push([0, positions.length]);
      for (var p = 0; p < positions.length; p++) covering[positions[p]].push(ci);
    }
    var solsByG = new Map();
    var cellGem = [];
    for (var q = 0; q < nCells; q++) cellGem.push(new Map());
    var assign = new Int8Array(nCells);

    function dfs(i, g) {
      if (i === nCells) {
        solsByG.set(g, (solsByG.get(g) || 0) + 1);
        for (var p2 = 0; p2 < nCells; p2++) {
          if (assign[p2]) {
            var mm = cellGem[p2];
            mm.set(g, (mm.get(g) || 0) + 1);
          }
        }
        return;
      }
      for (var vi = 0; vi < 2; vi++) {
        var val = vi;
        var saved = [];
        var ok = true;
        var cov = covering[i];
        for (var s = 0; s < cov.length; s++) {
          var cidx = cov[s];
          var st = states[cidx];
          var na = st[0] + val, nu = st[1] - 1;
          var need = consLocal[cidx][0];
          if (na > need || na + nu < need) { ok = false; break; }
          saved.push([st, st[0], st[1]]);
          st[0] = na; st[1] = nu;
        }
        if (ok) {
          assign[i] = val;
          dfs(i + 1, g + val);
        }
        for (var rb = 0; rb < saved.length; rb++) {
          saved[rb][0][0] = saved[rb][1];
          saved[rb][0][1] = saved[rb][2];
        }
      }
      assign[i] = 0;
    }

    dfs(0, 0);
    return { solsByG: solsByG, cellGem: cellGem };
  }

  // 计算所有未知格（含X格）的钻石概率。返回 Map(键r*cols+c -> 概率)
  function solve(rows, cols, numbers, gems, totalGems) {
    var known = new Set();
    numbers.forEach(function (v, k) { known.add(k); });
    gems.forEach(function (k) { known.add(k); });
    var K = totalGems - gems.size;
    if (K < 0) throw new InconsistentBoardError('总钻石数小于已找到数');

    var unknown = [], idx = new Map();
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var key = r * cols + c;
        if (!known.has(key)) { idx.set(key, unknown.length); unknown.push(key); }
      }
    }

    // 1. 建立约束
    var numKeys = Array.from(numbers.keys()).sort(function (a, b) { return a - b; });
    var cons = [];
    for (var ni = 0; ni < numKeys.length; ni++) {
      var nk = numKeys[ni];
      var rr = Math.floor(nk / cols), cc = nk % cols;
      var num = numbers.get(nk);
      var nbs = neighbors(rr, cc, rows, cols);
      var found = 0;
      for (var t = 0; t < nbs.length; t++) if (gems.has(nbs[t])) found++;
      var need = num - found;
      var positions = [];
      for (var u = 0; u < nbs.length; u++) {
        if (idx.has(nbs[u])) positions.push(idx.get(nbs[u]));
      }
      if (need < 0 || need > positions.length) {
        throw new InconsistentBoardError('格子(第' + (rr + 1) + '行第' + (cc + 1) + '列)的数字' + num + '与当前状态矛盾');
      }
      if (positions.length) cons.push({ need: need, positions: positions });
    }

    // 2. 并查集：共享格子的约束并入同一组件
    var parent = [];
    for (var pi = 0; pi < cons.length; pi++) parent.push(pi);
    function find(x) {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    }
    var cellToCon = new Map();
    for (var ci2 = 0; ci2 < cons.length; ci2++) {
      var pos2 = cons[ci2].positions;
      for (var p3 = 0; p3 < pos2.length; p3++) {
        var pv = pos2[p3];
        if (!cellToCon.has(pv)) cellToCon.set(pv, []);
        cellToCon.get(pv).push(ci2);
      }
    }
    cellToCon.forEach(function (cis) {
      for (var i2 = 1; i2 < cis.length; i2++) {
        var a = find(cis[0]), b = find(cis[i2]);
        if (a !== b) parent[b] = a;
      }
    });
    var groups = new Map();
    for (var ci3 = 0; ci3 < cons.length; ci3++) {
      var root = find(ci3);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(ci3);
    }
    var roots = Array.from(groups.keys()).sort(function (a, b) { return a - b; });

    // 3. 每个组件枚举所有解
    var compResults = [];
    var constrained = new Set();
    for (var gi = 0; gi < roots.length; gi++) {
      var cis2 = groups.get(roots[gi]).slice().sort(function (a, b) { return a - b; });
      var cells = [], posMap = new Map(), consLocal = [];
      for (var gj = 0; gj < cis2.length; gj++) {
        var con = cons[cis2[gj]];
        var local = [];
        for (var lp = 0; lp < con.positions.length; lp++) {
          var pp = con.positions[lp];
          if (!posMap.has(pp)) { posMap.set(pp, cells.length); cells.push(pp); }
          local.push(posMap.get(pp));
        }
        consLocal.push([con.need, local]);
      }
      var res = enumerateComponent(cells.length, consLocal);
      compResults.push({ cells: cells, solsByG: res.solsByG, cellGem: res.cellGem });
      for (var cs = 0; cs < cells.length; cs++) constrained.add(cells[cs]);
    }

    var far = [];
    for (var ui = 0; ui < unknown.length; ui++) {
      if (!constrained.has(ui)) far.push(ui);
    }

    // 4. 组件间卷积合并
    var ncomp = compResults.length;
    var D = new Array(ncomp + 1), suf = new Array(ncomp + 1);
    D[0] = new Map([[0, 1]]);
    suf[ncomp] = new Map([[0, 1]]);
    for (var d1 = 0; d1 < ncomp; d1++) D[d1 + 1] = conv(D[d1], compResults[d1].solsByG);
    for (var d2 = ncomp - 1; d2 >= 0; d2--) suf[d2] = conv(compResults[d2].solsByG, suf[d2 + 1]);
    var full = D[ncomp];
    var lenF = far.length;

    function w(G) {
      var rem = K - G;
      if (rem >= 0 && rem <= lenF) return comb(lenF, rem);
      return 0;
    }

    var totalWeight = 0;
    full.forEach(function (cnt, G) { totalWeight += cnt * w(G); });
    if (totalWeight === 0) {
      throw new InconsistentBoardError('当前棋盘状态与总钻石数矛盾，请检查识别结果或剩余钻石数');
    }

    // 5. 逐格算概率
    var probs = new Map();
    for (var i3 = 0; i3 < ncomp; i3++) {
      var comp = compResults[i3];
      var others = conv(D[i3], suf[i3 + 1]);
      for (var lp2 = 0; lp2 < comp.cells.length; lp2++) {
        var numr = 0;
        var cgMap = comp.cellGem[lp2];
        cgMap.forEach(function (cnt, g) {
          others.forEach(function (cntO, go) {
            var weight = w(g + go);
            if (weight) numr += cnt * cntO * weight;
          });
        });
        probs.set(unknown[comp.cells[lp2]], numr / totalWeight);
      }
    }
    if (lenF) {
      var expFar = 0;
      full.forEach(function (cnt, G) {
        var rem = K - G;
        if (rem >= 0 && rem <= lenF) expFar += cnt * comb(lenF, rem) * rem;
      });
      var pf = expFar / lenF / totalWeight;
      for (var f2 = 0; f2 < far.length; f2++) probs.set(unknown[far[f2]], pf);
    } else {
      for (var f3 = 0; f3 < far.length; f3++) probs.set(unknown[far[f3]], 0.0);
    }
    return probs;
  }

  function topMoves(probs, top) {
    if (top === undefined) top = 10;
    var arr = [];
    probs.forEach(function (p, k) { arr.push([k, p]); });
    arr.sort(function (a, b) { return b[1] - a[1]; });
    return arr.slice(0, top);
  }

  // 键 -> [行, 列]（0 起）
  function keyToRC(key, cols) {
    return [Math.floor(key / cols), key % cols];
  }

  // ========================= 高层流程 =========================

  // 照着 mapscan.analyze_board 的稳健策略：候选尺寸逐个试 + 求解器验证。
  // forcedN 非空时只试该尺寸。返回分析结果，全失败返回 null。
  //
  // 尺寸判定优先级（实测结论，见 tools/res_test.js）：
  //   1. 自动校准成功的尺寸——格点阵列能不能对上，是"是不是这个尺寸"最硬的证据。
  //      猜错的尺寸几乎必然校准失败（8/10/12 的列距差 20%+，对不上阵列）。
  //   2. detectBoardSize 的蓝格间距猜测（只在分辨率表覆盖时可靠，常返回 null）
  //   3. 12/10/8 兜底顺序
  // 若存在校准成功的尺寸，就只考虑这些尺寸：否则会出现"10×10 被当成 12×12
  // 照样算出一套看着合理的错误概率"的静默错误（实测 1284×2778 必现）。
  function analyzeBoard(img, guessN, forcedN) {
    var all = [12, 10, 8];
    var calib = {}, calibrated = [];
    for (var ci = 0; ci < all.length; ci++) {
      var cn = all[ci];
      var ac = null;
      try { ac = autoCalibrate(img, cn); } catch (eAc) { ac = null; }
      calib[cn] = ac;
      if (ac) calibrated.push(cn);
    }

    var candidates = [];
    var seenN = {};
    function push(N) {
      if (N && !seenN[N]) { seenN[N] = 1; candidates.push(N); }
    }
    for (var i2 = 0; i2 < calibrated.length; i2++) push(calibrated[i2]);
    if (forcedN) {
      candidates = [forcedN];
    } else {
      push(guessN || detectBoardSize(img));
      for (var i3 = 0; i3 < all.length; i3++) push(all[i3]);
    }

    for (var k = 0; k < candidates.length; k++) {
      var N = candidates[k];
      // 已有别的尺寸拿到了几何证据 → 没有证据的尺寸直接跳过
      if (!forcedN && calibrated.length > 0 && !calib[N]) continue;
      try {
        var rec = recognize(img, N);
        // 质量门槛：数字模板大面积认不出的识别结果不可信
        var qn = 0;
        for (var rr = 0; rr < N; rr++) {
          for (var cc = 0; cc < N; cc++) if (rec.grid[rr][cc] === '?') qn++;
        }
        if (qn > 0.15 * N * N) continue;
        var input = gridToSolverInput(rec.grid, N);
        var gems = input.gems;
        if (gems.size > GEM_TOTAL[N]) continue;
        var probs = solve(N, N, input.numbers, gems, GEM_TOTAL[N]);
        var best = topMoves(probs, 1)[0];
        var sure = 0, zero = 0;
        probs.forEach(function (p) { if (p >= 0.999) sure++; if (p <= 0.001) zero++; });
        return {
          N: N, grid: rec.grid, board: rec.board, probs: probs,
          numbers: input.numbers, gems: gems, unknown: input.unknown,
          found: gems.size, total: GEM_TOTAL[N], K: GEM_TOTAL[N] - gems.size,
          best: best ? best[0] : null, bestP: best ? best[1] : 0,
          sure: sure, zero: zero, unknownN: input.unknown.size,
          calibrated: !!calib[N], anyCalibrated: calibrated.length > 0,
          unknownCells: qn
        };
      } catch (e) {
        if (e && e.name === 'InconsistentBoardError') continue;
        // RuntimeError（定位失败）也换下一个尺寸试
        continue;
      }
    }
    return null;
  }

  var API = {
    GEM_TOTAL: GEM_TOTAL,
    BOARD_PARAMS: BOARD_PARAMS,
    InconsistentBoardError: InconsistentBoardError,
    RuntimeError: RuntimeError,
    // 图像基础
    channels: channels, connectedComponents: connectedComponents, resizeArea: resizeArea,
    median: median, mean: mean, comb: comb, pyRound: pyRound,
    // 定位
    gemCenters: gemCenters, cellPoints: cellPoints, pitchFrom: pitchFrom,
    clusterMin: clusterMin, refinePitch: refinePitch, axisFit: axisFit,
    autoCalibrate: autoCalibrate, snapToGems: snapToGems, detectBoard: detectBoard,
    detectBoardSize: detectBoardSize,
    // 识别
    classifyCells: classifyCells, digitToTemplate: digitToTemplate, dice: dice,
    loadTemplates: loadTemplates, classifyDigit: classifyDigit, recognize: recognize,
    // 求解
    gridToSolverInput: gridToSolverInput, solve: solve, topMoves: topMoves, keyToRC: keyToRC,
    // 高层
    analyzeBoard: analyzeBoard
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (global) global.CX_CORE = API;

})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));