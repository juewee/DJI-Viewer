// gallery.js —— 素材卡片、日期分组、侧栏日期树
import { api } from './api.js';
import {
  $, el, fmtSize, fmtDuration, dateLabel, toast, copyText,
} from './utils.js';
import {
  store, filteredClips, groupByDay, detailOf, vmOf, probedCount,
  displayItems, itemClips, burstSelectState,
} from './store.js';
import {
  selectAllFiltered as coreSelectAllFiltered,
  invertSelection as coreInvert,
  setClipsSelected as coreSelectClips,
} from './core.js';

const ICON_CHECK = '<svg viewBox="0 0 16 16"><path d="M3 8.6 6.3 12 13 4.6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_FOLDER = '<svg viewBox="0 0 16 16"><path d="M2 5.2A1.2 1.2 0 0 1 3.2 4h2.6l1.2 1.6h5.8A1.2 1.2 0 0 1 14 6.8v5A1.2 1.2 0 0 1 12.8 13H3.2A1.2 1.2 0 0 1 2 11.8Z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 16 16"><path d="M5 3.4 12 8l-7 4.6z" fill="currentColor"/></svg>';
const ICON_CHEV = '<svg class="chev" viewBox="0 0 16 16"><path d="M4 6.4 8 10.4l4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let onOpen = () => {};
let onSelectionChange = () => {};
let onVisibilityChange = () => {};

export function initGallery(handlers) {
  onOpen = handlers.onOpen || onOpen;
  onSelectionChange = handlers.onSelectionChange || onSelectionChange;
  onVisibilityChange = handlers.onVisibility || onVisibilityChange;
}

// ------------------------------------------------- 拖出到资源管理器 = 复制文件
const MIME_BY_EXT = {
  '.mp4': 'video/mp4',
  '.lrf': 'video/mp4',
  '.mov': 'video/quicktime',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.dng': 'image/x-adobe-dng',
  '.png': 'image/png',
};

function mimeOf(name) {
  const dot = String(name).lastIndexOf('.');
  return MIME_BY_EXT[String(name).slice(dot).toLowerCase()] || 'application/octet-stream';
}

/** 这条素材拖出时应该给哪个文件 */
function dragFileOf(clip) {
  return clip.video_path || clip.photo_path || clip.proxy_path || clip.path || '';
}

function fileBaseName(path) {
  return String(path).split(/[\\/]/).pop() || 'file';
}

/**
 * 拖拽卡片 = 把这个文件复制出去（拖到资源管理器 / 桌面 / 剪辑软件）。
 *
 * 浏览器不允许网页直接交出本地文件句柄，所以走 Chromium 的 `DownloadURL` 约定：
 *   dataTransfer.setData('DownloadURL', 'mime:文件名:绝对URL')
 * 松手后浏览器按这个 URL 取一份（服务端配合返回 Content-Disposition: attachment），
 * 落盘成同名文件，资源管理器再把它复制到你松手的位置。
 *
 * 实测限制：**QQ / 微信 不认这个"文件承诺"**，它们会退而取拖动预览图，于是拖视频过去
 * 也变成一张 jpeg。想往聊天窗口发原文件，用批量条上的「在资源管理器定位」把素材一起选中，
 * 再从资源管理器拖——那是零拷贝的。
 */
function attachDragOut(node, clip) {
  node.setAttribute('draggable', 'true');
  node.addEventListener('dragstart', (e) => {
    const file = dragFileOf(clip);
    if (!file || !e.dataTransfer) return;
    const name = fileBaseName(file);
    // DownloadURL 需要绝对 URL；拿不到 location 时（测试环境）退回带占位主机的形式
    let url = api.download(file);
    try {
      const origin = (typeof location !== 'undefined' && location.origin) || 'http://127.0.0.1';
      url = new URL(url, origin).href;
    } catch (_) { /* 保持相对路径 */ }
    try {
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('DownloadURL', `${mimeOf(name)}:${name}:${url}`);
      e.dataTransfer.setData('text/plain', file);   // 拖进输入框/聊天框就是路径
    } catch (_) { /* 老浏览器不支持就算了，text/plain 还能兜底 */ }
    const img = node.querySelector('.thumb img');
    if (img && e.dataTransfer.setDragImage) {
      try { e.dataTransfer.setDragImage(img, 60, 34); } catch (_) { /* 忽略 */ }
    }
    node.classList.add('dragging');
  });
  node.addEventListener('dragend', () => node.classList.remove('dragging'));
}

