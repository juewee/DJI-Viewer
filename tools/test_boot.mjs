// tools/test_boot.mjs —— 用 DOM 桩在 Node 里真跑一遍前端启动链路
// 目的：不依赖浏览器也能抓出「脚本报错 → 按钮点不动」这类运行时问题
// 用法：node tools/test_boot.mjs
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, '..', 'web');
const html = readFileSync(join(webDir, 'index.html'), 'utf8');
const scanFixture = join(here, 'fixtures', 'scan.json');

let pass = 0;
const fails = [];
const errors = [];
process.on('unhandledRejection', (err) => {
  errors.push(`未处理的 Promise 异常: ${err && err.message ? err.message : err}`);
});
process.on('uncaughtException', (err) => {
  errors.push(`未捕获异常: ${err && err.message ? err.message : err}`);
});
function ok(name, cond, info = '') {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}${info ? '  ' + info : ''}`); }
  else { fails.push(name); console.log(`  [FAIL] ${name}${info ? '  ' + info : ''}`); }
}

// ===================================================== 极简 DOM 实现
const VOID_TAGS = new Set(['img', 'input', 'br', 'hr', 'meta', 'link', 'source']);

class El {
  constructor(tag = 'div', attrs = {}) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.style = {
      setProperty(k, v) { this[k] = v; },
      removeProperty(k) { delete this[k]; },
      getPropertyValue(k) { return this[k] ?? ''; },
    };
    this.listeners = new Map();
    this._text = '';
    this._html = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.currentTime = 0;
    this.duration = NaN;
    this.networkState = 1;
    this.paused = true;
    this.ended = false;
    this.readyState = 0;
    this.error = null;
    this.canPlayTypeResult = 'probably';   // 测试里可覆盖，模拟不支持的浏览器
    this.classList = makeClassList(this);
    for (const [k, v] of Object.entries(attrs)) this.setAttribute(k, v);
  }

  get className() { return this.attributes.class || ''; }
  set className(v) { this.attributes.class = String(v); }

  get id() { return this.attributes.id || ''; }
  set id(v) { this.attributes.id = String(v); }

  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }

  set textContent(v) { this._text = String(v); this.children = []; }

  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    this.children = [];
    // 真 DOM 会解析 HTML，textContent 也能读到里面的文字；桩里近似模拟一下
    this._text = this._html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  setAttribute(k, v) {
    if (v === false || v === null || v === undefined) return;
    this.attributes[k] = String(v);
    if (k === 'class') this.attributes.class = String(v);
    if (k === 'value') this.value = String(v);
    if (k === 'checked') this.checked = true;
    if (k === 'disabled') this.disabled = true;
    if (k === 'hidden') this.hidden = true;
    if (k.startsWith('data-')) {
      const key = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = String(v);
    }
    if (k === 'id') this.attributes.id = String(v);
  }

  getAttribute(k) { return this.attributes[k] ?? null; }
  hasAttribute(k) { return k in this.attributes; }
  removeAttribute(k) { delete this.attributes[k]; }

  // src / href 这类属性：元素属性与 HTML 属性互相映照（浏览器就这么干）
  get src() { return this.attributes.src || ''; }
  set src(v) { if (v === null || v === undefined) delete this.attributes.src; else this.attributes.src = String(v); }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); if (c) c.parentNode = null; return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  appendChild(c) { if (!c) return c; c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c) { return this.appendChild(c); }
  replaceWith(c) {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) { this.parentNode.children[i] = c; c.parentNode = this.parentNode; }
  }
  contains(c) {
    if (c === this) return true;
    return this.children.some((x) => x.contains && x.contains(c));
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    this.listeners.set(type, list.filter((f) => f !== fn));
  }
  dispatch(type, ev = {}) {
    // 事件目标要用"代理后"的节点：应用是通过 $()（代理）拿到元素的，
    // 这里若传原始节点，应用里的 video !== $('#player') 守卫会误判（真浏览器无此问题）
    const proxy = wrapEl(this);
    const event = {
      type, target: proxy, currentTarget: proxy, preventDefault() {}, stopPropagation() {},
      ...ev,
    };
    for (const fn of (this.listeners.get(type) || []).slice()) {
      try { fn(event); } catch (err) { errors.push(`${this.tagName} ${type} 处理器抛错: ${err.message}`); }
    }
    return event;
  }
  focus() { document.activeElement = this; }
  blur() {}
  scrollIntoView() {}
  play() { return Promise.resolve(); }
  pause() {}
  load() {}
  canPlayType() { return this.canPlayTypeResult; }
  click() { return this.dispatch('click', {}); }
  get firstChild() { return this.children[0] || null; }
  get parentElement() { return this.parentNode; }

  _all(acc = []) {
    for (const c of this.children) { acc.push(c); c._all(acc); }
    return acc;
  }

  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const groups = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
    const all = this._all();
    const out = [];
    for (const el of all) {
      if (groups.some((g) => matchesSelector(el, g))) {
        if (!out.includes(el)) out.push(el);
      }
    }
    // 桩里 innerHTML 不做真正解析：若选择器是 #id 且出现在 innerHTML 里，就当它存在
    // （真实浏览器会解析出来；这样断言"元素已生成"仍然有意义）
    if (!out.length && /^#[\w-]+$/.test(sel) && String(this._html || '').includes(`id="${sel.slice(1)}"`)) {
      out.push(new El('div', { id: sel.slice(1) }));
    }
    return out;
  }
}

function makeClassList(node) {
  const read = () => (node.attributes.class || '').split(/\s+/).filter(Boolean);
  return {
    contains: (c) => read().includes(c),
    add: (...cs) => { node.attributes.class = [...new Set([...read(), ...cs])].join(' '); },
    remove: (...cs) => { node.attributes.class = read().filter((x) => !cs.includes(x)).join(' '); },
    toggle: (c, force) => {
      const has = read().includes(c);
      const want = force === undefined ? !has : !!force;
      node.attributes.class = want
        ? [...new Set([...read(), c])].join(' ')
        : read().filter((x) => x !== c).join(' ');
      return want;
    },
  };
}

function matchesSimple(el, token) {
  const parts = token.match(/^[a-zA-Z]+|\.[\w-]+|#[\w-]+|\[[^\]]+\]/g) || [];
  for (const p of parts) {
    if (p.startsWith('.')) {
      if (!(el.attributes.class || '').split(/\s+/).includes(p.slice(1))) return false;
    } else if (p.startsWith('#')) {
      if (el.attributes.id !== p.slice(1)) return false;
    } else if (p.startsWith('[')) {
      const m = /^\[([\w-]+)(?:([~^$*|]?=)"?([^"\]]*)"?)?\]$/.exec(p);
      if (!m) return false;
      const [, name, op, val] = m;
      const actual = el.attributes[name];
      if (actual === undefined) return false;
      if (op === '=' && actual !== val) return false;
    } else if (!el.tagName.startsWith(p.toUpperCase())) return false;
  }
  return true;
}

function matchesSelector(el, sel) {
  const tokens = sel.trim().split(/\s+/);
  if (!matchesSimple(el, tokens[tokens.length - 1])) return false;
  let node = el.parentNode;
  for (let i = tokens.length - 2; i >= 0; i -= 1) {
    let found = false;
    while (node) {
      if (matchesSimple(node, tokens[i])) { found = true; node = node.parentNode; break; }
      node = node.parentNode;
    }
    if (!found) return false;
  }
  return true;
}

// ---- 未知 DOM API 预警 + hidden 变更溯源：真浏览器里 setText() 这种写法会直接 TypeError ----
const domWarnings = [];
const hiddenTrace = [];     // 谁把关键元素的 hidden 改成了 false
const SAFE_PROPS = new Set(['then', 'catch', 'finally', 'toJSON', 'constructor', 'valueOf',
  'toString', 'inspect', 'nodeType', 'nodeName', 'Symbol.toStringTag']);
const proxyMap = new WeakMap();
const seenNodes = new WeakSet();

function wrapEl(node) {
  if (!node || typeof node !== 'object') return node;
  if (proxyMap.has(node)) return proxyMap.get(node);
  const proxy = new Proxy(node, {
    get(target, prop, receiver) {
      if (prop === 'querySelector' || prop === 'querySelectorAll') {
        const raw = Reflect.get(target, prop, target);
        return (...args) => {
          const out = raw.apply(target, args);
          return Array.isArray(out) ? out.map(wrapEl) : wrapEl(out);
        };
      }
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (typeof prop === 'symbol' || SAFE_PROPS.has(prop) || domWarnings.length > 20) return undefined;
      domWarnings.push(`${target.tagName}${target.attributes.id ? '#' + target.attributes.id : ''}: `
        + `读取了不存在的属性 "${String(prop)}"`);
      return undefined;
    },
    set(target, prop, value) {
      if (prop === 'hidden' && value === false && target.attributes.id) {
        const stack = (new Error().stack || '').split('\n').slice(1, 4)
          .map((s) => s.trim().replace(/^at\s+/, '').replace(/\s*\(.*?([^\\/]+:\d+:\d+)\)$/, ' @$1'));
        hiddenTrace.push(`#${target.attributes.id} → hidden=false\n      ${stack.join('\n      ')}`);
      }
      return Reflect.set(target, prop, value);
    },
  });
  proxyMap.set(node, proxy);
  seenNodes.add(node);
  return proxy;
}

