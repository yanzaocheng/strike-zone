// =====================================================================
//  03 程序化纹理模块：用 Canvas 2D 在运行时绘制所有贴图（无外部图片）
//  地面/墙面纹理使用可平铺噪声，保证重复时无接缝
// =====================================================================

const Tex = {
  anisotropy: 1,
  t: {},          // 已生成的纹理表

  _canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h || w; return c; },
  _finish(canvas, repeat = true) {
    const tex = new THREE.CanvasTexture(canvas);
    if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = this.anisotropy;
    return tex;
  },
  /** 逐像素绘制：fn(u, v, x, y, out) 往 out 写入 [r,g,b,a] */
  _pixels(ctx, w, h, fn) {
    const img = ctx.createImageData(w, h);
    const d = img.data;
    const out = [0, 0, 0, 255];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        out[3] = 255;
        fn(x / w, y / h, x, y, out);
        const i = (y * w + x) * 4;
        d[i] = out[0]; d[i + 1] = out[1]; d[i + 2] = out[2]; d[i + 3] = out[3];
      }
    }
    ctx.putImageData(img, 0, 0);
  },
  _set(out, base, k) {
    out[0] = clamp(base[0] * k, 0, 255); out[1] = clamp(base[1] * k, 0, 255); out[2] = clamp(base[2] * k, 0, 255);
  },
  /** 在平铺纹理上画圆点（跨边界时在对侧补画，保证无缝） */
  _wrapDot(ctx, S, x, y, r, style) {
    ctx.fillStyle = style;
    for (let ox = -S; ox <= S; ox += S) for (let oy = -S; oy <= S; oy += S) {
      if (x + ox + r < 0 || x + ox - r > S || y + oy + r < 0 || y + oy - r > S) continue;
      ctx.beginPath(); ctx.arc(x + ox, y + oy, r, 0, TAU); ctx.fill();
    }
  },

  init(renderer) {
    this.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const t = this.t;
    t.sand = this.sand();
    t.dirt = this.sand([176, 146, 104], 7);
    t.plaster = this.plaster();
    t.stone = this.blocks([196, 174, 132], 17, 128, 64);
    t.brick = this.bricks();
    t.tiles = this.tiles();
    t.dark = this.blocks([118, 114, 106], 31, 64, 32, 256);
    t.concrete = this.concrete();
    t.crate = this.crate();
    t.planks = this.planks();
    t.metal = this.metal();
    t.soft = this.softCircle();
    t.smoke = this.smokePuff();
    t.muzzle = this.muzzleFlash();
    t.hole = this.bulletHole();
    t.blood = this.bloodSplat();
    t.scorch = this.scorch();
  },

  // ------------------------------------------------------------------
  //  场景纹理
  // ------------------------------------------------------------------
  sand(base = [200, 170, 120], seed = 3) {
    const S = 512, c = this._canvas(S), ctx = c.getContext('2d');
    this._pixels(ctx, S, S, (u, v, x, y, o) => {
      const n = tileFbm(u, v, 4, 5, seed);
      const n2 = tileFbm(u, v, 32, 3, seed + 50);
      const k = 0.8 + n * 0.32 + (n2 - 0.5) * 0.14 + (Math.random() - 0.5) * 0.09;
      this._set(o, base, k);
    });
    const rng = new RNG(seed * 7);
    for (let i = 0; i < 420; i++) {
      const r = rng.range(0.6, 2.4), l = rng.next() < 0.5;
      this._wrapDot(ctx, S, rng.range(0, S), rng.range(0, S), r, l ? 'rgba(255,240,210,.35)' : 'rgba(70,50,30,.30)');
    }
    return this._finish(c);
  },

  plaster() {
    const S = 512, c = this._canvas(S), ctx = c.getContext('2d');
    const base = [214, 190, 146], worn = [188, 160, 118];
    this._pixels(ctx, S, S, (u, v, x, y, o) => {
      const n = tileFbm(u, v, 3, 5, 21);
      const n2 = tileFbm(u, v, 24, 3, 22);
      const b = smoothstep(0.62, 0.8, tileFbm(u, v, 5, 4, 23)) * 0.7;
      const k = 0.9 + n * 0.12 + (n2 - 0.5) * 0.08 + (Math.random() - 0.5) * 0.05;
      o[0] = clamp(lerp(base[0], worn[0], b) * k, 0, 255);
      o[1] = clamp(lerp(base[1], worn[1], b) * k, 0, 255);
      o[2] = clamp(lerp(base[2], worn[2], b) * k, 0, 255);
    });
    // 裂纹（保持在中间区域，避免破坏平铺）
    const rng = new RNG(99);
    ctx.strokeStyle = 'rgba(70,52,34,.35)'; ctx.lineWidth = 1;
    for (let i = 0; i < 7; i++) {
      let x = rng.range(80, S - 80), y = rng.range(80, S - 80);
      ctx.beginPath(); ctx.moveTo(x, y);
      for (let k = 0; k < 12; k++) { x += rng.range(-9, 9); y += rng.range(-2, 11); ctx.lineTo(x, y); }
      ctx.stroke();
    }
    return this._finish(c);
  },

  /** 石块墙（错缝砌筑） */
  blocks(base, seed, bw, bh, S = 512) {
    const c = this._canvas(S), ctx = c.getContext('2d');
    const mortar = 3;
    this._pixels(ctx, S, S, (u, v, x, y, o) => {
      const row = Math.floor(y / bh);
      const off = (row % 2) * (bw / 2);
      const bx = Math.floor(((x + off) % S) / bw);
      const lx = (x + off) % bw, ly = y % bh;
      const n = tileFbm(u, v, 8, 4, seed);
      if (lx < mortar || ly < mortar) {
        this._set(o, base, 0.62 + n * 0.15);
        return;
      }
      const tint = 0.85 + hash2(bx, row, seed) * 0.28;
      let k = tint * (0.86 + n * 0.22 + (Math.random() - 0.5) * 0.06);
      // 边缘倒角：左上亮、右下暗
      if (lx < mortar + 4 || ly < mortar + 4) k *= 1.08;
      else if (lx > bw - 5 || ly > bh - 5) k *= 0.88;
      this._set(o, base, k);
    });
    return this._finish(c);
  },

  bricks() {
    const S = 512, c = this._canvas(S), ctx = c.getContext('2d');
    const base = [158, 92, 64], mortar = [176, 164, 146];
    const bw = 64, bh = 32;
    this._pixels(ctx, S, S, (u, v, x, y, o) => {
      const row = Math.floor(y / bh);
      const off = (row % 2) * (bw / 2);
      const bx = Math.floor(((x + off) % S) / bw);
      const lx = (x + off) % bw, ly = y % bh;
      const n = tileFbm(u, v, 16, 3, 41);
      if (lx < 3 || ly < 3) { this._set(o, mortar, 0.8 + n * 0.2); return; }
      const h = hash2(bx, row, 42);
      const k = (0.78 + h * 0.34) * (0.88 + n * 0.2 + (Math.random() - 0.5) * 0.08);
      o[0] = clamp(base[0] * k, 0, 255); o[1] = clamp((base[1] + h * 18) * k, 0, 255); o[2] = clamp((base[2] + h * 10) * k, 0, 255);
    });
    return this._finish(c);
  },

  tiles() {
    const S = 512, c = this._canvas(S), ctx = c.getContext('2d');
    const base = [196, 178, 142];
    const ts = 128, grout = 4;
    this._pixels(ctx, S, S, (u, v, x, y, o) => {
      const tx = Math.floor(x / ts), ty = Math.floor(y / ts);
      const lx = x % ts, ly = y % ts;
      const n = tileFbm(u, v, 6, 4, 61);
      if (lx < grout || ly < grout) { this._set(o, base, 0.55 + n * 0.12); return; }
      const h = hash2(tx, ty, 62);
      const k = (0.84 + h * 0.22) * (0.88 + n * 0.2 + (Math.random() - 0.5) * 0.07);
      this._set(o, base, k);
    });
    const rng = new RNG(63);
    ctx.strokeStyle = 'rgba(60,48,32,.4)'; ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      const tx = rng.int(0, 3) * ts, ty = rng.int(0, 3) * ts;
      ctx.beginPath(); ctx.moveTo(tx + rng.range(10, 118), ty + 6);
      ctx.lineTo(tx + rng.range(20, 108), ty + rng.range(40, 90)); ctx.lineTo(tx + rng.range(10, 118), ty + 122);
      ctx.stroke();
    }
    return this._finish(c);
  },

  concrete() {
    const S = 256, c = this._canvas(S), ctx = c.getContext('2d');
    const base = [156, 152, 144];
    this._pixels(ctx, S, S, (u, v, x, y, o) => {
      const n = tileFbm(u, v, 4, 5, 71);
      const st = smoothstep(0.6, 0.8, tileFbm(u, v, 3, 3, 72));
      const k = (0.82 + n * 0.26 + (Math.random() - 0.5) * 0.08) * (1 - st * 0.18);
      this._set(o, base, k);
    });
    return this._finish(c);
  },

  /** 木箱：每个面完整映射一张（UV 0..1） */
  crate() {
    const S = 256, c = this._canvas(S), ctx = c.getContext('2d');
    const base = [158, 116, 66], frame = [122, 86, 48];
    const bw = 26;
    this._pixels(ctx, S, S, (u, v, x, y, o) => {
      const inFrame = x < bw || y < bw || x >= S - bw || y >= S - bw;
      const d = Math.abs((x - y)) ; // 对角支撑
      const inBrace = !inFrame && d < bw * 0.72;
      const grainDir = inFrame ? (x < bw || x >= S - bw ? x : y) : (inBrace ? (x + y) * 0.7 : y);
      const n = tileFbm(u, v, 8, 3, 81);
      const grain = 0.5 + 0.5 * Math.sin(grainDir * 0.9 + n * 14);
      let k = 0.8 + grain * 0.16 + (Math.random() - 0.5) * 0.06;
      const col = inFrame || inBrace ? frame : base;
      // 内部木板缝
      if (!inFrame && !inBrace && (y % 51) < 2) k *= 0.55;
      // 框与板交界阴影
      if (!inFrame && (x < bw + 3 || y < bw + 3 || x > S - bw - 4 || y > S - bw - 4)) k *= 0.7;
      if (!inFrame && !inBrace && d < bw * 0.72 + 3) k *= 0.72;
      this._set(o, col, k);
    });
    // 钉子
    for (const [x, y] of [[13, 13], [S - 13, 13], [13, S - 13], [S - 13, S - 13], [S / 2, 13], [S / 2, S - 13], [13, S / 2], [S - 13, S / 2]]) {
      ctx.fillStyle = 'rgba(40,36,32,.85)'; ctx.beginPath(); ctx.arc(x, y, 3, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(200,190,170,.35)'; ctx.beginPath(); ctx.arc(x - 1, y - 1, 1.2, 0, TAU); ctx.fill();
    }
    return this._finish(c);
  },

  planks() {
    const S = 256, c = this._canvas(S), ctx = c.getContext('2d');
    const base = [140, 102, 62];
    const pw = 32;
    this._pixels(ctx, S, S, (u, v, x, y, o) => {
      const p = Math.floor(x / pw);
      const lx = x % pw;
      const n = tileFbm(u, v, 4, 3, 91 + p);
      const grain = 0.5 + 0.5 * Math.sin(x * 1.3 + n * 20 + p * 3);
      let k = (0.78 + hash2(p, 0, 92) * 0.25) * (0.86 + grain * 0.14 + (Math.random() - 0.5) * 0.05);
      if (lx < 2) k *= 0.45;
      // 横向接缝
      const seam = (y + p * 83) % 256;
      if (seam < 2) k *= 0.5;
      this._set(o, base, k);
    });
    return this._finish(c);
  },

  metal() {
    const S = 256, c = this._canvas(S), ctx = c.getContext('2d');
    const base = [108, 118, 126], rust = [132, 78, 44];
    this._pixels(ctx, S, S, (u, v, x, y, o) => {
      const corr = 0.82 + 0.18 * Math.sin(u * TAU * 16);
      const n = tileFbm(u, v, 5, 4, 101);
      const r = smoothstep(0.58, 0.75, tileFbm(u, v, 6, 4, 102));
      const k = corr * (0.86 + n * 0.2 + (Math.random() - 0.5) * 0.05);
      o[0] = clamp(lerp(base[0], rust[0], r) * k, 0, 255);
      o[1] = clamp(lerp(base[1], rust[1], r) * k, 0, 255);
      o[2] = clamp(lerp(base[2], rust[2], r) * k, 0, 255);
    });
    return this._finish(c);
  },

  // ------------------------------------------------------------------
  //  粒子/贴花纹理（带透明通道，不平铺）
  // ------------------------------------------------------------------
  softCircle() {
    const S = 64, c = this._canvas(S), ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.4, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    return this._finish(c, false);
  },
  smokePuff() {
    const S = 128, c = this._canvas(S), ctx = c.getContext('2d');
    this._pixels(ctx, S, S, (u, v, x, y, o) => {
      const dx = u - 0.5, dy = v - 0.5;
      const d = Math.sqrt(dx * dx + dy * dy) * 2;
      const n = tileFbm(u, v, 4, 4, 111);
      const a = clamp((1 - d) * 1.6, 0, 1) * (0.55 + n * 0.7);
      const k = 200 + n * 55;
      o[0] = k; o[1] = k; o[2] = k; o[3] = clamp(a * 255, 0, 255);
    });
    return this._finish(c, false);
  },
  muzzleFlash() {
    const S = 128, c = this._canvas(S), ctx = c.getContext('2d');
    ctx.translate(S / 2, S / 2);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 7; i++) {
      ctx.save();
      ctx.rotate(i / 7 * TAU + Math.random() * 0.3);
      const len = S * (0.32 + Math.random() * 0.16);
      const g = ctx.createLinearGradient(0, 0, len, 0);
      g.addColorStop(0, 'rgba(255,235,170,1)'); g.addColorStop(0.5, 'rgba(255,170,60,.6)'); g.addColorStop(1, 'rgba(255,120,20,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(len, 0); ctx.lineTo(0, 7); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, S * 0.24);
    g.addColorStop(0, 'rgba(255,255,230,1)'); g.addColorStop(0.5, 'rgba(255,200,90,.7)'); g.addColorStop(1, 'rgba(255,140,30,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, S * 0.24, 0, TAU); ctx.fill();
    return this._finish(c, false);
  },
  bulletHole() {
    const S = 64, c = this._canvas(S), ctx = c.getContext('2d');
    this._pixels(ctx, S, S, (u, v, x, y, o) => {
      const dx = u - 0.5, dy = v - 0.5;
      const d = Math.sqrt(dx * dx + dy * dy) * 2;
      const ang = Math.atan2(dy, dx);
      const rough = 0.32 + 0.1 * Math.sin(ang * 7) + 0.06 * Math.sin(ang * 13);
      let a = 0, k = 20;
      if (d < 0.16) { a = 1; k = 12; }
      else if (d < rough) { a = 0.75; k = 45; }
      else if (d < rough + 0.25) { a = 0.35 * (1 - (d - rough) / 0.25); k = 60; }
      o[0] = k; o[1] = k * 0.92; o[2] = k * 0.85; o[3] = a * 255;
    });
    return this._finish(c, false);
  },
  bloodSplat() {
    const S = 64, c = this._canvas(S), ctx = c.getContext('2d');
    const rng = new RNG(131);
    for (let i = 0; i < 14; i++) {
      const r = rng.range(3, 12), a = rng.range(0, TAU), d = rng.range(0, 18);
      ctx.fillStyle = `rgba(${110 + rng.int(0, 40)},8,8,${rng.range(0.6, 0.95)})`;
      ctx.beginPath(); ctx.arc(S / 2 + Math.cos(a) * d, S / 2 + Math.sin(a) * d, r, 0, TAU); ctx.fill();
    }
    return this._finish(c, false);
  },
  scorch() {
    const S = 128, c = this._canvas(S), ctx = c.getContext('2d');
    this._pixels(ctx, S, S, (u, v, x, y, o) => {
      const dx = u - 0.5, dy = v - 0.5;
      const d = Math.sqrt(dx * dx + dy * dy) * 2;
      const n = tileFbm(u, v, 5, 4, 141);
      const a = clamp((1 - d) * (0.6 + n * 0.8), 0, 0.9);
      o[0] = 18; o[1] = 15; o[2] = 12; o[3] = a * 255;
    });
    return this._finish(c, false);
  },

  /** 墙上喷漆标识（包点字母、方向箭头）。箭头用图形绘制，不依赖字体字形 */
  sign(text, color = 'rgba(200,30,20,.88)', w = 256, h = 256, font = 190) {
    const c = this._canvas(w, h), ctx = c.getContext('2d');
    ctx.fillStyle = color;
    ctx.font = `900 ${font}px "Arial Black", "Segoe UI", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const arrows = { '→': 0, '↑': -Math.PI / 2, '←': Math.PI, '↓': Math.PI / 2 };
    const parts = text.split(' ').filter(Boolean);
    const aw = font * 0.95;
    const widths = parts.map(p => arrows[p] !== undefined ? aw : ctx.measureText(p).width);
    const gap = font * 0.18;
    let x = w / 2 - (widths.reduce((a, b) => a + b, 0) + gap * (parts.length - 1)) / 2;
    parts.forEach((p, i) => {
      const cx = x + widths[i] / 2, cy = h / 2;
      if (arrows[p] !== undefined) {
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(arrows[p]);
        const L = aw * 0.5, t = font * 0.13, hd = font * 0.32;
        ctx.beginPath();
        ctx.moveTo(-L, -t); ctx.lineTo(L - hd, -t); ctx.lineTo(L - hd, -hd); ctx.lineTo(L, 0);
        ctx.lineTo(L - hd, hd); ctx.lineTo(L - hd, t); ctx.lineTo(-L, t); ctx.closePath(); ctx.fill();
        ctx.restore();
      } else ctx.fillText(p, cx, cy + font * 0.04);
      x += widths[i] + gap;
    });
    // 喷漆的斑驳感：随机擦除
    ctx.globalCompositeOperation = 'destination-out';
    const rng = new RNG(text.length * 17 + w);
    for (let i = 0; i < 260; i++) {
      ctx.fillStyle = `rgba(0,0,0,${rng.range(0.2, 0.7)})`;
      ctx.beginPath(); ctx.arc(rng.range(0, w), rng.range(0, h), rng.range(0.5, 3), 0, TAU); ctx.fill();
    }
    const tex = this._finish(c, false);
    return tex;
  },
};
