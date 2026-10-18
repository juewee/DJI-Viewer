// exporter.js —— 转存（导出）原始素材：目标文件夹选择、清单预览、实时进度
import { api, normPath } from './api.js';
import { $, el, fmtSize, toast, debounce } from './utils.js';
import { store, selectedClips, exportFileList, sourceFiles } from './store.js';

let pollTimer = null;
let currentJob = null;
let lastPlan = null;

// ------------------------------------------------------------ 素材收集
export function exportSelection() {
  const clips = selectedClips();
  const list = exportFileList(clips);
  return { clips, ...list };
}

// ------------------------------------------------------------ 打开弹窗
export async function openExport() {
  const { clips, files, bytes, count } = exportSelection();
  if (!clips.length) { toast('请先勾选要转存的素材', 'err'); return; }
  if (!count) {
    toast('选中的条目没有原始素材可导出（只有 LRF 预览文件）', 'err');
    return;
  }

  const modal = $('#export-modal');
  modal.hidden = false;
  resetProgress();
  $('#ex-count').textContent = `${files.length} 个原片 · ${fmtSize(bytes)}`;
  $('#ex-note').innerHTML = `将转存 <b>${files.length}</b> 个原始文件（MP4 / 照片），`
    + `合计 <b>${fmtSize(bytes)}</b>；<b>LRF 预览文件不会导出</b>（你勾了 ${clips.length} 条素材）。`;

  // 默认目标：优先上次用过的，其次源目录同级的 *_export
  const destInput = $('#ex-dest');
  let suggested = store.serverInfo?.settings?.last_export_dest || '';
  try {
    const sug = await api.suggestDest(store.folder);
    renderCandidates(sug.candidates || [], sug.history || [], sug.last || '');
    if (!suggested) suggested = sug.last || (sug.candidates?.[0]?.path) || '';
  } catch (err) {
    renderCandidates([], [], '');
  }
  if (suggested) destInput.value = suggested;
  destInput.focus();
  $('#ex-browser').hidden = true;
  $('#ex-done').hidden = true;
  $('#ex-reveal').hidden = true;
  $('#ex-stop').hidden = true;
  $('#ex-start').hidden = false;
  await refreshPlan();
}

export function closeExport() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (currentJob) return;              // 正在转存时不要误关
  $('#export-modal').hidden = true;
  $('#ex-browser').hidden = true;
}

function renderCandidates(cands, history, last) {
  const box = $('#ex-cands');
  box.innerHTML = '';
  const items = cands.slice();
  for (const h of history || []) {
    if (!items.some((c) => c.path === h)) items.unshift({ path: h, exists: true, free_label: '', recent: true });
  }
  if (last && !items.some((c) => c.path === last)) {
    items.unshift({ path: last, exists: true, free_label: '', recent: true });
  }
  for (const c of items) {
    box.appendChild(el('button', {
      class: 'chip mini', title: c.path,
      text: `${c.recent ? '↺ ' : ''}${c.path}${c.free_label ? ` · 可用 ${c.free_label}` : ''}`,
      onclick: () => { $('#ex-dest').value = c.path; refreshPlan(); },
    }));
  }
}

// ------------------------------------------------------------ 计划预览
const refreshPlan = debounce(async () => {
  const { files } = exportSelection();
  const dest = $('#ex-dest').value.trim();
  const box = $('#ex-plan');
  if (!dest) {
    box.innerHTML = '<span class="dim">填写目标文件夹后自动预览清单</span>';
    $('#ex-start').disabled = true;
    $('#ex-status').textContent = '';
    return;
  }
  box.innerHTML = '<span class="dim">正在生成预览…</span>';
  const opts = readOpts();
  try {
    const plan = await api.exportPlan(files.map((f) => f.path), dest, opts);
    if (!plan.ok) throw new Error(plan.error || '预览失败');
    lastPlan = plan;
    renderPlan(plan);
  } catch (err) {
    box.innerHTML = `<span class="err-text">预览失败：${err.message}</span>`;
    $('#ex-start').disabled = true;
  }
}, 350);

function readOpts() {
  return {
    byDate: $('#ex-by-date').checked,
    keepDirName: $('#ex-keep-dir').checked,
    manifest: $('#ex-manifest').checked,
    conflict: $('#ex-conflict').value,
    lut: !!($('#ex-lut') && $('#ex-lut').checked),
  };
}

