// app.js —— 交互装配：扫描、筛选、进度轮询、快捷键、批量操作
import { api } from './api.js';
import {
  $, $$, el, toast, debounce, fmtSize, dateLabel, copyText,
} from './utils.js';
import {
  store, FILTER_DEFAULT, cloneFilter, activeFilterCount, facets, filteredClips,
  detailOf, vmOf, probedCount, selectedClips, selectedExportFiles,
} from './store.js';
import {
  initGallery, renderGallery, renderDateTree, renderStats, updateCardMeta,
  clearSelection, selectAllVisible, refreshSelectionUI, toggleSelect,
  toggleSelectFiltered, invertSelection, selectFilteredDates, setRenderAll,
  fillThumbImage,
} from './gallery.js';
import { initDrawer, renderDrawer, closeDrawer, step, currentClip } from './drawer.js';
import { initExporter, openExport, closeExport, exportBusy } from './exporter.js';

const LS = {
  folder: 'dji.folder',
  recursive: 'dji.recursive',
  size: 'dji.cardSize',
  sort: 'dji.sort',
  autoLrf: 'dji.autoLrf',
  burst: 'dji.mergeBursts',
  analyze: 'dji.analysisMode',
  lut: 'dji.lutEnabled',
  collapsed: 'dji.sidebarCollapsed',
};

let pollTimer = null;
let pollIdle = 0;
let thumbIdle = 0;
/** 正在同步分析的 clip.id，避免重复触发 */
const analyzeInflight = new Set();
const ANALYSIS_LABEL = {
  'on-open': '点开才分析',
  viewport: '只分析屏幕里的',
  all: '全部分析',
};

// ------------------------------------------------------------ 渲染管线
const scheduleRender = debounce(() => renderAll(), 40);

function renderAll() {
  window.__visibleClips = filteredClips();
  renderGallery();
  renderDateTree();
  renderStats();
  renderFacets();
  updateFilterBadge();
  updateSelCounts();
  $('#status-right').textContent = buildStatusRight();
}

/** 注入给 gallery.js（日期行点击后整屏刷新），避免循环 import */
setRenderAll(() => renderAll());

function buildStatusRight() {
  const visible = window.__visibleClips || [];
  const size = visible.reduce((a, c) => a + (c.size || 0), 0);
  const dur = visible.reduce((a, c) => a + (detailOf(c)?.duration || 0), 0);
  const parts = [`${visible.length} 条`, fmtSize(size)];
  if (dur) parts.push(`${Math.round(dur / 60)} 分钟`);
  return parts.join('  ·  ');
}

function updateFilterBadge() {
  const n = activeFilterCount();
  const badge = $('#filter-count');
  badge.textContent = n;
  badge.dataset.zero = n ? '0' : '1';
}

// ------------------------------------------------------------ 筛选面板
function chip(text, on, onClick, cls = 'chip mini') {
  const node = el('button', { class: `${cls}${on ? ' on' : ''}`, text });
  node.addEventListener('click', onClick);
  return node;
}

function renderFacets() {
  const f = store.filter;
  const fx = facets();

  const resBox = $('#f-res');
  resBox.innerHTML = '';
  if (!fx.res.length) resBox.appendChild(el('span', { class: 'dim', text: '分析中…' }));
  for (const [label, n] of fx.res) {
    resBox.appendChild(chip(`${label} ${n}`, f.res.has(label), () => {
      f.res.has(label) ? f.res.delete(label) : f.res.add(label);
      renderAll();
    }));
  }

  const fpsBox = $('#f-fps');
  fpsBox.innerHTML = '';
  if (!fx.fps.length) fpsBox.appendChild(el('span', { class: 'dim', text: '分析中…' }));
  for (const [label, n] of fx.fps) {
    fpsBox.appendChild(chip(`${label}p ${n}`, f.fps.has(label), () => {
      f.fps.has(label) ? f.fps.delete(label) : f.fps.add(label);
      renderAll();
    }));
  }

  const codecBox = $('#f-codec');
  codecBox.innerHTML = '';
  if (!fx.codec.length) codecBox.appendChild(el('span', { class: 'dim', text: '分析中…' }));
  for (const [label, n] of fx.codec) {
    codecBox.appendChild(chip(`${label} ${n}`, f.codec.has(label), () => {
      f.codec.has(label) ? f.codec.delete(label) : f.codec.add(label);
      renderAll();
    }));
  }

  $$('#filter-bar .chip.tgl').forEach((btn) => {
    const key = btn.dataset.type ? 'types' : 'attrs';
    const val = btn.dataset.type || btn.dataset.attr;
    btn.classList.toggle('on', f[key].has(val));
    if (!btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => {
        // 注意：必须取 store.filter，不能用渲染时捕获的 f——
        // 「重置筛选」会整体替换 store.filter，捕获旧对象会让芯片从此失效
        const live = store.filter;
        live[key].has(val) ? live[key].delete(val) : live[key].add(val);
        renderAll();
      });
    }
  });

  // 日期下拉
  const dates = Array.from(new Set(store.clips.map((c) => c.date))).sort();
  for (const [sel, key] of [['#f-date-from', 'dateFrom'], ['#f-date-to', 'dateTo']]) {
    const box = $(sel);
    const prev = f[key];
    box.innerHTML = '';
    box.appendChild(el('option', { value: '', text: key === 'dateFrom' ? '最早' : '最晚' }));
    for (const d of dates) box.appendChild(el('option', { value: d, text: d }));
    box.value = dates.includes(prev) ? prev : '';
    if (!box.dataset.bound) {
      box.dataset.bound = '1';
      box.addEventListener('change', () => {
        store.filter[key] = box.value;
        scheduleRender();
      });
    }
  }
}

