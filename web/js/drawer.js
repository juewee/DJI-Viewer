// drawer.js —— 右侧详情抽屉 + 预览播放器（MP4 / LRF / 实时转码）
import { api, normPath } from './api.js';
import {
  $, el, fmtSize, fmtDuration, fmtBitrate, toast, copyText, dateLabel,
} from './utils.js';
import { store, detailOf, vmOf, isDLog } from './store.js';

let current = null;

/** 「色彩还原」开关：只有 D-Log 视频才可勾（照片/实况本来颜色就正常，不套 LUT） */
function syncLutToggle(clip) {
  const box = $('#chk-lut');
  const lbl = $('#lbl-lut');
  if (!box || !lbl) return;
  const usable = !!store.lutAvailable && !clip.is_photo && !clip.is_scrub
    && !clip.is_live && isDLog(clip);
  box.disabled = !usable;
  box.checked = usable && !!store.lutEnabled;
  lbl.classList.toggle('disabled', !usable);
  if (!store.lutAvailable) {
    lbl.title = '项目目录里没找到 .cube LUT';
  } else if (usable) {
    lbl.title = '把这条 D-Log M 视频按 LUT 还原成 Rec.709（实时转码预览，不改原文件）';
  } else {
    lbl.title = clip.is_photo || clip.is_scrub || clip.is_live
      ? '照片/实况本身颜色正常，不需要色彩还原'
      : '这条素材不是 D-Log，不需要色彩还原';
  }
}

// ------------------------------------------------------------ 转码流播放
function attachLiveStream(video, path, onFail, lut = false) {
  if (!('MediaSource' in window)) {
    onFail('当前浏览器不支持 Media Source 流式播放，请改用 LRF 预览或外部播放器。');
    return null;
  }
  let ms;
  try {
    ms = new MediaSource();
    video.src = URL.createObjectURL(ms);
  } catch (err) {
    onFail(`初始化转码流失败：${err.message}`);
    return null;
  }
  let sb = null;
  let queue = [];
  let fetching = false;
  let aborted = false;
  const controller = new AbortController();

  const pump = async () => {
    if (fetching || aborted) return;
    while (sb && sb.updating) await new Promise((r) => setTimeout(r, 30));
    if (!sb || sb.updating || aborted) return;
    if (!queue.length) {
      if (!fetching) {
        fetching = true;
        try {
          const res = await fetch(api.live(path, lut), { signal: controller.signal });
          fetching = false;
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          const reader = res.body.getReader();
          while (!aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            if (sb && sb.readyState === 'open' && !sb.updating) {
              try { sb.appendBuffer(value); } catch { queue.push(value); }
            } else {
              queue.push(value);
            }
            if (queue.length > 40) await new Promise((r) => setTimeout(r, 120));
          }
        } catch (err) {
          fetching = false;
          if (!aborted) onFail(`转码失败：${err.message}`);
        }
      }
      return;
    }
    const chunk = queue.shift();
    try { sb.appendBuffer(chunk); } catch { queue.unshift(chunk); }
  };

  ms.addEventListener('sourceopen', () => {
    try {
      sb = ms.addSourceBuffer('video/mp4; codecs="avc1.640028"');
    } catch {
      try { sb = ms.addSourceBuffer('video/mp4; codecs="avc1.42E01E"'); }
      catch (err) { onFail(`无法创建播放缓冲：${err.message}`); return; }
    }
    sb.mode = 'segments';
    sb.addEventListener('updateend', () => {
      if (video.buffered.length && video.currentTime < 0.05) {
        try { video.currentTime = video.buffered.start(0) + 0.05; } catch { /* 忽略 */ }
      }
      pump();
    });
    pump();
  });
  ms.addEventListener('error', () => onFail('转码流解析出错，建议改用 LRF 预览。'));
  video.addEventListener('waiting', pump, { once: false });

  return () => {
    aborted = true;
    try { controller.abort(); } catch { /* 忽略 */ }
    try { if (ms.readyState === 'open') ms.endOfStream(); } catch { /* 忽略 */ }
  };
}

