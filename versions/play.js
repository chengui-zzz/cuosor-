'use strict';

const NS = 'http://www.w3.org/2000/svg';
const CUTS = {
  shutter: { name: '快门', dur: 4600 },
  strike: { name: '一击', dur: 4800 },
  word: { name: '一个词', dur: 5200 },
  drop: { name: '落点', dur: 4800 },
  flip: { name: '翻面', dur: 5200 },
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const seg = (t, a, b) => clamp((t - a) / (b - a), 0, 1);
const ease = (p) => p * p * (3 - 2 * p);
const easeIn = (p) => p * p * p;
const easeOut = (p) => 1 - (1 - p) ** 3;

const params = new URLSearchParams(location.search);
let cut = CUTS[params.get('v')] ? params.get('v') : 'shutter';
const stage = document.getElementById('stage');
const wb = document.getElementById('wb');
const phaseEl = document.getElementById('phase');
const timeEl = document.getElementById('time');
const scrub = document.getElementById('scrub');
const playBtn = document.getElementById('btnPlay');
const lines = [];
const heads = [];
let pointer = null;
let playing = true;
let t0 = performance.now();
let pausedAt = 0;

if (params.get('clean') === '1') document.body.classList.add('clean');
if (params.get('mx') && params.get('my')) {
  pointer = { x: Number(params.get('mx')), y: Number(params.get('my')) };
}
if (params.has('t')) {
  pausedAt = Number(params.get('t')) || 0;
  playing = false;
}

document.querySelectorAll('[data-cube]').forEach(fillCube);
buildStrike();
showCut(cut);

addEventListener('pointermove', (e) => {
  if (e.isTrusted) pointer = { x: e.clientX, y: e.clientY };
});
document.getElementById('cuts').addEventListener('click', (e) => {
  const id = e.target.closest('button')?.dataset.v;
  if (id) switchCut(id);
});
document.getElementById('btnReplay').addEventListener('click', replay);
playBtn.addEventListener('click', toggle);
scrub.addEventListener('input', () => {
  const dur = CUTS[cut].dur;
  pausedAt = (Number(scrub.value) / 1000) * dur;
  playing = false;
  playBtn.classList.add('paused');
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') skip();
  if (e.key === ' ') { e.preventDefault(); toggle(); }
  const n = '12345'.indexOf(e.key);
  if (n >= 0) switchCut(Object.keys(CUTS)[n]);
});

requestAnimationFrame(frame);

function fillCube(host) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '-50 -58 100 116');
  [
    ['0,-46 40,-23 0,0 -40,-23', 'rgba(237,236,236,.16)'],
    ['-40,-23 0,0 0,46 -40,23', 'rgba(237,236,236,.08)'],
    ['0,0 40,-23 40,23 0,46', 'rgba(237,236,236,.05)'],
  ].forEach(([pts, fill]) => {
    const p = document.createElementNS(NS, 'polygon');
    p.setAttribute('points', pts);
    p.setAttribute('fill', fill);
    svg.appendChild(p);
  });
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', 'M0 -46 L40 -23 L40 23 L0 46 L-40 23 L-40 -23 Z M0 0 L-40 -23 M0 0 L40 -23 M0 0 L0 46');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', '#EDECEC');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  host.appendChild(svg);
}

function buildStrike() {
  const svg = document.getElementById('st-svg');
  for (let i = 0; i < 3; i++) {
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('stroke', 'rgba(237,236,236,.5)');
    line.setAttribute('stroke-width', '1.25');
    svg.appendChild(line);
    lines.push(line);
    const head = document.createElementNS(NS, 'polygon');
    head.setAttribute('fill', '#F54E00');
    svg.appendChild(head);
    heads.push(head);
  }
}

function showCut(id) {
  document.querySelectorAll('.scene').forEach((el) => {
    el.classList.toggle('on', el.dataset.id === id);
  });
  document.querySelectorAll('#cuts button').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.v === id);
  });
  document.getElementById('cutName').textContent = CUTS[id].name;
  document.getElementById('sb').textContent = CUTS[id].name;
  document.title = 'Caret · ' + CUTS[id].name;
}

function switchCut(id) {
  cut = id;
  const url = new URL(location.href);
  url.searchParams.set('v', id);
  url.searchParams.delete('t');
  history.replaceState(null, '', url);
  showCut(id);
  replay();
}

function replay() {
  t0 = performance.now();
  pausedAt = 0;
  playing = true;
  playBtn.classList.remove('paused');
  document.body.classList.remove('done');
}