// ------------------------------------------------------------ 快捷筛选
function initQuickChips() {
  $$('#quick-chips .chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const q = btn.dataset.quick;
      if (q === 'all') {
        store.filter = cloneFilter(FILTER_DEFAULT);
        syncFilterInputs();
      } else {
        store.filter.quick = store.filter.quick === q ? '' : q;
      }
      renderAll();
      syncQuickChips();
    });
  });
}

function syncQuickChips() {
  $$('#quick-chips .chip').forEach((btn) => {
    const q = btn.dataset.quick;
    const on = q === 'all' ? activeFilterCount() === 0 : store.filter.quick === q;
    btn.classList.toggle('on', on);
  });
}

function syncFilterInputs() {
  const f = store.filter;
  $('#search').value = f.text;
  $('#f-dur').value = f.minDuration;
  $('#f-size').value = f.minSize;
  $('#f-dur-val').textContent = `${f.minDuration}s`;
  $('#f-size-val').textContent = `${f.minSize}MB`;
  renderFacets();
  syncQuickChips();
}

// ------------------------------------------------------------ 扫描与轮询
async function doScan({ force = false } = {}) {
  const folder = $('#folder-input').value.trim() || store.folder;
  if (!folder) { toast('请先填写素材目录', 'err'); return; }
  setStatus('正在扫描目录…');
  try {
    // 只有"全部分析"才让服务端扫描时就排满 ffprobe；其余模式按需触发
    const autoAll = store.analysisMode === 'all';
    const res = await api.scan(folder, {
      recursive: $('#chk-recursive').checked, force, analyze: autoAll,
    });
    store.folder = res.folder;
    store.clips = res.clips;
    store.summary = res.summary;
    store.meta = new Map();
    store.selection.clear();
    store.collapsedDays.clear();
    store.expandedBursts.clear();
    localStorage.setItem(LS.folder, res.folder);
    for (const clip of res.clips) {
      if (clip.detail) store.meta.set(clip.id, clip.detail);
    }
    $('#folder-input').value = res.folder;
    store.pendingPaths = new Map();
    store.pendingIds = new Set();
    if (autoAll) {
      for (const clip of res.clips) {
        for (const file of clip.files) {
          if (!file.probed) {
            store.pendingPaths.set(file.path, clip.id);
            store.pendingIds.add(clip.id);
          }
        }
      }
    }
    // 还没有图的素材：进入"缩略图阶段"队列，图一生成就贴上去
    store.thumbPending = new Map();
    store.thumbReadyCount = 0;
    for (const clip of res.clips) {
      if (clip.thumb) { store.thumbReadyCount += 1; continue; }
      const main = clip.video_path || clip.photo_path || clip.proxy_path || clip.path;
      if (main) store.thumbPending.set(main, clip.id);
    }
    renderAll();
    const pending = store.pendingPaths.size;
    const instant = res.instant_thumbs || 0;
    const cachedCount = res.clips.filter((c) => c.detail).length;
    const thumbsReady = res.clips.filter((c) => c.thumb).length;
    const modeLabel = ANALYSIS_LABEL[store.analysisMode] || '';
    setStatus(pending
      ? `扫描完成：${res.clip_count} 条素材 · 缩略图 ${thumbsReady} 张已就绪`
        + `${instant ? `（本次立即缓存 ${instant} 张）` : ''}`
        + ` · 参数按日期由近到远分析中，剩余 ${pending} 个文件（已命中缓存 ${cachedCount} 条）`
      : `扫描完成：${res.clip_count} 条素材 · 缩略图 ${thumbsReady} 张`
        + `（本次立即缓存 ${instant} 张）· 参数已读 ${cachedCount}/${res.clip_count}`
        + `（${modeLabel}，点开素材即读参数）`);
    toast(pending
      ? `扫描完成：${res.clip_count} 条素材，缩略图已就绪，正在分析参数…`
      : `扫描完成：${res.clip_count} 条素材 · ${res.summary.total_size_label}`);
    startPolling();
    if (store.analysisMode === 'viewport') scheduleViewportAnalysis();
  } catch (err) {
    setStatus(`扫描失败：${err.message}`);
    toast(`扫描失败：${err.message}`, 'err');
  }
}

