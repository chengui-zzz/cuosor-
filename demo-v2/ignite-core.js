/*!
 * Caret Ignite · Cursor 开机动画第二稿（科幻交互版）v0.2
 *
 * 和第一稿一样的硬约束：不用 innerHTML / eval，不加载外部资源，出错立即自毁，12 秒必定收尾。
 * 这一稿让画面跟着鼠标走，所以时间分成两条：
 *  - 剧情时间线：无人机焊接、字标、点火，是（启动里程碑, 就绪时刻, 点火时刻）的纯函数
 *  - 环境模拟：粒子、引力波、鼠标惯性，逐帧推进；随机数用固定种子，?t= 截图可以复现
 */
(function (global) {
  'use strict';

  const TAU = Math.PI * 2;
  const CAP_MS = 12000;
  const ISO_PITCH = -Math.atan(1 / Math.SQRT2); // 等轴视角：同时看到顶面和两个侧面，轮廓是正六边形
  const CAM_D = 6.5;
  const SMART_KEY = 'caret-ignite:lastStory';
  const BOOTS_KEY = 'caret-ignite:boots';

  const BONE = [237, 236, 236];
  const EMBER = [245, 78, 0];
  const HOT = [255, 200, 166];
  const COOL = [152, 211, 223];
  const FONT_MONO = '"Cascadia Code", "JetBrains Mono", "SF Mono", Consolas, "Microsoft YaHei UI", monospace';
  const FONT_DISPLAY = 'Bahnschrift, "DIN Alternate", "Segoe UI", sans-serif';

  const GATES = [
    { id: 'code/didStartRenderer', label: '渲染进程启动' },
    { id: 'code/didWaitForWindowConfig', label: '窗口配置就绪' },
    { id: 'code/didShowPartsSplash', label: '骨架屏绘制' },
    { id: 'code/willLoadWorkbenchMain', label: '开始加载工作台' },
    { id: 'code/didLoadWorkbenchMain', label: '工作台主包就绪' },
    { id: 'code/willStartWorkbench', label: '工作台开始启动' },
    { id: 'code/didRestoreViewlet', label: '侧栏恢复' },
    { id: 'code/didRestorePanel', label: '面板恢复' },
    { id: 'code/didRestoreEditors', label: '编辑器恢复' },
  ];
  const READY_MARK = 'code/didStartWorkbench';
  const TICKS = GATES.concat([{ id: READY_MARK, label: '工作台就绪' }]);

  // 立方体顶点 (±1, ±1, ±1)：第 i 个顶点的 x/y/z 取 i 的三个二进制位
  const VERTS = Array.from({ length: 8 }, (_, i) => [i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1]);
  // 三架无人机各走一条 0→7 号顶点的三段路线（x、y、z 三个方向轮换），再各补一条"赤道"边，刚好焊完 12 条边
  const ROUTES = [[0, 1, 3, 7], [0, 2, 6, 7], [0, 4, 5, 7]];
  const EQUATOR = [[1, 5], [2, 3], [4, 6]];
  const SPAWN_ARC = [[0.6, -0.2, 0.3], [-0.2, 0.6, 0.3], [0.3, -0.2, 0.6]];
  const FACES = [[0, 2, 6, 4], [1, 3, 7, 5], [0, 1, 5, 4], [2, 3, 7, 6], [0, 1, 3, 2], [4, 5, 7, 6]];
  const NORMALS = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];
  // 立方体的六个面 ↔ 工作台的六个区域；选择器与 VS Code / Cursor 的真实 DOM 一致
  const PARTS = [
    { sel: '.part.titlebar', label: '标题栏', en: 'TITLE BAR' },
    { sel: '.part.activitybar', label: '活动栏', en: 'ACTIVITY' },
    { sel: '.part.sidebar', label: '侧栏', en: 'SIDEBAR' },
    { sel: '.part.editor', label: '编辑器', en: 'EDITOR' },
    { sel: '.part.auxiliarybar', label: 'Agent 面板', en: 'AGENT' },
    { sel: '.part.statusbar', label: '状态栏', en: 'STATUS' },
  ];
  const CARET_SELECTORS = ['.monaco-editor.focused .cursors-layer > .cursor', '.monaco-editor .cursors-layer > .cursor'];
  const PERMS = (() => {
    const out = [];
    const rec = (pre, rest) => {
      if (!rest.length) return out.push(pre);
      rest.forEach((v, i) => rec(pre.concat(v), rest.filter((_, j) => j !== i)));
    };
    rec([], [0, 1, 2, 3, 4, 5]);
    return out;
  })();

  const TIMING = {
    story: {
      wake: 1000, coreAt: 380, spawnAt: 1150, spawnDur: 420, stagger: 110, edgeDur: 460, edgeGap: 100,
      flyDur: 360, eqDur: 420, armDelay: 260, auto: 1300, igniteDur: 1400,
    },
    brief: {
      wake: 480, coreAt: 100, spawnAt: 260, spawnDur: 220, stagger: 60, edgeDur: 210, edgeGap: 30,
      flyDur: 200, eqDur: 240, armDelay: 40, auto: 120, igniteDur: 1150,
    },
  };

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const seg = (t, s, d) => (d > 0 ? clamp((t - s) / d, 0, 1) : t >= s ? 1 : 0);
  const lerp = (a, b, p) => a + (b - a) * p;
  const lerp3 = (a, b, p) => [lerp(a[0], b[0], p), lerp(a[1], b[1], p), lerp(a[2], b[2], p)];
  const mix = lerp3;
  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp(a, 0, 1).toFixed(3)})`;
  const ease = {
    out2: (p) => 1 - (1 - p) * (1 - p),
    out3: (p) => 1 - (1 - p) ** 3,
    in2: (p) => p * p,
    io2: (p) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2),
    io3: (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2),
  };
  const hash = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const makeCanvas = (w, h) => {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  };
  function glowSprite(color) {
    const c = makeCanvas(64, 64), g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, rgba(color, 1));
    gr.addColorStop(0.22, rgba(color, 0.5));
    gr.addColorStop(1, rgba(color, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    return c;
  }
  function sprite(ctx, img, x, y, size, alpha) {
    if (alpha <= 0.003 || size <= 0.5) return;
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * Math.min(1, alpha);
    ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
    ctx.globalAlpha = prev;
  }
  function rotMatrix(yaw, pitch) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    return [cy, 0, sy, sp * sy, cp, -sp * cy, -cp * sy, sp, cp * cy];
  }
  function inPoly(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  const centroid = (pts) => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  function sortAround(pts) {
    const [cx, cy] = centroid(pts);
    return pts.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  }
  function defaultRects(W, H) {
    const tb = 35, sb = 22, ab = 44, side = Math.round(W * 0.19), aux = Math.round(W * 0.23), mid = H - tb - sb;
    return [
      { x: 0, y: 0, w: W, h: tb },
      { x: 0, y: tb, w: ab, h: mid },
      { x: ab, y: tb, w: side, h: mid },
      { x: ab + side, y: tb, w: W - ab - side - aux, h: mid },
      { x: W - aux, y: tb, w: aux, h: mid },
      { x: 0, y: H - sb, w: W, h: sb },
    ];
  }
  /** 正式版里点火时工作台已经就绪，直接量真实区域；量不到就按默认布局 */
  function partRects(W, H) {
    const def = defaultRects(W, H);
    return PARTS.map((p, i) => {
      const n = document.querySelector(p.sel);
      if (n) {
        const r = n.getBoundingClientRect();
        if (r.width > 4 && r.height > 4) return { x: r.left, y: r.top, w: r.width, h: r.height };
      }
      return def[i];
    });
  }
  /** 6 个面分配到 6 个区域：枚举 720 种排列，取总飞行距离最短的那种 */
  function bestAssign(cents, rects) {
    const rc = rects.map((r) => [r.x + r.w / 2, r.y + r.h / 2]);
    let best = PERMS[0], bestCost = Infinity;
    for (const p of PERMS) {
      let c = 0;
      for (let i = 0; i < 6 && c < bestCost; i++) {
        const dx = cents[i][0] - rc[p[i]][0], dy = cents[i][1] - rc[p[i]][1];
        c += dx * dx + dy * dy;
      }
      if (c < bestCost) { bestCost = c; best = p; }
    }
    return best;
  }
  function ymd(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function stardate(d) {
    const day = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
    return `${d.getFullYear()}.${String(day).padStart(3, '0')}`;
  }
  function greeting(d) {
    const hr = d.getHours();
    if (hr < 5) return '夜深了';
    if (hr < 11) return '早上好';
    if (hr < 13) return '中午好';
    if (hr < 18) return '下午好';
    if (hr < 23) return '晚上好';
    return '夜深了';
  }
  function resolveMode(mode, storage) {
    if (mode !== 'smart') return { mode, reason: '' };
    const today = ymd(new Date());
    let last = null;
    try { last = storage && storage.getItem(SMART_KEY); } catch (e) { /* 存储不可用就当第一次 */ }
    if (last !== today) {
      return { mode: 'story', reason: '今天第一次打开', commit() { try { storage.setItem(SMART_KEY, today); } catch (e) { /* ignore */ } } };
    }
    return { mode: 'brief', reason: '今天已经看过完整版' };
  }

  /** 可选音效：合成器嗡鸣跟着进度和鼠标变化，焊点有提示音，点火有低频轰鸣。默认关闭 */
  class Synth {
    constructor() {
      const AC = global.AudioContext || global.webkitAudioContext;
      const ac = (this.ac = new AC());
      this.out = ac.createGain();
      this.out.gain.value = 0.0001;
      this.out.connect(ac.destination);
      this.lp = ac.createBiquadFilter();
      this.lp.type = 'lowpass';
      this.lp.frequency.value = 260;
      this.lp.Q.value = 5;
      this.lp.connect(this.out);
      this.oscs = [55, 82.4, 110.2].map((f, i) => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = i === 1 ? 'triangle' : 'sawtooth';
        o.frequency.value = f;
        g.gain.value = i === 1 ? 0.5 : 0.22;
        o.connect(g);
        g.connect(this.lp);
        o.start();
        return o;
      });
      const len = ac.sampleRate;
      this.noise = ac.createBuffer(1, len, ac.sampleRate);
      const ch = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
      this.out.gain.setTargetAtTime(0.11, ac.currentTime, 0.5);
    }
    update(progress, mx, my, charge) {
      const now = this.ac.currentTime;
      this.lp.frequency.setTargetAtTime(160 + 1500 * progress * (1.2 - my) + 2400 * charge, now, 0.06);
      this.oscs.forEach((o, i) => o.detune.setTargetAtTime((mx - 0.5) * 70 * (i + 1) + charge * 320, now, 0.08));
    }
    blip(pitch) {
      const ac = this.ac, t = ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(900 * (pitch || 1), t);
      o.frequency.exponentialRampToValueAtTime(420 * (pitch || 1), t + 0.08);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      o.connect(g);
      g.connect(this.out);
      o.start(t);
      o.stop(t + 0.14);
    }
    boom() {
      const ac = this.ac, t = ac.currentTime;
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(130, t);
      o.frequency.exponentialRampToValueAtTime(32, t + 1.0);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.9, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
      o.connect(g);
      g.connect(ac.destination);
      o.start(t);
      o.stop(t + 1.25);
      const n = ac.createBufferSource(), hp = ac.createBiquadFilter(), ng = ac.createGain();
      n.buffer = this.noise;
      hp.type = 'highpass';
      hp.frequency.setValueAtTime(300, t);
      hp.frequency.exponentialRampToValueAtTime(6000, t + 0.7);
      ng.gain.setValueAtTime(0.25, t);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
      n.connect(hp);
      hp.connect(ng);
      ng.connect(ac.destination);
      n.start(t);
      n.stop(t + 0.85);
      this.out.gain.setTargetAtTime(0.0001, t + 0.3, 0.35);
    }
    stop() {
      const ac = this.ac;
      this.out.gain.setTargetAtTime(0.0001, ac.currentTime, 0.12);
      setTimeout(() => ac.close().catch(() => {}), 700);
    }
  }

  const GRAIN = 'url("data:image/svg+xml,' + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'>" +
    "<feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/>" +
    "<feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>"
  ) + '")';

  const CSS = `