// ------------------------------------------------------------------ 卡片
/** 缩略图上的角标 + 时长 + LRF 标记（元数据到达时可局部刷新，不重建整卡） */
function fillThumbOverlay(thumb, clip) {
  thumb.querySelectorAll('.badge-row, .dur, .proxy-dot').forEach((n) => n.remove());
  const v = vmOf(clip);

  const badges = el('div', { class: 'badge-row' });
  if (clip.is_live) {
    badges.appendChild(el('span', {
      class: 'tag live', text: '实况',
      title: 'DJI 实况照片：机身存的是一段固定的 3 秒 4K 视频',
    }));
  } else if (clip.is_photo) badges.appendChild(el('span', { class: 'tag ph', text: '照片' }));
  if ((clip.burst_count || 1) > 1) {
    // 摊开状态下：点角标可以把整组收起来
    const expandedFrame = !store.mergeBursts || store.expandedBursts.has(clip.burst_key);
    badges.appendChild(el('span', {
      class: `tag burst${expandedFrame ? ' clickable' : ''}`,
      text: expandedFrame ? `连拍 ${clip.burst_pos}/${clip.burst_count}` : `连拍 ${clip.burst_count}`,
      title: expandedFrame ? '点这里把整组连拍收起来' : '同一次连拍的多张照片，文件名末尾是 _001、_002 …',
      onclick: expandedFrame ? (e) => {
        e.stopPropagation();
        store.expandedBursts.delete(clip.burst_key);
        store.mergeBursts = true;
        const chk = document.querySelector('#chk-burst');
        if (chk) chk.checked = true;
        renderGallery();
        refreshSelectionUI();
      } : undefined,
    }));
  }
  if (clip.is_scrub) {
    badges.appendChild(el('span', {
      class: 'tag scrub', text: /\.scr$/i.test(clip.name) ? 'SCR 预览图' : 'THM 缩略图',
      title: '这条素材只有相机自带的预览图，没有可播放的视频文件',
    }));
  }
  if (v.probed) {
    badges.appendChild(el('span', { class: 'tag res', text: v.resolution }));
    if (v.fps) badges.appendChild(el('span', { class: 'tag fps', text: `${v.fps}p` }));
    if (v.hdr) badges.appendChild(el('span', { class: 'tag hdr', text: v.bitDepth ? `${v.bitDepth}bit HDR` : 'HDR' }));
    else if (v.bitDepth && v.bitDepth >= 10) badges.appendChild(el('span', { class: 'tag', text: `${v.bitDepth}bit` }));
  } else if (v.error) {
    badges.appendChild(el('span', { class: 'tag err', text: '异常' }));
  }
  thumb.appendChild(badges);
  thumb.appendChild(el('span', { class: 'dur mono', text: v.durationLabel }));
  if (clip.has_proxy) {
    thumb.appendChild(el('span', { class: 'proxy-dot', text: clip.has_video ? 'LRF' : '仅 LRF' }));
  }
}

/** 缩略图图片本身（有 thumb 才加载；加载失败回退占位） */
export function fillThumbImage(thumb, clip) {
  thumb.querySelectorAll('img, .skel, .noimg').forEach((n) => n.remove());
  if (clip.thumb) {
    thumb.appendChild(el('div', { class: 'skel' }));
    const img = el('img', {
      src: api.thumb(clip.thumb, clip.path), alt: clip.name, loading: 'lazy', decoding: 'async',
    });
    img.addEventListener('load', () => {
      img.classList.add('loaded');
      thumb.querySelector('.skel')?.remove();
    }, { once: true });
    img.addEventListener('error', () => { img.remove(); }, { once: true });
    thumb.appendChild(img);
  } else {
    thumb.appendChild(el('div', { class: 'skel' }));
    thumb.appendChild(el('div', {
      class: 'noimg',
      html: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5Z" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4 15l4-3.6 3.4 3 3-2.4L20 15.6" fill="none" stroke="currentColor" stroke-width="1.4"/></svg><span>分析中…</span>',
    }));
  }
  fillThumbOverlay(thumb, clip);
}