function setStatus(text) { $('#status-left').textContent = text; }

function startPolling() {
  clearInterval(pollTimer);
  pollIdle = 0;
  updateProbeMeter();
  if (!store.pendingPaths.size && !store.thumbPending.size) {
    updateProbeMeter(true);
    return;
  }
  pollTimer = setInterval(pollOnce, 900);
}

async function pollOnce() {
  if (!store.pendingPaths.size && !store.thumbPending.size) {
    pollIdle += 1;
    if (pollIdle > 2) {
      clearInterval(pollTimer);
      pollTimer = null;
      updateProbeMeter(true);
      setStatus(`分析完成：${probedCount()}/${store.clips.length} 条已取得参数`);
    }
    return;
  }
  // 阶段①：缩略图还在生成时，优先把新出好的图贴上去（不等参数分析）
  if (store.thumbPending.size) await pullThumbs();
  if (!store.pendingPaths.size) {
    updateProbeMeter(false);
    return;
  }
  // 每轮只问一小批，别把几百个路径一股脑 POST 过去（省 CPU 也省带宽）
  const paths = Array.from(store.pendingPaths.keys()).slice(0, 80);
  try {
    const res = await api.meta(paths, false);
    const got = Object.keys(res.meta || {});
    if (got.length) {
      const touched = new Set();
      for (const p of got) {
        const id = store.pendingPaths.get(p);
        if (!id) continue;
        store.pendingPaths.delete(p);
        touched.add(id);
      }
      for (const [p, meta] of Object.entries(res.meta)) {
        const clip = store.clips.find((c) => c.files.some((f) => f.path === p));
        if (!clip) continue;
        const cur = store.meta.get(clip.id);
        if (!cur || !cur.ok) store.meta.set(clip.id, meta);
        if (meta.thumb && !clip.thumb) clip.thumb = meta.thumb;
      }
      for (const id of touched) store.pendingIds.delete(id);
      updateCardMeta(touched);
      renderStats();
      window.__visibleClips = filteredClips();
      $('#status-right').textContent = buildStatusRight();
    } else {
      pollIdle += 1;
      if (pollIdle > 4) {
        // 队列可能还在跑，退化为只更新进度
        pollIdle = 0;
      }
    }
    updateProbeMeter(false, res.progress);
  } catch (err) {
    clearInterval(pollTimer);
    pollTimer = null;
    setStatus(`分析中断：${err.message}`);
  }
}

/** 缩略图阶段：只问"哪些图已经能看了"，拿到就立刻贴到卡片上 */
async function pullThumbs() {
  const paths = Array.from(store.thumbPending.keys()).slice(0, 80);
  if (!paths.length) return;
  try {
    const res = await api.thumbStatus(paths);
    const ready = res.ready || {};
    const touched = new Set();
    for (const [p, name] of Object.entries(ready)) {
      const id = store.thumbPending.get(p);
      if (!id) continue;
      const clip = store.clips.find((c) => c.id === id);
      store.thumbPending.delete(p);
      if (!clip || clip.thumb) continue;
      clip.thumb = name;
      touched.add(id);
    }
    if (touched.size) {
      thumbIdle = 0;
      for (const id of touched) {
        const clip = store.clips.find((c) => c.id === id);
        const el = document.querySelector(`.card[data-id="${id}"]`);
        if (clip && el) fillThumbImage(el.querySelector('.thumb'), clip);
      }
      store.thumbReadyCount += touched.size;
    } else {
      // 长时间一张都没出（比如个别文件抓不出来）：放弃等待，别让轮询空转
      thumbIdle += 1;
      if (thumbIdle > 40) {
        store.thumbPending.clear();
        thumbIdle = 0;
      }
    }
    if (res.progress) updateProbeMeter(false, res.progress);
  } catch { /* 下一轮再试 */ }
}