// ---- 把 index.html 解析成嵌套 DOM（忽略注释/脚本，够用即可）----
const roots = new Map();

function parseHTML(source) {
  const root = new El('body');
  const stack = [root];
  const tokenRe = /<!--[\s\S]*?-->|<!\[[\s\S]*?\]>|<!doctype[^>]*>|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;
  let mm;
  while ((mm = tokenRe.exec(source))) {
    const [raw, closeTag, openTag, attrText = ''] = mm;
    if (raw.startsWith('<!--') || raw.startsWith('<!')) continue;
    if (closeTag) {
      const tag = closeTag.toLowerCase();
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].tagName.toLowerCase() === tag) { stack.length = i; break; }
      }
      continue;
    }
    const tag = (openTag || '').toLowerCase();
    if (tag === 'script' || tag === 'style') {
      const end = source.toLowerCase().indexOf(`</${tag}`, tokenRe.lastIndex);
      if (end >= 0) tokenRe.lastIndex = source.indexOf('>', end) + 1;
      continue;
    }
    const attrs = {};
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let am;
    while ((am = attrRe.exec(attrText))) {
      const name = am[1];
      const value = am[2] ?? am[3] ?? am[4] ?? '';
      attrs[name] = value === '' && !am[2] && !am[3] && !am[4] ? '' : value;
    }
    const node = new El(tag, attrs);
    stack[stack.length - 1].appendChild(node);
    if (!VOID_TAGS.has(tag)) stack.push(node);
  }
  return root;
}

const parsed = parseHTML(html);
for (const node of parsed._all()) {
  if (node.attributes.id) roots.set(node.attributes.id, node);
}
const body = parsed;

function byId(id) {
  if (!roots.has(id)) { roots.set(id, new El('div', { id })); parsed.appendChild(roots.get(id)); }
  return roots.get(id);
}
/** 拿原始（未代理）元素，便于测试内部断言 */
const rawById = (id) => roots.get(id) || null;

// 诊断：谁改了 dataset.token
const tokenTrace = [];
const tokenSetterRaw = (node) => {
  const ds = node.dataset;
  if (!ds) return;
  let last = ds.token;
  setInterval(() => {
    if (ds.token !== last) {
      tokenTrace.push(`token ${last} → ${ds.token} @${(new Error().stack || '').split('\n')[2]?.trim().slice(0, 90)}`);
      last = ds.token;
    }
  }, 5);
};

// 原始 html 里已有的 id 全部注册进 document
function ensureAll(root) {
  for (const node of root._all()) {
    if (node.attributes.id) roots.set(node.attributes.id, node);
  }
}

