// api.js —— 后端接口封装
const json = async (res) => {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data && data.error) msg = data.error;
    } catch { /* 忽略 */ }
    throw new Error(msg);
  }
  return res.json();
};

const qs = (params) => {
  const sp = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  });
  const s = sp.toString();
  return s ? `?${s}` : '';
};

/** 路径式接口：把绝对路径按段编码，避免 % 等字符被误解析 */
const pathSeg = (p) => String(p || '').split(/[\\/]/).map(encodeURIComponent).join('/');

export const api = {
  info: () => fetch('/_api/info').then(json),

  scan: (folder, { recursive = true, force = false, analyze = true } = {}) =>
    fetch(`/_api/scan${qs({
      folder, recursive: recursive ? 1 : 0, force: force ? 1 : 0, analyze: analyze ? 1 : 0,
    })}`).then(json),

  /** 单文件分析；wait=true 时同步返回结果（"点开才分析"用） */
  probe: (path, wait = false) => fetch(`/_api/probe${qs({ path, wait: wait ? 1 : 0 })}`).then(json),

  /** 批量取已缓存的探测结果；enqueue 时会顺便把缺失的排进后台队列 */
  meta: (paths, enqueue = true) =>
    fetch('/_api/meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths, enqueue }),
    }).then(json),

  progress: () => fetch('/_api/progress').then(json),

  /** 缩略图阶段：只问"这些文件的图好了没"，好了就给文件名，用于边生成边贴图 */
  thumbStatus: (paths) =>
    fetch('/_api/thumb_status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    }).then(json),

  frames: (path, t, w = 320) => `/_api/frames${qs({ path, t, w })}`,
  /** 缩略图：带上素材路径，服务端在缓存缺失时可回退到相机自带的 SCR/THM */
  thumb: (name, clipPath) =>
    `/_thumb/${encodeURIComponent(name)}${clipPath ? `?path=${encodeURIComponent(clipPath)}` : ''}`,
  media: (path) => `/_media/${pathSeg(path)}`,
  /** 附件形式（Content-Disposition: attachment），供拖到资源管理器时浏览器落盘 */
  download: (path) => `/_media/${pathSeg(path)}?dl=1`,
  live: (path) => `/_live/${pathSeg(path)}`,
  photo: (path) => `/_photo/${pathSeg(path)}`,

  reveal: (path) => fetch(`/_api/reveal${qs({ path })}`).then(json),
  /** 在资源管理器里一次选中多个文件（同一目录） */
  revealMany: (paths) => fetch('/_api/reveal_many', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  }).then(json),
  open: (path) => fetch(`/_api/open${qs({ path })}`).then(json),
  purge: () => fetch('/_api/cache/purge', { method: 'POST' }).then(json),
  del: (paths) =>
    fetch('/_api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths, confirm: true }),
    }).then(json),

  exportCsv: async (paths, filename = 'dji_export.csv') => {
    const res = await fetch('/_export/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    });
    if (!res.ok) throw new Error('导出失败');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  },

  // ---------------- 转存（导出原始素材） ----------------
  exportPlan: (paths, dest, opts) =>
    fetch('/_api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths, dest, dryRun: true, ...opts }),
    }).then(json),

  exportStart: (paths, dest, opts) =>
    fetch('/_api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths, dest, ...opts }),
    }).then(json),

  exportProgress: (job) => fetch(`/_api/export/progress${qs({ job })}`).then(json),

  exportCancel: (job) =>
    fetch('/_api/export/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job }),
    }).then(json),

  browse: (path) => fetch(`/_api/browse${qs({ path })}`).then(json),
  suggestDest: (folder) => fetch(`/_api/suggest_dest${qs({ folder })}`).then(json),
};

/** 绝对路径统一转成 / 形式，便于拼 URL 与跨平台显示 */
export const normPath = (p) => String(p || '').replace(/\\/g, '/');