function updateProbeMeter(done = false, progress = null) {
  const meter = $('#probe-meter');
  const p = progress || null;
  const remaining = store.pendingPaths.size;
  const thumbLeft = store.thumbPending.size;
  const total = p ? p.total : 0;
  const finished = p ? p.done + p.failed : 0;
  if (done || (!remaining && !thumbLeft && !(p && (p.pending || p.active)))) {
    meter.hidden = true;
    return;
  }
  meter.hidden = false;
  let pct = 0;
  let text = '';
  const phase = p?.phase || (thumbLeft ? 'thumb' : 'analyze');
  if (phase === 'thumb' && p) {
    const tt = p.thumb_total || thumbLeft;
    const td = p.thumb_done || 0;
    pct = tt ? Math.min(100, (td / tt) * 100) : 0;
    text = `① 正在贴缩略图 ${td}/${tt}`;
    if (tt && Math.ceil(tt / 8) > 1) text += ' · 全部贴完才开始分析参数';
  } else {
    pct = total ? Math.min(100, (finished / total) * 100)
      : (store.clips.length ? 100 - (remaining / Math.max(1, store.clips.length)) * 100 : 0);
    text = total
      ? `② 按日期由近到远分析 ${finished}/${total}${p.failed ? ` · 失败 ${p.failed}` : ''}`
      : `分析中 · 剩余 ${remaining}`;
  }
  $('#probe-bar-fill').style.width = `${pct.toFixed(1)}%`;
  $('#probe-text').textContent = text;
}

// ------------------------------------------------------------ 详情抽屉
function openClip(clip) {
  if (!clip) return;
  store.focusId = clip.id;
  refreshSelectionUI();
  renderDrawer(clip);
  document.querySelector(`.card[data-id="${clip.id}"]`)?.classList.add('focus');
  analyzeOnOpen(clip);
}

/**
 * "点开才分析"：打开详情时同步读这一条（最多一次 ffprobe，几百毫秒）。
 * 已经在缓存里的不会重复跑；'all' 模式也走这里，只是多半已命中。
 */
async function analyzeOnOpen(clip) {
  const d = detailOf(clip);
  if (d && d.ok) return;
  const target = clip.video_path || clip.photo_path || clip.proxy_path || clip.path;
  if (!target) return;
  const key = `analyzing:${clip.id}`;
  if (analyzeInflight.has(key)) return;
  analyzeInflight.add(key);
  const sub = $('#d-sub');
  const oldSub = sub ? sub.textContent : '';
  if (sub) sub.textContent = `${oldSub}  ·  正在读取参数…`;
  try {
    const res = await api.probe(target, true);
    if (res && res.meta && res.meta.ok) {
      store.meta.set(clip.id, res.meta);
      if (res.meta.thumb && !clip.thumb) clip.thumb = res.meta.thumb;
      updateCardMeta(new Set([clip.id]));
      renderStats();
      $('#status-right').textContent = buildStatusRight();
      if (store.current === clip) renderDrawer(clip);
    }
  } catch (err) {
    setStatus(`读取参数失败：${err.message}`);
  } finally {
    analyzeInflight.delete(key);
    if (sub && store.current === clip) sub.textContent = `${dateLabel(clip.date)} ${clip.time}  ·  ${clip.size_label}`;
  }
}

/** 把一批素材排进后台分析队列（异步，走轮询更新） */
function enqueueClips(clips) {
  const add = [];
  for (const clip of clips) {
    const d = detailOf(clip);
    if (d && d.ok) continue;
    for (const file of clip.files || []) {
      if (file.probed) continue;
      if (store.pendingPaths.has(file.path)) continue;
      store.pendingPaths.set(file.path, clip.id);
      store.pendingIds.add(clip.id);
      add.push(file.path);
    }
  }
  if (!add.length) return 0;
  api.meta(add, true).catch(() => {});
  startPolling();
  return add.length;
}

/** viewport 模式：只把屏幕里出现、还没分析的排进队列（最多 2 条/次） */
let viewportTimer = null;
function scheduleViewportAnalysis() {
  if (store.analysisMode !== 'viewport') return;
  clearTimeout(viewportTimer);
  viewportTimer = setTimeout(() => {
    if (store.analysisMode !== 'viewport') return;
    const targets = store.clips.filter((c) => store.visibleIds.has(c.id));
    const todo = targets.filter((c) => {
      const d = detailOf(c);
      return !(d && d.ok);
    }).slice(0, 2);
    if (todo.length) {
      enqueueClips(todo);
      scheduleViewportAnalysis();
    }
  }, 400);
}

/** 手动分析可见 / 全部 */
function analyzeVisible() {
  const clips = filteredClips().filter((c) => store.visibleIds.has(c.id));
  const list = clips.length ? clips : filteredClips().slice(0, 12);
  const n = enqueueClips(list);
  toast(n ? `已排队分析 ${list.length} 条素材` : '可见素材都已读过参数');
}

