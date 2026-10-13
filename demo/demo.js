/* Demo 外壳：模拟 Cursor 的启动里程碑、驱动开机动画、提供调参面板 */
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const params = new URLSearchParams(location.search);
  const PREF = 'caret-boot-demo:';
  const WORKSPACE = '开机动画';
  const LOADS = { fast: 900, normal: 2400, slow: 5500 };
  // 9 个里程碑在整段启动里的大致位置，最后一项是"工作台就绪"
  const SHAPE = [0.05, 0.11, 0.18, 0.24, 0.36, 0.43, 0.62, 0.72, 0.86, 1];
  // 工作台各部分在哪个里程碑之后出现：骨架 → 标题栏 → 侧栏 → Agent 面板 → 编辑器 → 状态栏
  const STAGE_GATES = [2, 5, 6, 7, 8, 9];

  const store = (() => { try { return window.localStorage; } catch (e) { return null; } })();
  const load = (k) => { try { return store && store.getItem(PREF + k); } catch (e) { return null; } };
  const save = (k, v) => { try { if (store) store.setItem(PREF + k, v); } catch (e) { /* ignore */ } };
  const pick = (k, allowed, fallback) => {
    const v = params.get(k) || load(k);
    return allowed.includes(v) ? v : fallback;
  };

  const state = {
    mode: pick('mode', ['smart', 'story', 'brief', 'off'], 'smart'),
    style: pick('style', ['dark', 'paper', 'draft'], 'dark'),
    load: pick('load', ['fast', 'normal', 'slow'], 'normal'),
  };
  const clock = { t: 0, playing: true, speed: 1, last: performance.now() };
  const deterministic = params.has('t');
  let boot = null;
  let times = [];
  let resolved = { mode: 'off', reason: '' };
  let stage = -1;
  let scrubbing = false;

  const wb = $('#wb'), dock = $('#dock'), scrub = $('#scrub');
  const timeEl = $('#time'), phaseEl = $('#phase'), playBtn = $('#btnPlay');

  function simulateLoad() {
    const L = LOADS[state.load];
    const out = SHAPE.map((f, i) => {
      const jitter = deterministic || i === SHAPE.length - 1 ? 1 : 0.94 + Math.random() * 0.12;
      return Math.round(L * f * jitter);
    });
    for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + 15);
    return out;
  }

  const readyAt = () => times[times.length - 1];
  const endTime = () => (boot ? boot.duration : readyAt() + 800);

  function start() {
    if (boot) boot.destroy();
    boot = null;
    times = simulateLoad();
    clock.t = 0;
    clock.playing = true;
    clock.last = performance.now();
    stage = -1;
    document.body.dataset.wbTheme = state.style === 'paper' ? 'light' : 'dark';
    resolved = state.mode === 'off' ? { mode: 'off', reason: '' } : CaretBoot.resolveMode(state.mode, store);
    if (resolved.mode !== 'off') {
      if (resolved.commit) resolved.commit();
      boot = CaretBoot.mount({
        mode: resolved.mode,
        style: state.style,
        workspace: WORKSPACE,
        now: () => clock.t,
        marks: times.slice(0, -1),
        readyAt: readyAt(),
        autoDestroy: false,
        skipOnAnyKey: false,
      });
    }
    syncDock();
  }

  function renderWorkbench(t) {
    let s = 0;
    STAGE_GATES.forEach((g, i) => { if (t >= times[g]) s = i + 1; });
    if (s === stage) return;
    stage = s;
    wb.dataset.stage = String(s);
    $$('[data-at]').forEach((n) => n.classList.toggle('on', s >= Number(n.dataset.at)));
    $('#sbReady').textContent = s >= 6 ? `Caret · 启动 ${(readyAt() / 1000).toFixed(2)}s` : '';
  }

  function renderTimeline(t, end) {
    if (!scrubbing) scrub.value = String(Math.round((t / end) * 1000));
    timeEl.textContent = `${(t / 1000).toFixed(2)} / ${(end / 1000).toFixed(2)} s`;
    const phase = boot ? boot.phase(t) : t < readyAt() ? '没有动画：工作台正在拼装' : '没有动画：工作台就绪';
    if (phaseEl.textContent !== phase) phaseEl.textContent = phase;
  }

  function frame(now) {
    const dt = Math.min(50, now - clock.last);
    clock.last = now;
    const end = endTime();
    if (clock.playing) {
      clock.t = Math.min(end, clock.t + dt * clock.speed);
      if (clock.t >= end) { clock.playing = false; syncPlay(); }
    }
    renderWorkbench(clock.t);
    renderTimeline(clock.t, end);
    requestAnimationFrame(frame);
  }

  function syncPlay() { playBtn.classList.toggle('paused', !clock.playing); }

  function syncDock() {
    $$('.seg').forEach((seg) => {
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === state[seg.dataset.k]));
    });
    const note = $('#modeNote');
    note.classList.toggle('off', state.mode !== 'smart');
    $('#resolved').textContent = state.mode === 'smart'
      ? `本次播${resolved.mode === 'story' ? '完整' : '简易'}版 · ${resolved.reason}`
      : '';
    $('#btnSlow').classList.toggle('on', clock.speed !== 1);
    syncPlay();
  }

  function togglePlay() {
    if (!clock.playing && clock.t >= endTime()) return start();
    clock.playing = !clock.playing;
    clock.last = performance.now();
    syncPlay();
  }

  function step(ms) {
    clock.playing = false;
    clock.t = clamp(clock.t + ms, 0, endTime());
    syncPlay();
  }

  dock.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    b.blur();
    const seg = b.closest('.seg');
    if (seg) {
      state[seg.dataset.k] = b.dataset.v;
      save(seg.dataset.k, b.dataset.v);
      return start();
    }
    switch (b.dataset.act) {
      case 'hide': dock.classList.add('hidden'); break;
      case 'play': togglePlay(); break;
      case 'replay': start(); break;
      case 'skip': if (boot) boot.skip(); break;
      case 'slow': clock.speed = clock.speed === 1 ? 0.35 : 1; syncDock(); break;
      case 'reset-smart':
        try { store.removeItem('caret-boot:lastStory'); } catch (err) { /* ignore */ }
        start();
        break;
    }
  });

  scrub.addEventListener('input', () => {
    scrubbing = true;
    clock.playing = false;
    clock.t = (Number(scrub.value) / 1000) * endTime();
    syncPlay();
  });
  scrub.addEventListener('change', () => { scrubbing = false; });

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case ' ': e.preventDefault(); togglePlay(); break;
      case 'r': case 'R': start(); break;
      case 'h': case 'H': dock.classList.toggle('hidden'); break;
      case 'ArrowLeft': e.preventDefault(); step(e.shiftKey ? -100 : -1000 / 60); break;
      case 'ArrowRight': e.preventDefault(); step(e.shiftKey ? 100 : 1000 / 60); break;
    }
  });

  if (params.get('clean') === '1') dock.classList.add('hidden');
  start();
  if (deterministic) {
    clock.t = clamp(Number(params.get('t')) || 0, 0, endTime());
    clock.playing = false;
    syncPlay();
  }
  requestAnimationFrame(frame);
})();