function buildCard(clip) {
  const v = vmOf(clip);
  const card = el('div', {
    class: `card${store.selection.has(clip.id) ? ' selected' : ''}${store.focusId === clip.id ? ' focus' : ''}`,
    dataset: { id: clip.id },
    tabindex: '0',
    title: `${clip.name}\n${clip.path}`,
  });

  const thumb = el('div', { class: 'thumb' });
  fillThumbImage(thumb, clip);

  thumb.appendChild(el('button', {
    class: 'card-check',
    title: (clip.burst_count || 1) > 1 ? '选择这一张（连拍组请用组卡片的勾选框）'
      : '选择（Ctrl 多选 / Shift 连选）',
    html: ICON_CHECK,
    // 摊开状态下的连拍单张：点这里的勾选框只选这一张
    onclick: (e) => { e.stopPropagation(); toggleSelect(clip.id, { ctrl: true }); },
  }));
  card.appendChild(thumb);

  const body = el('div', { class: 'card-body' });
  body.appendChild(el('div', { class: 'card-name', text: clip.name }));
  const sub = el('div', { class: 'card-sub' });
  sub.appendChild(el('span', { class: 'k mono', text: `${clip.date} ${clip.time}` }));
  sub.appendChild(el('span', { text: clip.size_label }));
  if (v.codec) sub.appendChild(el('span', { text: v.codec }));
  body.appendChild(sub);

  const sizeRatio = Math.min(1, (clip.size || 0) / (400 * 1024 * 1024));
  body.appendChild(el('div', { class: 'card-bar', html: `<i style="width:${(sizeRatio * 100).toFixed(1)}%"></i>` }));

  const actions = el('div', { class: 'card-actions' });
  actions.appendChild(el('button', {
    class: 'icon-btn', title: '在资源管理器中定位', html: ICON_FOLDER,
    onclick: async (e) => {
      e.stopPropagation();
      try { await api.reveal(clip.path); toast('已在资源管理器中定位'); }
      catch (err) { toast(`定位失败：${err.message}`, 'err'); }
    },
  }));
  actions.appendChild(el('button', {
    class: 'icon-btn', title: '外部播放器打开', html: ICON_PLAY,
    onclick: async (e) => {
      e.stopPropagation();
      try { await api.open(clip.video_path || clip.path); toast('已用系统默认播放器打开'); }
      catch (err) { toast(`打开失败：${err.message}`, 'err'); }
    },
  }));
  body.appendChild(actions);
  card.appendChild(body);

  card.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey) { toggleSelect(clip.id, { ctrl: true }); return; }
    if (e.shiftKey) { toggleSelect(clip.id, { shift: true }); return; }
    onOpen(clip);
  });
  card.addEventListener('dblclick', () => api.open(clip.video_path || clip.path).catch(() => {}));
  attachDragOut(card, clip);
  return card;
}

// ------------------------------------------------------- 连拍：一组一张卡
/** 悬停时在组内逐张预览（用 Image 预加载，避免 404 把 <img> 打掉） */
function attachBurstHover(card, item) {
  const img = card.querySelector('.thumb img');
  if (!img || item.clips.length < 2) return;
  let timer = null;
  let idx = 0;
  const preload = item.clips.map((c) => {
    if (!c.thumb) return null;
    const im = new Image();
    im.src = api.thumb(c.thumb, c.path);
    return im;
  });
  let token = 0;
  card.addEventListener('mouseenter', () => {
    const my = ++token;
    timer = setInterval(() => {
      if (my !== token) return;
      idx = (idx + 1) % item.clips.length;
      const im = preload[idx];
      if (im && im.complete && im.naturalWidth) {
        img.src = im.src;
        const pos = card.querySelector('.burst-pos');
        if (pos) pos.textContent = `${idx + 1}/${item.clips.length}`;
      }
    }, 620);
  });
  card.addEventListener('mouseleave', () => {
    token += 1;
    if (timer) clearInterval(timer);
    timer = null;
    idx = 0;
    img.src = api.thumb(item.cover.thumb, item.cover.path);
    const pos = card.querySelector('.burst-pos');
    if (pos) pos.textContent = `1/${item.clips.length}`;
  });
}