function toggle() {
  if (playing) {
    pausedAt = performance.now() - t0;
    playing = false;
    playBtn.classList.add('paused');
  } else {
    if (pausedAt >= CUTS[cut].dur - 20) replay();
    else {
      t0 = performance.now() - pausedAt;
      playing = true;
      playBtn.classList.remove('paused');
    }
  }
}

function skip() {
  pausedAt = CUTS[cut].dur;
  playing = false;
  playBtn.classList.add('paused');
}

function now() {
  if (!playing) return pausedAt;
  return performance.now() - t0;
}

function frame() {
  const dur = CUTS[cut].dur;
  let t = now();
  if (t >= dur) {
    t = dur;
    if (playing) {
      playing = false;
      pausedAt = dur;
      playBtn.classList.add('paused');
    }
  }
  apply(cut, t);
  scrub.value = String(Math.round((t / dur) * 1000));
  timeEl.textContent = (t / 1000).toFixed(2) + 's';
  requestAnimationFrame(frame);
}

function handoff(t, a, b) {
  const p = ease(seg(t, a, b));
  stage.style.opacity = String(1 - p);
  wb.style.opacity = String(p);
  document.body.classList.toggle('done', p > 0.92);
}

function iconCenter() {
  const r = document.querySelector('.window-appicon').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function caretPoints(x, y, angle) {
  const L = 12;
  return [[L, 0], [-7, 5.2], [-7, -5.2]].map(([px, py]) => {
    const rx = px * Math.cos(angle) - py * Math.sin(angle);
    const ry = px * Math.sin(angle) + py * Math.cos(angle);
    return (x + rx).toFixed(1) + ',' + (y + ry).toFixed(1);
  }).join(' ');
}

function apply(id, t) {
  if (id === 'shutter') return shutter(t);
  if (id === 'strike') return strike(t);
  if (id === 'word') return word(t);
  if (id === 'drop') return drop(t);
  return flip(t);
}

function shutter(t) {
  const close = ease(seg(t, 280, 1150));
  const open = ease(seg(t, 1550, 2550));
  const shut = close * (1 - open);
  document.getElementById('sh-top').style.height = shut * 50 + '%';
  document.getElementById('sh-bot').style.height = shut * 50 + '%';
  document.getElementById('sh-caret').style.opacity = t < 1500 ? String(1 - close) : '0';
  document.getElementById('sh-mark').style.opacity = t > 1050 ? '1' : '0';
  handoff(t, 3400, 4600);
  phaseEl.textContent = t < 1150 ? '合上' : t < 2550 ? '打开' : t < 3400 ? '停住' : '交给编辑器';
}

function strike(t) {
  const w = innerWidth;
  const h = innerHeight;
  const svg = document.getElementById('st-svg');
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  const corners = [[w * 0.1, h * 0.16], [w * 0.9, h * 0.16], [w * 0.5, h * 0.84]];
  const c = [w / 2, h * 0.42];
  const travel = ease(seg(t, 180, 1550));
  const fade = ease(seg(t, 1500, 1950));
  corners.forEach((p, i) => {
    const x = p[0] + (c[0] - p[0]) * travel;
    const y = p[1] + (c[1] - p[1]) * travel;
    lines[i].setAttribute('x1', p[0]);
    lines[i].setAttribute('y1', p[1]);
    lines[i].setAttribute('x2', x);
    lines[i].setAttribute('y2', y);
    lines[i].setAttribute('opacity', String(1 - fade));
    const ang = Math.atan2(c[1] - p[1], c[0] - p[0]);
    heads[i].setAttribute('points', caretPoints(x, y, ang));
    heads[i].setAttribute('opacity', String((1 - fade) * (travel > 0.02 ? 1 : 0)));
  });
  const born = easeOut(seg(t, 1500, 1950));
  const over = 1 + Math.sin(born * Math.PI) * 0.05;
  const mark = document.getElementById('st-mark');
  mark.style.top = c[1] + 'px';
  mark.style.transform = 'translate(-50%, -42%)';
  mark.style.opacity = String(born);
  mark.querySelector('.cube').style.transform = 'scale(' + ((0.55 + 0.45 * born) * over) + ')';
  mark.querySelector('.word').style.opacity = String(ease(seg(t, 1850, 2350)));
  const flash = seg(t, 1480, 2200);
  const flashEl = document.getElementById('st-flash');
  flashEl.style.left = c[0] + 'px';
  flashEl.style.top = c[1] + 'px';
  flashEl.style.margin = '0';
  flashEl.style.opacity = String(flash < 0.12 ? flash / 0.12 : Math.max(0, 1 - (flash - 0.12) / 0.88));
  flashEl.style.transform = 'translate(-50%, -50%) scale(' + (1 + flash * 22) + ')';
  handoff(t, 3600, 4800);
  phaseEl.textContent = t < 1550 ? '三道光标汇合' : t < 2350 ? '撞出字标' : t < 3600 ? '停住' : '交给编辑器';
}

function word(t) {
  const typed = document.getElementById('w-typed');
  const ghost = document.getElementById('w-ghost');
  const line = document.getElementById('w-line');
  const tab = document.getElementById('w-tab');
  const text = 'cursor';
  const n = Math.min(text.length, Math.floor(seg(t, 180, 1100) * (text.length + 0.001)));
  const ghostIn = ease(seg(t, 1150, 1550));
  const accept = seg(t, 1650, 1900);
  const collapse = ease(seg(t, 2050, 2600));
  typed.textContent = text.slice(0, n);
  ghost.textContent = ghostIn > 0 && collapse < 1 ? '开机动画' : '';
  ghost.style.opacity = String(accept > 0.55 ? 1 : ghostIn);
  ghost.style.color = accept > 0.55 ? 'rgb(237,236,236)' : 'rgba(237,236,236,.38)';
  line.style.transform = 'translate(-50%, -50%) scaleX(' + (1 - collapse) + ')';
  line.style.opacity = String(1 - Math.max(0, (collapse - 0.72) / 0.28));
  tab.style.opacity = String(ghostIn * (1 - collapse));
  tab.classList.toggle('down', accept > 0.35 && accept < 0.85);
  const born = easeOut(seg(t, 2480, 3200));
  const mark = document.getElementById('w-mark');
  mark.style.opacity = String(born);
  mark.querySelector('.cube').style.transform = 'scale(' + (0.7 + 0.3 * born) + ')';
  mark.querySelector('.word').style.opacity = String(ease(seg(t, 2900, 3400)));
  handoff(t, 4000, 5200);
  phaseEl.textContent = t < 1100 ? '写下 cursor' : t < 2050 ? '补全，按下 Tab' : t < 3200 ? '收成字标' : t < 4000 ? '停住' : '交给编辑器';
}

function drop(t) {
  const land = pointer || { x: innerWidth / 2, y: innerHeight * 0.46 };
  const fall = easeIn(seg(t, 120, 1280));
  const x = land.x;
  const y = -140 + (land.y + 140) * fall;
  const hit = seg(t, 1220, 1580);
  const squash = Math.sin(hit * Math.PI);
  let sx = 1 + squash * 0.08;
  let sy = 1 - squash * 0.1;
  const fly = ease(seg(t, 3100, 4300));
  const icon = iconCenter();
  const fx = x + (icon.x - x) * fly;
  const fy = y + (icon.y - y) * fly;
  const scale = (1 - fly * 0.82);
  const el = document.getElementById('d-drop');
  el.style.left = fx + 'px';
  el.style.top = fy + 'px';
  el.style.transform = 'translate(-74px, -90px) scale(' + (sx * scale) + ', ' + (sy * scale) + ')';
  document.getElementById('d-word').style.opacity = String(ease(seg(t, 1450, 1900)) * (1 - fly));
  handoff(t, 3900, 4800);
  phaseEl.textContent = t < 1280 ? '落下' : t < 1900 ? '落地' : t < 3100 ? '停住' : '飞进图标';
}

function flip(t) {
  const card = document.querySelector('#f-pivot .card');
  const p = ease(seg(t, 450, 1750));
  const leave = ease(seg(t, 3600, 4700));
  const front = card.querySelector('.front');
  const back = card.querySelector('.rear');
  if (p < 0.5) {
    card.style.transform = 'rotateY(' + (p * 180) + 'deg)';
    front.style.visibility = 'visible';
    back.style.visibility = 'hidden';
  } else {
    card.style.transform = 'rotateY(' + (-90 + (p - 0.5) * 180 + leave * 40) + 'deg)';
    front.style.visibility = 'hidden';
    back.style.visibility = 'visible';
  }
  document.getElementById('f-pivot').style.opacity = String(1 - leave);
  handoff(t, 3900, 5200);
  phaseEl.textContent = t < 1750 ? '翻面' : t < 3600 ? '停住' : '交给编辑器';
}

if (!playing) playBtn.classList.add('paused');