function analyzeAll() {
  const n = enqueueClips(store.clips);
  if (n) toast(`已排队分析全部素材（共 ${store.clips.length} 条）`);
  else toast('全部素材都已读过参数');
}

function focusMove(delta) {
  const list = window.__visibleClips || [];
  if (!list.length) return;
  const idx = store.focusId ? list.findIndex((c) => c.id === store.focusId) : -1;
  const next = list[Math.min(list.length - 1, Math.max(0, idx + delta))] || list[0];
  store.focusId = next.id;
  refreshSelectionUI();
  const card = document.querySelector(`.card[data-id="${next.id}"]`);
  card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (!$('#drawer').hidden) renderDrawer(next);
}

// ------------------------------------------------------------ 选择条
function onSelectionChange() {
  const sel = selectedClips();
  const bar = $('#selbar');
  bar.hidden = sel.length === 0;
  updateSelCounts();
}

/** 选中项统计：条目数 / 总体积 / 其中待转存的原片数 */
function updateSelCounts() {
  const sel = selectedClips();
  $('#sel-n').textContent = sel.length;
  if (!sel.length) { $('#sel-size').textContent = ''; $('#sel-src').textContent = ''; return; }
  const all = sel.reduce((a, c) => a + (c.size || 0), 0);
  $('#sel-size').textContent = `· ${fmtSize(all)}`;
  const exp = selectedExportFiles();
  $('#sel-src').textContent = `· 可转存原片 ${exp.count} 个 (${fmtSize(exp.bytes)})`;
}

function selectedPaths() {
  const out = [];
  for (const clip of selectedClips()) {
    if (clip.video_path) out.push(clip.video_path);
    if (clip.proxy_path) out.push(clip.proxy_path);
    if (clip.is_photo) out.push(clip.photo_path || clip.path);
    if (!clip.video_path && !clip.proxy_path && !clip.is_photo) out.push(clip.path);
  }
  return out;
}

/** 勾选素材对应的"主文件"（一条素材一个文件，不含 LRF 代理），用于在资源管理器里选中 */
function selectedPrimaryPaths() {
  const out = [];
  for (const clip of selectedClips()) {
    const p = clip.video_path || clip.photo_path || clip.proxy_path || clip.path;
    if (p) out.push(p);
  }
  return out;
}

// ------------------------------------------------------------ 弹窗
function showModal(title, bodyHTML, footNodes = []) {
  const mask = el('div', { class: 'modal-mask' });
  const modal = el('div', { class: 'modal' });
  const head = el('div', { class: 'modal-head' });
  head.appendChild(el('b', { text: title }));
  head.appendChild(el('button', {
    class: 'icon-btn', html: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    onclick: () => mask.remove(),
  }));
  modal.appendChild(head);
  modal.appendChild(el('div', { class: 'modal-body', html: bodyHTML }));
  if (footNodes.length) {
    const foot = el('div', { class: 'modal-foot' });
    footNodes.forEach((n) => foot.appendChild(n));
    modal.appendChild(foot);
  }
  mask.appendChild(modal);
  mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
  document.body.appendChild(mask);
  return mask;
}

async function showInfo() {
  let info = store.serverInfo;
  try { info = await api.info(); store.serverInfo = info; } catch (err) { toast(err.message, 'err'); }
  if (!info) return;
  const cache = info.cache || {};
  showModal('环境信息', `
    <div class="kvs">
      <div class="k">程序</div><div class="v">${info.app} v${info.version}</div>
      <div class="k">Python</div><div class="v">${info.python}</div>
      <div class="k">ffmpeg</div><div class="v">${info.ffmpeg || '未找到'}</div>
      <div class="k">ffprobe</div><div class="v">${info.ffprobe_path || '未找到'}</div>
      <div class="k">缓存条目</div><div class="v">${cache.entries ?? 0}</div>
      <div class="k">缓存目录</div><div class="v">${info.cache_dir || ''}</div>
      <div class="k">当前目录</div><div class="v">${store.folder || '(未选择)'}</div>
    </div>
    <p>所有操作都是只读的：程序只读取目录结构与视频元数据，缩略图写入上面这个缓存目录，
       不会修改或移动你的原始素材。删除文件需要在界面里显式勾选并确认。</p>
  `, [
    el('button', { class: 'btn ghost', text: '打开缓存目录', onclick: () => api.open(info.cache_dir).catch(() => {}) }),
    el('button', { class: 'btn primary', text: '知道了' }),
  ]);
}

