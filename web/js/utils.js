// utils.js —— 格式化与通用小工具

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c === null || c === undefined || c === false) return;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return node;
}

export function fmtSize(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  const digits = i === 0 ? 0 : v < 10 ? 2 : v < 100 ? 1 : 0;
  return `${v.toFixed(digits)} ${units[i]}`;
}

export function fmtDuration(sec) {
  if (sec === null || sec === undefined || Number.isNaN(sec)) return '--:--';
  const s = Math.max(0, Math.round(Number(sec)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
           : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function fmtBitrate(bps) {
  if (!bps) return '-';
  return `${(bps / 1e6).toFixed(bps / 1e6 < 10 ? 1 : 0)} Mbps`;
}

export function dateLabel(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) return dateStr || '未知日期';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const wk = '日一二三四五六'[d.getDay()];
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  const yest = new Date(today.getTime() - 864e5);
  const isYest = d.toDateString() === yest.toDateString();
  const base = `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日`;
  return `周${wk} · ${base}${isToday ? ' · 今天' : isYest ? ' · 昨天' : ''}`;
}

export function debounce(fn, wait = 160) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

export function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

let snackTimer = null;
export function toast(msg, kind = '') {
  const box = $('#snackbar');
  if (!box) return;
  box.textContent = msg;
  box.className = `snackbar ${kind}`;
  box.hidden = false;
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => { box.hidden = true; }, kind === 'err' ? 4200 : 2400);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function downloadBlobUrl(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 卡片需要的展示字段（detail 可能还没探测出来） */
export function viewModel(clip, detail) {
  const d = detail && detail.ok ? detail : null;
  const aspect = (d && d.width && d.height) ? `${d.width}×${d.height}` : '';
  return {
    resolution: d ? d.resolution : (clip.is_photo ? '照片' : '…'),
    fps: d ? d.fps_label : '',
    codec: d ? d.codec_label : '',
    bitDepth: d ? d.bit_depth : null,
    hdr: !!(d && d.hdr),
    duration: d ? d.duration : null,
    durationLabel: d ? fmtDuration(d.duration) : (clip.is_photo ? '照片' : '—'),
    aspect,
    profile: d ? d.profile : '',
    error: detail && detail.ok === false ? (detail.error || '无法解析') : '',
    probed: !!d,
  };
}