function buildBurstCard(item) {
  const cover = item.cover;
  const n = item.clips.length;
  const selectedAll = item.clips.every((c) => store.selection.has(c.id));
  const selectedSome = item.clips.some((c) => store.selection.has(c.id));
  const expanded = store.expandedBursts.has(item.burstKey);

  // 外层容器负责画"叠起来"的层次感（.card 自己有 overflow:hidden 画不出来）
  const stack = el('div', { class: 'card-stack burst' });
  if (n > 2) stack.appendChild(el('i', { class: 'layer l2' }));
  stack.appendChild(el('i', { class: 'layer l1' }));

  const card = el('div', {
    class: `card burst${selectedAll ? ' selected' : ''}${selectedSome && !selectedAll ? ' partial' : ''}`,
    dataset: { id: cover.id, burst: item.burstKey },
    tabindex: '0',
    title: `${n} 张连拍\n${item.clips[0].name}\n… ${item.clips[n - 1].name}`,
  });

  const thumb = el('div', { class: 'thumb' });
  fillThumbImage(thumb, cover);
  // 位置角标（悬停预览时实时变成 3/10）
  thumb.appendChild(el('span', { class: 'burst-pos mono', text: `1/${n}` }));
  card.appendChild(thumb);

  thumb.appendChild(el('button', {
    class: 'card-check',
    title: selectedAll ? '取消选中这一组' : '选中这一组（全部 N 张）',
    'aria-pressed': selectedAll ? 'true' : 'false',
    html: ICON_CHECK,
    onclick: (e) => {
      e.stopPropagation();
      const on = !item.clips.every((c) => store.selection.has(c.id));
      for (const c of item.clips) {
        if (on) store.selection.add(c.id);
        else store.selection.delete(c.id);
      }
      refreshSelectionUI();
      onSelectionChange();
    },
  }));

  // 展开 / 收起
  const toggle = el('button', {
    class: 'burst-expand',
    title: expanded ? '收起这组连拍' : '把这组连拍一张张摊开',
    text: expanded ? '收起' : '摊开',
    onclick: (e) => {
      e.stopPropagation();
      if (expanded) store.expandedBursts.delete(item.burstKey);
      else store.expandedBursts.add(item.burstKey);
      renderGallery();
      refreshSelectionUI();
    },
  });
  thumb.appendChild(toggle);

  const body = el('div', { class: 'card-body' });
  body.appendChild(el('div', { class: 'card-name', text: cover.name.replace(/_\d{3}(\.\w+)$/, '$1') }));
  const sub = el('div', { class: 'card-sub' });
  sub.appendChild(el('span', { class: 'k mono', text: `${cover.date} ${cover.time}` }));
  sub.appendChild(el('span', { text: `${n} 张 · ${fmtSize(item.size || 0)}` }));
  body.appendChild(sub);
  body.appendChild(el('div', { class: 'card-bar', html: '<i style="width:100%"></i>' }));

  const actions = el('div', { class: 'card-actions' });
  actions.appendChild(el('button', {
    class: 'icon-btn', title: '在资源管理器中定位第一张', html: ICON_FOLDER,
    onclick: async (e) => {
      e.stopPropagation();
      try { await api.reveal(cover.path); toast('已在资源管理器中定位'); }
      catch (err) { toast(`定位失败：${err.message}`, 'err'); }
    },
  }));
  body.appendChild(actions);
  card.appendChild(body);

  card.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey) {
      toggleSelect(cover.id, { ctrl: true });
      return;
    }
    onOpen(cover);
  });
  stack.appendChild(card);
  attachBurstHover(card, item);
  // 连拍组拖出 → 拖的是封面那张（DownloadURL 一次只能带一个文件）
  attachDragOut(card, cover);
  return stack;
}

/** 监听卡片进出视口（viewport 分析模式用；测试环境没有 IntersectionObserver 就跳过） */
let viewObserver = null;
function ensureViewObserver() {
  if (typeof IntersectionObserver === 'undefined') return null;
  if (!viewObserver) {
    viewObserver = new IntersectionObserver((entries) => {
      let changed = false;
      for (const en of entries) {
        const id = en.target.dataset.id;
        if (!id) continue;
        if (en.isIntersecting) {
          if (!store.visibleIds.has(id)) { store.visibleIds.add(id); changed = true; }
        } else if (store.visibleIds.delete(id)) {
          changed = true;
        }
      }
      if (changed) onVisibilityChange();
    }, { root: null, rootMargin: '200px 0px', threshold: 0.01 });
  }
  return viewObserver;
}