function confirmDelete() {
  const n = store.selection.size;
  if (!n) return;
  const mask = showModal('确认删除', `
    <p style="color:var(--danger)">即将从磁盘上永久删除 <b>${n}</b> 个素材条目对应的文件
    （含 MP4 与 LRF）。此操作不可撤销，也不进回收站。</p>
    <p>建议先在资源管理器里核对一遍。要继续吗？</p>
  `, [
    el('button', { class: 'btn ghost', text: '取消', onclick: () => mask.remove() }),
    el('button', {
      class: 'btn danger', text: `确认删除 ${n} 项`,
      onclick: async () => {
        mask.remove();
        const paths = selectedPaths();
        try {
          const res = await api.del(paths);
          const failed = (res.results || []).filter((r) => !r.ok);
          toast(`已删除 ${paths.length - failed.length} 个文件${failed.length ? `，${failed.length} 个失败` : ''}`,
            failed.length ? 'err' : '');
        } catch (err) {
          toast(`删除失败：${err.message}`, 'err');
        }
        await doScan({ force: false });
      },
    }),
  ]);
}

// ------------------------------------------------------------ 初始化
function initShortcuts() {
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
    if (e.key === 'Escape') {
      if (!$('#export-modal').hidden && !exportBusy()) { closeExport(); return; }
      if (document.querySelector('.modal-mask:not([hidden])')) {
        const m = Array.from(document.querySelectorAll('.modal-mask:not([hidden])'))
          .find((x) => x.id !== 'export-modal');
        if (m) m.remove();
        return;
      }
      if (!$('#drawer').hidden) { closeDrawer(); return; }
      if (store.selection.size) { clearSelection(); return; }
      if (!$('#filter-bar').hidden) { $('#filter-bar').hidden = true; return; }
    }
    if (typing) return;
    switch (e.key) {
      case '/': e.preventDefault(); $('#search').focus(); break;
      case 'f': $('#btn-filters').click(); break;
      case 'e': if (store.selection.size) { e.preventDefault(); openExport(); } break;
      case 'F5': e.preventDefault(); doScan(); break;
      case 'ArrowLeft': e.preventDefault(); focusMove(-1); break;
      case 'ArrowRight': e.preventDefault(); focusMove(1); break;
      case 'ArrowUp': e.preventDefault(); focusMove(-4); break;
      case 'ArrowDown': e.preventDefault(); focusMove(4); break;
      case 'Enter': {
        const clip = (window.__visibleClips || []).find((c) => c.id === store.focusId);
        if (clip) openClip(clip);
        break;
      }
      case 'a': if (e.ctrlKey || e.metaKey) { e.preventDefault(); selectAllVisible(); }
        else if (e.shiftKey) { e.preventDefault(); toggleSelectFiltered(); }
        break;
      case 'b': if (e.ctrlKey || e.metaKey) { e.preventDefault(); $('#app').classList.toggle('collapsed'); localStorage.setItem(LS.collapsed, $('#app').classList.contains('collapsed') ? '1' : ''); } break;
      default: break;
    }
  });
}