function renderPlan(plan) {
  const box = $('#ex-plan');
  const dates = Object.entries(plan.dates || {}).sort((a, b) => a[0].localeCompare(b[0]));
  const rows = dates.slice(0, 8).map(([d, v]) => `${d} · ${v.count} 个`).join('　');
  const more = dates.length > 8 ? ` …共 ${dates.length} 天` : '';
  const sample = (plan.items || []).slice(0, 3)
    .map((it) => normPath(it.dst)).join('<br>');

  const warn = [];
  if (!plan.dest_ok) warn.push(`<span class="err-text">目标不可用：${plan.dest_error}</span>`);
  else if (!plan.dest_exists) warn.push('<span class="warn-text">目标文件夹不存在，导出时自动创建</span>');
  if (plan.enough_space === false) {
    warn.push(`<span class="err-text">磁盘空间可能不足：需要 ${plan.total_size_label}，可用 ${plan.free_label}</span>`);
  }
  if (plan.missing) warn.push(`<span class="err-text">${plan.missing} 个源文件不存在，将被跳过</span>`);
  if (plan.clash_count) {
    warn.push(`<span class="warn-text">${plan.clash_count} 个目标文件已存在（按"${conflictLabel(plan.conflict)}"处理）</span>`);
  }
  if (plan.empty_count) warn.push(`<span class="warn-text">${plan.empty_count} 个源文件是 0 字节</span>`);
  if (plan.skipped_proxy) warn.push(`<span class="dim">已忽略 ${plan.skipped_proxy} 个 LRF 预览文件</span>`);

  box.innerHTML = `
    <div class="ex-plan-line"><b>${plan.count}</b> 个文件 · <b>${plan.total_size_label}</b>
      · ${plan.date_count} 个日期 · 目标可用 ${plan.free_label || '未知'}</div>
    <div class="dim ex-plan-dates">${rows}${more}</div>
    <div class="dim ex-plan-sample mono">${sample}${plan.count > 3 ? '<br>…' : ''}</div>
    ${warn.map((w) => `<div class="ex-plan-warn">${w}</div>`).join('')}
  `;
  $('#ex-start').disabled = !plan.count || !plan.dest_ok || plan.enough_space === false;
  $('#ex-status').textContent = plan.count ? `${plan.count} 个文件待转存` : '没有可导出的文件';
}

function conflictLabel(mode) {
  return { overwrite: '覆盖', skip: '跳过', rename: '自动改名' }[mode] || mode;
}

// ------------------------------------------------------------ 目录浏览
async function browse(path) {
  const box = $('#ex-br-list');
  box.innerHTML = '<span class="dim">读取中…</span>';
  try {
    const res = await api.browse(path);
    if (!res.ok) throw new Error(res.error || '无法读取');
    $('#ex-br-path').textContent = normPath(res.path);
    $('#ex-br-path').title = res.path;
    $('#ex-browser').dataset.path = res.path;
    $('#ex-br-info').textContent = `${res.dir_count} 个子文件夹 · 可用 ${res.free_label || '?'}`
      + (res.writable ? '' : ' · 只读');
    const roots = $('#ex-br-roots');
    roots.innerHTML = '';
    for (const r of res.roots || []) {
      roots.appendChild(el('button', { class: 'chip mini', text: r.name, onclick: () => browse(r.path) }));
    }
    if (res.parent && res.parent !== res.path) {
      roots.appendChild(el('button', {
        class: 'chip mini', text: '↑ 上一层', onclick: () => browse(res.parent),
      }));
    }
    box.innerHTML = '';
    if (!res.dirs.length) {
      box.appendChild(el('div', { class: 'empty-hint', text: '（没有子文件夹，可直接"用这个文件夹"' }));
    }
    for (const d of res.dirs) {
      const row = el('button', { class: 'ex-br-item', onclick: () => browse(d.path) });
      row.appendChild(el('span', { class: 'ex-br-ico', text: '📁' }));
      row.appendChild(el('span', { class: 'ex-br-name', text: d.name }));
      box.appendChild(row);
    }
    $('#ex-up').disabled = !res.parent;
  } catch (err) {
    box.innerHTML = `<span class="err-text">${err.message}</span>`;
  }
}