function observeCard(card) {
  const ob = ensureViewObserver();
  if (ob) ob.observe(card);
}

function buildItem(item) {
  const node = item.kind === 'burst' ? buildBurstCard(item) : buildCard(item.clip);
  const card = node.classList && node.classList.contains('card') ? node : node.querySelector('.card');
  if (card) observeCard(card);
  return node;
}

// --------------------------------------------------------------- 画廊渲染
export function renderGallery() {
  const wrap = $('#gallery');
  const ph = $('#placeholder');
  if (!store.clips.length) {
    wrap.innerHTML = '';
    ph.hidden = false;
    return;
  }
  ph.hidden = true;

  const clips = filteredClips();
  const items = displayItems();
  const days = groupByDay(clips);
  wrap.innerHTML = '';

  if (!clips.length) {
    wrap.appendChild(el('div', {
      class: 'placeholder',
      html: '<h2>没有符合条件的素材</h2><p>试试放宽筛选条件，或点击「重置筛选」。</p>',
    }));
    return;
  }

  // 展示项按日期归到各自的天
  const itemsByDate = new Map();
  for (const it of items) {
    const d = itemClips(it)[0].date;
    if (!itemsByDate.has(d)) itemsByDate.set(d, []);
    itemsByDate.get(d).push(it);
  }

  const frag = document.createDocumentFragment();
  for (const day of days) {
    const section = el('section', {
      class: `day${store.collapsedDays.has(day.date) ? ' collapsed' : ''}`,
      dataset: { day: day.date },
    });
    const head = el('div', { class: 'day-head' });
    head.innerHTML = ICON_CHEV;

    // 当日勾选框（只作用于该日、且通过筛选的部分）
    const state = dateSelectState(day.date);
    const dayChk = el('input', {
      type: 'checkbox', class: 'date-check',
      title: '选中这一天（当前筛选内的素材）',
    });
    dayChk.checked = state === 'all';
    dayChk.indeterminate = state === 'partial';
    dayChk.addEventListener('click', (e) => e.stopPropagation());
    dayChk.addEventListener('change', (e) => {
      e.stopPropagation();
      const list = day.items;
      const all = list.every((c) => store.selection.has(c.id));
      for (const c of list) {
        if (all) store.selection.delete(c.id);
        else store.selection.add(c.id);
      }
      refreshSelectionUI();
    });
    head.appendChild(dayChk);

    head.appendChild(el('h3', { text: dateLabel(day.date) }));
    head.appendChild(el('span', {
      class: 'day-meta',
      text: `${day.items.length} 条 · ${fmtSize(day.size)}${day.duration ? ` · ${fmtDuration(day.duration)}` : ''}`,
    }));
    head.addEventListener('click', () => {
      if (store.collapsedDays.has(day.date)) store.collapsedDays.delete(day.date);
      else store.collapsedDays.add(day.date);
      section.classList.toggle('collapsed');
    });
    section.appendChild(head);

    const grid = el('div', { class: 'grid' });
    for (const item of (itemsByDate.get(day.date) || [])) grid.appendChild(buildItem(item));
    section.appendChild(grid);
    frag.appendChild(section);
  }
  wrap.appendChild(frag);
}

/** 元数据到达后局部刷新卡片（不重建缩略图 <img>，避免重复下载与闪烁） */
export function updateCardMeta(clipIds) {
  for (const id of clipIds) {
    const card = document.querySelector(`.card[data-id="${id}"]`);
    const clip = store.clips.find((c) => c.id === id);
    if (!card || !clip) continue;
    const thumb = card.querySelector('.thumb');
    if (!thumb) continue;
    const hasImg = !!thumb.querySelector('img');
    if (clip.thumb && !hasImg) fillThumbImage(thumb, clip);
    else fillThumbOverlay(thumb, clip);
    const check = thumb.querySelector('.card-check');
    if (check) thumb.appendChild(check);   // 保证勾选框仍是最上层
  }
}

// ------------------------------------------------------------- 日期侧栏树
/** 某个日期下、通过当前筛选的素材 */
function filteredByDate(date) {
  return filteredClips().filter((c) => c.date === date);
}

/** 日期行的勾选态：all | partial | none */
function dateSelectState(date) {
  const list = filteredByDate(date);
  if (!list.length) return 'none';
  let on = 0;
  for (const c of list) if (store.selection.has(c.id)) on += 1;
  if (on === 0) return 'none';
  return on === list.length ? 'all' : 'partial';
}