function initControls() {
  $('#btn-scan').addEventListener('click', () => doScan({ force: false }));
  $('#btn-refresh').addEventListener('click', () => doScan({ force: true }));
  $('#folder-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doScan(); });
  $('#chk-recursive').addEventListener('change', (e) => localStorage.setItem(LS.recursive, e.target.checked ? '1' : ''));
  $('#chk-burst').addEventListener('change', (e) => {
    store.mergeBursts = e.target.checked;
    localStorage.setItem(LS.burst, store.mergeBursts ? '1' : '');
    renderGallery();
    refreshSelectionUI();
  });
  $('#sel-analyze').addEventListener('change', (e) => {
    store.analysisMode = e.target.value;
    localStorage.setItem(LS.analyze, store.analysisMode);
    if (store.analysisMode === 'all') {
      analyzeAll();
      scheduleViewportAnalysis();
    } else if (store.analysisMode === 'viewport') {
      scheduleViewportAnalysis();
    }
    setStatus(`参数分析：${ANALYSIS_LABEL[store.analysisMode]}`);
  });
  $('#btn-analyze-visible').addEventListener('click', analyzeVisible);
  $('#btn-analyze-all').addEventListener('click', analyzeAll);
  $('#chk-lut').addEventListener('change', (e) => {
    store.lutEnabled = e.target.checked;
    localStorage.setItem(LS.lut, store.lutEnabled ? '1' : '');
    // 只影响播放预览：D-Log 视频会自动改用带 LUT 的实时转码，缩略图不动
    const clip = store.current;
    if (clip) renderDrawer(clip);
    toast(store.lutEnabled ? '色彩还原已开启：播放走带 LUT 的实时转码' : '色彩还原已关闭');
  });

  $('#search').addEventListener('input', debounce((e) => {
    store.filter.text = e.target.value;
    renderAll();
    syncQuickChips();
  }, 180));

  $('#btn-filters').addEventListener('click', () => {
    const bar = $('#filter-bar');
    bar.hidden = !bar.hidden;
    $('#btn-filters').classList.toggle('on', !bar.hidden);
  });

  $('#sort').addEventListener('change', (e) => {
    store.sort = e.target.value;
    localStorage.setItem(LS.sort, store.sort);
    renderAll();
  });

  $('#thumb-size').addEventListener('input', (e) => {
    store.clipSize = Number(e.target.value);
    document.documentElement.style.setProperty('--card', `${store.clipSize}px`);
    localStorage.setItem(LS.size, String(store.clipSize));
  });

  $('#f-dur').addEventListener('input', (e) => {
    store.filter.minDuration = Number(e.target.value);
    $('#f-dur-val').textContent = `${e.target.value}s`;
    scheduleRender();
    syncQuickChips();
  });
  $('#f-size').addEventListener('input', (e) => {
    store.filter.minSize = Number(e.target.value);
    $('#f-size-val').textContent = `${e.target.value}MB`;
    scheduleRender();
    syncQuickChips();
  });
  $('#btn-filter-reset').addEventListener('click', () => {
    store.filter = cloneFilter(FILTER_DEFAULT);
    syncFilterInputs();
    renderAll();
  });

  $('#btn-date-select').addEventListener('click', () => {
    const on = filteredClips().filter((c) => store.selection.has(c.id)).length;
    if (on && on >= filteredClips().length) {
      for (const c of filteredClips()) store.selection.delete(c.id);
      refreshSelectionUI();
    } else {
      selectFilteredDates();
    }
  });
  $('#btn-date-invert').addEventListener('click', () => {
    const n = invertSelection();
    toast(`已反选 ${n} 条`);
  });

  $('#btn-purge').addEventListener('click', () => {
    const mask = showModal('清空缓存', `
      <p>将删除已生成的缩略图与探测结果缓存。原始素材不受影响，但下次打开需要重新分析。</p>
    `, [
      el('button', { class: 'btn ghost', text: '取消', onclick: () => mask.remove() }),
      el('button', {
        class: 'btn danger', text: '清空',
        onclick: async () => {
          mask.remove();
          try {
            await api.purge();
            store.meta = new Map();
            toast('缓存已清空');
            doScan({ force: true });
          } catch (err) { toast(err.message, 'err'); }
        },
      }),
    ]);
  });

  $('#btn-info').addEventListener('click', showInfo);
  $('#btn-collapse').addEventListener('click', () => {
    $('#app').classList.add('collapsed');
    localStorage.setItem(LS.collapsed, '1');
  });
  $('#btn-expand').addEventListener('click', () => {
    $('#app').classList.remove('collapsed');
    localStorage.setItem(LS.collapsed, '');
  });

  // 批量操作
  $('#sel-clear').addEventListener('click', clearSelection);
  $('#sel-all-filtered').addEventListener('click', () => {
    const n = toggleSelectFiltered();
    if (!n) toast('当前筛选结果为空', 'err');
    else toast(`已勾选 ${n} 条筛选结果`);
  });
  $('#sel-invert').addEventListener('click', () => {
    const n = invertSelection();
    toast(`已反选 ${n} 条`);
  });
  $('#sel-export').addEventListener('click', () => { openExport(); });
  $('#sel-csv').addEventListener('click', async () => {
    const paths = selectedPaths();
    if (!paths.length) return;
    try {
      await api.exportCsv(paths, `dji_export_${store.selection.size}.csv`);
      toast(`已导出 ${paths.length} 个文件的信息`);
    } catch (err) { toast(`导出失败：${err.message}`, 'err'); }
  });
  $('#sel-reveal').addEventListener('click', async () => {
    // 一条素材选一个主文件（不含 LRF 代理），资源管理器里选中的就是"你勾的那些"
    const paths = selectedPrimaryPaths();
    if (!paths.length) return;
    try {
      const res = await api.revealMany(paths);
      if (res.multi) {
        toast(`已在资源管理器选中 ${res.count} 个文件`
          + (res.skipped ? `（另有 ${res.skipped} 个在别的目录，未选中）` : ''));
      } else {
        toast(`多选定位失败（${res.detail || '未知'}），已定位第一个文件`, 'err');
      }
    } catch (err) { toast(`定位失败：${err.message}`, 'err'); }
  });
  $('#sel-delete').addEventListener('click', confirmDelete);

  // 点空白处取消焦点
  $('#gallery-wrap').addEventListener('click', (e) => {
    if (e.target.id === 'gallery-wrap') { store.focusId = null; refreshSelectionUI(); }
  });
}

function initRoots(roots) {
  const box = $('#quick-roots');
  const phBox = $('#ph-roots');
  box.innerHTML = '';
  phBox.innerHTML = '';
  const all = [];
  for (const root of roots || []) {
    all.push(root);
    for (const child of root.children || []) {
      all.push({ path: child, label: `${root.label}\\${child.split(/[\\/]/).pop()}` });
    }
  }
  const shown = all.slice(0, 8);
  for (const item of shown) {
    const pill = el('button', {
      class: 'root-pill',
      html: `<b>${item.label.split('\\')[0]}</b>${item.path.split(/[\\/]/).slice(-2).join('\\')}`,
      title: item.path,
      onclick: () => { $('#folder-input').value = item.path; doScan(); },
    });
    box.appendChild(pill);
    if (phBox) {
      phBox.appendChild(el('button', {
        class: 'btn ghost sm', text: item.path, title: item.path,
        onclick: () => { $('#folder-input').value = item.path; doScan(); },
      }));
    }
  }
  if (!shown.length) box.appendChild(el('span', { class: 'empty-hint', text: '未发现 DCIM 目录，手动输入路径即可' }));
}

async function boot() {
  window.__djiViewerReady = true;   // 告诉 index.html 的兜底提示：脚本正常起来了
  const bootMsg = document.getElementById('boot-msg');
  if (bootMsg) bootMsg.hidden = true;
  initGallery({
    onOpen: openClip,
    onSelectionChange,
    onVisibility: () => scheduleViewportAnalysis(),
  });
  initDrawer();
  initExporter();
  initControls();
  initQuickChips();
  initShortcuts();

  store.sort = localStorage.getItem(LS.sort) || 'time-desc';
  $('#sort').value = store.sort;
  const savedSize = Number(localStorage.getItem(LS.size) || 264);
  store.clipSize = savedSize;
  $('#thumb-size').value = savedSize;
  document.documentElement.style.setProperty('--card', `${savedSize}px`);
  store.autoLrf = localStorage.getItem(LS.autoLrf) === '1';
  $('#chk-autolrf').checked = store.autoLrf;
  if (localStorage.getItem(LS.collapsed)) $('#app').classList.add('collapsed');
  $('#chk-recursive').checked = localStorage.getItem(LS.recursive) !== '0';
  store.mergeBursts = localStorage.getItem(LS.burst) !== '0';
  $('#chk-burst').checked = store.mergeBursts;
  store.analysisMode = localStorage.getItem(LS.analyze) || 'on-open';
  if (!ANALYSIS_LABEL[store.analysisMode]) store.analysisMode = 'on-open';
  $('#sel-analyze').value = store.analysisMode;
  store.lutEnabled = localStorage.getItem(LS.lut) === '1';
  $('#chk-lut').checked = store.lutEnabled;

  try {
    const info = await api.info();
    store.serverInfo = info;
    initRoots(info.roots);
    // 没有 LUT 就把「色彩还原」置灰并说明
    store.lutAvailable = !!(info.lut && info.lut.available);
    const lutChip = $('#lbl-lut');
    if (lutChip) {
      const hasLut = store.lutAvailable;
      const box = $('#chk-lut');
      if (!hasLut) {
        if (box) { box.disabled = true; box.checked = false; }
        store.lutEnabled = false;
        lutChip.classList.add('disabled');
        lutChip.title = '项目目录里没找到 .cube LUT（放到 djiviewer/ 根目录或 luts/ 下即可）';
      } else {
        lutChip.title = `色彩还原：${info.lut.name}`;
      }
    }
    // 导出弹窗里的「色彩还原」也只有找到 LUT 才可用
    const exLut = $('#ex-lut');
    if (exLut) {
      exLut.disabled = !store.lutAvailable;
      const line = $('#ex-lut-line');
      if (line) {
        line.classList.toggle('disabled', !store.lutAvailable);
        if (!store.lutAvailable) line.title = '项目目录里没找到 .cube LUT';
      }
    }
    const tag = $('#build-tag');
    if (tag && info.build) tag.textContent = `· v${String(info.build).split('.').slice(-1)[0]}`;
    if (info.tools_error) toast(info.tools_error, 'err');
    if (info.settings?.last_folder && !$('#folder-input').value) {
      $('#folder-input').value = info.settings.last_folder;
    }
    console.info(`[DJI Viewer] 前端模块版本 ${info.build || '未标记'}`);  } catch (err) {
    toast(`无法连接本地服务：${err.message}`, 'err');
  }

  const saved = localStorage.getItem(LS.folder) || $('#folder-input').value;
  if (saved) {
    $('#folder-input').value = saved;
    await doScan();
  } else {
    setStatus('就绪 · 请选择素材目录');
  }
  window.__openClip = openClip;
}

boot();