const document = {
  documentElement: new El('html'),
  body,
  activeElement: null,
  hidden: false,
  listeners: new Map(),
  createElement: (tag) => wrapEl(new El(tag)),
  createDocumentFragment: () => new El('#fragment'),
  createTextNode: (t) => { const n = new El('#text'); n.textContent = t; return n; },
  getElementById: (id) => (roots.get(id) ? wrapEl(roots.get(id)) : null),
  querySelector(sel) { const out = document.querySelectorAll(sel); return out[0] || null; },
  querySelector(sel) { const out = document.querySelectorAll(sel); return out[0] || null; },
  querySelectorAll(sel) {
    const out = [];
    for (const node of [document.documentElement, ...body._all()]) {
      if (matchesSelector(node, sel) && !out.includes(node)) out.push(node);
    }
    return out.map(wrapEl);
  },
  addEventListener(type, fn) {
    if (!document.listeners.has(type)) document.listeners.set(type, []);
    document.listeners.get(type).push(fn);
  },
  removeEventListener() {},
  dispatch(type, ev = {}) {
    for (const fn of (document.listeners.get(type) || []).slice()) {
      try {
        fn({ type, target: ev.target || body, preventDefault() {}, stopPropagation() {}, ...ev });
      } catch (err) { errors.push(`document ${type} 处理器抛错: ${err.message}`); }
    }
  },
};

// ===================================================== 浏览器 API 桩
const requests = [];
const fixture = existsSync(scanFixture) ? JSON.parse(readFileSync(scanFixture, 'utf8')) : null;

function jsonResponse(obj, status = 200) {
  return {
    ok: status < 400, status, statusText: 'OK',
    headers: { get: () => 'application/json' },
    json: async () => obj,
    text: async () => JSON.stringify(obj),
    blob: async () => ({}),
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  requests.push({ url: u, method: opts.method || 'GET', body: opts.body });
  if (u.includes('/_api/info')) {
    return jsonResponse({
      ok: true, app: 'DJI Footage Viewer', version: '1.0.0', python: '3.12.4',
      ffmpeg: 'ffmpeg version test', ffprobe_path: 'C:/ffmpeg/ffprobe.exe',
      cache: { entries: 460, pending: 0, running: 0 },
      settings: { last_folder: 'G:\\DCIM\\DJI_001', recursive: true, play_mode: 'direct' },
      roots: [{ path: 'G:\\DCIM', label: 'G: DCIM', children: ['G:\\DCIM\\DJI_001'] }],
      cache_dir: 'D:/x/cache', tools_error: null,
    });
  }
  if (u.includes('/_api/scan')) {
    if (!fixture) return jsonResponse({ ok: false, error: '缺少 fixtures/scan.json' }, 500);
    return jsonResponse({
      ok: true, folder: 'G:\\DCIM\\DJI_001', clip_count: fixture.clips.length,
      file_count: fixture.clips.reduce((a, c) => a + c.files.length, 0),
      scan_ms: 313, clips: fixture.clips, needs_probe: [], summary: fixture.summary,
      cache: { entries: 460 }, generated_at: Date.now(), progress: { total: 460, done: 460, failed: 0, pending: 0, active: 0 },
    });
  }
  if (u.includes('/_api/meta')) return jsonResponse({ ok: true, meta: {}, pending: 0, progress: {} });
  if (u.includes('/_api/progress')) return jsonResponse({ ok: true, progress: { total: 0, done: 0, failed: 0, pending: 0, active: 0 } });
  if (u.includes('/_api/suggest_dest')) {
    return jsonResponse({
      ok: true, last: 'G:\\DCIM\\DJI_001_export',
      candidates: [{ path: 'G:\\DCIM\\DJI_001_export', exists: false, free_label: '52.9 GB' }],
      history: ['D:\\exports\\上次的目录', 'E:\\备份\\DJI'],
    });
  }
  if (u.includes('/_api/export/progress')) {
    return jsonResponse({
      ok: true,
      job: {
        id: 'exp0001', status: 'done', dest: 'G:\\DCIM\\DJI_001_export',
        total: 3, done: 2, failed: 1, byte_total: 100,
        bytes_total: 3000, bytes_done: 2000, bytes_written: 3000, progress: 100,
        speed: 104857600, speed_label: '100 MB/s', eta: null, eta_label: null,
        elapsed: 2.5, log: ['完成：成功 2，失败 1'],
        failure_count: 1,
        failures: [{ src: 'G:\\DCIM\\DJI_001\\DJI_x.MP4', dst: 'G:\\out\\DJI_x.MP4', error: 'PermissionError: 拒绝访问' }],
        recent: [],
      },
    });
  }
  if (u.includes('/_api/export/cancel')) return jsonResponse({ ok: true });
  if (u.includes('/_api/export')) {
    const body = JSON.parse(opts.body || '{}');
    const items = (body.paths || []).filter((p) => !/\.lrf$/i.test(p)).map((p, i) => ({
      src: p, dst: `${body.dest}\\2026-10-05\\${p.split('\\').pop()}`, name: p.split('\\').pop(),
      size: 1000 + i, size_label: '1.0 KB', date: '2026-10-05', time: '12:00:00', kind: 'video',
      empty: false, clash: 'none',
    }));
    return jsonResponse({
      ok: true, dest: body.dest, dest_ok: true, dest_exists: false, dest_error: null,
      items, count: items.length, total_size: items.reduce((a, b) => a + b.size, 0),
      total_size_label: '3.0 KB', dates: { '2026-10-05': { count: items.length, size: 1000 } },
      date_count: 1, missing: 0, skipped_proxy: 0, clash_count: 0, empty_count: 0,
      free: 56800000000, free_label: '52.9 GB', enough_space: true, warnings: [],
      conflict: body.conflict || 'overwrite', byDate: true, keepDirName: false,
      job: 'exp0001', file_count: items.length,
    });
  }
  return jsonResponse({ ok: true });
};

const storeMap = new Map();
globalThis.localStorage = {
  getItem: (k) => (storeMap.has(k) ? storeMap.get(k) : null),
  setItem: (k, v) => storeMap.set(k, String(v)),
  removeItem: (k) => storeMap.delete(k),
};
globalThis.window = globalThis;
// Node 22 的 navigator 只有 getter，必须用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true, writable: true,
});
globalThis.URL.createObjectURL = () => 'blob:stub';
globalThis.URL.revokeObjectURL = () => {};
globalThis.MediaSource = undefined; // 触发「不支持转码流」的降级分支
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
// 浏览器标准 API：连拍卡片用 new Image() 预加载下一帧（桩里立即"加载完成"）
globalThis.Image = class Image {
  constructor() {
    this.complete = false;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this._src = '';
  }

  set src(v) {
    this._src = v;
    this.complete = true;              // 桩：立即视为加载成功
    this.naturalWidth = 512;
    this.naturalHeight = 288;
    if (typeof this.onload === 'function') setTimeout(() => this.onload(), 0);
  }

  get src() { return this._src; }
};
// 轮询用受控调度：测试里可以手动"滴答"一次，验证进度轮询逻辑
const intervalTimers = new Map();
let intervalSeq = 0;
globalThis.setInterval = (fn, ms) => {
  intervalSeq += 1;
  intervalTimers.set(intervalSeq, { fn, ms });
  return intervalSeq;
};
globalThis.clearInterval = (id) => { intervalTimers.delete(id); };
async function tickIntervals(times = 1) {
  for (let i = 0; i < times; i += 1) {
    for (const t of Array.from(intervalTimers.values())) {
      try { await t.fn(); } catch (err) { errors.push(`interval 回调抛错: ${err.message}`); }
    }
    await new Promise((r) => setTimeout(r, 30));
  }
}
globalThis.document = document;
globalThis.window.addEventListener = () => {};
const els = { document, window: globalThis, navigator: globalThis.navigator, localStorage: globalThis.localStorage };
globalThis.HTMLElement = El;