export function renderDateTree() {
  const box = $('#date-tree');
  const counts = new Map();
  const sizes = new Map();
  for (const clip of store.clips) {
    counts.set(clip.date, (counts.get(clip.date) || 0) + 1);
    sizes.set(clip.date, (sizes.get(clip.date) || 0) + (clip.size || 0));
  }
  box.innerHTML = '';
  if (!counts.size) {
    box.appendChild(el('div', { class: 'empty-hint', text: '扫描后按日期归类显示' }));
    return;
  }
  const dates = Array.from(counts.keys()).sort((a, b) => (store.sort === 'time-asc' ? a.localeCompare(b) : b.localeCompare(a)));
  for (const date of dates) {
    const active = store.filter.dates.has(date);
    const row = el('div', { class: `date-row${active ? ' active' : ''}`, dataset: { date } });

    // 勾选框：选中"该日期下通过筛选的素材"，与"筛选该日期"互不干扰
    const state = dateSelectState(date);
    const chk = el('input', {
      type: 'checkbox',
      class: 'date-check',
      title: '选中该日期下、通过当前筛选的所有素材（再点一次取消）',
    });
    chk.checked = state === 'all';
    chk.indeterminate = state === 'partial';
    chk.addEventListener('click', (e) => e.stopPropagation());
    chk.addEventListener('change', (e) => {
      e.stopPropagation();
      const list = filteredByDate(date);
      if (!list.length) {
        toast('该日期下没有符合当前筛选的素材', 'err');
        return;
      }
      const all = list.every((c) => store.selection.has(c.id));
      for (const c of list) {
        if (all) store.selection.delete(c.id);
        else store.selection.add(c.id);
      }
      refreshSelectionUI();
    });
    row.appendChild(chk);

    row.appendChild(el('span', { class: 'd-label', text: dateLabel(date) }));
    row.appendChild(el('span', { class: 'd-count', text: `${counts.get(date)}` }));
    row.title = `${date} · ${counts.get(date)} 条 · ${fmtSize(sizes.get(date))}\n点文字=筛选该日期；点勾选框=选中该日期（筛选后）`;
    row.addEventListener('click', () => {
      if (store.filter.dates.has(date)) store.filter.dates.delete(date);
      else store.filter.dates.add(date);
      renderAllRefs();
      $('#status-left').textContent = store.filter.dates.size
        ? `已筛选 ${store.filter.dates.size} 个日期`
        : '显示全部日期';
    });
    box.appendChild(row);
  }
  updateDateSelectAllState();
}

/** 侧栏顶部"选中这些日期"：把当前筛选出的日期整批勾上 */
export function selectFilteredDates() {
  const dates = store.filter.dates.size
    ? Array.from(store.filter.dates)
    : Array.from(new Set(filteredClips().map((c) => c.date)));
  const list = filteredClips().filter((c) => dates.includes(c.date));
  if (!list.length) {
    toast('当前没有可勾选的素材', 'err');
    return 0;
  }
  for (const c of list) store.selection.add(c.id);
  refreshSelectionUI();
  toast(`已选中 ${list.length} 条（${dates.length} 个日期）`);
  return list.length;
}

function updateDateSelectAllState() {
  const btn = $('#btn-date-select');
  if (!btn) return;
  const visible = filteredClips().length;
  const on = filteredClips().filter((c) => store.selection.has(c.id)).length;
  btn.textContent = visible && on >= visible ? '取消选中' : '选中这些日期';
  btn.dataset.all = visible && on >= visible ? '1' : '';
}

/** 由 app.js 注入，避免循环依赖 */
let renderAllRefs = () => {};
export function setRenderAll(fn) { renderAllRefs = fn; }