// ------------------------------------------------------------ 执行
async function startExport() {
  const { files } = exportSelection();
  const dest = $('#ex-dest').value.trim();
  if (!dest) { toast('请先选择目标文件夹', 'err'); return; }
  const opts = readOpts();
  try {
    const res = await api.exportStart(files.map((f) => f.path), dest, opts);
    if (!res.ok) throw new Error(res.error || '启动失败');
    currentJob = res.job;
    store.serverInfo = store.serverInfo || {};
    store.serverInfo.settings = { ...(store.serverInfo.settings || {}), last_export_dest: res.dest };
    $('#ex-start').hidden = true;
    $('#ex-stop').hidden = false;
    $('#ex-preview').disabled = true;
    $('#ex-status').textContent = `正在转存到 ${normPath(res.dest)}`;
    startPolling();
  } catch (err) {
    toast(`转存失败：${err.message}`, 'err');
  }
}

function resetProgress() {
  $('#ex-progress').hidden = true;
  $('#ex-bar-fill').style.width = '0%';
  $('#ex-progress-text').textContent = '';
  $('#ex-log').textContent = '';
  const failBox = $('#ex-failures');
  if (failBox) { failBox.hidden = true; failBox.innerHTML = ''; }
  $('#ex-preview').disabled = false;
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  $('#ex-progress').hidden = false;
  pollTimer = setInterval(async () => {
    if (!currentJob) return;
    try {
      const res = await api.exportProgress(currentJob);
      if (!res.ok) throw new Error(res.error || '查询失败');
      renderProgress(res.job);
      if (['done', 'cancelled', 'error'].includes(res.job.status)) {
        clearInterval(pollTimer);
        pollTimer = null;
        finish(res.job);
      }
    } catch (err) {
      clearInterval(pollTimer);
      pollTimer = null;
      toast(`进度查询失败：${err.message}`, 'err');
    }
  }, 600);
}