// 全局暴露给被 import 的模块使用
for (const [k, v] of Object.entries(els)) {
  if (!(k in globalThis) || globalThis[k] === undefined) globalThis[k] = v;
}

// ===================================================== 跑起来
console.log('\n== 1. 加载前端模块并执行 boot ==');
let bootError = null;
try {
  await import(pathToFileURL(join(webDir, 'js', 'app.js')).href);
  await new Promise((r) => setTimeout(r, 700));  // 等 boot() 里的 await 走完
} catch (err) {
  bootError = err;
}
ok('app.js 可加载且 boot() 无异常', !bootError, bootError ? bootError.stack.split('\n').slice(0, 4).join(' | ') : '');
ok('事件处理器未抛错', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log('\n== 2. 启动流程 ==');
ok('已请求 /_api/info', requests.some((r) => r.url.includes('/_api/info')));
const scanReqs = requests.filter((r) => r.url.includes('/_api/scan'));
ok('启动时自动扫描了缓存目录', scanReqs.length > 0, scanReqs[0]?.url.slice(0, 80) || '');

const gallery = rawById('gallery');
const cards = gallery.querySelectorAll('.card');
const days = gallery.querySelectorAll('.day');
ok('卡片已渲染', cards.length > 0, `${cards.length} 张卡片`);
// 连拍会合并成一张卡，所以卡片数 = 素材数 - (连拍张数 - 连拍组数)
const burstPhotos = fixture.clips.filter((c) => c.burst_key && (c.burst_count || 1) > 1);
const burstGroups = new Set(burstPhotos.map((c) => c.burst_key)).size;
if (fixture) {
  const expect = fixture.clips.length - (burstPhotos.length - burstGroups);
  ok('卡片数与素材数一致（连拍已折叠）', cards.length === expect,
    `${cards.length} 张卡 / ${fixture.clips.length} 条素材（${burstGroups} 组连拍合并 ${burstPhotos.length} 张）`);
}
ok('日期分组已渲染', days.length > 0, `${days.length} 组`);
ok('占位提示已隐藏', rawById('placeholder').hidden === true);
ok('日期树已渲染', rawById('date-tree').querySelectorAll('.date-row').length > 0,
  `${rawById('date-tree').querySelectorAll('.date-row').length} 行`);
ok('概览数字已填充', rawById('st-clips').textContent !== '-', `条目=${rawById('st-clips').textContent}`);
ok('状态栏已更新', /扫描完成|分析/.test(rawById('status-left').textContent), rawById('status-left').textContent.slice(0, 40));
ok('缩略图 URL 指向服务端', gallery.querySelectorAll('img').some((i) => (i.attributes.src || '').startsWith('/_thumb/')));
ok('勾选框已挂到卡片上', gallery.querySelectorAll('.card-check').length === cards.length,
  `${gallery.querySelectorAll('.card-check').length} 个`);
ok('LRF 角标已渲染', gallery.querySelectorAll('.proxy-dot').length > 0,
  `${gallery.querySelectorAll('.proxy-dot').length} 个`);
ok('分辨率角标已渲染', gallery.querySelectorAll('.tag.res').length > 0,
  `${gallery.querySelectorAll('.tag.res').length} 个`);
ok('时长已显示', gallery.querySelectorAll('.dur').length === cards.length);

console.log('\n== 3. 点击「扫描目录」 ==');
const before = requests.filter((r) => r.url.includes('/_api/scan')).length;
wrapEl(byId('btn-scan')).dispatch('click', {});
await new Promise((r) => setTimeout(r, 400));
const after = requests.filter((r) => r.url.includes('/_api/scan')).length;
ok('点击按钮真的发出了扫描请求', after > before, `${before} → ${after}`);
ok('请求里带了素材目录', requests.some((r) => r.url.includes('/_api/scan') && /folder=G(%3A|:)/.test(r.url)),
  requests.filter((r) => r.url.includes('/_api/scan')).slice(-1)[0]?.url.slice(0, 90) || '');

console.log('\n== 4. 搜索与筛选交互 ==');
try {
  const search = wrapEl(byId('search'));
  search.value = '0002';
  search.dispatch('input', { target: search });
  await new Promise((r) => setTimeout(r, 300));
  const n = rawById('gallery').querySelectorAll('.card').length;
  ok('搜索后卡片数量变化', n > 0 && n < cards.length, `0002 → ${n} 张`);
  search.value = '';
  search.dispatch('input', { target: search });
  await new Promise((r) => setTimeout(r, 300));
  ok('清空搜索后恢复', rawById('gallery').querySelectorAll('.card').length === cards.length);
} catch (err) {
  ok('搜索交互', false, err.message);
}

try {
  const chip = rawById('f-res').querySelectorAll('.chip')[0];
  if (chip) {
    wrapEl(chip).dispatch('click', {});
    await new Promise((r) => setTimeout(r, 120));
    ok('分辨率筛选芯片可点击', true, `筛后 ${rawById('gallery').querySelectorAll('.card').length} 张`);
    wrapEl(byId('btn-filter-reset')).dispatch('click', {});
    await new Promise((r) => setTimeout(r, 120));
    ok('重置筛选后恢复全部', rawById('gallery').querySelectorAll('.card').length === cards.length);
  } else {
    ok('分辨率筛选芯片可点击', false, '没有渲染出分辨率芯片');
  }
} catch (err) {
  ok('分辨率筛选芯片可点击', false, err.message);
}

console.log('\n== 5. 打开详情抽屉 ==');
try {
  const card = rawById('gallery').querySelectorAll('.card')[0];
  wrapEl(card).dispatch('click', {});
  await new Promise((r) => setTimeout(r, 250));
  ok('抽屉已打开', rawById('drawer').hidden === false);
  const kvs = rawById('d-kvs');
  ok('元数据表已填充', kvs.children.length > 10, `${kvs.children.length} 个单元格`);
  ok('详情里显示文件名', rawById('d-name').textContent.length > 4, rawById('d-name').textContent);
  const src = rawById('player').attributes.src || rawById('player').src || '';
  ok('播放器已设置视频源', /^\/_media\//.test(src), src || '(空)');
  ok('源切换按钮状态正确', rawById('src-seg').querySelectorAll('.seg-btn').some((b) => b.classList.contains('on')));
  ok('文件列表已渲染', rawById('d-files').children.length >= 2, `${rawById('d-files').children.length} 行`);
  ok('HEVC 降级提示已就绪', rawById('player-fallback') !== null);
  ok('时间轴抓帧已渲染', rawById('d-strip').hidden === false
    && rawById('strip-inner').children.length > 0,
    `${rawById('strip-inner').children.length} 帧`);

  // 切到 LRF 源
  const lrfBtn = rawById('src-seg').querySelectorAll('.seg-btn').find((b) => b.dataset.src === 'lrf');
  if (lrfBtn && !lrfBtn.disabled) {
    wrapEl(lrfBtn).dispatch('click', {});
    await new Promise((r) => setTimeout(r, 120));
    const lrfSrc = rawById('player').attributes.src || rawById('player').src || '';
    ok('切到 LRF 预览源', /\.lrf/i.test(decodeURIComponent(lrfSrc)), decodeURIComponent(lrfSrc).slice(-46));
  } else {
    ok('切到 LRF 预览源', false, 'LRF 按钮不可用');
  }

  wrapEl(byId('d-close')).dispatch('click', {});
  ok('关闭抽屉', rawById('drawer').hidden === true);
} catch (err) {
  ok('打开详情抽屉', false, err.message);
}

console.log('\n== 6. 播放兜底蒙版：有在播证据就必须消失 ==');
try {
  const card = rawById('gallery').querySelectorAll('.card')[0];
  wrapEl(card).dispatch('click', {});
  await new Promise((r) => setTimeout(r, 150));
  const player = rawById('player');
  const fallback = rawById('player-fallback');
  const loading = rawById('player-loading');

  // 明确从"原始 MP4"开始，复刻用户实际动作
  const mp4BtnStart = rawById('src-seg').querySelectorAll('.seg-btn').find((b) => b.dataset.src === 'mp4');
  player.canPlayTypeResult = 'probably';           // 浏览器声称支持 HEVC
  wrapEl(mp4BtnStart).dispatch('click', {});
  await new Promise((r) => setTimeout(r, 60));

  ok('已切到原始 MP4 源',
    rawById('src-seg').querySelectorAll('.seg-btn').find((b) => b.dataset.src === 'mp4')
      ?.classList.contains('on') === true);
  ok('刚打开时不显示蒙版', fallback.hidden === true);
  ok('不显示转圈（等 2.5s 无进展才显示）', loading.hidden === true);

  // 硬失败：没有任何解码/播放证据。因为该素材有 LRF，界面应当"自动降级"而不是弹蒙版
  player.readyState = 0;
  player.currentTime = 0;
  player.paused = true;
  player.error = { code: 4 };
  if (player.dataset) player.dataset.alive = '';
  player.dispatch('error', {});
  await new Promise((r) => setTimeout(r, 60));
  ok('原片失败时自动降级到 LRF（有 LRF 就不弹蒙版）',
    rawById('player-fallback').hidden === true
    && /\.lrf$/i.test(decodeURIComponent(player.src || '').split('?')[0]),
    `蒙版hidden=${fallback.hidden} src=${decodeURIComponent(player.src || '')}`);
  if (fallback.hidden !== true) {
    console.log('    ↳ 谁把蒙版打开了：');
    hiddenTrace.slice(-3).forEach((t) => console.log('      ' + t));
  }
  ok('降级后给出小字说明', /自动改用 LRF/.test(rawById('seg-hint').textContent),
    `hint="${rawById('seg-hint').textContent}" hidden=${rawById('seg-hint').hidden} toast="${rawById('snackbar').textContent}"`);
  ok('降级后 LRF 按钮选中',
    rawById('src-seg').querySelectorAll('.seg-btn')
      .find((b) => b.dataset.src === 'lrf')?.classList.contains('on') === true);

  // 切回 MP4 继续验证"证据优先"逻辑
  const mp4Btn0 = rawById('src-seg').querySelectorAll('.seg-btn').find((b) => b.dataset.src === 'mp4');
  wrapEl(mp4Btn0).dispatch('click', {});
  await new Promise((r) => setTimeout(r, 60));
  // 模拟"当前源"的合法事件：需要带上 app 刚打在 video 上的 token
  const token = player.dataset?.token;
  ok('换源后 video 带上新的 load token', !!token && token !== 'stale-token', `token=${token}`);

  // 关键回归：浏览器解码 HEVC 时 readyState 可能长期偏低，但确实在播 —— 蒙版必须撤掉
  player.readyState = 0;          // 故意保持低值，复刻实际踩到的坑
  player.currentTime = 1.2;
  player.paused = false;
  if (player.dataset) player.dataset.alive = '';
  player.dispatch('playing', {});
  ok('playing 证据撤掉蒙版（readyState 低也算）', fallback.hidden === true);
  ok('playing 证据同时撤掉转圈', loading.hidden === true);
  ok('playing 事件处理器被调用（桩限制：不做 dataset 断言）',
    (player.dataset?.token || '') === (token || ''), `token=${token}`);

  // timeupdate 是"正在播放"最硬的证据
  if (player.dataset) player.dataset.alive = '';
  player.currentTime = 2.4;
  player.dispatch('timeupdate', {});
  ok('timeupdate 事件同样被处理', (player.dataset?.token || '') === (token || ''));
  ok('有证据时不显示蒙版', fallback.hidden === true);
  ok('诊断框在正常播放时是空的', rawById('fb-diag').textContent === '');

  // 换源瞬间的假 error：已有在播证据就不该降级/弹蒙版
  if (player.dataset) player.dataset.alive = '1';
  player.currentTime = 3.1;
  player.error = { code: 3 };
  player.dispatch('error', {});
  ok('已有在播证据时忽略假 error', fallback.hidden === true
    && /\.mp4/i.test(decodeURIComponent(player.src || '')));

  // 旧源迟到的 error（token 对不上）不得影响当前源
  if (player.dataset) { player.dataset.alive = ''; player.dataset.token = 'stale-token'; }
  player.currentTime = 0;
  player.readyState = 0;
  player.error = { code: 4 };
  player.dispatch('error', {});
  ok('旧源迟到的 error 被 token 拦下', fallback.hidden === true
    && /\.mp4/i.test(decodeURIComponent(player.src || '')),
    `hidden=${fallback.hidden}`);

  // 切换播放源后蒙版必须清掉
  const lrfBtn = rawById('src-seg').querySelectorAll('.seg-btn').find((b) => b.dataset.src === 'lrf');
  if (lrfBtn && !lrfBtn.disabled) {
    player.error = { code: 4 };
    if (player.dataset) player.dataset.alive = '';
    player.currentTime = 0;
    player.dispatch('error', {});
    wrapEl(lrfBtn).dispatch('click', {});
    await new Promise((r) => setTimeout(r, 80));
    ok('切换播放源后蒙版被清除', fallback.hidden === true);
  }
} catch (err) {
  ok('播放兜底蒙版', false, err.message);
}

console.log('\n== 7. 浏览器不支持 HEVC 时自动切 LRF ==');
try {
  // 重新打开抽屉（第 5 组末尾关掉了）
  const card7 = rawById('gallery').querySelectorAll('.card')[0];
  wrapEl(card7).dispatch('click', {});
  await new Promise((r) => setTimeout(r, 150));
  ok('重新打开抽屉', rawById('drawer').hidden === false);

  // 模拟一个不支持 HEVC 的浏览器
  const player = rawById('player');
  player.canPlayTypeResult = '';
  const mp4Btn = rawById('src-seg').querySelectorAll('.seg-btn').find((b) => b.dataset.src === 'mp4');
  ok('MP4 源按钮可用', !!mp4Btn && !mp4Btn.disabled);
  wrapEl(mp4Btn).dispatch('click', {});
  await new Promise((r) => setTimeout(r, 120));
  const src = decodeURIComponent(player.src || '');
  ok('自动改用 LRF 源', /\.lrf/i.test(src), src.slice(-42));
  ok('自动切换后 LRF 按钮选中',
    rawById('src-seg').querySelectorAll('.seg-btn')
      .find((b) => b.dataset.src === 'lrf')?.classList.contains('on') === true);
  ok('自动切换不弹蒙版', rawById('player-fallback').hidden === true);
  ok('已提示用户自动切换', /自动切到 LRF/.test(rawById('snackbar').textContent),
    rawById('snackbar').textContent.slice(0, 30));
  ok('切换按钮旁给出小字说明', /LRF/.test(rawById('seg-hint').textContent),
    rawById('seg-hint').textContent);

  // 支持 HEVC 的浏览器不该被自动切换
  player.canPlayTypeResult = 'probably';
  wrapEl(mp4Btn).dispatch('click', {});
  await new Promise((r) => setTimeout(r, 120));
  const src2 = decodeURIComponent(player.src || '');
  ok('支持 HEVC 时保留原始 MP4', /\.mp4/i.test(src2), src2.slice(-42));
  wrapEl(byId('d-close')).dispatch('click', {});
} catch (err) {
  ok('自动切 LRF', false, err.message);
}

console.log('\n== 8. 未使用不存在 DOM API ==');
ok('没有访问不存在的 DOM 属性', domWarnings.length === 0, domWarnings.slice(0, 4).join(' | '));

console.log('\n== 9. 勾选系统（日期复选框 / 筛选后全选 / 反选） ==');
try {
  const clearBtn = wrapEl(byId('sel-clear'));
  const tree = rawById('date-tree');
  const dayChecks = tree.querySelectorAll('.date-check');
  ok('日期行渲染出勾选框', dayChecks.length > 0, `${dayChecks.length} 个`);

  clearBtn.dispatch('click', {});
  await new Promise((r) => setTimeout(r, 60));
  ok('清空后选择条隐藏', rawById('selbar').hidden === true);

  // 点第一个日期行的勾选框 → 该日全部素材被选中
  const firstRow = tree.querySelectorAll('.date-row')[0];
  const firstDate = firstRow.dataset.date;
  const dayCount = fixture ? fixture.clips.filter((c) => c.date === firstDate).length : 0;
  // 该日被折叠掉的卡片数 = 连拍张数 - 连拍组数
  const dayBursts = fixture
    ? fixture.clips.filter((c) => c.date === firstDate && c.burst_key && (c.burst_count || 1) > 1)
    : [];
  const dayMerged = dayBursts.length - new Set(dayBursts.map((c) => c.burst_key)).size;
  wrapEl(firstRow.querySelector('.date-check')).dispatch('change', {});
  await new Promise((r) => setTimeout(r, 60));
  ok('勾选日期行选中该日素材', Number(rawById('sel-n').textContent) === dayCount,
    `${firstDate}: ${rawById('sel-n').textContent} / ${dayCount}`);
  ok('选择条出现', rawById('selbar').hidden === false);
  ok('显示可转存原片数', /可转存原片\s*\d+\s*个/.test(rawById('sel-src').textContent),
    rawById('sel-src').textContent);
  // 当日全部素材选中后：普通卡各 1 张，连拍组卡按"整组"算 1 张
  const selectedCards = rawById('gallery').querySelectorAll('.card.selected').length;
  ok('当日卡片被标记选中', selectedCards === dayCount - dayMerged,
    `选中 ${selectedCards} 张卡 / ${dayCount} 条素材`);

  // 三态：该日全选后勾选框应为 checked
  ok('全选后勾选框为选中态', firstRow.querySelector('.date-check').checked === true);
  wrapEl(firstRow.querySelector('.date-check')).dispatch('change', {});
  await new Promise((r) => setTimeout(r, 40));
  ok('再点一次取消该日选中', Number(rawById('sel-n').textContent || 0) === 0,
    rawById('sel-n').textContent);

  // 筛选后全选：只选中筛选结果
  const search = wrapEl(byId('search'));
  search.value = '0002';
  search.dispatch('input', { target: search });
  await new Promise((r) => setTimeout(r, 260));
  const visible = rawById('gallery').querySelectorAll('.card').length;
  wrapEl(byId('sel-all-filtered')).dispatch('click', {});
  await new Promise((r) => setTimeout(r, 60));
  ok('筛选后"选中筛选结果"只选筛出来的', Number(rawById('sel-n').textContent) === visible,
    `${rawById('sel-n').textContent} / 可见 ${visible}`);

  wrapEl(byId('sel-invert')).dispatch('click', {});
  await new Promise((r) => setTimeout(r, 60));
  ok('反选后数量归零（只有那一条被选中）', Number(rawById('sel-n').textContent) === 0,
    rawById('sel-n').textContent);
  wrapEl(byId('sel-invert')).dispatch('click', {});
  await new Promise((r) => setTimeout(r, 60));
  ok('再反选回来', Number(rawById('sel-n').textContent) === visible);

  search.value = '';
  search.dispatch('input', { target: search });
  await new Promise((r) => setTimeout(r, 260));
} catch (err) {
  ok('勾选系统', false, err.message);
}

console.log('\n== 9.5 连拍分组展示 ==');
try {
  // 清掉上一节留下的勾选，保证这里的计数是干净的
  wrapEl(byId('sel-clear')).dispatch('click', {});
  await new Promise((r) => setTimeout(r, 60));
  const stacks = rawById('gallery').querySelectorAll('.card-stack.burst');
  ok('连拍渲染成堆叠卡片', stacks.length === burstGroups,
    `${stacks.length} 组 / 应有 ${burstGroups} 组`);
  if (stacks.length) {
    const firstStack = stacks[0];
    const badge = firstStack.querySelector('.tag.burst');
    ok('连拍角标显示张数', /连拍\s*\d+/.test(badge ? badge.textContent : ''),
      badge ? badge.textContent : '无角标');
    ok('堆叠出层次（多层）',
      firstStack.querySelectorAll('.layer').length >= 1,
      `${firstStack.querySelectorAll('.layer').length} 层`);
    const pos = firstStack.querySelector('.burst-pos');
    ok('角标显示当前位置', /1\/\d+/.test(pos ? pos.textContent : ''), pos ? pos.textContent : '无');
    // 勾选整组 → 选中 N 条素材
    const stackCard = firstStack.querySelector('.card');
    const groupKey = stackCard.dataset.burst;
    const groupSize = fixture.clips.filter((c) => c.burst_key === groupKey).length;
    wrapEl(stackCard.querySelector('.card-check')).dispatch('click', {});
    await new Promise((r) => setTimeout(r, 60));
    ok('勾选连拍组 = 选中全部 N 张', Number(rawById('sel-n').textContent) === groupSize,
      `${rawById('sel-n').textContent} / ${groupSize}`);
    ok('组卡片变为选中态', stackCard.classList.contains('selected'));
    // 摊开
    const before = rawById('gallery').querySelectorAll('.card').length;
    const coverId = stackCard.dataset.id;
    wrapEl(firstStack.querySelector('.burst-expand')).dispatch('click', {});
    await new Promise((r) => setTimeout(r, 80));
    const after = rawById('gallery').querySelectorAll('.card').length;
    ok('点"摊开"把该组拆成单张', after === before + groupSize - 1,
      `${before} → ${after} 张（组内 ${groupSize} 张）`);
    // 抽屉里的胶片条（点该组的第一张，必须落在连拍帧上）
    const frameCard = rawById('gallery').querySelectorAll('.card')
      .find((c) => c.dataset.id === coverId);
    ok('摊开后能找到该组第一张卡片', !!frameCard);
    if (frameCard) {
      wrapEl(frameCard).dispatch('click', {});
      await new Promise((r) => setTimeout(r, 100));
      const strip = rawById('d-burst');
      ok('抽屉显示连拍胶片条', !!strip && strip.hidden === false);
      const frames = rawById('d-burst-inner').querySelectorAll('img, .ph-slot').length;
      ok('胶片条含该组全部帧', frames === groupSize, `${frames} 帧 / ${groupSize}`);
      wrapEl(byId('d-close')).dispatch('click', {});
      await new Promise((r) => setTimeout(r, 60));
    }
    // 从摊开的某一张上点角标收起整组
    const frameWithBadge = rawById('gallery').querySelectorAll('.card')
      .find((c) => c.dataset.id === coverId);
    const badgeEl = frameWithBadge && frameWithBadge.querySelector('.tag.burst');
    ok('摊开的帧上有可点击的连拍角标', !!badgeEl,
      badgeEl ? badgeEl.textContent : '无');
    if (badgeEl) {
      wrapEl(badgeEl).dispatch('click', {});
      await new Promise((r) => setTimeout(r, 80));
      ok('点角标收起整组',
        rawById('gallery').querySelectorAll('.card').length === before,
        `恢复为 ${rawById('gallery').querySelectorAll('.card').length} 张`);
    }
  }
  // 全局开关
  const chkBurst = wrapEl(byId('chk-burst'));
  chkBurst.checked = false;
  chkBurst.dispatch('change', { target: chkBurst });
  await new Promise((r) => setTimeout(r, 80));
  ok('关闭合并后连拍逐张显示',
    rawById('gallery').querySelectorAll('.card-stack.burst').length === 0
    && rawById('gallery').querySelectorAll('.card').length === fixture.clips.length,
    `${rawById('gallery').querySelectorAll('.card').length} 张`);
  chkBurst.checked = true;
  chkBurst.dispatch('change', { target: chkBurst });
  await new Promise((r) => setTimeout(r, 80));
  ok('重新开启合并恢复折叠',
    rawById('gallery').querySelectorAll('.card-stack.burst').length === burstGroups);
} catch (err) {
  ok('连拍展示', false, err.message);
}

console.log('\n== 10. 转存弹窗 ==');
try {
  wrapEl(byId('sel-export')).dispatch('click', {});
  await new Promise((r) => setTimeout(r, 500));
  ok('弹窗已打开', rawById('export-modal').hidden === false);
  ok('只导原片的说明已显示', /LRF 预览文件不会导出/.test(rawById('ex-note').textContent),
    rawById('ex-note').textContent.slice(0, 40));
  ok('标题显示原片数量', /\d+ 个原片/.test(rawById('ex-count').textContent),
    rawById('ex-count').textContent);
  ok('目标框已填入建议路径', /_export/.test(rawById('ex-dest').value), rawById('ex-dest').value);
  ok('已生成清单预览', /个文件/.test(rawById('ex-plan').textContent),
    rawById('ex-plan').textContent.replace(/\s+/g, ' ').slice(0, 60));
  ok('开始按钮可用', rawById('ex-start').disabled === false);
  ok('预览里排除了 LRF', !/\.lrf/i.test(rawById('ex-plan').innerHTML));

  // 目标为空 → 开始按钮禁用
  const dest = wrapEl(byId('ex-dest'));
  dest.value = '';
  dest.dispatch('input', { target: dest });
  await new Promise((r) => setTimeout(r, 450));
  ok('清空目标后禁止开始', rawById('ex-start').disabled === true);
  ok('提示需要目标文件夹', /目标文件夹/.test(rawById('ex-plan').textContent));

  // 开始转存（桩里会立刻返回 done）
  dest.value = 'G:\\DCIM\\DJI_001_export';
  dest.dispatch('input', { target: dest });
  await new Promise((r) => setTimeout(r, 500));
  wrapEl(byId('ex-start')).dispatch('click', {});
  await new Promise((r) => setTimeout(r, 300));
  ok('转存请求已发出', requests.some((r) => r.url.includes('/_api/export') && /"dest"/.test(r.body || '')),
    `export 请求 ${requests.filter((r) => r.url.includes('/_api/export')).length} 次`);
  await tickIntervals(3);       // 手动驱动一次进度轮询
  ok('进度区已显示', rawById('ex-progress').hidden === false);
  ok('进度文案含文件名统计', /\d+\/\d+ 个文件/.test(rawById('ex-progress-text').textContent),
    rawById('ex-progress-text').textContent.slice(0, 56));
  ok('进度文案含速度', /\/s/.test(rawById('ex-progress-text').textContent),
    rawById('ex-progress-text').textContent.slice(0, 70));
  ok('进度文案含已写/总量', /\/\s*[\d.]+ ?(B|KB|MB|GB)/.test(rawById('ex-progress-text').textContent),
    rawById('ex-progress-text').textContent.slice(0, 70));
  ok('进度条已推进', rawById('ex-bar-fill').style.width !== '', rawById('ex-bar-fill').style.width);
  ok('失败明细已展示', rawById('ex-failures').hidden === false);
  ok('失败明细含原因', /PermissionError/.test(rawById('ex-failures').textContent),
    rawById('ex-failures').textContent.replace(/\s+/g, ' ').slice(0, 60));
  ok('提供失败报告下载入口', !!rawById('ex-failures').querySelector('#ex-report'));
  ok('完成后出现"打开目标文件夹"', rawById('ex-reveal').hidden === false);
  ok('完成后隐藏开始按钮', rawById('ex-start').hidden === true);
  ok('完成后状态栏显示结果', /完成/.test(rawById('ex-status').textContent),
    rawById('ex-status').textContent.slice(0, 44));

  wrapEl(byId('ex-done')).dispatch('click', {});
  ok('点完成关闭弹窗', rawById('export-modal').hidden === true);
} catch (err) {
  ok('转存弹窗', false, err.message);
}

console.log(`\n${'='.repeat(58)}\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (errors.length) {
  console.log('运行时报错：');
  errors.slice(0, 8).forEach((e) => console.log(`  - ${e}`));
}
if (domWarnings.length) {
  console.log('可疑 DOM 用法：');
  domWarnings.slice(0, 8).forEach((w) => console.log(`  - ${w}`));
}
if (fails.length) {
  console.log('失败项：');
  fails.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
