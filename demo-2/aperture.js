/* 光圈 · Caret 开机动画第二稿
 *
 * 鼠标是一枚镜头，不是一个进度条。
 *  - 全场的针会转向焦点，镜头里面的针更长、更齐
 *  - 立方体的朝向跟着焦点偏转，拖得越快，边缘越拉出橙色像差
 *  - 三束光标性格不同：直追、环绕、预判。你一动，它们就离开立方体来追你
 *  - 不碰的时候，焦点自己沿弧线扫一遍，然后锁定、交接
 * 点击是锁定（光圈收缩），Esc 才是跳过。
 */
(function () {
  'use strict';

  const DURATION = 9600;
  const ACCENT = '#F54E00';
  const BONE = 'rgba(237,236,236,';
  const WORD = 'CURSOR';
  const LABELS = ['直追', '环绕', '预判', '对焦', '锁定', '视差', '光束', '交接'];

  const V = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ];
  const FACES = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 3, 7, 4]];
  const EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];

  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (p) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);
  const seg = (t, a, b) => clamp((t - a) / (b - a), 0, 1);
  function lerpAngle(a, b, t) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  const q = new URLSearchParams(location.search);
  const canvas = $('#c');
  const ctx = canvas.getContext('2d');
  const wb = $('#wb');
  const veil = $('#veil');
  const dock = $('#dock');
  const statusEl = $('#status');
  const phaseEl = $('#phase');
  const timeEl = $('#time');
  const scrub = $('#scrub');
  const focalInput = $('#focal');
  const focalVal = $('#focalVal');
  const playBtn = $('#btnPlay');

  const agents = [0, 1, 2].map((i) => ({ i, x: 0, y: 0, trail: [] }));

  const clock = { t: 0, playing: !q.has('t'), speed: 1 };
  const mouse = { x: innerWidth / 2, y: innerHeight / 2 };
  let w = 1, h = 1, cx = 0, cy = 0, dpr = 1;
  let focus = { x: innerWidth / 2, y: innerHeight / 2, r: 158 };
  let focal = q.has('focal') ? clamp(+q.get('focal'), 96, 250) : 158;
  let lead = q.has('lead') ? clamp(+q.get('lead'), -1, 2) : -1;
  let pinned = q.has('mx');
  let moved = pinned;
  let lastMove = pinned ? 1e15 : 0;
  let iris = q.has('iris') ? clamp(+q.get('iris'), 0, 1) : 0;
  let stability = 0.55;
  let vel = { x: 0, y: 0 };
  let prevFocus = { x: focus.x, y: focus.y };
  let scrubbing = false;
  let lastNow = performance.now();
  let raf = 0;
  let reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pulses = [];
  const sweep = [];
  let projected = [];
  let skipAt = -1;
  let statusText = '';
  let finished = false;

  if (q.get('clean') === '1') document.body.classList.add('clean');
  if (q.has('mx')) mouse.x = clamp(+q.get('mx'), 0, 1) * innerWidth;
  if (q.has('my')) mouse.y = clamp(+q.get('my'), 0, 1) * innerHeight;
  if (q.has('t')) clock.t = clamp(+q.get('t'), 0, DURATION);
  focalInput.value = String(Math.round(focal));

  function resize() {
    w = innerWidth;
    h = innerHeight;
    dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cx = w / 2;
    cy = h * 0.44;
    if (pinned && q.has('mx')) {
      mouse.x = clamp(+q.get('mx'), 0, 1) * w;
      mouse.y = clamp(+q.get('my') || 0.5, 0, 1) * h;
    }
  }

  function userActive() {
    return pinned || (moved && performance.now() - lastMove < 1700);
  }

  function autoPoint(t) {
    const u = ease(seg(t, 400, 7600));
    const ang = -0.9 + u * 2.7;
    const rad = Math.sin(u * Math.PI) * Math.min(w, h) * 0.26;
    return { x: cx + Math.cos(ang) * rad, y: cy + Math.sin(ang) * rad * 0.72 };
  }

  function desiredPoint(t) {
    if (userActive()) return { x: mouse.x, y: mouse.y };
    return autoPoint(t);
  }

  function projectAll(t, fx, fy) {
    const spin = reduced ? 0.5 : t * 0.00012;
    const rotY = spin + ((fx - cx) / Math.max(w, 1)) * 1.7;
    const rotX = 0.42 + ((fy - cy) / Math.max(h, 1)) * 1.15;
    const cyaw = Math.cos(rotY), syaw = Math.sin(rotY);
    const cpit = Math.cos(rotX), spit = Math.sin(rotX);
    const size = clamp(Math.min(w, h) * 0.105, 68, 104);
    projected = V.map(([x, y, z]) => {
      const x1 = x * cyaw + z * syaw;
      const z1 = -x * syaw + z * cyaw;
      const y1 = y * cpit - z1 * spit;
      const z2 = y * spit + z1 * cpit;
      const s = 4.4 / (4.4 + z2);
      return { x: cx + x1 * size * s, y: cy + y1 * size * s, z: z2 };
    });
  }

  function edgeProgress(t, k) {
    if (reduced) return 1;
    return ease(seg(t, 1500 + k * 760, 1500 + k * 760 + 640));
  }

  function edgeHead(i) {
    const mine = EDGES.filter((_, idx) => idx % 3 === i);
    let last = projected[mine[0][0]];
    for (let k = 0; k < mine.length; k++) {
      const p = edgeProgress(clock.t, k);
      const a = projected[mine[k][0]];
      const b = projected[mine[k][1]];
      if (p < 1) return { x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p) };
      last = b;
    }
    return last;
  }

  function huntPoint(i, fx, fy) {
    if (i === 1) {
      const a = clock.t * 0.0016 + 2.2;
      return { x: fx + Math.cos(a) * 62, y: fy + Math.sin(a) * 62 };
    }
    if (i === 2) return { x: fx + vel.x * 0.18, y: fy + vel.y * 0.18 };
    return { x: fx, y: fy };
  }

  function drawNeedles(influence, len, alpha) {
    const gap = 46;
    const slideX = (cx - focus.x) * 0.1;
    const slideY = (cy - focus.y) * 0.1;
    ctx.lineWidth = 1.15;
    ctx.strokeStyle = BONE + alpha + ')';
    ctx.beginPath();
    for (let gy = -1; gy < h / gap + 2; gy++) {
      for (let gx = -1; gx < w / gap + 2; gx++) {
        const x = gx * gap + ((slideX % gap) + gap) % gap;
        const y = gy * gap + ((slideY % gap) + gap) % gap;
        if (Math.hypot(x - focus.x, y - focus.y) < 46) continue;
        if (Math.hypot(x - cx, y - cy) < 150) continue;
        const wx = x - slideX;
        const wy = y - slideY;
        const base = ((Math.sin(wx * 0.017) + Math.cos(wy * 0.013)) * 0.5) * Math.PI;
        const aim = Math.atan2(focus.y - y, focus.x - x);
        const ang = lerpAngle(base, aim, influence);
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
      }
    }
    ctx.stroke();
  }

  function drawLabels(alpha) {
    ctx.font = '400 12px "Microsoft YaHei UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = BONE + alpha + ')';
    const radius = clamp(Math.min(w, h) * 0.4, 250, 390);
    const wordY = cy + clamp(Math.min(w, h) * 0.168, 118, 156);
    LABELS.forEach((text, i) => {
      const a = -Math.PI / 2 + (i / LABELS.length) * Math.PI * 2 + clock.t * 0.00004;
      const x = cx + Math.cos(a) * radius + (cx - focus.x) * 0.04;
      const y = cy + Math.sin(a) * radius * 0.82 + (cy - focus.y) * 0.04;
      if (Math.hypot(x - cx, y - wordY) < 120) return;
      ctx.fillText(text, x, y);
    });
  }

  function drawCube(color, width, offsetX, offsetY) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    EDGES.forEach((e, idx) => {
      const p = edgeProgress(clock.t, idx % 4);
      if (p <= 0) return;
      const a = projected[e[0]];
      const b = projected[e[1]];
      ctx.moveTo(a.x + offsetX, a.y + offsetY);
      ctx.lineTo(lerp(a.x, b.x, p) + offsetX, lerp(a.y, b.y, p) + offsetY);
    });
    ctx.stroke();
  }

  function drawFaces(alphaMul) {
    const fade = reduced ? 1 : seg(clock.t, 4500, 5600);
    if (fade <= 0) return;
    const faces = FACES.map((f) => {
      const pts = f.map((i) => projected[i]);
      const z = pts.reduce((s, p) => s + p.z, 0) / pts.length;
      return { pts, z };
    }).sort((a, b) => b.z - a.z);
    for (const f of faces) {
      const shade = clamp(0.16 - f.z * 0.08, 0.04, 0.28) * fade * alphaMul;
      ctx.beginPath();
      f.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = BONE + shade + ')';
      ctx.fill();
    }
  }

  function drawWord(alpha) {
    const n = reduced ? 6 : clock.t < 5450 ? 0 : Math.min(6, Math.floor((clock.t - 5450) / 100) + 1);
    if (!n || alpha < 0.02) return;
    const text = WORD.slice(0, n);
    const size = clamp(Math.min(w, h) * 0.072, 40, 68);
    ctx.font = `600 ${size}px Bahnschrift, "Segoe UI", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const spacing = size * 0.16;
    const widths = [...text].map((ch) => ctx.measureText(ch).width);
    const total = widths.reduce((s, v) => s + v, 0) + spacing * (text.length - 1);
    let x = cx - total / 2;
    const y = cy + clamp(Math.min(w, h) * 0.168, 118, 156);
    ctx.fillStyle = `rgba(237,236,236,${alpha})`;
    for (let i = 0; i < text.length; i++) {
      ctx.fillText(text[i], x, y);
      x += widths[i] + spacing;
    }
    if (n === 6 && clock.t > 6300) {
      ctx.font = '400 13px "Microsoft YaHei UI", sans-serif';
      ctx.textAlign = 'center';
      const sub = userActive() ? '开机动画  ·  焦点在你手里' : '开机动画  ·  自动对焦完成';
      ctx.globalAlpha = alpha * seg(clock.t, 6300, 6800);
      ctx.fillText(sub, cx, y + size * 0.72);
      ctx.globalAlpha = 1;
    }
  }

  function drawRing() {
    const r = focus.r;
    const dist = Math.hypot(focus.x - cx, focus.y - cy);
    const locked = dist < 64 && clock.t > 4800;
    ctx.lineCap = 'butt';
    ctx.strokeStyle = locked ? 'rgba(245,78,0,.85)' : BONE + '0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(focus.x, focus.y, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = BONE + '0.38)';
    ctx.beginPath();
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      const long = i % 6 === 0;
      const r0 = r + 4;
      const r1 = r + (long ? 12 : 7);
      ctx.moveTo(focus.x + Math.cos(a) * r0, focus.y + Math.sin(a) * r0);
      ctx.lineTo(focus.x + Math.cos(a) * r1, focus.y + Math.sin(a) * r1);
    }
    ctx.stroke();

    // 稳定度：内圈的橙色弧，停得越稳越接近整圆
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(focus.x, focus.y, r - 8, -Math.PI / 2, -Math.PI / 2 + Math.max(0.04, stability) * Math.PI * 2);
    ctx.stroke();

    if (dist > 90) {
      const ang = Math.atan2(cy - focus.y, cx - focus.x);
      const bx = focus.x + Math.cos(ang) * (r + 16);
      const by = focus.y + Math.sin(ang) * (r + 16);
      ctx.save();
      ctx.translate(bx, by);
      ctx.rotate(ang);
      ctx.fillStyle = ACCENT;
      ctx.beginPath();
      ctx.moveTo(7, 0);
      ctx.lineTo(-4, 3.2);
      ctx.lineTo(-4, -3.2);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  function drawAgents() {
    const fade = 1 - seg(clock.t, 8300, 9000);
    agents.forEach((a) => {
      if (a.trail.length > 1) {
        ctx.beginPath();
        a.trail.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        const hot = lead === a.i;
        ctx.strokeStyle = hot ? `rgba(245,78,0,${0.45 * fade})` : BONE + (0.28 * fade) + ')';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.fillStyle = ACCENT;
      ctx.globalAlpha = fade;
      ctx.fillRect(a.x - 1, a.y - 8, 2, 16);
      ctx.globalAlpha = 1;
      if (lead === a.i || userActive()) {
        ctx.font = '11px "Cascadia Code", Consolas, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = BONE + (0.55 * fade) + ')';
        ctx.fillText(String(a.i + 1).padStart(2, '0'), a.x + 7, a.y - 2);
      }
    });
  }

  function drawCaret() {
    const fly = seg(clock.t, 8200, 9500);
    const hh = lerp(24, 18, ease(fly));
    ctx.save();
    ctx.shadowColor = 'rgba(245,78,0,.75)';
    ctx.shadowBlur = 16 * (1 - fly);
    ctx.fillStyle = fly > 0.82 ? '#EDECEC' : ACCENT;
    ctx.fillRect(focus.x - 1, focus.y - hh / 2, 2, hh);
    ctx.restore();
  }

  function updateStatus() {
    const dist = Math.hypot(focus.x - cx, focus.y - cy);
    const bearing = Math.round((Math.atan2(cy - focus.y, cx - focus.x) * 180 / Math.PI + 360) % 360);
    const locked = dist < 64 && clock.t > 4800;
    const beam = lead < 0 ? '三束' : `光束 0${lead + 1}`;
    const text = `焦距 ${Math.round(focal)}   稳定 ${stability.toFixed(2)}   方位 ${String(bearing).padStart(3, ' ')}°   ${beam}${locked ? '   锁定' : ''}`;
    if (text !== statusText) {
      statusText = text;
      statusEl.textContent = text;
    }
    const phase = clock.t > 8200 ? '交接：光圈收进编辑器'
      : clock.t > 5450 ? '焦点点亮字标'
      : clock.t > 1500 ? (userActive() ? '三束光标在追你的焦点' : '自动扫掠，正在找焦点')
      : '光圈唤醒';
    if (phaseEl.textContent !== phase) phaseEl.textContent = phase;
    timeEl.textContent = `${(clock.t / 1000).toFixed(2)} / ${(DURATION / 1000).toFixed(2)} s`;
    if (!scrubbing) scrub.value = String(Math.round((clock.t / DURATION) * 1000));
    focalVal.textContent = String(Math.round(focal));
  }

  function render(dt, instant) {
    const t = clock.t;
    const target = desiredPoint(t);
    const k = instant ? 1 : 1 - Math.exp(-dt / 90);
    focus.x = lerp(focus.x, target.x, k);
    focus.y = lerp(focus.y, target.y, k);

    const hand = seg(t, 8200, 9500);
    if (hand > 0) {
      const dest = document.getElementById('liveCaret').getBoundingClientRect();
      if (dest.height > 0) {
        const p = ease(hand);
        focus.x = lerp(focus.x, dest.left + 1, p);
        focus.y = lerp(focus.y, dest.top + dest.height / 2, p);
      }
    }

    const speed = dt > 0 ? Math.hypot(focus.x - prevFocus.x, focus.y - prevFocus.y) / dt * 1000 : 0;
    prevFocus = { x: focus.x, y: focus.y };
    vel.x = lerp(vel.x, (focus.x - (vel._x || focus.x)), 0.35);
    vel.y = lerp(vel.y, (focus.y - (vel._y || focus.y)), 0.35);
    vel._x = focus.x;
    vel._y = focus.y;
    const calm = Math.exp(-speed / 900);
    stability = lerp(stability, calm, instant ? 1 : 1 - Math.exp(-dt / 220));
    iris *= instant ? 1 : Math.exp(-dt / 160);
    const handScale = 1 - ease(hand);
    focus.r = focal * (1 - 0.4 * iris) * lerp(1, 0.06, ease(hand));

    projectAll(t, focus.x, focus.y);

    const active = userActive();
    agents.forEach((a) => {
      const home = edgeHead(a.i);
      const hunt = huntPoint(a.i, focus.x, focus.y);
      const distC = Math.hypot(focus.x - cx, focus.y - cy);
      let blend = active ? clamp((distC - 36) / 200, 0, 1) : 0.05;
      if (lead === a.i) blend = Math.max(blend, active ? 0.85 : 0.25);
      else if (lead >= 0) blend *= 0.3;
      const tx = lerp(home.x, hunt.x, blend);
      const ty = lerp(home.y, hunt.y, blend);
      const lag = instant ? 1 : 1 - Math.exp(-dt / (lead === a.i ? 70 : 90 + a.i * 40));
      a.x = lerp(a.x || tx, tx, lag);
      a.y = lerp(a.y || ty, ty, lag);
      if (instant || dt > 80) a.trail = [{ x: a.x, y: a.y }];
      else {
        a.trail.push({ x: a.x, y: a.y });
        if (a.trail.length > 16) a.trail.shift();
      }
    });

    if (!instant && dt > 0 && dt < 80) sweep.push({ x: focus.x, y: focus.y, t });
    while (sweep.length && t - sweep[0].t > 1500) sweep.shift();

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#14120B';
    ctx.fillRect(0, 0, w, h);
    const awaken = reduced ? 1 : seg(t, 200, 1100);

    ctx.globalAlpha = awaken;
    drawNeedles(0.84, 13, 0.26);
    drawLabels(0.16);
    drawFaces(0.45);
    drawCube(BONE + '0.28)', 1, 0, 0);
    ctx.globalAlpha = 1;

    ctx.save();
    ctx.beginPath();
    ctx.arc(focus.x, focus.y, Math.max(2, focus.r), 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#16140e';
    ctx.fillRect(0, 0, w, h);
    const g = ctx.createRadialGradient(focus.x, focus.y, focus.r * 0.15, focus.x, focus.y, focus.r);
    g.addColorStop(0, 'rgba(237,236,236,.045)');
    g.addColorStop(1, 'rgba(237,236,236,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    drawNeedles(1, 28, 0.9);
    drawLabels(0.9);
    drawFaces(1);
    const smear = Math.min(12, speed * 0.01);
    if (smear > 1.2) {
      const nx = vel.x / (Math.hypot(vel.x, vel.y) || 1);
      const ny = vel.y / (Math.hypot(vel.x, vel.y) || 1);
      drawCube('rgba(245,78,0,.4)', 1.2, nx * smear, ny * smear);
    }
    drawCube('rgba(237,236,236,.95)', 1.45, 0, 0);
    ctx.restore();

    if (sweep.length > 1 && handScale > 0.2) {
      ctx.beginPath();
      sweep.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.strokeStyle = 'rgba(245,78,0,.38)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    pulses.forEach((p) => {
      const u = clamp((t - p.t) / 420, 0, 1);
      if (u >= 1) return;
      ctx.beginPath();
      ctx.arc(p.x, p.y, lerp(20, 120, ease(u)), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(245,78,0,${0.45 * (1 - u)})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    });
    for (let i = pulses.length - 1; i >= 0; i--) if (t - pulses[i].t > 420) pulses.splice(i, 1);

    if (hand < 0.92) {
      ctx.globalAlpha = awaken * (1 - hand);
      drawRing();
      drawAgents();
      ctx.globalAlpha = 1;
    }
    const wordY = cy + clamp(Math.min(w, h) * 0.168, 118, 156);
    const wordDist = Math.hypot(focus.x - cx, focus.y - wordY);
    const cover = clamp(1 - (wordDist - focus.r) / 90, 0, 1);
    if (hand < 0.4) drawWord(0.16 + 0.84 * cover);
    if (t > 700 && hand < 0.95) drawCaret();

    const veilFade = 1 - seg(t, 8400, 9300);
    veil.style.opacity = veilFade.toFixed(3);
    canvas.style.opacity = (1 - seg(t, 8300, 9200)).toFixed(3);
    wb.style.opacity = seg(t, 8600, 9600).toFixed(3);
    document.body.classList.toggle('done', t >= 9300);
    $('#sb').textContent = t >= 9000 ? '光圈 · 已交接' : '';
    updateStatus();

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
    raf = requestAnimationFrame(frame);
    const dt = Math.min(48, now - lastNow);
    lastNow = now;
    try {
      if (clock.playing && !reduced) clock.t = Math.min(DURATION, clock.t + dt * clock.speed);
      render(clock.playing ? dt : 0, !clock.playing);
      playBtn.classList.toggle('paused', !clock.playing);
    } catch (err) {
      console.error('[aperture]', err);
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
    canvas.style.pointerEvents = '';
    iris = 0;
    sweep.length = 0;
    pulses.length = 0;
    agents.forEach((a) => { a.trail = []; });
    skipAt = -1;
  }

  function skip() {
    if (clock.t < 8200) {
      clock.t = 8200;
      clock.playing = true;
    }
  }

  function setLead(n) {
    lead = n;
    document.querySelectorAll('#leads button').forEach((b) => b.classList.toggle('on', +b.dataset.lead === n));
  }

  window.addEventListener('pointermove', (e) => {
    if (!e.isTrusted) return;
    if (e.target.closest && e.target.closest('.dock')) return;
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
    iris = 1;
    pulses.push({ t: clock.t, x: e.clientX, y: e.clientY });
    document.body.classList.add('touched');
  });
  window.addEventListener('wheel', (e) => {
    if (e.target.closest && e.target.closest('.dock')) return;
    e.preventDefault();
    focal = clamp(focal + Math.sign(e.deltaY) * 12, 96, 250);
    focalInput.value = String(Math.round(focal));
    document.body.classList.add('touched');
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input')) return;
    if (e.key === '1' || e.key === '2' || e.key === '3') return setLead(+e.key - 1);
    if (e.key === '0' || e.key === '`') return setLead(-1);
    if (e.key === 'Escape') return skip();
    if (e.key === ' ') { e.preventDefault(); clock.playing = !clock.playing; return; }
    if (e.key === 'r' || e.key === 'R') return replay();
    if (e.key === 'h' || e.key === 'H') return dock.classList.toggle('hidden');
    const step = e.shiftKey ? 48 : 22;
    const map = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (map[e.key]) {
      e.preventDefault();
      mouse.x = clamp(mouse.x + map[e.key][0], 0, w);
      mouse.y = clamp(mouse.y + map[e.key][1], 0, h);
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
    if (b.dataset.lead != null) return setLead(+b.dataset.lead);
    if (b.dataset.act === 'hide') dock.classList.add('hidden');
    if (b.dataset.act === 'play') {
      if (!clock.playing && clock.t >= DURATION) replay();
      else clock.playing = !clock.playing;
    }
    if (b.dataset.act === 'replay') replay();
    if (b.dataset.act === 'skip') skip();
    if (b.dataset.act === 'slow') {
      clock.speed = clock.speed === 1 ? 0.35 : 1;
      b.classList.toggle('on', clock.speed !== 1);
    }
  });
  focalInput.addEventListener('input', () => { focal = +focalInput.value; });
  scrub.addEventListener('input', () => {
    scrubbing = true;
    clock.playing = false;
    clock.t = (scrub.value / 1000) * DURATION;
    finished = false;
    canvas.style.pointerEvents = '';
  });
  scrub.addEventListener('change', () => { scrubbing = false; });

  setLead(lead);
  resize();
  if (pinned) { focus.x = mouse.x; focus.y = mouse.y; }
  window.CaretAperture = {
    duration: DURATION,
    poke(x, y) { mouse.x = x; mouse.y = y; moved = true; pinned = true; lastMove = performance.now(); },
    seek(t) { clock.t = clamp(t, 0, DURATION); clock.playing = false; render(0, true); },
    state() {
      return {
        t: clock.t, x: focus.x, y: focus.y, r: focus.r, stability,
        rotInfluence: (focus.x - cx) / w, agents: agents.map((a) => ({ x: a.x, y: a.y })),
      };
    },
  };
  requestAnimationFrame(frame);
})();