/* ============================ 播放健康检查 ============================
   原则：只要有任何"确实在播/确实能播"的证据，就撤掉蒙版与加载态。
   证据 = playing / timeupdate / canplay / loadeddata 事件，或 currentTime 真的在走。
   绝不因为 readyState 数值偏低就认为解码失败——部分浏览器解码 HEVC 时这个值长期很低，
   但画面其实正常（真实踩过的坑）。
   ==================================================================== */
let watchTimers = [];

function clearPlaybackOverlays() {
  const fallback = $('#player-fallback');
  if (fallback) fallback.hidden = true;
  const loading = $('#player-loading');
  if (loading) loading.hidden = true;
}

/** 是否已有"能播"的证据（事件标记 + 时间轴真的在走） */
function playbackLooksAlive(video) {
  if (video.dataset && video.dataset.alive === '1') return true;
  if (video.currentTime > 0.08 || video.readyState >= 3) return true;
  return false;
}

function markAlive(video) {
  if (video.dataset) video.dataset.alive = '1';
  clearPlaybackOverlays();
}

function isActuallyPlaying(video) {
  return !video.paused && !video.ended && video.currentTime > 0;
}

let loadToken = 0;               // 每次换源自增；旧源迟到的事件凭 token 失效
let currentFail = null;
let lastFailedToken = '';        // 同一源只报一次失败，避免降级后又被旧源的 error 覆盖

function nextToken(video) {
  loadToken += 1;
  if (video && video.dataset) video.dataset.token = String(loadToken);
  return loadToken;
}

function isStaleEvent(video) {
  return !video.dataset || video.dataset.token !== String(loadToken);
}

function cleanupPlaybackWatch(video, bumpToken = true) {
  if (!video) return;
  if (bumpToken) nextToken(video);   // 让旧源的迟到事件全部失效
  watchTimers.forEach((t) => clearTimeout(t));
  watchTimers = [];
  ['playing', 'timeupdate', 'canplay', 'loadeddata'].forEach((ev) => {
    try { video.removeEventListener(ev, onPlaybackEvidence); } catch { /* 忽略 */ }
  });
}

function onPlaybackEvidence(e) {
  const video = e.currentTarget || e.target;
  if (!video || video !== $('#player')) return;
  if (isStaleEvent(video)) return;   // 旧源的事件不能影响当前状态
  markAlive(video);
}

/** 全局只注册一次的视频错误处理（避免监听器堆积、多个源互相打架） */
function onVideoError(e) {
  const video = e.currentTarget || e.target;
  if (!video || video !== $('#player')) return;
  if (isStaleEvent(video)) return;   // 关键：旧源迟到的 error 不得影响新源
  const token = video.dataset ? video.dataset.token : '';
  if (token && token === lastFailedToken) return;   // 同一源只报一次
  if (playbackLooksAlive(video)) { clearPlaybackOverlays(); return; }
  const code = video.error ? video.error.code : 0;
  if (code === 1) return;            // MEDIA_ERR_ABORTED：换源的正常现象
  lastFailedToken = token;
  const msg = code === 4 ? '格式/编码不支持' : code === 2 ? '无法读取文件' : `播放错误 (code ${code})`;
  if (currentFail) currentFail(msg, { reason: `video.error(code=${code})` });
}

/** 浏览器是否支持直接播放该编码 */
function canDecode(video, clip) {
  const codec = (clip && detailOf(clip) || {}).codec;
  try {
    if (codec === 'hevc') {
      return video.canPlayType('video/mp4; codecs="hvc1.1.6.L153.B0"') !== ''
          || video.canPlayType('video/mp4; codecs="hev1.1.6.L153.B0"') !== '';
    }
    if (codec === 'h264' || codec === 'avc1') {
      return video.canPlayType('video/mp4; codecs="avc1.640028"') !== '';
    }
  } catch { /* 忽略 */ }
  return true;   // 拿不准就当能播，让事件去决定
}