:host { all: initial; position: fixed; inset: 0; z-index: 2147483000; display: block; overflow: hidden; contain: strict;
  cursor: none; user-select: none; -webkit-user-select: none; touch-action: none; }
.bgwrap, .void, .grain, .scan, .cv { position: absolute; inset: 0; }
.cv { width: 100%; height: 100%; display: block; }
.void { background: radial-gradient(120% 95% at 50% 44%, #17140D 0%, #0C0B07 52%, #050403 100%); }
.grain { inset: -10%; opacity: .06; background-image: ${GRAIN}; background-size: 180px 180px; mix-blend-mode: overlay; }
.scan { display: none; background: repeating-linear-gradient(to bottom, rgba(237, 236, 236, .035) 0 1px, transparent 1px 3px); }
:host([data-scene="holo"]) .scan { display: block; }
.fg { pointer-events: none; }
.drag { position: absolute; left: 0; right: 0; top: 0; height: 36px; cursor: default; -webkit-app-region: drag; app-region: drag; }
`;

  let uid = 0;

  class Ignite {
    constructor(opts) {
      this.o = Object.assign({
        parent: null,
        scene: 'gravity', // gravity | warp | holo
        mode: 'story', // story | brief（smart 先用 resolveMode 解析）
        workspace: '',
        now: null, // 外部时钟（Demo 用来暂停）；正式版不传，用真实时间
        marks: null, // 预置里程碑（Demo 用）；正式版通过 mark() 实时送入
        readyAt: undefined,
        autoDestroy: true,
        skipOnAnyKey: true,
        hideCaret: true,
        sound: false,
        reducedMotion: !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches),
        virtualMouse: null, // { x, y }（0–1），截图时代替真实鼠标
        virtualCharge: 0,
        seed: 20261013,
        onDone: null,
      }, opts || {});
      const factories = global.CaretIgniteScenes || {};
      this.sceneId = factories[this.o.scene] ? this.o.scene : 'gravity';
      this.mode = this.o.mode === 'story' ? 'story' : 'brief';
      this.T = TIMING[this.mode];
      this.rm = this.o.reducedMotion;
      this.id = ++uid;
      this.marks = GATES.map((_, i) => (this.o.marks && typeof this.o.marks[i] === 'number' ? this.o.marks[i] : undefined));
      this.readyAt = typeof this.o.readyAt === 'number' ? this.o.readyAt : undefined;
      this.userIgnite = null;
      this.ignited = false;
      this.finished = false;
      this.destroyed = false;
      this.t0 = performance.now();
      this.lastT = 0;
      this.at = 0;
      this.rand = rng(this.o.seed);
      this.ripples = [];
      this.sparks = [];
      this.m = {
        x: 0, y: 0, sx: 0, sy: 0, vx: 0, vy: 0, speed: 0, tx: 0, ty: 0, present: false,
        down: false, drag: false, downAt: 0, downX: 0, downY: 0, lx: 0, ly: 0, charge: 0, lastEmit: -1e9,
      };
      this.spin = { yaw: 0, pitch: 0, vy: 0, vp: 0 };
      this.gest = { acc: 0, last: null, t: 0 };
      this.lastOverdrive = -1e9;
      this.toast = null;
      this.lock = 0;
      this.frame = { cx: 0, cy: 0, R: 60, prog: 0, energy: 0, armedP: 0 };
      this.ws = this.o.workspace || 'workspace';
      const now = new Date();
      this.greet = greeting(now);
      this.stardate = stardate(now);
      this.boots = 1;
      try {
        this.boots = (parseInt(global.localStorage.getItem(BOOTS_KEY), 10) || 0) + 1;
        global.localStorage.setItem(BOOTS_KEY, String(this.boots));
      } catch (e) { /* ignore */ }
      this.env = {
        W: 0, H: 0, dpr: 1, at: 0, t: 0, rand: this.rand, rm: this.rm, wakeA: 0,
        m: { x: 0, y: 0, vx: 0, vy: 0, speed: 0, charge: 0, vis: 0 },
        core: { x: 0, y: 0, R: 60, energy: 0, vis: 0 },
        ignite: { p: -1, x: 0, y: 0 },
        ripples: this.ripples,
      };
      this.glow = { ember: glowSprite(EMBER), white: glowSprite(HOT), cool: glowSprite(COOL) };
      const sc = makeCanvas(1, 3), sg = sc.getContext('2d');
      sg.fillStyle = 'rgba(237,236,236,1)';
      sg.fillRect(0, 0, 1, 1);
      this.scanImg = sc;

      this._build();
      (this.o.parent || document.body || document.documentElement).appendChild(this.host);
      this._resize(true);
      this.scene = factories[this.sceneId](this.env);
      if (this.scene.resize) this.scene.resize(this.env);
      this.scanPattern = this.ctx.bg.createPattern(this.scanImg, 'repeat');
      this._schedule();
      this._bind();
      if (this.o.sound) this.setSound(true);
      this._tick = this._tick.bind(this);
      this.raf = requestAnimationFrame(this._tick);
    }

    get now() { return this.o.now ? this.o.now() : performance.now() - this.t0; }
    get duration() { return this.S.doneAt; }

    mark(name, startTime) {
      const rel = startTime === undefined ? this.now : Math.max(0, startTime - this.t0);
      if (name === READY_MARK) return this.ready(rel);
      const i = GATES.findIndex((g) => g.id === name);
      if (i >= 0 && this.marks[i] === undefined) { this.marks[i] = rel; this._schedule(); }
    }
    ready(at) {
      if (this.readyAt !== undefined) return;
      this.readyAt = at === undefined ? this.now : at;
      this._schedule();
    }
    /** 用户点火：按住充满、或单击（fast）；x/y 为空表示从核心点火（Esc） */
    ignite(x, y, fast) {
      if (this.userIgnite || this.ignited) return;
      this.userIgnite = { at: this.lastT, x, y, fast: !!fast };
      this._schedule();
    }
    skip() { this.ignite(null, null, true); }
    setSound(on) {
      if (on && !this.audio) {
        try { this.audio = new Synth(); } catch (e) { this.audio = null; }
      } else if (!on && this.audio) {
        this.audio.stop();
        this.audio = null;
      }
    }
    /** 截图用：按 60fps 把环境模拟推进到 t，画面才和真实播放一致 */
    warmup(t) {
      for (let tt = 16; tt <= t; tt += 16) this._step(tt, 16);
      this.lastT = t;
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      cancelAnimationFrame(this.raf);
      global.removeEventListener('pointermove', this._onMove, true);
      global.removeEventListener('pointerup', this._onUp, true);
      global.removeEventListener('keydown', this._onKey, true);
      global.removeEventListener('resize', this._onResize);
      if (this.audio) this.audio.stop();
      this.host.remove();
      if (this.gstyle) this.gstyle.remove();
    }

    phase(t) {
      const S = this.S, T = this.T;
      if (t >= S.doneAt) return '已交接，工作台可用';
      if (t >= S.igniteAt) return this.userIgnite && this.userIgnite.at <= S.igniteAt ? '手动点火：六个面展开成工作台' : '点火：六个面展开成工作台';
      if (this.rm) return '减弱动态：静帧';
      if (t < T.coreAt) return '苏醒：从鼠标位置点亮';
      if (t < T.spawnAt) return '核心成形';
      if (t < S.coreDone) {
        const w = this._waiting(t);
        const n = S.edges.filter((e) => t >= e.end).length;
        return w ? `焊接 ${n}/12 · 等待「${w}」` : `三架无人机焊接核心 ${n}/12`;
      }
      if (this.readyAt === undefined || t < this.readyAt + 60) return '核心就绪 · 等待工作台';
      return '核心已对准 · 按住鼠标可提前点火';
    }

    _waiting(t) {
      for (const e of this.S.edges) if (t >= e.earliest && t < e.start) return GATES[e.g].label;
      return '';
    }

    _build() {
      const host = (this.host = document.createElement('caret-ignite'));
      host.setAttribute('data-scene', this.sceneId);
      host.setAttribute('aria-hidden', 'true');
      const root = host.attachShadow({ mode: 'open' });
      const css = document.createElement('style');
      css.textContent = CSS;
      root.appendChild(css);
      const el = (tag, cls) => { const n = document.createElement(tag); n.className = cls; return n; };
      this.bgwrap = el('div', 'bgwrap');
      this.cv = { bg: el('canvas', 'cv'), fg: el('canvas', 'cv fg') };
      this.bgwrap.append(el('div', 'void'), this.cv.bg, el('div', 'grain'), el('div', 'scan'));
      root.append(this.bgwrap, this.cv.fg, el('div', 'drag'));
      this.ctx = { bg: this.cv.bg.getContext('2d'), fg: this.cv.fg.getContext('2d') };
      if (this.o.hideCaret) {
        this.gstyle = document.createElement('style');
        this.gstyle.setAttribute('data-caret-ignite', '');
        this.gstyle.textContent = CARET_SELECTORS[1] + ' { visibility: hidden !important; }';
        (document.head || document.documentElement).appendChild(this.gstyle);
      }
    }

    _bind() {
      const m = this.m;
      this._onMove = (e) => {
        m.x = e.clientX;
        m.y = e.clientY;
        if (!m.present) {
          m.present = true;
          if (this.at < 80) { m.sx = m.x; m.sy = m.y; }
        }
        if (m.down) {
          if (!m.drag && this.scene.cube && this.scene.cube.dragSpin && Math.hypot(m.x - m.downX, m.y - m.downY) > 7) m.drag = true;
          if (m.drag) {
            const dx = m.x - m.lx, dy = m.y - m.ly;
            this.spin.yaw += dx * 0.0085;
            this.spin.pitch = clamp(this.spin.pitch - dy * 0.006, -0.7, 0.7);
            this.spin.vy = lerp(this.spin.vy, (dx * 0.0085) / 16, 0.5);
            this.spin.vp = lerp(this.spin.vp, (-dy * 0.006) / 16, 0.5);
          }
          m.lx = m.x;
          m.ly = m.y;
        }
        this._gesture(m.x, m.y);
      };
      this._onDown = (e) => {
        if (e.button !== 0) return;
        Object.assign(m, { down: true, drag: false, downAt: this.lastT, downX: e.clientX, downY: e.clientY, lx: e.clientX, ly: e.clientY, x: e.clientX, y: e.clientY, present: true });
        if (this.audio && this.audio.ac.state === 'suspended') this.audio.ac.resume();
      };
      this._onUp = (e) => {
        if (!m.down) return;
        m.down = false;
        if (!m.drag && this.lastT - m.downAt < 220) this.ignite(e.clientX, e.clientY, true);
        m.drag = false;
      };
      this._onKey = (e) => {
        if (this.ignited) return;
        if (e.key === 'Escape') return this.skip();
        if (!this.o.skipOnAnyKey || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace' || e.key === 'Tab') this.skip();
      };
      this._onResize = () => this._resize(false);
      global.addEventListener('pointermove', this._onMove, true);
      global.addEventListener('pointerup', this._onUp, true);
      global.addEventListener('keydown', this._onKey, true);
      global.addEventListener('resize', this._onResize);
      this.host.addEventListener('pointerdown', this._onDown);
    }

    _resize(first) {
      const W = (this.W = global.innerWidth || 1280);
      const H = (this.H = global.innerHeight || 800);
      const dpr = (this.dpr = Math.min(global.devicePixelRatio || 1, 1.5));
      for (const c of [this.cv.bg, this.cv.fg]) {
        c.width = Math.round(W * dpr);
        c.height = Math.round(H * dpr);
      }
      Object.assign(this.env, { W, H, dpr });
      if (first) {
        const vm = this.o.virtualMouse;
        this.m.sx = this.m.x = vm ? vm.x * W : W / 2;
        this.m.sy = this.m.y = vm ? vm.y * H : H * 0.46;
      }
      this.rects = partRects(W, H);
      if (!first && this.scene && this.scene.resize) this.scene.resize(this.env);
    }

    _schedule() {
      const T = this.T, S = { edges: [], drones: [] };
      const gate = (g) => (this.marks[g] === undefined ? Infinity : this.marks[g]);
      const readyGate = this.readyAt === undefined ? Infinity : this.readyAt + 60;
      if (this.rm) {
        S.drones = [];
        ROUTES.forEach((r, k) => {
          r.slice(0, 3).forEach((a, j) => S.edges.push({ k, j, g: 3 * j + k, a, b: r[j + 1], earliest: 0, start: 0, end: 0 }));
          S.edges.push({ k, j: 3, g: 8, a: EQUATOR[k][0], b: EQUATOR[k][1], earliest: 0, start: 0, end: 0 });
        });
        S.coreDone = S.routesDone = S.armedAt = 0;
        S.igniteAt = Math.min(Math.max(700, readyGate), CAP_MS);
        S.igniteDur = 420;
      } else {
        let routesDone = 0, coreDone = 0;
        for (let k = 0; k < 3; k++) {
          const d = { k, spawn0: T.spawnAt + k * T.stagger };
          d.spawn1 = d.spawn0 + T.spawnDur;
          let prev = d.spawn1;
          d.route = [0, 1, 2].map((j) => {
            const g = 3 * j + k, earliest = j === 0 ? prev : prev + T.edgeGap;
            const start = Math.max(earliest, gate(g));
            const e = { k, j, g, a: ROUTES[k][j], b: ROUTES[k][j + 1], earliest, start, end: start + T.edgeDur, dur: T.edgeDur };
            prev = e.end;
            S.edges.push(e);
            return e;
          });
          d.fly0 = prev;
          d.fly1 = prev + T.flyDur;
          const eqStart = Math.max(d.fly1, gate(8));
          d.eq = { k, j: 3, g: 8, a: EQUATOR[k][0], b: EQUATOR[k][1], earliest: d.fly1, start: eqStart, end: eqStart + T.eqDur, dur: T.eqDur };
          S.edges.push(d.eq);
          routesDone = Math.max(routesDone, d.route[2].end);
          coreDone = Math.max(coreDone, d.eq.end);
          S.drones.push(d);
        }
        S.routesDone = routesDone;
        S.coreDone = coreDone;
        S.armedAt = coreDone + T.armDelay;
        S.igniteAt = Math.min(Math.max(S.armedAt + T.auto, readyGate), CAP_MS);
        S.igniteDur = T.igniteDur;
      }
      S.edges.forEach((e) => { if (!e.dur) e.dur = 0; });
      S.wordAt = this.rm ? 0 : Math.min(S.routesDone - 300, CAP_MS);
      S.origin = null;
      const u = this.userIgnite;
      if (u && u.at < S.igniteAt) {
        S.igniteAt = u.at;
        S.origin = u.x == null ? null : { x: u.x, y: u.y };
        if (u.fast) S.igniteDur = Math.min(S.igniteDur, 950);
      }
      const ends = new Map(S.edges.map((e) => [Math.min(e.a, e.b) * 8 + Math.max(e.a, e.b), e.end]));
      S.faceDone = FACES.map((fv) => Math.max(...fv.map((v, i) => {
        const w = fv[(i + 1) % 4];
        return ends.get(Math.min(v, w) * 8 + Math.max(v, w));
      })));
      S.doneAt = S.igniteAt + S.igniteDur;
      this.S = S;
    }

    _progress(t) {
      let s = 0;
      for (const e of this.S.edges) s += e.dur ? seg(t, e.start, e.dur) : t >= e.start ? 1 : 0;
      return s / 12;
    }

    _proj(v) {
      const M = this.M, f = this.frame;
      const x = M[0] * v[0] + M[1] * v[1] + M[2] * v[2];
      const y = M[3] * v[0] + M[4] * v[1] + M[5] * v[2];
      const z = M[6] * v[0] + M[7] * v[1] + M[8] * v[2];
      const s = (this.unit * CAM_D) / (CAM_D + z);
      return [f.cx + x * s, f.cy - y * s, z];
    }

    _dronePos3(d, t) {
      const T = this.T;
      if (t < d.spawn0) return null;
      if (t < d.spawn1) {
        const q = ease.io3(seg(t, d.spawn0, T.spawnDur)), p = lerp3([0, 0, 0], VERTS[0], q), b = Math.sin(q * Math.PI);
        return [p[0] + SPAWN_ARC[d.k][0] * b, p[1] + SPAWN_ARC[d.k][1] * b, p[2] + SPAWN_ARC[d.k][2] * b];
      }
      for (const e of d.route) {
        if (t < e.start) return VERTS[e.a];
        if (t < e.end) return lerp3(VERTS[e.a], VERTS[e.b], ease.io2(seg(t, e.start, e.dur)));
      }
      if (t < d.fly1) {
        const q = ease.io3(seg(t, d.fly0, T.flyDur)), p = lerp3(VERTS[7], VERTS[d.eq.a], q), s = 1 + Math.sin(q * Math.PI) * 0.45;
        return [p[0] * s, p[1] * s, p[2] * s];
      }
      if (t < d.eq.start) return VERTS[d.eq.a];
      if (t < d.eq.end) return lerp3(VERTS[d.eq.a], VERTS[d.eq.b], ease.io2(seg(t, d.eq.start, d.eq.dur)));
      const q = ease.io3(seg(t, d.eq.end, 600)), th = (t - d.eq.end) * 0.0016 + (d.k * TAU) / 3;
      return lerp3(VERTS[d.eq.b], [Math.cos(th) * 1.8, Math.sin(th * 2) * 0.24, Math.sin(th) * 1.8], q);
    }

    _droneWelding(d, t) {
      for (const e of d.route) if (t >= e.start && t < e.end) return true;
      return t >= d.eq.start && t < d.eq.end;
    }

    _ripple(x, y, amp, v, decay) {
      this.ripples.push({ x, y, t0: this.at, amp, v: v || 0.6, w: 34, decay: decay || 900 });
      if (this.ripples.length > 10) this.ripples.shift();
    }

    _burst(x, y, n, spd) {
      for (let i = 0; i < n; i++) {
        const a = this.rand() * TAU, s = (0.3 + this.rand() * 0.7) * spd;
        this.sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, age: 0, life: 300 + this.rand() * 500 });
      }
    }

    _gesture(x, y) {
      const f = this.frame, g = this.gest;
      if (this.ignited || this.rm) return;
      const dx = x - f.cx, dy = y - f.cy, r = Math.hypot(dx, dy);
      if (r < f.R * 1.1 || r > Math.min(this.W, this.H) * 0.48) { g.acc = 0; g.last = null; return; }
      const a = Math.atan2(dy, dx);
      if (g.last != null) {
        let d = a - g.last;
        if (d > Math.PI) d -= TAU;
        if (d < -Math.PI) d += TAU;
        if (this.at - g.t > 900 || (Math.sign(d) !== Math.sign(g.acc) && Math.abs(g.acc) > 0.6)) g.acc = 0;
        g.acc += d;
        g.t = this.at;
        if (Math.abs(g.acc) > TAU * 0.95 && this.at - this.lastOverdrive > 2500) {
          this.lastOverdrive = this.at;
          this.spin.vy += Math.sign(g.acc) * 0.012;
          this._ripple(f.cx, f.cy, 46, 1.0, 1400);
          this._burst(f.cx, f.cy, 70, 0.45);
          this.toast = { text: '超频 · OVERDRIVE', at: this.at };
          if (this.audio) this.audio.blip(1.6);
          g.acc = 0;
        }
      }
      g.last = a;
    }

    /** 环境模拟：鼠标惯性、充能、无人机火花、引力波、场景粒子 */
    _step(t, dt) {
      this.at += dt;
      const m = this.m, W = this.W, H = this.H, S = this.S, vm = this.o.virtualMouse;
      let tx, ty;
      if (vm) { tx = vm.x * W; ty = vm.y * H; m.present = true; } else if (m.present) { tx = m.x; ty = m.y; } else {
        tx = W / 2 + Math.sin(this.at / 2700) * W * 0.13; // 没有鼠标时自动巡航，画面不至于死板
        ty = H * 0.46 + Math.cos(this.at / 3300) * H * 0.09;
      }
      const k = 1 - Math.exp(-dt / 90), px = m.sx, py = m.sy;
      m.sx += (tx - m.sx) * k;
      m.sy += (ty - m.sy) * k;
      if (dt > 0) { m.vx = (m.sx - px) / dt; m.vy = (m.sy - py) / dt; }
      m.speed = Math.hypot(m.vx, m.vy);
      if (!this.rm && !this.ignited && m.speed > 1.1 && this.at - m.lastEmit > 110) {
        this._ripple(m.sx, m.sy, Math.min(26, m.speed * 9), 0.55);
        m.lastEmit = this.at;
      }
      if (this.o.virtualCharge > 0) m.charge = this.o.virtualCharge;
      else m.charge = m.down && !m.drag && !this.ignited ? Math.min(1, m.charge + dt / 750) : Math.max(0, m.charge - dt / 320);
      if (m.down && !m.drag && m.charge >= 1 && !this.ignited) this.ignite(m.sx, m.sy, false);

      const sp = this.spin;
      if (!(m.down && m.drag)) {
        sp.yaw += sp.vy * dt;
        sp.pitch = clamp(sp.pitch + sp.vp * dt, -0.7, 0.7);
        sp.vy *= Math.exp(-dt / 900);
        sp.vp *= Math.exp(-dt / 500);
      }
      if (t >= S.armedAt && Math.abs(sp.vy) < 0.002) {
        const target = Math.round(sp.yaw / (Math.PI / 2)) * (Math.PI / 2); // 对准：转回最近的等轴角度
        sp.yaw += (target - sp.yaw) * (1 - Math.exp(-dt / 380));
        sp.pitch += -sp.pitch * (1 - Math.exp(-dt / 380));
      }

      this._updateEnv(t, dt);
      const prev = t - dt;
      if (!this.ignited) {
        for (const e of S.edges) {
          if (e.end > prev && e.end <= t && e.dur) {
            const p = this._proj(VERTS[e.b]);
            this._ripple(p[0], p[1], 9, 0.5, 700); // 每焊完一条边，放出一圈引力波
            if (this.audio) this.audio.blip(1 + e.g * 0.06);
          }
        }
      }
      if (!this.ignited && t >= S.igniteAt) this._onIgnite();
      if (!this.rm && !this.ignited) {
        for (const d of S.drones) {
          if (!this._droneWelding(d, t)) continue;
          const p = this._proj(this._dronePos3(d, t));
          const n = Math.round((dt / 9) * (0.6 + this.rand() * 0.8));
          for (let i = 0; i < n; i++) {
            const a = this.rand() * TAU, s = 0.05 + this.rand() * 0.27;
            this.sparks.push({ x: p[0], y: p[1], vx: Math.cos(a) * s, vy: Math.sin(a) * s - 0.06, age: 0, life: 260 + this.rand() * 360 });
          }
        }
      }
      for (const s of this.sparks) {
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.vy += 0.00055 * dt;
        s.vx *= Math.exp(-dt / 900);
        s.age += dt;
      }
      this.sparks = this.sparks.filter((s) => s.age < s.life);
      if (this.sparks.length > 420) this.sparks.splice(0, this.sparks.length - 420);
      for (let i = this.ripples.length - 1; i >= 0; i--) if (this.at - this.ripples[i].t0 > this.ripples[i].decay * 3) this.ripples.splice(i, 1);
      this.scene.update(this.env, dt);
      if (this.audio) this.audio.update(this.frame.prog, m.sx / W, m.sy / H, m.charge);
    }

    _updateEnv(t, dt) {
      const S = this.S, T = this.T, m = this.m, W = this.W, H = this.H, cfg = this.scene.cube || {}, f = this.frame;
      const prog = this._progress(t);
      const armedP = this.rm ? 1 : ease.io3(seg(t, S.armedAt, 650));
      const kt = 1 - Math.exp(-dt / 260);
      m.tx += ((m.sx - W / 2) / W - m.tx) * kt;
      m.ty += ((m.sy - H / 2) / H - m.ty) * kt;
      const tilt = this.rm ? 0 : lerp(1, 0.3, armedP);
      const osc = this.rm ? 0 : 0.2 * Math.sin(this.at / 2600) * (1 - armedP);
      this.M = rotMatrix(Math.PI / 4 + osc + m.tx * tilt + this.spin.yaw, ISO_PITCH + m.ty * 0.7 * tilt + this.spin.pitch);
      let R = clamp(Math.min(W, H) * 0.12, 46, 132) * (cfg.scale || 1);
      if (cfg.grow) R *= lerp(0.5, 1, ease.out2(prog));
      const par = this.rm ? 0 : cfg.parallax == null ? 0.035 : cfg.parallax;
      const baseY = H * (cfg.y || 0.43);
      f.cx = W / 2 + (m.sx - W / 2) * par;
      f.cy = baseY + (m.sy - baseY) * par;
      f.R = R;
      f.prog = prog;
      f.armedP = armedP;
      f.energy = clamp(0.18 + 0.82 * prog, 0, 1);
      this.unit = R / 1.3;
      const env = this.env;
      env.at = this.at;
      env.t = t;
      env.wakeA = this.rm ? 1 : ease.out2(seg(t, 0, T.wake));
      Object.assign(env.m, { x: m.sx, y: m.sy, vx: m.vx, vy: m.vy, speed: m.speed, charge: m.charge, vis: m.present ? 1 : 0.55 });
      Object.assign(env.core, { x: f.cx, y: f.cy, R, energy: f.energy, vis: this.rm ? 1 : ease.out3(seg(t, T.coreAt, 600)) });
      env.ignite.p = this.ignited ? seg(t, S.igniteAt, S.igniteDur) : -1;
    }

    _faceQuads() {
      return FACES.map((fv) => fv.map((v) => this._proj(VERTS[v])));
    }

    _assign(quads) {
      const f = this.frame, k = Math.min(this.W, this.H) / (2 * f.R);
      const cents = quads.map((q) => { const c = centroid(q); return [f.cx + (c[0] - f.cx) * k, f.cy + (c[1] - f.cy) * k]; });
      return bestAssign(cents, this.rects);
    }

    _onIgnite() {
      this.ignited = true;
      const S = this.S, f = this.frame;
      const o = S.origin ? { x: S.origin.x, y: S.origin.y } : { x: f.cx, y: f.cy };
      this.rects = partRects(this.W, this.H);
      const quads = this._faceQuads();
      const assign = this._assign(quads);
      const faces = quads.map((q, i) => {
        const r = this.rects[assign[i]];
        const rc = sortAround([[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]]);
        const qs = sortAround(q.map((p) => [p[0], p[1]]));
        let bestS = 0, bestD = Infinity;
        for (let s = 0; s < 4; s++) {
          let d = 0;
          for (let j = 0; j < 4; j++) d += (qs[(j + s) % 4][0] - rc[j][0]) ** 2 + (qs[(j + s) % 4][1] - rc[j][1]) ** 2;
          if (d < bestD) { bestD = d; bestS = s; }
        }
        return { from: [0, 1, 2, 3].map((j) => qs[(j + bestS) % 4]), to: rc, part: assign[i] };
      });
      let caret = null;
      for (const s of CARET_SELECTORS) {
        const n = document.querySelector(s);
        if (n) { const r = n.getBoundingClientRect(); if (r.height > 0) { caret = { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height }; break; } }
      }
      const far = Math.max(...[[0, 0], [this.W, 0], [0, this.H], [this.W, this.H]].map(([x, y]) => Math.hypot(x - o.x, y - o.y)));
      this.ig = { o, core: { x: f.cx, y: f.cy, R: f.R }, faces, caret, far };
      this.env.ignite.x = o.x;
      this.env.ignite.y = o.y;
      this._ripple(o.x, o.y, 70, 1.4, 1600);
      this._burst(f.cx, f.cy, 90, 0.6);
      if (this.audio) this.audio.boom();
    }

    _tick() {
      if (this.destroyed) return;
      try {
        const t = this.now;
        const dt = clamp(t - this.lastT, 0, 50);
        this.lastT = t;
        this._step(t, dt);
        const done = t >= this.S.doneAt;
        if (done) {
          this.finished = true;
          this.host.style.visibility = 'hidden';
          if (this.gstyle) this.gstyle.media = 'not all';
          if (this.audio) { this.audio.stop(); this.audio = null; }
          if (this.o.onDone) this.o.onDone();
          if (this.o.autoDestroy) this.destroy();
          return;
        }
        this._draw(t);
      } catch (err) {
        this.destroy(); // 开机动画出任何错都不能挡住工作台
        if (global.console) console.error('[caret-ignite]', err);
        return;
      }
      this.raf = requestAnimationFrame(this._tick);
    }

    /** 截图或暂停时直接画某一帧 */
    renderAt(t) {
      this._draw(t);
    }

    _draw(t) {
      const { bg, fg } = this.ctx, W = this.W, H = this.H, dpr = this.dpr, S = this.S, env = this.env;
      bg.setTransform(dpr, 0, 0, dpr, 0, 0);
      fg.setTransform(dpr, 0, 0, dpr, 0, 0);
      bg.clearRect(0, 0, W, H);
      fg.clearRect(0, 0, W, H);

      this.scene.drawBack(bg, env);
      if (env.wakeA < 1) {
        // 苏醒：从鼠标所在的位置向外点亮整个场景
        const r = env.wakeA * Math.hypot(W, H) * 1.05;
        const g = bg.createRadialGradient(env.m.x, env.m.y, Math.max(0, r - 280), env.m.x, env.m.y, r + 1);
        g.addColorStop(0, 'rgba(0,0,0,1)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        bg.globalCompositeOperation = 'destination-in';
        bg.fillStyle = g;
        bg.fillRect(0, 0, W, H);
        bg.globalCompositeOperation = 'source-over';
      }
      this._drawCube(bg, t);
      if (this.scene.postBack) this.scene.postBack(bg, env, this.cv.bg);

      this._drawSparks(fg);
      this._drawHud(fg, t);
      if (this.ignited) this._drawIgnition(fg, t);
      if (this.scene.drawFront) this.scene.drawFront(fg, env);

      const ip = env.ignite.p;
      if (ip >= 0 && !this.rm) {
        const o = this.ig.o, rr = ease.io3(seg(ip, 0.03, 0.62)) * this.ig.far;
        const mask = `radial-gradient(circle at ${o.x.toFixed(1)}px ${o.y.toFixed(1)}px, transparent ${rr.toFixed(1)}px, #000 ${(rr + 90).toFixed(1)}px)`;
        this.bgwrap.style.maskImage = mask;
        this.bgwrap.style.webkitMaskImage = mask;
      } else if (ip >= 0) {
        this.bgwrap.style.opacity = String(1 - ip);
      }
      if (this.gstyle) this.gstyle.media = ip >= 0.8 ? 'not all' : 'all';
    }

    _drawCube(ctx, t) {
      const S = this.S, T = this.T, f = this.frame;
      const fade = this.ignited ? 1 - seg(t, S.igniteAt, S.igniteDur * 0.06) : 1;
      if (fade <= 0) return;
      const coreVis = this.env.core.vis;
      const P = VERTS.map((v) => this._proj(v));

      // 核心：奇点和光晕，能量随焊接进度上升
      if (coreVis > 0) {
        const e = f.energy * coreVis, flick = 0.9 + 0.1 * Math.sin(this.at / 70) * Math.sin(this.at / 23);
        ctx.globalCompositeOperation = 'lighter';
        sprite(ctx, this.glow.ember, f.cx, f.cy, f.R * (1.2 + 2.2 * e), 0.5 * e * flick * fade);
        sprite(ctx, this.glow.white, f.cx, f.cy, f.R * (0.25 + 0.35 * e), 0.85 * coreVis * flick * fade);
        ctx.globalCompositeOperation = 'source-over';
      }

      // 面：四条边都焊好才显形；朝向镜头的面叠一层全息扫描线
      FACES.forEach((fv, i) => {
        const a = (this.rm ? 1 : ease.out3(seg(t, S.faceDone[i], 520))) * fade;
        if (a <= 0) return;
        const n = NORMALS[i], M = this.M;
        const front = M[6] * n[0] + M[7] * n[1] + M[8] * n[2] < 0;
        ctx.beginPath();
        fv.forEach((v, j) => (j ? ctx.lineTo(P[v][0], P[v][1]) : ctx.moveTo(P[v][0], P[v][1])));
        ctx.closePath();
        ctx.fillStyle = rgba(BONE, (front ? 0.07 : 0.022) * a);
        ctx.fill();
        if (front && this.scanPattern) {
          if (this.scanPattern.setTransform && global.DOMMatrix) this.scanPattern.setTransform(new DOMMatrix().translateSelf(0, (this.at * 0.02) % 3));
          ctx.globalAlpha = 0.09 * a;
          ctx.fillStyle = this.scanPattern;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      });

      // 边：两遍描边，外层是热光，内层是线芯；刚焊完的边还是橙热的
      ctx.lineCap = 'round';
      for (const e of S.edges) {
        const q = this.rm ? 1 : e.dur ? seg(t, e.start, e.dur) : t >= e.start ? 1 : 0;
        if (q <= 0) continue;
        const A = VERTS[e.a], pa = P[e.a], pb = this._proj(lerp3(A, VERTS[e.b], ease.io2(q)));
        const heat = this.rm ? 0 : q < 1 ? 1 : 1 - seg(t, e.end, 900);
        const depth = clamp(0.62 - (pa[2] + pb[2]) * 0.22, 0.3, 1);
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = rgba(mix(BONE, EMBER, heat), (0.12 * depth + 0.22 * heat) * fade);
        ctx.lineWidth = 5 + 3 * heat;
        ctx.beginPath();
        ctx.moveTo(pa[0], pa[1]);
        ctx.lineTo(pb[0], pb[1]);
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = rgba(mix(BONE, HOT, heat), (0.45 + 0.55 * depth) * fade);
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }

      // 无人机：带尾迹的橙色光点；点火后向外散开
      if (this.rm) return;
      const ip = this.env.ignite.p;
      ctx.globalCompositeOperation = 'lighter';
      for (const d of S.drones) {
        const p3 = this._dronePos3(d, t);
        if (!p3) continue;
        const spread = ip >= 0 ? 1 + ease.out3(ip) * 7 : 1;
        const alpha = ip >= 0 ? 1 - seg(ip, 0, 0.35) : 1;
        if (alpha <= 0) continue;
        const pos = this._proj([p3[0] * spread, p3[1] * spread, p3[2] * spread]);
        ctx.beginPath();
        let first = true;
        for (let i = 1; i <= 8; i++) {
          const q3 = this._dronePos3(d, t - i * 22);
          if (!q3) break;
          const q = this._proj([q3[0] * spread, q3[1] * spread, q3[2] * spread]);
          if (first) { ctx.moveTo(pos[0], pos[1]); first = false; }
          ctx.lineTo(q[0], q[1]);
        }
        ctx.strokeStyle = rgba(EMBER, 0.55 * alpha);
        ctx.lineWidth = 2;
        ctx.stroke();
        const weld = this._droneWelding(d, t);
        const fl = weld ? 0.75 + 0.25 * hash(Math.floor(this.at / 30) + d.k) : 1;
        sprite(ctx, this.glow.ember, pos[0], pos[1], (weld ? 46 : 30) * fl, 0.9 * alpha);
        sprite(ctx, this.glow.white, pos[0], pos[1], weld ? 12 : 8, alpha);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    _drawSparks(ctx) {
      if (!this.sparks.length) return;
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      ctx.lineWidth = 1.3;
      for (const s of this.sparks) {
        const q = s.age / s.life;
        ctx.strokeStyle = rgba(mix(HOT, EMBER, q), 1 - q);
        ctx.beginPath();
        ctx.moveTo(s.x - s.vx * 14, s.y - s.vy * 14);
        ctx.lineTo(s.x, s.y);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    _text(ctx, str, x, y, size, color, alpha, opts) {
      const o = opts || {};
      ctx.font = `${o.weight || 400} ${size}px ${o.family || FONT_MONO}`;
      ctx.textAlign = o.align || 'left';
      ctx.textBaseline = o.base || 'alphabetic';
      if ('letterSpacing' in ctx) ctx.letterSpacing = o.ls ? `${o.ls}px` : '0px';
      ctx.fillStyle = rgba(color, alpha);
      ctx.fillText(str, x, y);
    }

    _drawHud(ctx, t) {
      const W = this.W, H = this.H, S = this.S, T = this.T, f = this.frame, m = this.m, env = this.env;
      const hudA = (this.rm ? 1 : ease.out3(seg(t, 250, 700))) * (this.ignited ? 1 - seg(t, S.igniteAt, 320) : 1);
      if (hudA <= 0.003) return;
      ctx.save();
      ctx.globalAlpha = hudA;

      // 四角取景框
      ctx.strokeStyle = rgba(BONE, 0.3);
      ctx.lineWidth = 1;
      const inset = 18, arm = 20;
      [[inset, 46, 1, 1], [W - inset, 46, -1, 1], [inset, H - inset, 1, -1], [W - inset, H - inset, -1, -1]].forEach(([x, y, sx, sy]) => {
        ctx.beginPath();
        ctx.moveTo(x, y + sy * arm);
        ctx.lineTo(x, y);
        ctx.lineTo(x + sx * arm, y);
        ctx.stroke();
      });
      this._text(ctx, 'CARET // IGNITION', 30, 66, 10.5, BONE, 0.72, { ls: 2.2 });
      this._text(ctx, `星历 ${this.stardate} · 第 ${this.boots} 次启动 · ${this.ws}`, 30, 84, 10.5, BONE, 0.42);

      // 字标与日志
      const wordA = this.rm ? 1 : seg(t, S.wordAt, 700);
      if (wordA > 0) {
        const fs = Math.round(clamp(f.R * 0.34, 18, 40)), ls = fs * 0.62, y = f.cy + f.R * 1.78;
        ctx.font = `600 ${fs}px ${FONT_DISPLAY}`;
        if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        const chars = Array.from('CURSOR'), widths = chars.map((c) => ctx.measureText(c).width);
        let x = f.cx - (widths.reduce((a, b) => a + b, 0) + ls * (chars.length - 1)) / 2;
        chars.forEach((c, i) => {
          const q = this.rm ? 1 : seg(t, S.wordAt + i * 90, 320);
          const flick = q < 1 ? (hash(Math.floor(this.at / 45) + i * 7) > 0.45 ? q : q * 0.25) : 1;
          if (flick > 0.01) {
            const gx = q < 1 ? (hash(i + Math.floor(this.at / 60)) - 0.5) * 6 * (1 - q) : 0;
            ctx.fillStyle = rgba(BONE, flick);
            ctx.fillText(c, x + gx, y);
          }
          x += widths[i] + ls;
        });
        const ready = this.readyAt !== undefined && t >= this.readyAt;
        const sub = `${this.ws}  ·  ${this.greet}  ·  ${ready ? `就绪 ${(this.readyAt / 1000).toFixed(2)} s` : '正在恢复工作区…'}`;
        this._text(ctx, sub, f.cx, y + 26, 11.5, BONE, 0.5 * wordA, { align: 'center' });
      }

      // 左下：真实启动里程碑走表
      const tickAt = (g) => (g < GATES.length ? this.marks[g] : this.readyAt);
      const reached = TICKS.map((_, g) => g).filter((g) => tickAt(g) !== undefined && tickAt(g) <= t).sort((a, b) => tickAt(a) - tickAt(b)).slice(-5);
      const ready = this.readyAt !== undefined && t >= this.readyAt;
      const pend = ready ? -1 : TICKS.findIndex((_, g) => !(tickAt(g) !== undefined && tickAt(g) <= t));
      let ly = H - 30;
      if (pend >= 0) {
        this._text(ctx, `◌ 等待${TICKS[pend].label}${'.'.repeat(1 + (Math.floor(this.at / 320) % 3))}`, 30, ly, 10.5, COOL, 0.75);
        ly -= 17;
      }
      for (let i = reached.length - 1; i >= 0; i--) {
        const g = reached[i], r = reached.length - 1 - i;
        this._text(ctx, `▸ ${((tickAt(g) / 1000).toFixed(2) + 's').padStart(6, ' ')}  ${TICKS[g].label}`, 30, ly, 10.5, BONE, [0.8, 0.55, 0.38, 0.26, 0.16][r] * seg(t, tickAt(g), 200));
        ly -= 17;
      }

      // 右下：玩法提示
      const hint = this.scene.hint || '移动鼠标';
      this._text(ctx, hint, W - 30, H - 47, 10.5, BONE, 0.42, { align: 'right' });
      this._text(ctx, '按住鼠标 点火 · 单击 / Esc 跳过', W - 30, H - 30, 10.5, BONE, 0.42, { align: 'right' });

      // 核心对准后：自动点火倒计时环
      if (!this.ignited && t >= S.armedAt && !this.rm) {
        const q = seg(t, S.armedAt, T.auto), rr = f.R * 1.62;
        ctx.strokeStyle = rgba(EMBER, 0.8);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(f.cx, f.cy, rr, -Math.PI / 2, -Math.PI / 2 + q * TAU);
        ctx.stroke();
        ctx.strokeStyle = rgba(BONE, 0.14);
        ctx.beginPath();
        ctx.arc(f.cx, f.cy, rr, 0, TAU);
        ctx.stroke();
        if (this.mode === 'story') {
          const blink = 0.55 + 0.45 * Math.sin(this.at / 260);
          this._text(ctx, ready ? '核心已对准 · 按住鼠标点火' : '核心已对准 · 等待工作台就绪', f.cx, f.cy + f.R * 1.78 + 50, 11, COOL, 0.8 * blink, { align: 'center' });
        }
      }

      // 悬停核心：锁定框和遥测
      const near = !this.ignited && Math.hypot(m.sx - f.cx, m.sy - f.cy) < f.R * 1.35 && m.present;
      this.lock += ((near ? 1 : 0) - this.lock) * 0.18;
      if (this.lock > 0.02) {
        const L = this.lock, bx = f.R * lerp(1.9, 1.3, ease.out3(L)), arm2 = f.R * 0.28;
        ctx.strokeStyle = rgba(COOL, 0.85 * L);
        ctx.lineWidth = 1.2;
        [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sy]) => {
          const x = f.cx + sx * bx, y = f.cy + sy * bx;
          ctx.beginPath();
          ctx.moveTo(x - sx * arm2, y);
          ctx.lineTo(x, y);
          ctx.lineTo(x, y - sy * arm2);
          ctx.stroke();
        });
        const welded = S.edges.filter((e) => t >= e.end).length;
        this._text(ctx, `核心 · 焊接 ${welded}/12 · 能量 ${Math.round(f.energy * 100)}%`, f.cx + bx + 10, f.cy - bx + 10, 10.5, COOL, 0.9 * L);
      }

      // 全息场景：悬停哪个面，就告诉你它会变成工作台的哪一块
      if (this.scene.cube && this.scene.cube.labels && !this.ignited && !this.rm) {
        const quads = this._faceQuads(), assign = this._assign(quads), M = this.M;
        for (let i = 0; i < 6; i++) {
          const n = NORMALS[i];
          if (M[6] * n[0] + M[7] * n[1] + M[8] * n[2] >= 0 || t < S.faceDone[i]) continue;
          const pts = quads[i].map((p) => [p[0], p[1]]);
          if (!inPoly(m.sx, m.sy, pts)) continue;
          ctx.beginPath();
          pts.forEach((p, j) => (j ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
          ctx.closePath();
          ctx.fillStyle = rgba(COOL, 0.1);
          ctx.fill();
          ctx.strokeStyle = rgba(COOL, 0.9);
          ctx.lineWidth = 1.5;
          ctx.stroke();
          const c = centroid(pts), side = c[0] >= f.cx ? 1 : -1, lx = f.cx + side * f.R * 2.1, lyy = c[1] - 18;
          ctx.strokeStyle = rgba(COOL, 0.6);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(c[0], c[1]);
          ctx.lineTo(lx - side * 10, lyy);
          ctx.lineTo(lx, lyy);
          ctx.stroke();
          const part = PARTS[assign[i]];
          this._text(ctx, `${part.label}  ${part.en}`, lx + side * 6, lyy + 4, 11.5, COOL, 0.95, { align: side > 0 ? 'left' : 'right' });
          this._text(ctx, '点火后这一面会展开成它', lx + side * 6, lyy + 21, 10, BONE, 0.5, { align: side > 0 ? 'left' : 'right' });
        }
      }

      // 准星：替代系统光标；按住时外圈充能
      if (!this.rm) {
        const rx = m.sx, ry = m.sy, va = m.present ? 0.9 : 0.4;
        ctx.strokeStyle = rgba(BONE, va);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(rx, ry, 11, 0, TAU);
        ctx.stroke();
        [[0, -1], [1, 0], [0, 1], [-1, 0]].forEach(([dx, dy]) => {
          ctx.beginPath();
          ctx.moveTo(rx + dx * 15, ry + dy * 15);
          ctx.lineTo(rx + dx * 21, ry + dy * 21);
          ctx.stroke();
        });
        ctx.globalCompositeOperation = 'lighter';
        sprite(ctx, this.glow.ember, rx, ry, 10, 0.9 * va);
        ctx.globalCompositeOperation = 'source-over';
        this._text(ctx, m.present ? `${(rx / W).toFixed(2)} · ${(ry / H).toFixed(2)}` : '自动巡航', rx + 18, ry + 26, 9.5, COOL, 0.7 * va);
        if (m.charge > 0.01) {
          ctx.globalCompositeOperation = 'lighter';
          ctx.strokeStyle = rgba(EMBER, 0.25);
          ctx.lineWidth = 7;
          ctx.beginPath();
          ctx.arc(rx, ry, 27, -Math.PI / 2, -Math.PI / 2 + m.charge * TAU);
          ctx.stroke();
          ctx.globalCompositeOperation = 'source-over';
          ctx.strokeStyle = rgba(HOT, 0.95);
          ctx.lineWidth = 2;
          ctx.stroke();
          this._text(ctx, `点火 ${Math.round(m.charge * 100)}%`, rx + 34, ry - 22, 10.5, EMBER, 0.95);
        }
      }

      if (this.toast && this.at - this.toast.at < 1700) {
        const q = (this.at - this.toast.at) / 1700;
        this._text(ctx, this.toast.text, W / 2, H * 0.17, 13, EMBER, Math.sin(q * Math.PI) * 1.2, { align: 'center', ls: 4 });
      }
      ctx.restore();
    }

    _drawIgnition(ctx, t) {
      const S = this.S, ig = this.ig, p = seg(t, S.igniteAt, S.igniteDur);
      if (this.rm) return;
      // 核心爆闪
      const flare = Math.exp(-((p - 0.04) ** 2) / 0.003);
      ctx.globalCompositeOperation = 'lighter';
      sprite(ctx, this.glow.ember, ig.core.x, ig.core.y, ig.core.R * 7 * flare, 0.9 * flare);
      sprite(ctx, this.glow.white, ig.core.x, ig.core.y, ig.core.R * 2.4 * flare, flare);
      // 冲击环：遮罩从这里向外撕开，露出下面的工作台
      const rr = ease.io3(seg(p, 0.03, 0.62)) * ig.far, ringA = 1 - seg(p, 0.45, 0.35);
      if (ringA > 0) {
        ctx.strokeStyle = rgba(EMBER, 0.16 * ringA);
        ctx.lineWidth = 22;
        ctx.beginPath();
        ctx.arc(ig.o.x, ig.o.y, rr + 46, 0, TAU);
        ctx.stroke();
        ctx.strokeStyle = rgba(HOT, 0.8 * ringA);
        ctx.lineWidth = 1.6;
        ctx.stroke();
        ctx.strokeStyle = rgba(COOL, 0.3 * ringA);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(ig.o.x, ig.o.y, rr + 78, 0, TAU);
        ctx.stroke();
      }
      // 六个面飞出去，落成工作台的六个区域
      ig.faces.forEach((fc, i) => {
        const lp = ease.io3(seg(p, 0.06 + i * 0.035, 0.55));
        const fade = 1 - seg(p, 0.74 + i * 0.02, 0.2);
        if (fade <= 0) return;
        let pts = fc.from.map((a, j) => [lerp(a[0], fc.to[j][0], lp), lerp(a[1], fc.to[j][1], lp)]);
        const c = centroid(pts), lift = Math.sin(lp * Math.PI) * 0.12;
        pts = pts.map((q) => [q[0] + (q[0] - c[0]) * lift, q[1] + (q[1] - c[1]) * lift]);
        ctx.beginPath();
        pts.forEach((q, j) => (j ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
        ctx.closePath();
        const flash = lp > 0.82 ? Math.max(0, 1 - Math.abs(lp - 0.95) / 0.13) : 0;
        ctx.fillStyle = rgba(BONE, (0.05 + 0.2 * flash) * fade);
        ctx.fill();
        ctx.strokeStyle = rgba(EMBER, 0.22 * fade);
        ctx.lineWidth = 6;
        ctx.stroke();
        ctx.strokeStyle = rgba(mix(HOT, BONE, lp), (0.95 - 0.35 * lp) * fade);
        ctx.lineWidth = 1.4;
        ctx.stroke();
        if (lp > 0.7) {
          const part = PARTS[fc.part], r = fc.to;
          this._text(ctx, part.en, r[0][0] + 8, r[0][1] + 13, 9.5, HOT, 0.85 * seg(lp, 0.7, 0.2) * fade, { ls: 1.5 });
        }
      });
      // 最后一粒火花落进编辑器的光标位置，真实光标接班
      if (ig.caret) {
        const q = ease.io2(seg(p, 0.12, 0.6)), a = ig.core, b = ig.caret;
        const cx = (a.x + b.x) / 2, cy = Math.min(a.y, b.y) - 120;
        const bez = (u) => [(1 - u) * (1 - u) * a.x + 2 * (1 - u) * u * cx + u * u * b.x, (1 - u) * (1 - u) * a.y + 2 * (1 - u) * u * cy + u * u * b.y];
        if (q > 0 && q < 1) {
          for (let i = 6; i >= 0; i--) {
            const u = Math.max(0, q - i * 0.035), pt = bez(u);
            sprite(ctx, this.glow.ember, pt[0], pt[1], 26 - i * 3, (1 - i / 7) * 0.9);
          }
          const pt = bez(q);
          sprite(ctx, this.glow.white, pt[0], pt[1], 9, 1);
        }
        const land = seg(p, 0.72, 0.18);
        if (land > 0 && land < 1) {
          ctx.strokeStyle = rgba(HOT, 1 - land);
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(b.x, b.y, 4 + land * 26, 0, TAU);
          ctx.stroke();
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  global.CaretIgnite = {
    version: '0.2.0',
    gates: GATES.map((g) => Object.assign({}, g)),
    readyMark: READY_MARK,
    parts: PARTS.map((p) => Object.assign({}, p)),
    resolveMode,
    mount(opts) {
      try {
        return new Ignite(opts);
      } catch (err) {
        document.querySelectorAll('caret-ignite, style[data-caret-ignite]').forEach((n) => n.remove());
        if (global.console) console.error('[caret-ignite] mount failed', err);
        return null;
      }
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