function renderProgress(job) {
  // 百分比以服务端为准：色彩还原导出是重新编码，输出体积和源文件对不上，
  // 前端自己按字节算会永远停在 30~40%
  const pct = Number.isFinite(job.progress) ? job.progress
    : (job.bytes_total
      ? Math.min(100, ((job.bytes_written ?? job.bytes_done) / job.bytes_total) * 100)
      : (job.total ? (job.done / job.total) * 100 : 0));
  $('#ex-bar-fill').style.width = `${pct.toFixed(1)}%`;
  const written = job.bytes_written ?? job.bytes_done;
  const bits = [`${job.done}/${job.total} 个文件`];
  if (job.mode === 'transcode') {
    bits.push(`已写出 ${fmtSize(written)}`);
  } else {
    bits.push(`${fmtSize(written)} / ${fmtSize(job.bytes_total)}`);
  }
  bits.push(`${pct.toFixed(1)}%`);
  if (job.speed_label && job.speed_label !== '-') bits.push(job.speed_label);
  if (job.status === 'running' && job.eta_label) bits.push(`剩余约 ${job.eta_label}`);
  bits.push(`已用时 ${job.elapsed}s`);
  if (job.failed) bits.push(`失败 ${job.failed}`);
  if (job.current) bits.push(`当前 ${job.current}`);
  $('#ex-progress-text').textContent = bits.join(' · ');

  // 失败明细：只显示最近几条，完整清单可下载
  const failBox = $('#ex-failures');
  const fails = job.failures || [];
  if (failBox) {
    failBox.hidden = !fails.length;
    if (fails.length) {
      failBox.innerHTML = `<div class="ex-fail-head">失败 ${job.failure_count || fails.length} 个文件
        <button class="link-btn" id="ex-report">下载失败明细 CSV</button></div>`
        + fails.slice(0, 5).map((f) => `<div class="ex-fail-row mono" title="${esc(f.src)}">${esc(baseName(f.src))}
            <span class="err-text">${esc(f.error)}</span></div>`).join('')
        + (fails.length > 5 ? `<div class="dim">…还有 ${fails.length - 5} 个</div>` : '');
      const btn = $('#ex-report');
      if (btn) btn.addEventListener('click', () => downloadReport(job.id));
    }
  }

  const log = $('#ex-log');
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
  log.textContent = (job.log || []).slice(-12).join('\n');
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function baseName(p) {
  const s = String(p || '');
  return s.split(/[\\/]/).pop() || s;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function downloadReport(jobId) {
  const a = document.createElement('a');
  a.href = `/_api/export/report?job=${encodeURIComponent(jobId)}`;
  a.download = `dji_export_failures_${jobId}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function finish(job) {
  currentJob = null;
  $('#ex-stop').hidden = true;
  $('#ex-preview').disabled = false;
  renderProgress(job);          // 让进度条走到实际值（100% / 取消时的真实进度）
  if (job.status === 'done') {
    toast(`转存完成：${job.done} 个文件${job.failed ? `，失败 ${job.failed}` : ''}`);
  } else if (job.status === 'cancelled') {
    toast(`已停止：成功 ${job.done} 个${job.failed ? `，失败 ${job.failed}` : ''}`);
  } else {
    toast(`转存出错：${job.error || '未知错误'}`, 'err');
  }
  const fails = job.failures || [];
  $('#ex-status').textContent = `${job.done}/${job.total} 完成`
    + `${job.failed ? ` · ${job.failed} 失败` : ''}`
    + ` · ${fmtSize(job.bytes_written ?? job.bytes_done)} · ${normPath(job.dest)}`;
  const failBox = $('#ex-failures');
  if (failBox && fails.length) {
    failBox.hidden = false;
    failBox.innerHTML = `<div class="ex-fail-head">失败 ${job.failure_count || fails.length} 个文件
      <button class="link-btn" id="ex-report">下载失败明细 CSV</button></div>`
      + fails.slice(0, 6).map((f) => `<div class="ex-fail-row mono" title="${esc(f.src)}">${esc(baseName(f.src))}
          <span class="err-text">${esc(f.error)}</span></div>`).join('');
    const btn = $('#ex-report');
    if (btn) btn.addEventListener('click', () => downloadReport(job.id));
  }
  $('#ex-reveal').hidden = false;
  $('#ex-done').hidden = false;
  $('#ex-start').hidden = true;
}

// ------------------------------------------------------------ 初始化
export function initExporter() {
  $('#ex-close').addEventListener('click', closeExport);
  $('#ex-done').addEventListener('click', () => { $('#export-modal').hidden = true; });
  $('#ex-dest').addEventListener('input', refreshPlan);
  $('#ex-dest').addEventListener('keydown', (e) => { if (e.key === 'Enter') refreshPlan(); });
  ['#ex-by-date', '#ex-keep-dir', '#ex-conflict', '#ex-manifest', '#ex-lut'].forEach((sel) => {
    $(sel).addEventListener('change', refreshPlan);
  });
  $('#ex-preview').addEventListener('click', refreshPlan);
  $('#ex-start').addEventListener('click', startExport);
  $('#ex-stop').addEventListener('click', async () => {
    if (!currentJob) return;
    try { await api.exportCancel(currentJob); toast('已请求停止…'); }
    catch (err) { toast(err.message, 'err'); }
  });
  $('#ex-reveal').addEventListener('click', async () => {
    const dest = lastPlan?.dest || $('#ex-dest').value.trim();
    try { await api.open(dest); } catch (err) { toast(err.message, 'err'); }
  });
  $('#ex-browse').addEventListener('click', () => {
    const box = $('#ex-browser');
    box.hidden = !box.hidden;
    if (!box.hidden) browse($('#ex-dest').value.trim() || store.folder || '');
  });
  $('#ex-br-use').addEventListener('click', () => {
    const p = $('#ex-browser').dataset.path;
    if (p) { $('#ex-dest').value = p; $('#ex-browser').hidden = true; refreshPlan(); }
  });
  $('#ex-up').addEventListener('click', () => {
    const p = $('#ex-browser').dataset.path;
    if (p) browse(p.replace(/[\\/][^\\/]+[\\/]?$/, '') || p);
  });
  // 点击遮罩空白处关闭（转存中不关）
  $('#export-modal').addEventListener('click', (e) => {
    if (e.target.id === 'export-modal') closeExport();
  });
}

export function exportBusy() { return !!currentJob; }