function watchPlayback(video, fail) {
  if (video.dataset) video.dataset.alive = '';
  const onEvidence = onPlaybackEvidence;
  ['playing', 'timeupdate', 'canplay', 'loadeddata'].forEach((ev) => {
    video.addEventListener(ev, onEvidence);
  });
  // 加载态延迟出现：避免"已经开始播了还压着一个转圈"
  watchTimers.push(setTimeout(() => {
    const el = $('#player-loading');
    if (el && video === $('#player') && !playbackLooksAlive(video) && !video.error) {
      el.hidden = false;
    }
  }, 2500));
  // 8 秒仍没有任何"在播/能播"的证据，才认为是真的播不了
  watchTimers.push(setTimeout(() => {
    if (video !== $('#player') || !current) return;
    if (playbackLooksAlive(video) || isActuallyPlaying(video)) {
      clearPlaybackOverlays();
      return;
    }
    fail('8 秒内没有出画面：可能是解码能力不足或文件读取失败，可改用 LRF 预览 / 实时转码 / 外部播放器。',
      { reason: '8s超时' });
  }, 8000));
}

/** 播放源切换按钮旁的小字提示（例如"已自动改用 LRF"） */
function setSegHint(text) {
  const box = $('#seg-hint');
  if (box) {
    box.textContent = text || '';
    box.hidden = !text;
  }
}

function setSource(mode, opts = {}) {
  const clip = current;
  if (!clip) return;
  const video = $('#player');
  const photoView = $('#photo-view');
  const fallback = $('#player-fallback');
  const loading = $('#player-loading');
  store.srcMode = mode;
  fallback.hidden = true;
  setSegHint(opts.hint || '');
  const diagBox = $('#fb-diag');
  if (diagBox) diagBox.textContent = '';   // 每次换源都清掉上一次的诊断信息

  if (window.__liveStop) { window.__liveStop(); window.__liveStop = null; }
  cleanupPlaybackWatch(video);
  try { video.pause(); } catch { /* 忽略 */ }
  video.removeAttribute('src');
  try { video.load(); } catch { /* 忽略 */ }

  document.querySelectorAll('#src-seg .seg-btn').forEach((b) => {
    b.classList.toggle('on', b.dataset.src === mode);
  });

  if (clip.is_photo || clip.is_scrub) {
    video.hidden = true;
    photoView.hidden = false;
    // 只有相机预览图的条目：直接把 SCR/THM 当图片显示
    photoView.src = api.photo(clip.photo_path || clip.preview_path || clip.path);
    loading.hidden = true;
    return;
  }
  photoView.hidden = true;
  video.hidden = false;

  const fail = (msg, diag) => {
    loading.hidden = true;
    // 有 LRF 就别用蒙版打断：自动降级到 LRF，只给一行小字说明
    if (clip.has_proxy && mode !== 'lrf') {
      const from = mode === 'live' ? '实时转码' : '原始 MP4';
      setSource('lrf', { hint: `${from}：${msg} → 已自动改用 LRF 预览` });
      toast(`${from}播不了（${msg}），已自动切到 LRF 预览`);
      return;
    }
    // 切到 LRF 也救不了（或本来就在放 LRF）：这才需要蒙版
    setSegHint(clip.has_proxy ? 'LRF 预览也无法播放，请用实时转码或外部播放器' : '');
    fallback.hidden = false;
    $('#fb-body').textContent = msg;
    $('#fb-lrf').hidden = !clip.has_proxy || mode === 'lrf';
    $('#fb-live').hidden = mode === 'live';
    const v = vmOf(clip);
    if (!clip.has_proxy && mode !== 'live') {
      $('#fb-lrf').hidden = true;
      const hint = v.codec === 'H.265'
        ? '该素材是 H.265(HEVC) 编码，且没有 LRF 预览文件。可以直接在系统播放器中打开，或使用实时转码。'
        : '浏览器无法播放该文件，可能文件损坏或为 0 字节。';
      $('#fb-body').textContent = `${hint}（${msg}）`;
    }
    // 诊断信息：方便一眼看出到底是解码、读取还是网络的问题
    const diagEl = $('#fb-diag');
    if (diagEl) {
      const d = diag || {};
      diagEl.textContent = [
        `触发=${d.reason || 'unknown'}`,
        `readyState=${video.readyState}`,
        `networkState=${video.networkState}`,
        `error=${video.error ? video.error.code : '无'}`,
        `currentTime=${video.currentTime.toFixed(2)}`,
        `时长=${Number.isFinite(video.duration) ? video.duration.toFixed(1) : '未知'}`,
        `支持HEVC=${canDecode(video, clip) ? '是' : '否'}`,
        `源=${store.srcMode}`,
        `前端版本=${window.__assetVersion || '未标记'}`,
      ].join('　');
    }
  };

  if (mode === 'live') {
    nextToken(video);
    if (video.dataset) video.dataset.alive = '';
    currentFail = fail;
    // 开了色彩还原就用带 LUT 的转码流（服务端 lut3d，画面已经是 Rec.709）
    const wantLut = store.lutEnabled && isDLog(clip);
    if (wantLut) setSegHint('实时转码 + 色彩还原（D-Log M → Rec.709）');
    window.__liveStop = attachLiveStream(video, clip.video_path || clip.path, fail, wantLut);
    video.play().catch(() => { /* 需要用户手势，忽略 */ });
    watchPlayback(video, fail);
    return;
  }

  const src = mode === 'lrf'
    ? (clip.proxy_path || clip.video_path)
    : (clip.video_path || clip.proxy_path);
  if (!src) { fail('没有可播放的视频文件'); return; }

  // 浏览器明确不支持这个编码 + 有 LRF → 直接切 LRF，不弹蒙版打扰
  if (mode === 'mp4' && clip.has_proxy && !canDecode(video, clip)) {
    setSource('lrf', { hint: '浏览器不支持 HEVC，已自动改用 LRF 预览（720p）' });
    toast('当前浏览器不支持该编码(HEVC)，已自动切到 LRF 预览');
    return;
  }

  loading.hidden = true;    // 由 watchPlayback 决定是否再显示
  nextToken(video);
  if (video.dataset) video.dataset.alive = '';
  currentFail = fail;
  video.src = api.media(src);
  video.load();
  video.play().catch(() => { /* 自动播放被拦不算失败 */ });
  watchPlayback(video, fail);
}

