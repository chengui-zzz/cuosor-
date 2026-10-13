/*!
 * Caret Boot · Cursor 开机动画引擎 v0.1（网页 Demo）
 *
 * 这个文件以后要原样注入 Cursor 的 workbench.html，所以守工作台的规矩：
 *  - 不用 innerHTML / insertAdjacentHTML / eval：工作台开了 require-trusted-types-for 'script'
 *  - 不加载外部资源：CSP 只放行 'self'，字体只用本地 / 系统字体
 *  - 画面是 render(t) 的纯函数：可以任意 seek、暂停、逐帧截图，不会状态漂移
 */
(function (global) {
  'use strict';

  const SVGNS = 'http://www.w3.org/2000/svg';
  const C30 = Math.cos(Math.PI / 6);
  const GY = 26; // 图纸点阵的竖向间距
  const GX = GY * Math.sqrt(3); // 横向间距：点阵方向正好是等轴立方体的 90° 与 ±30°
  const CAP_MS = 12000; // 不管信号到没到齐，12 秒必定收尾
  const SMART_KEY = 'caret-boot:lastStory';
  const ACCENT = [245, 78, 0];
  const TYPED = 'cursor.';

  /** 9 个启动里程碑，依次放行立方体的 9 条边。前 5 个已在本机 Cursor 3.24 的 workbench.js 里确认存在 */
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

  /** 三个 Agent 从中心出发各画三条边，120° 旋转对称，正好覆盖等轴立方体可见的 9 条边 */
  const PATHS = [
    ['C', 'UL', 'T', 'UR'],
    ['C', 'UR', 'LR', 'B'],
    ['C', 'B', 'LL', 'UL'],
  ];

  const TIMING = {
    story: {
      caretIn: 80, typeAt: 760, typeChar: 56, ghostAt: 1380, ghostDur: 260, slideDur: 420,
      hintAt: 1640, tabAt: 2300, collapseAt: 2760, collapseDur: 320, travelDur: 380,
      splitDur: 260, edgeDur: 330, edgeGap: 60, stagger: 70,
      facesDur: 720, mergeDur: 380, wordDelay: 80, letterDur: 72, subDelay: 160, hold: 760, outDur: 950,
    },
    brief: {
      caretIn: 60, splitAt: 360, splitDur: 200, edgeDur: 190, edgeGap: 24, stagger: 40,
      facesDur: 480, mergeDur: 220, wordDelay: 20, letterDur: 34, subDelay: 0, hold: 80, outDur: 680,
    },
  };

  const ICON_SELECTORS = ['.window-appicon', '[data-caret-boot="icon"]'];
  const CARET_SELECTORS = [
    '.monaco-editor.focused .cursors-layer > .cursor',
    '.monaco-editor .cursors-layer > .cursor',
    '[data-caret-boot="caret"]',
  ];
  const HIDE_CSS = '.monaco-editor .cursors-layer > .cursor, .window-appicon { visibility: hidden !important; }';

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const seg = (t, start, dur) => (dur > 0 ? clamp((t - start) / dur, 0, 1) : t >= start ? 1 : 0);
  const lerp = (a, b, p) => a + (b - a) * p;
  const ease = {
    out3: (p) => 1 - (1 - p) ** 3,
    in3: (p) => p * p * p,
    io2: (p) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2),
    io3: (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2),
  };
  // 柔和闪烁：起点为亮，周期 1.06s，和编辑器的光标节奏一致
  const softBlink = (t, from) => clamp(0.7 + Math.cos(((t - from) / 1060) * Math.PI * 2), 0, 1);
  const fmtS = (ms) => ((ms / 1000).toFixed(2) + 's').padStart(6, ' ');

  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }
  function svg(tag, attrs) {
    const el = document.createElementNS(SVGNS, tag);
    if (attrs) setAttrs(el, attrs);
    return el;
  }
  function setAttrs(el, attrs) {
    for (const k in attrs) el.setAttribute(k, typeof attrs[k] === 'number' ? +attrs[k].toFixed(2) : attrs[k]);
  }
  function parseRGB(s) {
    const m = /rgba?\(([^)]+)\)/.exec(s || '');
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    return p.length >= 3 ? p.slice(0, 3) : null;
  }
  const mixRGB = (a, b, p) => `rgb(${a.map((v, i) => Math.round(lerp(v, b[i], p))).join(',')})`;
  const clip = (s, n) => (Array.from(s).length > n ? Array.from(s).slice(0, n - 1).join('') + '…' : s);

  function ymd(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function greeting(d) {
    const hr = (d || new Date()).getHours();
    if (hr < 5) return '夜深了';
    if (hr < 11) return '早上好';
    if (hr < 13) return '中午好';
    if (hr < 18) return '下午好';
    if (hr < 23) return '晚上好';
    return '夜深了';
  }
  /** 智能档：每天第一次播完整版，之后当天都播简易版 */
  function resolveMode(mode, storage) {
    if (mode !== 'smart') return { mode, reason: '' };
    const today = ymd(new Date());
    let last = null;
    try { last = storage && storage.getItem(SMART_KEY); } catch (e) { /* 存储不可用就当第一次 */ }
    if (last !== today) {
      return {
        mode: 'story',
        reason: '今天第一次打开',
        commit() { try { storage.setItem(SMART_KEY, today); } catch (e) { /* ignore */ } },
      };
    }
    return { mode: 'brief', reason: '今天已经看过完整版' };
  }

  const GRAIN = 'url("data:image/svg+xml,' + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'>" +
    "<feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/>" +
    "<feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(#n)'/></svg>"
  ) + '")';

  const CSS = `
:host { all: initial; position: fixed; inset: 0; z-index: 2147483000; display: block; overflow: hidden; contain: strict;
  cursor: default; user-select: none; -webkit-user-select: none;
  --mono: "Berkeley Mono", "Cascadia Code", "JetBrains Mono", "SF Mono", Menlo, Consolas, "Microsoft YaHei UI", monospace;
  --display: Bahnschrift, "DIN Alternate", "D-DIN", Barlow, "Helvetica Neue", "Segoe UI", sans-serif;
  --cjk: "Microsoft YaHei UI", "PingFang SC", "Noto Sans SC", sans-serif;
  --accent: #F54E00; --glow-a: .5;
  --bg: #14120B; --fg: 237, 236, 236;
  --face-top: rgba(237, 236, 236, .13); --face-left: rgba(237, 236, 236, .065); --face-right: rgba(237, 236, 236, .028);
  --sheen: .2; --grain: .08; --vig: rgba(0, 0, 0, .45); }
:host([data-style="paper"]) { --bg: #F7F7F4; --fg: 38, 37, 30; --glow-a: .2;
  --face-top: #E8E7E1; --face-left: #DEDDD7; --face-right: #F0EFEA; --sheen: .75; --grain: .06; --vig: rgba(38, 37, 30, .07); }
.layer { position: absolute; inset: 0; }
.bg { background: var(--bg); }
.vig { background: radial-gradient(125% 95% at 50% 47%, transparent 50%, var(--vig)); }
.grain { inset: -10%; opacity: var(--grain); background-image: ${GRAIN}; background-size: 180px 180px; mix-blend-mode: overlay; }
:host([data-style="paper"]) .grain { mix-blend-mode: multiply; }
.grid { display: none; width: 100%; height: 100%; }
.grid circle { fill: rgba(var(--fg), .2); }
:host([data-style="draft"]) .grid { display: block; }
.stage { width: 100%; height: 100%; overflow: visible; }
.face { opacity: 0; }
.face-top { fill: var(--face-top); }
.face-left { fill: var(--face-left); }
.face-right { fill: var(--face-right); }
.sheen { opacity: var(--sheen); visibility: hidden; }
.edge { stroke: rgb(var(--fg)); stroke-width: 1.6px; stroke-linecap: round; opacity: 0; vector-effect: non-scaling-stroke; }
.ripple { fill: none; stroke: rgba(var(--fg), .55); stroke-width: 1px; opacity: 0; vector-effect: non-scaling-stroke; }
.guide, .dim { display: none; }
:host([data-style="draft"]) .guide { display: inline; stroke: rgba(var(--fg), .26); stroke-width: 1px; stroke-dasharray: 2 5;
  opacity: 0; vector-effect: non-scaling-stroke; }
:host([data-style="draft"]) .dim { display: inline; font: 400 10px var(--mono); fill: rgba(var(--fg), .58);
  letter-spacing: .04em; opacity: 0; }
.code, .kbd, .word, .sub, .caret { position: absolute; left: 0; top: 0; will-change: transform, opacity; }
.code { white-space: pre; font: 450 var(--code-fs, 20px)/1.25 var(--mono); transform-origin: 100% 50%; }
.ch { opacity: 0; color: rgba(var(--fg), .94); }
.ch.pn { color: rgba(var(--fg), .46); }
.ch.str { color: rgba(var(--fg), .72); }
.bl { display: inline-block; width: 0; height: 0; vertical-align: baseline; }
.kbd { opacity: 0; font: 500 11px/1 var(--mono); letter-spacing: .06em; color: rgba(var(--fg), .72); padding: 5px 8px 4px;
  border: 1px solid rgba(var(--fg), .24); border-bottom-width: 2px; border-radius: 5px; transform-origin: 50% 100%; }
.kbd.down { background: rgba(var(--fg), .12); border-bottom-width: 1px; }
.word { white-space: nowrap; font: 600 var(--word-fs, 80px)/1 var(--display); letter-spacing: .14em; color: rgb(var(--fg)); }
.lt { display: inline-block; opacity: 0; }
.sub { opacity: 0; white-space: pre; font: 400 12.5px/1 var(--mono); letter-spacing: .03em; color: rgba(var(--fg), .5); }
.caret { width: 2px; height: 20px; opacity: 0; border-radius: 1px; background: var(--accent);
  box-shadow: 0 0 14px rgba(245, 78, 0, calc(var(--glow, 1) * var(--glow-a))); }
.ticker { position: absolute; left: 28px; bottom: 26px; font: 400 11px/1 var(--mono); color: rgba(var(--fg), .62); }
.tk { position: absolute; left: 0; bottom: 0; white-space: pre; opacity: 0; }
.tk .id { color: rgba(var(--fg), .32); }
.skip { position: absolute; right: 28px; bottom: 22px; display: flex; align-items: center; gap: 8px; opacity: 0;
  font: 400 11.5px/1 var(--cjk); color: rgba(var(--fg), .5); }
.skip kbd { font: 500 10.5px/1 var(--mono); padding: 4px 6px 3px; border: 1px solid rgba(var(--fg), .22);
  border-bottom-width: 2px; border-radius: 4px; color: rgba(var(--fg), .7); }
.block { display: none; }
:host([data-style="draft"]) .block { display: block; position: absolute; right: 28px; bottom: 56px; min-width: 220px; opacity: 0;
  border: 1px solid rgba(var(--fg), .22); font: 400 10.5px/1 var(--mono); color: rgba(var(--fg), .6); }
.block .r { padding: 7px 10px; white-space: pre; border-top: 1px solid rgba(var(--fg), .12); }
.block .r.head { border-top: 0; color: rgba(var(--fg), .92); letter-spacing: .08em; }
:host([data-mode="brief"]) .code, :host([data-mode="brief"]) .kbd, :host([data-rm]) .code, :host([data-rm]) .kbd { display: none; }
.drag { position: absolute; left: 0; right: 0; top: 0; height: 36px; -webkit-app-region: drag; app-region: drag; }
`;

  let uid = 0;

  class Boot {
    constructor(opts) {
      this.o = Object.assign({
        parent: null, // 默认挂到 body；文档还在解析时挂到 <html>
        mode: 'brief', // story | brief（smart 先用 resolveMode 解析）
        style: 'dark', // dark | paper | draft
        workspace: '',
        now: null, // 外部时钟（毫秒）。Demo 用它来暂停 / 拖动；正式版用真实时间
        marks: null, // 预置里程碑时刻（Demo 用）；正式版通过 mark() 实时送入
        readyAt: undefined,
        autoDestroy: true,
        skipOnAnyKey: true,
        hideTargets: true,
        reducedMotion: !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches),
        onDone: null,
      }, opts || {});
      this.id = ++uid;
      this.mode = this.o.mode === 'story' ? 'story' : 'brief';
      this.style = ['dark', 'paper', 'draft'].includes(this.o.style) ? this.o.style : 'dark';
      this.T = TIMING[this.mode];
      this.marks = GATES.map((_, i) => (this.o.marks && typeof this.o.marks[i] === 'number' ? this.o.marks[i] : undefined));
      this.readyAt = typeof this.o.readyAt === 'number' ? this.o.readyAt : undefined;
      this.skipAt = undefined;
      this.t0 = performance.now();
      this.finished = false;
      this.destroyed = false;
      this.anchor = null;
      this.ws = clip(this.o.workspace || 'workspace', 14);
      this.greet = greeting(new Date());
      this._build();
      (this.o.parent || document.body || document.documentElement).appendChild(this.host);
      this._measure();
      this._schedule();
      this._bind();
      this._tick = this._tick.bind(this);
      this.render(this.now);
      this.raf = requestAnimationFrame(this._tick);
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => { if (!this.destroyed) { this._measure(); this.render(this.now); } });
      }
    }

    get now() { return this.o.now ? this.o.now() : performance.now() - this.t0; }
    get duration() { return this.S.doneAt; }

    /** 正式版：PerformanceObserver 拿到的 mark 直接丢进来（startTime 与 performance.now 同一时间轴） */
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
    skip() {
      if (this.skipAt !== undefined || this.finished) return;
      this.skipAt = this.now;
      this._schedule();
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      cancelAnimationFrame(this.raf);
      global.removeEventListener('keydown', this._onKey, true);
      global.removeEventListener('resize', this._onResize);
      this.host.remove();
      if (this.gstyle) this.gstyle.remove();
    }

    /** 给 Demo 面板看的当前段落名 */
    phase(t) {
      const S = this.S, T = this.T;
      if (t >= S.doneAt) return '已交接，工作台可用';
      if (t >= S.outAt) return this.skipAt !== undefined && this.skipAt <= S.outAt ? '已跳过 · 交接' : '交接：图标归位，光标落回编辑器';
      if (this.o.reducedMotion) return '减弱动态：静帧';
      if (this.mode === 'story') {
        if (t < T.typeAt) return '光标待命';
        if (t < T.ghostAt) return '键入 cursor.';
        if (t < T.tabAt) return 'AI 补全（灰字建议）';
        if (t < T.collapseAt) return 'Tab 接受补全';
        if (t < S.splitAt) return '代码收束进光标';
      } else if (t < S.splitAt) return '光标待命';
      if (t < S.splitAt + T.splitDur) return '分出三个 Agent';
      if (t < S.drawn) {
        const w = this._waiting(t);
        return w ? `作图 · 等待「${w}」` : '三个 Agent 并行作图';
      }
      if (t < S.wordAt) return '立方体成形';
      if (t < S.subAt) return '键入字标';
      if (this.readyAt === undefined || t < this.readyAt + 160) return '等待工作台就绪';
      return '定格';
    }

    _waiting(t) {
      for (const row of this.S.edges) {
        for (const e of row) {
          if (t >= e.earliest && t < e.start) return GATES[e.g].label;
        }
      }
      return '';
    }

    _build() {
      const host = (this.host = document.createElement('caret-boot'));
      host.setAttribute('data-style', this.style);
      host.setAttribute('data-mode', this.mode);
      host.setAttribute('aria-hidden', 'true');
      if (this.o.reducedMotion) host.setAttribute('data-rm', '');
      const root = host.attachShadow({ mode: 'open' });
      const css = document.createElement('style');
      css.textContent = CSS;
      root.appendChild(css);
      const el = (this.el = {});

      el.backdrop = h('div', 'layer');
      el.backdrop.append(h('div', 'layer bg'), h('div', 'layer vig'), h('div', 'layer grain'));
      const gid = `cb-grid-${this.id}`;
      el.grid = svg('svg', { class: 'layer grid' });
      el.pattern = svg('pattern', { id: gid, width: GX, height: GY, patternUnits: 'userSpaceOnUse' });
      for (const [x, y] of [[0, 0], [GX, 0], [0, GY], [GX, GY], [GX / 2, GY / 2]]) {
        el.pattern.appendChild(svg('circle', { cx: x, cy: y, r: 1 }));
      }
      const gdefs = svg('defs');
      gdefs.appendChild(el.pattern);
      el.grid.append(gdefs, svg('rect', { width: '100%', height: '100%', fill: `url(#${gid})` }));
      el.backdrop.appendChild(el.grid);
      root.appendChild(el.backdrop);

      el.svg = svg('svg', { class: 'layer stage' });
      const defs = svg('defs');
      const sid = `cb-sweep-${this.id}`;
      el.sweep = svg('linearGradient', { id: sid, gradientUnits: 'userSpaceOnUse' });
      for (const [o, a] of [[0, 0], [0.4, 0], [0.5, 1], [0.6, 0], [1, 0]]) {
        el.sweep.appendChild(svg('stop', { offset: o, 'stop-color': '#fff', 'stop-opacity': a }));
      }
      defs.appendChild(el.sweep);
      el.svg.appendChild(defs);
      el.cube = svg('g');
      el.guides = [];
      el.edges = [];
      el.dims = [];
      for (let i = 0; i < 9; i++) el.cube.appendChild((el.guides[i] = svg('line', { class: 'guide' })));
      el.faces = ['top', 'left', 'right'].map((n) => el.cube.appendChild(svg('polygon', { class: `face face-${n}` })));
      el.sheen = el.cube.appendChild(svg('polygon', { class: 'sheen', fill: `url(#${sid})` }));
      el.ripple = el.cube.appendChild(svg('circle', { class: 'ripple', cx: 0, cy: 0, r: 0 }));
      for (let i = 0; i < 9; i++) el.cube.appendChild((el.edges[i] = svg('line', { class: 'edge' })));
      for (let i = 0; i < 9; i++) el.cube.appendChild((el.dims[i] = svg('text', { class: 'dim' })));
      el.svg.appendChild(el.cube);
      root.appendChild(el.svg);

      // 完整档的那行代码：键入 cursor. → 灰字补全 open("工作区") → Tab
      el.code = h('div', 'code');
      el.chars = [];
      const tokens = [['cursor', 'id'], ['.', 'pn'], ['open', 'fn'], ['(', 'pn'], [`"${this.ws}"`, 'str'], [')', 'pn']];
      for (const [txt, cls] of tokens) {
        for (const ch of Array.from(txt)) el.chars.push(el.code.appendChild(h('span', `ch ${cls}`, ch)));
      }
      el.codeBase = el.code.appendChild(h('span', 'bl'));
      this.ghostLen = el.chars.length - TYPED.length;
      el.kbd = h('div', 'kbd', 'Tab');
      root.append(el.code, el.kbd);

      el.word = h('div', 'word');
      el.letters = Array.from('CURSOR').map((c) => el.word.appendChild(h('span', 'lt', c)));
      el.wordBase = el.word.appendChild(h('span', 'bl'));
      el.sub = h('div', 'sub');
      root.append(el.word, el.sub);

      el.ticker = h('div', 'ticker');
      el.ticks = TICKS.map((g) => {
        const tk = h('div', 'tk');
        tk.append(h('span', 'a'), h('span', 'id', this.style === 'draft' ? `  ${g.id}` : ''));
        return el.ticker.appendChild(tk);
      });
      el.pending = el.ticker.appendChild(h('div', 'tk'));
      root.appendChild(el.ticker);

      el.skip = h('div', 'skip');
      el.skip.append(h('kbd', null, 'Esc'), h('span', null, '跳过'));
      root.appendChild(el.skip);

      el.block = h('div', 'block');
      el.block.appendChild(h('div', 'r head', 'CURSOR · 启动图纸'));
      el.blockRows = [0, 1, 2].map(() => el.block.appendChild(h('div', 'r')));
      root.appendChild(el.block);

      el.agents = [0, 1, 2].map(() => root.appendChild(h('div', 'caret')));
      el.caret = root.appendChild(h('div', 'caret'));
      root.appendChild(h('div', 'drag'));

      if (this.o.hideTargets) {
        this.gstyle = document.createElement('style');
        this.gstyle.setAttribute('data-caret-boot', '');
        this.gstyle.textContent = HIDE_CSS;
        (document.head || document.documentElement).appendChild(this.gstyle);
      }
    }

    _bind() {
      this._onKey = (e) => {
        if (this.finished) return;
        if (e.key === 'Escape') return this.skip();
        if (!this.o.skipOnAnyKey || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace' || e.key === 'Tab') this.skip();
      };
      this._onResize = () => { this._measure(); this.render(this.now); };
      global.addEventListener('keydown', this._onKey, true);
      global.addEventListener('resize', this._onResize);
      this.host.addEventListener('pointerdown', (e) => { if (e.button === 0) this.skip(); });
    }

    _measure() {
      const el = this.el;
      const W = global.innerWidth || 1280;
      const H = global.innerHeight || 800;
      const draft = this.style === 'draft';
      let R = clamp(Math.min(W, H) * 0.092, 38, 96);
      if (draft) R = Math.max(GY * 2, Math.round(R / GY) * GY); // 顶点落在点阵上
      this.R = R;
      this.cx = Math.round(W / 2);
      this.cy = Math.round(H * 0.47);
      setAttrs(el.pattern, { x: this.cx % GX, y: this.cy % GY });

      const V = (this.V = {
        C: [0, 0], T: [0, -R], UR: [R * C30, -R / 2], LR: [R * C30, R / 2],
        B: [0, R], LL: [-R * C30, R / 2], UL: [-R * C30, -R / 2],
      });
      const pts = (...ks) => ks.map((k) => V[k].map((v) => +v.toFixed(2)).join(',')).join(' ');
      el.faces[0].setAttribute('points', pts('T', 'UR', 'C', 'UL'));
      el.faces[1].setAttribute('points', pts('UL', 'C', 'B', 'LL'));
      el.faces[2].setAttribute('points', pts('C', 'UR', 'LR', 'B'));
      el.sheen.setAttribute('points', pts('T', 'UR', 'LR', 'B', 'LL', 'UL'));
      for (let k = 0; k < 3; k++) {
        for (let j = 0; j < 3; j++) {
          const i = 3 * k + j, a = V[PATHS[k][j]], b = V[PATHS[k][j + 1]];
          const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
          const ext = R * 0.42;
          setAttrs(el.edges[i], { x1: a[0], y1: a[1], x2: a[0], y2: a[1] });
          setAttrs(el.guides[i], { x1: a[0] - ux * ext, y1: a[1] - uy * ext, x2: b[0] + ux * ext, y2: b[1] + uy * ext });
          const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
          let nx = uy, ny = -ux; // 辐条：标注放在线的一侧
          if (j > 0) { const l = Math.hypot(mx, my); nx = mx / l; ny = my / l; } // 外边：标注朝外
          const off = j > 0 ? 12 : 10;
          setAttrs(el.dims[i], { x: mx + nx * off, y: my + ny * off + 3.5 });
          el.dims[i].style.textAnchor = nx > 0.35 ? 'start' : nx < -0.35 ? 'end' : 'middle';
        }
      }

      const codeFs = Math.round(clamp(R * 0.3, 15, 24));
      const wordFs = Math.round(R * 1.04);
      this.host.style.setProperty('--code-fs', `${codeFs}px`);
      this.host.style.setProperty('--word-fs', `${wordFs}px`);

      this.chX = el.chars.map((c) => c.offsetLeft);
      this.codeW = el.code.offsetWidth;
      this.chX.push(this.codeW);
      this.typedW = this.chX[TYPED.length];
      this.codeTop = this.cy - (el.codeBase.offsetTop - codeFs * 0.36);
      this.codeCaretH = Math.round(codeFs * 1.32);
      this.kbdH = el.kbd.offsetHeight;

      this.wordLs = wordFs * 0.14;
      this.wordX = el.letters.map((l) => l.offsetLeft);
      const last = el.letters[el.letters.length - 1];
      this.wordX.push(last.offsetLeft + last.offsetWidth);
      const wordVisW = this.wordX[el.letters.length] - this.wordLs;
      this.wordTop = this.cy - (el.wordBase.offsetTop - wordFs * 0.35);
      this.wordCaretH = Math.round(wordFs * 0.7 * 1.24);

      const cubeW = 2 * R * C30, gap = Math.round(R * 0.62);
      let shift = (cubeW + gap + wordVisW) / 2 - cubeW / 2;
      if (draft) shift = Math.round(shift / GX) * GX; // 平移整列，保持顶点仍在点阵上
      this.lockX = this.cx - shift;
      this.wordLeft = this.lockX + cubeW / 2 + gap;
      this.agentH = Math.round(clamp(R * 0.24, 12, 22));
      this._subTxt = null;
    }

    _schedule() {
      const T = this.T;
      const S = {};
      const readyGate = this.readyAt === undefined ? Infinity : this.readyAt + 160;
      if (this.o.reducedMotion) {
        S.splitAt = 0;
        S.edges = PATHS.map((_, k) => [0, 1, 2].map((j) => ({ start: 0, end: 0, earliest: 0, g: 3 * j + k })));
        S.drawn = S.facesAt = S.mergeAt = S.wordAt = S.wordEnd = S.subAt = 0;
        S.outAt = Math.min(Math.max(700, readyGate), CAP_MS);
        S.outDur = 420;
      } else {
        S.splitAt = this.mode === 'story' ? T.collapseAt + T.collapseDur + T.travelDur : T.splitAt;
        const go = S.splitAt + T.splitDur;
        let drawn = go;
        S.edges = PATHS.map((_, k) => {
          let prev = go + k * T.stagger;
          return [0, 1, 2].map((j) => {
            const g = 3 * j + k, m = this.marks[g];
            const earliest = j === 0 ? prev : prev + T.edgeGap;
            const start = Math.max(earliest, m === undefined ? Infinity : m);
            prev = start + T.edgeDur;
            drawn = Math.max(drawn, prev);
            return { start, end: prev, earliest, g };
          });
        });
        S.drawn = drawn;
        S.facesAt = drawn - 80;
        S.mergeAt = drawn + 40;
        S.wordAt = S.mergeAt + T.mergeDur + T.wordDelay;
        S.wordEnd = S.wordAt + 6 * T.letterDur;
        S.subAt = S.wordEnd + T.subDelay;
        S.outAt = Math.min(Math.max(S.subAt + T.hold, readyGate), CAP_MS);
        S.outDur = T.outDur;
      }
      if (this.skipAt !== undefined && this.skipAt < S.outAt) {
        S.outAt = this.skipAt;
        S.outDur = Math.min(S.outDur, 640);
      }
      S.doneAt = S.outAt + S.outDur;
      this.S = S;
    }

    _tick() {
      if (this.destroyed) return;
      try {
        const t = this.now;
        this.render(t);
        const done = t >= this.S.doneAt;
        if (done && !this.finished) {
          this.finished = true;
          this.host.style.visibility = 'hidden';
          if (this.o.onDone) this.o.onDone();
          if (this.o.autoDestroy) return this.destroy();
        } else if (!done && this.finished) {
          this.finished = false;
          this.host.style.visibility = '';
        }
      } catch (err) {
        // 动画出任何错都不能挡住工作台
        this.destroy();
        if (global.console) console.error('[caret-boot]', err);
        return;
      }
      this.raf = requestAnimationFrame(this._tick);
    }

    _sampleAnchors() {
      const pick = (sels) => {
        for (const s of sels) {
          const n = document.querySelector(s);
          if (!n) continue;
          const r = n.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return { r, n };
        }
        return null;
      };
      const icon = pick(ICON_SELECTORS), caret = pick(CARET_SELECTORS);
      return {
        icon: icon && icon.r,
        caret: caret && caret.r,
        caretColor: caret ? parseRGB(getComputedStyle(caret.n).backgroundColor) : null,
      };
    }

    _wordCaretX(n) {
      return this.wordLeft + (n === 0 ? -this.wordLs * 0.5 : this.wordX[n] - this.wordLs * 0.5);
    }

    _line(ti) {
      const T = this.T;
      const n = ti < T.typeAt ? 0 : Math.min(TYPED.length, Math.floor((ti - T.typeAt) / T.typeChar) + 1);
      const gs = ease.io3(seg(ti, T.ghostAt, T.slideDur));
      const vw = this.chX[n] + (this.codeW - this.typedW) * gs;
      const left = this.cx - vw / 2;
      return { n, left, vw, caretX: left + lerp(this.chX[n], this.codeW, ease.io3(seg(ti, T.tabAt, 140))) };
    }

    /** 主光标在 ti 时刻的状态；三个 Agent 接手期间 on=false */
    _mainCaret(ti) {
      const S = this.S, T = this.T, cy = this.cy;
      if (this.o.reducedMotion) return { on: false, op: 0 };
      if (ti >= S.mergeAt + T.mergeDur) {
        const n = ti < S.wordAt ? 0 : Math.min(6, Math.floor((ti - S.wordAt) / T.letterDur) + 1);
        const idle = S.wordEnd + 260;
        return { on: true, x: this._wordCaretX(n), y: cy, h: this.wordCaretH, op: ti < idle ? 1 : softBlink(ti, idle) };
      }
      if (ti >= S.splitAt) return { on: false, op: 0 };
      if (this.mode === 'brief') {
        const hh = lerp(this.agentH * 1.5, this.agentH, ease.io3(seg(ti, S.splitAt - 180, 180)));
        return { on: ti >= T.caretIn, x: this.cx, y: cy, h: hh, op: ease.out3(seg(ti, T.caretIn, 140)) };
      }
      const L = this._line(ti);
      const typingEnd = T.typeAt + TYPED.length * T.typeChar;
      const collEnd = T.collapseAt + T.collapseDur;
      let op;
      if (ti < T.typeAt) op = ease.out3(seg(ti, T.caretIn, 160)) * (1 - seg(ti, T.typeAt - 230, 60)); // 亮一会儿，敲键前眨一下
      else if (ti < typingEnd + 360) op = 1; // 打字时光标常亮
      else if (ti < T.tabAt) op = softBlink(ti, typingEnd + 360); // 等你按 Tab
      else op = 1;
      let x = L.caretX, hh = this.codeCaretH;
      if (ti >= collEnd) {
        const m = ease.io3(seg(ti, collEnd, T.travelDur));
        x = lerp(this.cx + this.codeW / 2, this.cx, m);
        hh = lerp(this.codeCaretH, this.agentH, m);
      }
      return { on: ti >= T.caretIn, x, y: cy, h: hh, op };
    }

    _caret(node, x, y, hh, op, w, color, glow) {
      node.style.opacity = op > 0.001 ? op.toFixed(3) : '0';
      if (op <= 0.001) return;
      w = w || 2;
      node.style.width = `${w.toFixed(2)}px`;
      node.style.height = `${hh.toFixed(1)}px`;
      node.style.transform = `translate(${(x - w / 2).toFixed(2)}px, ${(y - hh / 2).toFixed(2)}px)`;
      node.style.background = color || '';
      node.style.setProperty('--glow', glow == null ? '1' : glow.toFixed(3));
    }

    render(t) {
      const S = this.S, T = this.T, el = this.el, V = this.V, R = this.R;
      const rm = this.o.reducedMotion;
      const story = this.mode === 'story' && !rm;
      const ti = Math.min(t, S.outAt); // 退场期间入场画面冻结，跳过时也一样
      const po = seg(t, S.outAt, S.outDur);
      const out = (a, b) => clamp((po - a) / (b - a), 0, 1);

      if (po > 0) { if (!this.anchor) this.anchor = this._sampleAnchors(); } else this.anchor = null;
      if (this.gstyle) this.gstyle.media = po < 0.86 ? 'all' : 'not all';

      el.backdrop.style.opacity = (1 - ease.io3(out(0.28, 0.9))).toFixed(3);
      el.grid.style.opacity = (ease.out3(seg(ti, 0, 700)) * (1 - 0.4 * seg(ti, S.facesAt, 600))).toFixed(3);

      // 立方体：居中作图 → 左移让出字标位置 → 退场时飞回标题栏图标
      let x = lerp(this.cx, this.lockX, rm ? 1 : ease.io3(seg(ti, S.mergeAt, T.mergeDur)));
      const mergeX = x + (this.wordLeft - this.lockX) - this.wordLs * 0.5; // 合流点跟着正在平移的立方体
      let y = this.cy, sc = 1, cubeOp = 1;
      if (po > 0) {
        const icon = !rm && this.anchor.icon;
        if (icon) {
          const f = ease.io3(out(0.05, 0.72));
          x = lerp(x, icon.left + icon.width / 2, f);
          y = lerp(y, icon.top + icon.height / 2, f);
          sc = lerp(1, (Math.min(icon.width, icon.height) * 0.45) / R, f);
          cubeOp = 1 - out(0.84, 1);
        } else {
          sc = lerp(1, 0.86, ease.out3(out(0, 0.5)));
          cubeOp = 1 - ease.io2(out(0, 0.45));
        }
      }
      el.cube.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${sc.toFixed(4)})`);
      el.cube.style.opacity = cubeOp.toFixed(3);
      const toScreen = (p) => [x + p[0] * sc, y + p[1] * sc];

      // 三个 Agent 各画三条边；没等到对应里程碑就停在顶点眨眼
      const go = S.splitAt + T.splitDur;
      for (let k = 0; k < 3; k++) {
        const row = S.edges[k], path = PATHS[k];
        for (let j = 0; j < 3; j++) {
          const i = 3 * k + j, e = row[j], a = V[path[j]], b = V[path[j + 1]];
          const p = rm ? 1 : ease.io2(seg(ti, e.start, T.edgeDur));
          const line = el.edges[i];
          line.style.opacity = p > 0 ? '1' : '0';
          if (p > 0) setAttrs(line, { x2: lerp(a[0], b[0], p), y2: lerp(a[1], b[1], p) });
          if (this.style === 'draft') {
            const gp = rm ? 0.5 : ease.out3(seg(ti, S.splitAt + e.g * 50, 320)) * (1 - 0.55 * seg(ti, S.facesAt, 500));
            el.guides[i].style.opacity = gp.toFixed(3);
            const dp = rm ? 1 : seg(ti, e.end, 260);
            el.dims[i].style.opacity = dp.toFixed(3);
            if (dp > 0 && !el.dims[i].textContent) {
              const m = this.marks[e.g];
              el.dims[i].textContent = `${Math.round(m !== undefined ? m : e.start)} ms`;
            }
          }
        }

        const ag = el.agents[k];
        if (rm || ti < S.splitAt || ti >= S.mergeAt + T.mergeDur) { ag.style.opacity = '0'; continue; }
        let pt = V[path[3]], solid = true, since = 0;
        if (ti < row[0].start) {
          pt = V.C;
          if (ti > go) { solid = false; since = go; }
        } else {
          for (let j = 0; j < 3; j++) {
            const e = row[j];
            if (ti < e.start) { pt = V[path[j]]; solid = false; since = row[j - 1].end; break; }
            if (ti < e.end) {
              const p = ease.io2(seg(ti, e.start, T.edgeDur)), a = V[path[j]], b = V[path[j + 1]];
              pt = [lerp(a[0], b[0], p), lerp(a[1], b[1], p)];
              break;
            }
          }
        }
        let [sx, sy] = toScreen(pt), hh = this.agentH, keep = 1;
        if (ti >= S.mergeAt) {
          const mp = seg(ti, S.mergeAt, T.mergeDur), m = ease.io3(mp);
          sx = lerp(sx, mergeX, m);
          sy = lerp(sy, this.cy, m);
          hh = lerp(hh, this.wordCaretH, m);
          solid = true;
          if (k > 0) keep = 1 - seg(mp, 0.55, 0.45); // 三合一：只留一个光标接着打字
        }
        this._caret(ag, sx, sy, hh, (solid ? 1 : softBlink(ti, since)) * keep * (1 - out(0, 0.15)));
      }

      el.faces.forEach((f, n) => {
        f.style.opacity = (rm ? 1 : ease.io2(seg(ti, S.facesAt + n * 90, T.facesDur * 0.6))).toFixed(3);
      });
      const sw = rm ? 0 : seg(ti, S.facesAt + 140, 1000);
      el.sheen.style.visibility = sw > 0 && sw < 1 ? 'visible' : 'hidden';
      if (sw > 0 && sw < 1) {
        const bx = lerp(-2.4 * R, 2.4 * R, ease.io2(sw));
        setAttrs(el.sweep, { x1: bx - R, y1: -R * 0.58, x2: bx + R, y2: R * 0.58 });
      }
      const rp = rm ? 0 : seg(ti, S.splitAt, 760);
      el.ripple.style.opacity = rp > 0 && rp < 1 ? (0.5 * (1 - rp)).toFixed(3) : '0';
      if (rp > 0 && rp < 1) el.ripple.setAttribute('r', lerp(R * 0.08, R * 1.3, ease.out3(rp)).toFixed(2));

      if (story) {
        const L = this._line(ti);
        const fade = 1 - out(0, 0.2);
        el.chars.forEach((c, i) => {
          let op;
          if (i < TYPED.length) op = ti >= T.typeAt + i * T.typeChar ? 1 : 0;
          else {
            const g = i - TYPED.length;
            op = seg(ti, T.ghostAt + (g * T.ghostDur) / this.ghostLen, 90) * lerp(0.4, 1, seg(ti, T.tabAt + g * 14, 110));
          }
          c.style.opacity = op.toFixed(3);
        });
        const c = ease.in3(seg(ti, T.collapseAt, T.collapseDur));
        el.code.style.opacity = ((1 - c) * fade).toFixed(3);
        el.code.style.transform = `translate(${L.left.toFixed(2)}px, ${this.codeTop.toFixed(2)}px) scaleX(${(1 - c).toFixed(4)})`;
        const hint = ease.out3(seg(ti, T.hintAt, 240)) * (1 - seg(ti, T.tabAt + 240, 200));
        const pr = seg(ti, T.tabAt, 180), push = pr > 0 && pr < 1 ? Math.sin(pr * Math.PI) : 0;
        el.kbd.style.opacity = (hint * fade).toFixed(3);
        el.kbd.style.transform = `translate(${(L.left + L.vw + 16 + (1 - hint) * 8).toFixed(2)}px, ` +
          `${(this.cy - this.kbdH / 2 + push * 1.5).toFixed(2)}px) scale(${(1 - 0.1 * push).toFixed(3)})`;
        el.kbd.classList.toggle('down', push > 0.25);
      }

      const wf = 1 - out(0, 0.22);
      el.word.style.opacity = wf.toFixed(3);
      el.word.style.transform = `translate(${this.wordLeft.toFixed(2)}px, ${(this.wordTop - 8 * out(0, 0.22)).toFixed(2)}px)`;
      el.letters.forEach((l, i) => {
        const p = rm ? 1 : ease.out3(seg(ti, S.wordAt + i * T.letterDur, 130));
        l.style.opacity = p.toFixed(3);
        l.style.transform = p < 1 ? `translateY(${((1 - p) * 0.06).toFixed(3)}em)` : '';
      });

      const ready = this.readyAt !== undefined && ti >= this.readyAt;
      const subTxt = `${this.ws}  ·  ${this.greet}  ·  ${ready ? `就绪 ${(this.readyAt / 1000).toFixed(2)} s` : '正在恢复工作区…'}`;
      if (subTxt !== this._subTxt) {
        this._subTxt = subTxt;
        el.sub.textContent = subTxt;
        this.subW = el.sub.offsetWidth;
      }
      el.sub.style.opacity = ((rm ? 1 : ease.out3(seg(ti, S.subAt, 320))) * wf).toFixed(3);
      el.sub.style.transform = `translate(${(this.cx - this.subW / 2).toFixed(2)}px, ${(this.cy + R + 34).toFixed(2)}px)`;

      // 左下角：真实启动里程碑走字
      const tf = 1 - out(0, 0.25);
      const tickAt = (g) => (g < GATES.length ? this.marks[g] : this.readyAt);
      const reached = [];
      TICKS.forEach((_, g) => { const m = tickAt(g); if (m !== undefined && m <= ti) reached.push(g); });
      reached.sort((a, b) => tickAt(a) - tickAt(b));
      const recent = reached.slice(-4);
      const pend = ready ? -1 : TICKS.findIndex((_, g) => !reached.includes(g));
      const lift = pend >= 0 ? 1 : 0;
      el.ticks.forEach((tk, g) => {
        const idx = recent.indexOf(g);
        if (idx < 0) { tk.style.opacity = '0'; return; }
        const r = recent.length - 1 - idx;
        if (!tk.firstChild.textContent) tk.firstChild.textContent = `${fmtS(tickAt(g))}  ${TICKS[g].label}`;
        tk.style.opacity = ([0.85, 0.55, 0.36, 0.2][r] * ease.out3(seg(ti, tickAt(g), 180)) * tf).toFixed(3);
        tk.style.transform = `translateY(${-(r + lift) * 17}px)`;
      });
      if (pend >= 0) {
        const txt = `   ···  等待${TICKS[pend].label}${'.'.repeat(1 + (Math.floor(ti / 320) % 3))}`;
        if (el.pending.textContent !== txt) el.pending.textContent = txt;
        el.pending.style.opacity = (0.5 * tf).toFixed(3);
      } else el.pending.style.opacity = '0';

      el.skip.style.opacity = (ease.out3(seg(ti, 900, 400)) * 0.9 * (1 - out(0, 0.2))).toFixed(3);

      if (this.style === 'draft') {
        el.block.style.opacity = (ease.out3(seg(ti, S.drawn, 420)) * (1 - out(0, 0.25))).toFixed(3);
        const rows = [
          `工作区  ${this.ws}`,
          `就绪    ${ready ? (this.readyAt / 1000).toFixed(2) + ' s' : '—'}`,
          `作图    3 Agents · 9 段 · ${ymd(new Date())}`,
        ];
        rows.forEach((txt, i) => { if (el.blockRows[i].textContent !== txt) el.blockRows[i].textContent = txt; });
      }

      // 主光标；退场时划一道弧落到编辑器的真实光标上，并换成主题的光标色
      const m = this._mainCaret(ti);
      const target = po > 0 && !rm ? this.anchor.caret : null;
      if (target) {
        const from = m.on ? m : { x: this.cx, y: this.cy, h: this.agentH };
        const f = ease.io3(out(0.1, 0.7));
        const tx = target.left + target.width / 2, ty = target.top + target.height / 2;
        const arc = Math.sin(f * Math.PI) * Math.min(56, Math.hypot(tx - from.x, ty - from.y) * 0.12);
        const col = this.anchor.caretColor ? mixRGB(ACCENT, this.anchor.caretColor, ease.io2(out(0.6, 0.86))) : null;
        this._caret(el.caret, lerp(from.x, tx, f), lerp(from.y, ty, f) - arc, lerp(from.h, target.height, f),
          (m.on ? 1 : out(0, 0.12)) * (1 - out(0.92, 1)), lerp(2, Math.max(1, target.width), f), col, 1 - out(0.5, 0.82));
      } else {
        this._caret(el.caret, m.x, m.y, m.h, m.on ? m.op * (1 - out(0, 0.3)) : 0);
      }
    }
  }

  global.CaretBoot = {
    version: '0.1.0',
    gates: GATES.map((g) => Object.assign({}, g)),
    readyMark: READY_MARK,
    resolveMode,
    greeting,
    mount(opts) {
      let boot = null;
      try {
        boot = new Boot(opts);
        return boot;
      } catch (err) {
        if (boot) boot.destroy();
        document.querySelectorAll('caret-boot, style[data-caret-boot]').forEach((n) => n.remove());
        if (global.console) console.error('[caret-boot] mount failed', err);
        return null;
      }
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