// ------------------------------------------------------------------ 概览
export function renderStats() {
  const s = store.summary || {};
  const clips = store.clips;
  $('#st-clips').textContent = `${clips.length}`;
  $('#st-size').textContent = fmtSize(clips.reduce((a, c) => a + (c.size || 0), 0));
  const totalDur = clips.reduce((a, c) => a + (detailOf(c)?.duration || 0), 0);
  $('#st-dur').textContent = totalDur ? fmtDuration(totalDur) : '-';
  $('#st-days').textContent = `${new Set(clips.map((c) => c.date)).size}`;
  $('#st-lrf').textContent = `${clips.filter((c) => c.has_proxy).length}`;
  $('#st-probed').textContent = `${probedCount()}/${clips.length}`;
  // 连拍信息：多少组、共多少张
  const burstGroups = new Set(clips.filter((c) => c.burst_key).map((c) => c.burst_key));
  const burstPhotos = clips.filter((c) => c.burst_key).length;
  const stBurst = $('#st-burst');
  if (stBurst) {
    stBurst.textContent = burstGroups.size
      ? `${burstGroups.size} 组 / ${burstPhotos} 张`
      : '-';
    stBurst.parentElement?.classList.toggle('dim', !burstGroups.size);
  }

  const resCount = new Map();
  for (const clip of clips) {
    const d = detailOf(clip);
    if (d && d.ok) resCount.set(d.resolution || '未知', (resCount.get(d.resolution || '未知') || 0) + 1);
  }
  const bars = $('#res-bars');
  bars.innerHTML = '';
  const entries = Array.from(resCount.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const max = Math.max(1, ...entries.map((e) => e[1]));
  for (const [label, n] of entries) {
    bars.appendChild(el('div', {
      class: 'res-bar',
      html: `<span class="rb-label">${label}</span>
             <span class="rb-track"><i class="rb-fill" style="width:${(n / max * 100).toFixed(0)}%"></i></span>
             <span class="rb-n">${n}</span>`,
    }));
  }
}

// ------------------------------------------------------------------ 选择
export function toggleSelect(id, { ctrl = false, shift = false } = {}) {
  if (shift && store.focusId && store.focusId !== id) {
    const list = filteredClips().map((c) => c.id);
    const a = list.indexOf(store.focusId);
    const b = list.indexOf(id);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i += 1) store.selection.add(list[i]);
      store.focusId = id;
      refreshSelectionUI();
      return;
    }
  }
  if (store.selection.has(id)) store.selection.delete(id);
  else store.selection.add(id);
  if (!ctrl) store.focusId = id;
  refreshSelectionUI();
}

export function clearSelection() {
  store.selection.clear();
  refreshSelectionUI();
}

export function selectAllVisible() {
  const list = filteredClips();
  if (!list.length) return 0;
  for (const c of list) store.selection.add(c.id);
  refreshSelectionUI();
  return list.length;
}

/** 选中/取消：当前筛选结果（一次搞定"筛完再全选"） */
export function toggleSelectFiltered() {
  const res = coreSelectAllFiltered(store.selection, filteredClips());
  refreshSelectionUI();
  return res.count;
}

/** 反选当前筛选结果 */
export function invertSelection() {
  const n = coreInvert(store.selection, filteredClips());
  refreshSelectionUI();
  return n;
}

/** 选中某一天（在筛选结果内的部分） */
export function selectDate(date) {
  const n = coreSelectClips(store.selection, filteredByDate(date), true);
  refreshSelectionUI();
  return n;
}

export function refreshSelectionUI() {
  document.querySelectorAll('.card').forEach((card) => {
    if (card.dataset.burst) {
      // 连拍组：整组都选中才算 selected，选了一部分显示部分态
      const members = store.clips.filter((c) => c.burst_key === card.dataset.burst);
      const on = members.length > 0 && members.every((c) => store.selection.has(c.id));
      const some = members.some((c) => store.selection.has(c.id));
      card.classList.toggle('selected', on);
      card.classList.toggle('partial', some && !on);
      const chk = card.querySelector('.card-check');
      if (chk) {
        chk.classList.toggle('on', on);
        chk.classList.toggle('half', some && !on);
        chk.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      card.classList.toggle('focus', members.some((c) => c.id === store.focusId));
      return;
    }
    const on = store.selection.has(card.dataset.id);
    card.classList.toggle('selected', on);
    card.classList.toggle('focus', card.dataset.id === store.focusId);
  });
  // 同步日期行勾选框（含半选态）
  document.querySelectorAll('.date-row').forEach((row) => {
    const chk = row.querySelector('.date-check');
    const st = dateSelectState(row.dataset.date);
    row.classList.toggle('has-selection', st !== 'none');
    if (!chk) return;
    chk.checked = st === 'all';
    chk.indeterminate = st === 'partial';
  });
  updateDateSelectAllState();
  onSelectionChange();
}