// ------------------------------------------------------------------ 抽屉
/**
 * 连拍胶片条：同一组的所有帧排一行，点击直接跳到那一张。
 * 只有真正属于连拍（>=2 张）才显示。
 */
function renderBurstStrip(clip) {
  const box = $('#d-burst');
  const inner = $('#d-burst-inner');
  if (!box || !inner) return;
  const n = clip.burst_count || 1;
  if (!clip.burst_key || n < 2) {
    box.hidden = true;
    inner.innerHTML = '';
    return;
  }
  const members = store.clips
    .filter((c) => c.burst_key === clip.burst_key)
    .sort((a, b) => (a.burst_pos || 0) - (b.burst_pos || 0));
  const pos = members.findIndex((c) => c.id === clip.id) + 1;
  $('#d-burst-label').textContent = `连拍 · 第 ${pos}/${n} 张`;
  inner.innerHTML = '';
  for (const m of members) {
    if (m.thumb) {
      const img = el('img', {
        src: api.thumb(m.thumb, m.path),
        title: `${m.name}（第 ${m.burst_pos} 张）`,
        alt: m.name,
        class: m.id === clip.id ? 'on' : '',
        loading: 'lazy',
      });
      img.addEventListener('click', () => {
        if (m.id !== clip.id) window.__openClip?.(m);
      });
      inner.appendChild(img);
    } else {
      inner.appendChild(el('div', { class: 'ph-slot', text: `${m.burst_pos}` }));
    }
    if (m.id === clip.id) {
      // 滚动到当前张
      requestAnimationFrame(() => {
        inner.querySelector('img.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
      });
    }
  }
  box.hidden = false;
}

export function renderDrawer(clip) {
  current = clip;
  store.current = clip;
  const d = detailOf(clip);
  const v = vmOf(clip);

  $('#drawer').hidden = false;
  $('#d-name').textContent = clip.name;
  $('#d-sub').textContent = `${dateLabel(clip.date)} ${clip.time}  ·  ${clip.size_label}`;

  // 源选择按钮可用性
  const segMp4 = document.querySelector('#src-seg [data-src="mp4"]');
  const segLrf = document.querySelector('#src-seg [data-src="lrf"]');
  segMp4.disabled = !clip.has_video || clip.is_photo;
  segLrf.disabled = !clip.has_proxy;
  segMp4.textContent = clip.is_photo ? '照片' : '原始 MP4';
  syncLutToggle(clip);

  let mode = store.srcMode;
  if (clip.is_photo) mode = 'mp4';
  else if (store.lutEnabled && isDLog(clip) && !clip.is_live) mode = 'live';   // 勾了色彩还原就必须走转码流
  else if (store.autoLrf && clip.has_proxy) mode = 'lrf';
  else if (!clip.has_video) mode = 'lrf';
  else if (mode === 'lrf' && !clip.has_proxy) mode = 'mp4';
  setSource(mode);

  // 元数据表
  const kvs = $('#d-kvs');
  kvs.innerHTML = '';
  const rows = [
    ['拍摄时间', `${clip.date} ${clip.time}`, true],
    ['分辨率', v.probed ? `${v.resolution}  (${v.aspect})` : (v.error || '分析中…'), v.probed],
    ['帧率', v.probed ? `${v.fps || '-'} fps` : '-', false],
    ['编码', v.probed ? `${v.codec}${v.profile ? ` · ${v.profile}` : ''}` : '-', false],
    ['位深 / 色彩', v.probed ? `${v.bitDepth ? `${v.bitDepth}bit` : '-'}${v.hdr ? ' · HDR' : ''}${d.color_transfer ? ` · ${d.color_transfer}` : ''}` : '-', v.hdr],
    ['时长', v.probed ? fmtDuration(v.duration) : '-', false],
    ['码率', v.probed ? fmtBitrate(d.bit_rate) : '-', false],
    ['文件大小', clip.size_label, false],
    ['LRF 预览', clip.has_proxy ? `${clip.proxy_size_label}  (${(clip.proxy_size / Math.max(1, clip.size) * 100).toFixed(1)}%)` : '无', clip.has_proxy],
    ['音频', d && d.ok ? (d.has_audio ? '有' : '无') : '-', false],
    ['色彩后缀', clip.color ? `${clip.suffix} → ${clip.color}` : (clip.suffix || '-'), !!clip.color],
    ['媒体序号', clip.seq !== null && clip.seq !== undefined ? `#${String(clip.seq).padStart(4, '0')}` : '-', false],
    ['拍摄设备', d && d.encoder ? d.encoder : '-', false],
    ['时间码', d && d.timecode ? d.timecode : '-', false],
    ['容器内时间', d && d.creation_time ? d.creation_time : '-', false],
    ['文件路径', normPath(clip.path), false],
  ];
  for (const [k, val, hl] of rows) {
    kvs.appendChild(el('div', { class: 'k', text: k }));
    kvs.appendChild(el('div', { class: `v${hl ? ' hl' : ''}`, text: String(val) }));
  }

  // 连拍胶片条
  renderBurstStrip(clip);

  // 文件列表
  const files = $('#d-files');
  files.innerHTML = '';
  for (const f of clip.files) {
    const kindLabel = {
      video: 'MP4 原始', proxy: 'LRF 预览', photo: '照片',
      preview: /\.scr$/i.test(f.name) ? 'SCR 预览图 1280×720' : 'THM 缩略图 256×144',
    }[f.kind] || f.kind;
    const row = el('div', { class: `file-row ${f.kind}` });
    row.appendChild(el('span', { class: 'ftag', text: kindLabel }));
    row.appendChild(el('span', { class: 'fname', text: f.name, title: normPath(f.path) }));
    row.appendChild(el('span', { class: 'fsize', text: f.size_label }));
    row.appendChild(el('button', {
      class: 'icon-btn', title: '在资源管理器中定位',
      html: '<svg viewBox="0 0 16 16"><path d="M2 5.2A1.2 1.2 0 0 1 3.2 4h2.6l1.2 1.6h5.8A1.2 1.2 0 0 1 14 6.8v5A1.2 1.2 0 0 1 12.8 13H3.2A1.2 1.2 0 0 1 2 11.8Z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
      onclick: async () => {
        try { await api.reveal(f.path); } catch (err) { toast(err.message, 'err'); }
      },
    }));
    files.appendChild(row);
  }

  // 时间轴抓帧（优先用 LRF：720p H.264 出帧快得多）
  const strip = $('#d-strip');
  const inner = $('#strip-inner');
  inner.innerHTML = '';
  const dur = d && d.duration ? d.duration : 0;
  const grabSrc = clip.proxy_path || clip.video_path;
  if (!clip.is_photo && grabSrc && dur > 0.6) {
    strip.hidden = false;
    const n = dur > 30 ? 8 : 6;
    for (let i = 0; i < n; i += 1) {
      const t = (dur * (i + 0.5)) / n;
      const img = el('img', {
        src: api.frames(grabSrc, t.toFixed(2), 240),
        title: `跳到 ${fmtDuration(t)}`,
        loading: 'lazy',
        alt: '',
      });
      img.addEventListener('click', () => {
        const video = $('#player');
        video.currentTime = t;
        video.play().catch(() => {});
      });
      inner.appendChild(img);
    }
  } else {
    strip.hidden = true;
  }
}

export function currentClip() { return current; }

export function step(delta) {
  if (!current) return;
  const list = window.__visibleClips || [];
  const idx = list.findIndex((c) => c.id === current.id);
  if (idx < 0) return;
  const next = list[idx + delta];
  if (!next) { toast(delta > 0 ? '已经是最后一条' : '已经是第一条'); return; }
  window.__openClip(next);
}

export function closeDrawer() {
  if (window.__liveStop) { window.__liveStop(); window.__liveStop = null; }
  const video = $('#player');
  cleanupPlaybackWatch(video);
  currentFail = null;
  try { video.pause(); } catch { /* 忽略 */ }
  video.removeAttribute('src');
  try { video.load(); } catch { /* 忽略 */ }
  $('#drawer').hidden = true;
  current = null;
  store.current = null;
}

export function initDrawer() {
  const player = $('#player');
  if (player) player.addEventListener('error', onVideoError);   // 只注册一次
  document.querySelectorAll('#src-seg .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled || !current) return;
      setSource(btn.dataset.src);
    });
  });
  $('#fb-lrf').addEventListener('click', () => { if (current && current.has_proxy) setSource('lrf'); });
  $('#fb-live').addEventListener('click', () => { if (current) setSource('live'); });
  $('#chk-autolrf').addEventListener('change', (e) => {
    store.autoLrf = e.target.checked;
    localStorage.setItem('dji.autoLrf', store.autoLrf ? '1' : '0');
    if (current && !current.is_photo) setSource(store.autoLrf && current.has_proxy ? 'lrf' : 'mp4');
  });
  $('#d-close').addEventListener('click', closeDrawer);
  $('#d-prev').addEventListener('click', () => step(-1));
  $('#d-next').addEventListener('click', () => step(1));
  $('#d-open').addEventListener('click', async () => {
    if (!current) return;
    try { await api.open(current.video_path || current.photo_path || current.path); toast('已用系统默认程序打开'); }
    catch (err) { toast(err.message, 'err'); }
  });
  $('#d-reveal').addEventListener('click', async () => {
    if (!current) return;
    try { await api.reveal(current.path); } catch (err) { toast(err.message, 'err'); }
  });
  $('#d-copy').addEventListener('click', async () => {
    if (!current) return;
    const ok = await copyText(normPath(current.path));
    toast(ok ? '路径已复制' : '复制失败', ok ? '' : 'err');
  });
}
