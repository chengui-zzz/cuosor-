/* 坍缩 · Caret 开机动画第三稿
 *
 * 鼠标是一口引力井，不是镜头，也不是进度条。
 * 字、光标和十二块边的碎片在三层椭圆轨道上绕着它转。
 * 停住，或者点一下，轨道向中心坠落，碎片收成一个立方体。
 * 快速移动可以把已经开始的坍缩重新撕开。不操作时，井自己漂一会儿再坍缩。
 */
(function () {
  'use strict';

  const DURATION = 10400;
  const ACCENT = '#F54E00';
  const BONE = 'rgba(237,236,236,';
  const V = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ];
  const FACES = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 3, 7, 4]];
  const EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const RINGS = [
    { r: 68, speed: 0.00042, tokens: ['光标', 'tab', 'await', 'caret'] },
    { r: 124, speed: -0.00026, tokens: ['const', 'agent', '补全', 'open'] },
    { r: 186, speed: 0.00016, tokens: ['轨道', 'cursor', '就绪', 'focus', 'boot'] },
  ];

  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);
  const seg = (t, a, b) => clamp((t - a) / (b - a), 0, 1);

  const q = new URLSearchParams(location.search);
  const canvas = $('c');
  const ctx = canvas.getContext('2d');
  const dock = $('dock');
  const veil = $('veil');
  const wb = $('wb');
  const statusEl = $('status');
  const phaseEl = $('phase');
  const timeEl = $('time');
  const scrub = $('scrub');
  const inclInput = $('incl');
  const inclVal = $('inclVal');
  const playBtn = $('btnPlay');

  const bodies = [];
  RINGS.forEach((ring, ri) => {
    ring.tokens.forEach((text, i) => {
      bodies.push({
        kind: 'word', text, r: ring.r, speed: ring.speed,
        angle: (i / ring.tokens.length) * Math.PI * 2 + ri * 0.6,
      });
    });
    bodies.push({
      kind: 'caret', r: ring.r, speed: ring.speed, orange: ri === 0,
      angle: Math.PI / ring.tokens.length + ri,
    });
  });
  for (let i = 0; i < 12; i++) {
    bodies.push({
      kind: 'shard', r: 156, speed: 0.0002, edge: i,
      angle: (i / 12) * Math.PI * 2 + 0.4,
    });
  }

  const clock = { t: 0, playing: !q.has('t'), speed: 1 };
  const mouse = { x: innerWidth / 2, y: innerHeight / 2 };
  let w = 1, h = 1, cx = 0, cy = 0;
  let well = { x: innerWidth / 2, y: innerHeight / 2 };
  let prevWell = { x: well.x, y: well.y };
  let vel = { x: 0, y: 0 };
  let incl = q.has('incl') ? clamp(+q.get('incl'), 0.1, 1.35) : 38 * Math.PI / 180;
  let stretchForce = q.has('stretch') ? clamp(+q.get('stretch'), 0, 1) : 0;
  let pinned = q.has('mx');
  let moved = pinned;
  let lastMove = pinned ? 1e15 : 0;
  let committedAt = -1;
  let scrubbing = false;
  let lastNow = performance.now();
  let finished = false;
  let statusText = '';
  let reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let projected = [];

  if (q.get('clean') === '1') document.body.classList.add('clean');
  if (q.has('t')) clock.t = clamp(+q.get('t'), 0, DURATION);
  inclInput.value = String(Math.round(incl * 180 / Math.PI));

  function resize() {
    w = innerWidth;
    h = innerHeight;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = w / 2;
    cy = h * 0.46;
    if (pinned && q.has('mx')) {
      mouse.x = clamp(+q.get('mx'), 0, 1) * w;
      mouse.y = clamp(+q.get('my') || 0.5, 0, 1) * h;
    }
  }

  function userActive() {
    return pinned || (moved && performance.now() - lastMove < 1400);
  }

  function autoCenter(t) {
    return {
      x: cx + Math.sin(t * 0.00033) * Math.min(w, h) * 0.06,
      y: cy + Math.cos(t * 0.00024) * Math.min(w, h) * 0.04,
    };
  }

  function collapseOf(t) {
    if (reduced) return t > 400 ? 1 : 0;
    if (committedAt >= 0) return ease(seg(t, committedAt, committedAt + 1100));
    if (userActive() && t < 9200) return 0;
    return ease(seg(t, 6200, 8000));
  }

  function projectCube(spin) {
    const rotY = spin;
    const rotX = incl * 0.85;
    const cyaw = Math.cos(rotY), syaw = Math.sin(rotY);
    const cpit = Math.cos(rotX), spit = Math.sin(rotX);
    const size = clamp(Math.min(w, h) * 0.092, 62, 92);
    projected = V.map(([x, y, z]) => {
      const x1 = x * cyaw + z * syaw;
      const z1 = -x * syaw + z * cyaw;
      const y1 = y * cpit - z1 * spit;
      const z2 = y * spit + z1 * cpit;
      const s = 4.2 / (4.2 + z2);
      return { x: x1 * size * s, y: y1 * size * s, z: z2 };
    });
  }

  function place(b, t, fall, stretch, stretchAng) {
    const a = b.angle + t * b.speed;
    const radius = b.r * (1 - fall);
    const rx = radius * (1 + stretch);
    const ry = radius * (1 - stretch * 0.45) * Math.cos(incl);
    const cosS = Math.cos(stretchAng), sinS = Math.sin(stretchAng);
    const lx = Math.cos(a) * rx;
    const ly = Math.sin(a) * ry;
    return {
      x: well.x + lx * cosS - ly * sinS,
      y: well.y + lx * sinS + ly * cosS,
      depth: Math.sin(a) * Math.sin(incl),
    };
  }

  function drawEllipse(radius, stretch, stretchAng, color) {
    ctx.beginPath();
    for (let i = 0; i <= 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      const lx = Math.cos(a) * radius * (1 + stretch);
      const ly = Math.sin(a) * radius * (1 - stretch * 0.45) * Math.cos(incl);
      const x = well.x + lx * Math.cos(stretchAng) - ly * Math.sin(stretchAng);
      const y = well.y + lx * Math.sin(stretchAng) + ly * Math.cos(stretchAng);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawCube(alpha) {
    if (alpha < 0.02) return;
    const faces = FACES.map((f) => {
      const pts = f.map((i) => projected[i]);
      return { pts, z: pts.reduce((s, p) => s + p.z, 0) / pts.length };
    }).sort((a, b) => b.z - a.z);
    faces.forEach((f) => {
      ctx.beginPath();
      f.pts.forEach((p, i) => (i ? ctx.lineTo(well.x + p.x, well.y + p.y) : ctx.moveTo(well.x + p.x, well.y + p.y)));
      ctx.closePath();
      ctx.fillStyle = BONE + (clamp(0.05 - f.z * 0.04, 0.02, 0.16) * alpha) + ')';
      ctx.fill();
    });
    ctx.beginPath();
    EDGES.forEach(([i, j]) => {
      ctx.moveTo(well.x + projected[i].x, well.y + projected[i].y);
      ctx.lineTo(well.x + projected[j].x, well.y + projected[j].y);
    });
    ctx.strokeStyle = BONE + (0.92 * alpha) + ')';
    ctx.lineWidth = 1.35;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  function drawWord(alpha) {
    if (alpha < 0.02) return;
    const size = clamp(Math.min(w, h) * 0.07, 40, 64);
    ctx.font = `600 ${size}px Bahnschrift, "Segoe UI", sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const text = 'CURSOR';
    const spacing = size * 0.14;
    const widths = [...text].map((ch) => ctx.measureText(ch).width);
    const total = widths.reduce((s, v) => s + v, 0) + spacing * (text.length - 1);
    let x = well.x - total / 2;
    const y = well.y + clamp(Math.min(w, h) * 0.092, 62, 92) * 1.55 + 18;
    ctx.fillStyle = `rgba(237,236,236,${alpha})`;
    for (let i = 0; i < text.length; i++) {
      ctx.fillText(text[i], x, y);
      x += widths[i] + spacing;
    }
    ctx.font = '400 13px "Microsoft YaHei UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = `rgba(237,236,236,${alpha * 0.7})`;
    ctx.fillText(committedAt >= 0 ? '开机动画  ·  你让它坍缩' : '开机动画  ·  轨道已落下', well.x, y + size * 0.62);
  }

  function drawCaretAt(x, y, hh, color, glow) {
    ctx.save();
    if (glow) {
      ctx.shadowColor = 'rgba(245,78,0,.8)';
      ctx.shadowBlur = 18;
    }
    ctx.fillStyle = color;
    ctx.fillRect(x - 1, y - hh / 2, 2, hh);
    ctx.restore();
  }

  function render(dt, instant) {
    const t = clock.t;
    const target = userActive() ? mouse : autoCenter(t);
    const k = instant ? 1 : 1 - Math.exp(-dt / 140);
    well.x = lerp(well.x, target.x, k);
    well.y = lerp(well.y, target.y, k);

    const hand = seg(t, 8600, 10000);
    if (hand > 0) {
      const dest = $('liveCaret').getBoundingClientRect();
      if (dest.height) {
        const p = ease(hand);
        well.x = lerp(well.x, dest.left + 1, p);
        well.y = lerp(well.y, dest.top + dest.height / 2, p);
      }
    }

    const speed = dt > 0 ? Math.hypot(well.x - prevWell.x, well.y - prevWell.y) / dt * 1000 : 0;
    prevWell = { x: well.x, y: well.y };
    vel.x = lerp(vel.x, well.x - (vel._x == null ? well.x : vel._x), 0.4);
    vel.y = lerp(vel.y, well.y - (vel._y == null ? well.y : vel._y), 0.4);
    vel._x = well.x;
    vel._y = well.y;
    if (speed > 700 && committedAt >= 0 && t < 8200 && t - committedAt > 400) committedAt = -1;

    const fall = collapseOf(t);
    const vmag = Math.hypot(vel.x, vel.y);
    const stretch = Math.max(stretchForce, clamp(vmag / 80, 0, 0.72));
    const stretchAng = vmag > 0.5 ? Math.atan2(vel.y, vel.x) : -0.4;
    const appear = reduced ? 1 : seg(t, 180, 900);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#14120B';
    ctx.fillRect(0, 0, w, h);

    const orbitAlpha = appear * (1 - fall * 0.92) * (1 - hand);
    RINGS.forEach((ring, i) => {
      drawEllipse(ring.r * (1 - fall), stretch, stretchAng, i === 0 ? `rgba(245,78,0,${0.55 * orbitAlpha})` : BONE + (0.22 * orbitAlpha) + ')');
    });

    projectCube(t * 0.00015);
    const drawn = bodies.map((b) => ({ b, p: place(b, t, b.kind === 'shard' ? fall : fall * 0.92, stretch, stretchAng) }));
    drawn.sort((a, b) => a.p.depth - b.p.depth);
    drawn.forEach(({ b, p }) => {
      const fade = appear * (1 - ease(clamp(fall / 0.72, 0, 1))) * (1 - hand);
      if (fade < 0.04) return;
      const depth = 0.55 + p.depth * 0.45;
      if (b.kind === 'word') {
        ctx.globalAlpha = fade * depth;
        ctx.font = `${b.r < 100 ? 15 : 13}px "Cascadia Code", "Microsoft YaHei UI", Consolas, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = BONE + '0.9)';
        ctx.fillText(b.text, p.x, p.y);
        ctx.globalAlpha = 1;
      } else if (b.kind === 'caret') {
        drawCaretAt(p.x, p.y, b.orange ? 18 : 14, b.orange ? ACCENT : `rgba(237,236,236,${0.8 * fade})`, b.orange && fade > 0.4);
      } else {
        const tang = b.angle + t * b.speed + Math.PI / 2;
        ctx.globalAlpha = fade * 0.85;
        ctx.beginPath();
        ctx.moveTo(p.x - Math.cos(tang) * 11, p.y - Math.sin(tang) * 11);
        ctx.lineTo(p.x + Math.cos(tang) * 11, p.y + Math.sin(tang) * 11);
        ctx.strokeStyle = 'rgba(237,236,236,.85)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    });

    drawCube(fall * (1 - hand));

    if (fall > 0.45) drawWord(seg(fall, 0.45, 0.85) * (1 - seg(hand, 0, 0.5)));
    if (t > 200 && hand < 0.92) drawCaretAt(well.x, well.y, lerp(22, 16, hand), hand > 0.75 ? '#EDECEC' : ACCENT, hand < 0.6);

    const count = bodies.filter((b) => b.kind !== 'caret').length;
    const text = `质量 1.00   在轨 ${Math.round(count * (1 - fall))}   倾角 ${Math.round(incl * 180 / Math.PI)}°   坍缩 ${fall.toFixed(2)}`;
    if (text !== statusText) { statusText = text; statusEl.textContent = text; }
    const phase = hand > 0 ? '交接：井收进编辑器' : fall > 0.55 ? '轨道正在落下' : t > 900 ? (userActive() ? '引力井跟着你' : '井在自己漂') : '轨道展开';
    if (phaseEl.textContent !== phase) phaseEl.textContent = phase;
    timeEl.textContent = `${(t / 1000).toFixed(2)} / ${(DURATION / 1000).toFixed(2)} s`;
    if (!scrubbing) scrub.value = String(Math.round((t / DURATION) * 1000));
    inclVal.textContent = `${Math.round(incl * 180 / Math.PI)}°`;

    veil.style.opacity = (1 - seg(t, 8800, 9800)).toFixed(3);
    canvas.style.opacity = (1 - seg(t, 9000, 10200)).toFixed(3);
    wb.style.opacity = seg(t, 9000, 10400).toFixed(3);
    document.body.classList.toggle('done', t >= 10000);
    $('sb').textContent = t >= 9800 ? '坍缩 · 已交接' : '';

    if (t >= DURATION && !finished) {
      finished = true;
      clock.playing = false;
      canvas.style.pointerEvents = 'none';
      playBtn.classList.add('paused');
    } else if (t < DURATION && finished) {
      finished = false;
      canvas.style.pointerEvents = '';
    }
  }

  function frame(now) {
    const raf = requestAnimationFrame(frame);
    const dt = Math.min(48, now - lastNow);
    lastNow = now;
    try {
      if (clock.playing && !reduced) clock.t = Math.min(DURATION, clock.t + dt * clock.speed);
      render(clock.playing ? dt : 0, !clock.playing);
      playBtn.classList.toggle('paused', !clock.playing);
    } catch (err) {
      console.error('[collapse]', err);
      cancelAnimationFrame(raf);
      canvas.remove();
      veil.style.opacity = '0';
      wb.style.opacity = '1';
      document.body.classList.add('done');
      document.body.style.cursor = 'default';
    }
  }

  function replay() {
    clock.t = 0;
    clock.playing = true;
    finished = false;
    committedAt = -1;
    canvas.style.pointerEvents = '';
  }
  function commit() {
    if (committedAt < 0) committedAt = clock.t;
    document.body.classList.add('touched');
  }
  function skip() {
    if (clock.t < 8600) { clock.t = 8600; clock.playing = true; }
  }

  window.addEventListener('pointermove', (e) => {
    if (!e.isTrusted || (e.target.closest && e.target.closest('.dock'))) return;
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    lastMove = performance.now();
    moved = true;
    pinned = false;
    document.body.classList.add('touched');
  });
  window.addEventListener('pointerdown', (e) => {
    if (!e.isTrusted || e.button !== 0) return;
    if (e.target.closest && e.target.closest('.dock')) return;
    commit();
  });
  window.addEventListener('wheel', (e) => {
    if (e.target.closest && e.target.closest('.dock')) return;
    e.preventDefault();
    incl = clamp(incl + Math.sign(e.deltaY) * 0.06, 0.12, 1.35);
    inclInput.value = String(Math.round(incl * 180 / Math.PI));
    document.body.classList.add('touched');
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input')) return;
    if (e.key === 'Escape') return skip();
    if (e.key === ' ') { e.preventDefault(); clock.playing = !clock.playing; return; }
    if (e.key === 'r' || e.key === 'R') return replay();
    if (e.key === 'h' || e.key === 'H') return dock.classList.toggle('hidden');
    if (e.key === 'Enter') return commit();
    const step = e.shiftKey ? 56 : 26;
    const map = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (map[e.key]) {
      e.preventDefault();
      mouse.x = clamp((pinned ? mouse.x : well.x) + map[e.key][0], 40, w - 40);
      mouse.y = clamp((pinned ? mouse.y : well.y) + map[e.key][1], 40, h - 40);
      moved = true;
      pinned = true;
      lastMove = performance.now();
      document.body.classList.add('touched');
    }
  });
  window.addEventListener('resize', () => { resize(); render(0, true); });

  dock.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    b.blur();
    if (b.dataset.act === 'hide') dock.classList.add('hidden');
    if (b.dataset.act === 'play') {
      if (!clock.playing && clock.t >= DURATION) replay();
      else clock.playing = !clock.playing;
    }
    if (b.dataset.act === 'replay') replay();
    if (b.dataset.act === 'collapse') commit();
    if (b.dataset.act === 'skip') skip();
  });
  inclInput.addEventListener('input', () => { incl = +inclInput.value * Math.PI / 180; });
  scrub.addEventListener('input', () => {
    scrubbing = true;
    clock.playing = false;
    clock.t = (scrub.value / 1000) * DURATION;
    committedAt = -1;
    finished = false;
    canvas.style.pointerEvents = '';
  });
  scrub.addEventListener('change', () => { scrubbing = false; });

  resize();
  if (pinned) { well.x = mouse.x; well.y = mouse.y; prevWell = { x: well.x, y: well.y }; }
  requestAnimationFrame(frame);
})();
