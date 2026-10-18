// core.js —— 纯逻辑（不碰 DOM / localStorage），既给浏览器用，也能被 Node 单测直接 import

/** 卡片展示用的字段（detail 可能还没探测出来） */
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
    aspect,
    profile: d ? d.profile : '',
    error: detail && detail.ok === false ? (detail.error || '无法解析') : '',
    probed: !!d,
  };
}

/** 导出/转存只取"原片"：MP4/MOV/JPG/DNG；LRF 是预览代理，不导出 */
export const SOURCE_EXT = /\.(mp4|mov|jpg|jpeg|dng|png)$/i;

/** 这条素材是不是 D-Log（需要色彩还原）——看文件名解析出的 color 字段 */
export function isDLog(clip) {
  return /d[\s-]?log/i.test(String((clip && clip.color) || ''));
}

export function sourceFiles(clip) {
  const out = [];
  for (const p of [clip.video_path, clip.photo_path]) {
    if (p && SOURCE_EXT.test(p)) out.push(p);
  }
  if (!out.length && clip.path && SOURCE_EXT.test(clip.path) && !clip.has_proxy) out.push(clip.path);
  return out;
}

/** 一批素材里真正会被导出的文件（去重后） */
export function exportFileList(clips) {
  const seen = new Set();
  const files = [];
  let bytes = 0;
  for (const clip of clips) {
    for (const p of sourceFiles(clip)) {
      const key = p.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const size = p === clip.video_path ? (clip.video_size ?? clip.size ?? 0)
        : p === clip.photo_path ? (clip.size || 0) : (clip.size || 0);
      files.push({ path: p, clipId: clip.id, date: clip.date, size });
      bytes += size;
    }
  }
  return { files, bytes, count: files.length };
}

export const FILTER_DEFAULT = {
  text: '',
  dates: new Set(),        // 选中的日期（空 = 全部）
  dateFrom: '',
  dateTo: '',
  res: new Set(),          // '4K' '8K' ...
  fps: new Set(),
  codec: new Set(),
  types: new Set(),        // video | photo | proxy
  attrs: new Set(),        // hdr | hasProxy | noProxy | audio | empty | unprobed
  minDuration: 0,          // 秒
  minSize: 0,              // MB
  quick: '',
};

export function cloneFilter(f) {
  return {
    ...f,
    dates: new Set(f.dates),
    res: new Set(f.res),
    fps: new Set(f.fps),
    codec: new Set(f.codec),
    types: new Set(f.types),
    attrs: new Set(f.attrs),
  };
}

export function activeFilterCount(f) {
  let n = 0;
  if (f.text) n += 1;
  n += f.dates.size + f.res.size + f.fps.size + f.codec.size + f.types.size + f.attrs.size;
  if (f.dateFrom || f.dateTo) n += 1;
  if (f.minDuration > 0) n += 1;
  if (f.minSize > 0) n += 1;
  if (f.quick) n += 1;
  return n;
}

export function matches(clip, f, detail) {
  const v = viewModel(clip, detail);

  if (f.text) {
    const q = f.text.trim().toLowerCase();
    if (q) {
      const hay = `${clip.name} ${clip.date} ${clip.time} ${clip.seq ?? ''} ${clip.color || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
  }
  if (f.dates.size && !f.dates.has(clip.date)) return false;
  if (f.dateFrom && clip.date < f.dateFrom) return false;
  if (f.dateTo && clip.date > f.dateTo) return false;
  if (f.res.size && !f.res.has(v.resolution)) return false;
  if (f.fps.size && !f.fps.has(v.fps || '未知')) return false;
  if (f.codec.size && !f.codec.has(v.codec || '未知')) return false;

  if (f.types.size) {
    const isLive = !!clip.is_live;
    const isPhoto = clip.is_photo && !isLive;
    const isProxyOnly = clip.has_proxy && !clip.has_video;
    // 实况照片单独一类：既不算视频也不算照片
    const isVideo = !clip.is_photo && !isLive;
    const ok = (f.types.has('photo') && isPhoto)
      || (f.types.has('video') && isVideo)
      || (f.types.has('live') && isLive)
      || (f.types.has('proxy') && isProxyOnly);
    if (!ok) return false;
  }
  if (f.attrs.has('hdr') && !v.hdr) return false;
  if (f.attrs.has('hasProxy') && !clip.has_proxy) return false;
  if (f.attrs.has('noProxy') && clip.has_proxy) return false;
  if (f.attrs.has('audio') && !(detail && detail.ok && detail.has_audio)) return false;
  if (f.attrs.has('empty') && !(!clip.size || v.error)) return false;
  if (f.attrs.has('unprobed') && v.probed) return false;

  if (f.minDuration > 0 && !(v.duration && v.duration >= f.minDuration)) return false;
  if (f.minSize > 0 && !(clip.size >= f.minSize * 1024 * 1024)) return false;

  if (f.quick) {
    switch (f.quick) {
      case '4k': if (!(v.probed && (detail.tier ?? 0) >= 3)) return false; break;
      case '8k': if (!(v.probed && (detail.tier ?? 0) >= 5)) return false; break;
      case '60': if (!(v.probed && v.fps && parseFloat(v.fps) >= 50)) return false; break;
      case 'long': if (!(v.probed && v.duration && v.duration >= 60)) return false; break;
      case 'big': if (!(clip.size >= 500 * 1024 * 1024)) return false; break;
      case 'today': {
        const t = new Date();
        const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
        if (clip.date !== today) return false;
        break;
      }
      default: break;
    }
  }
  return true;
}

export function sortKey(sort) {
  switch (sort) {
    case 'time-asc': return (c) => [c.date, c.time, c.seq ?? 0];
    case 'size-desc': return (c) => [c.size || 0];
    case 'size-asc': return (c) => [c.size || 0];
    case 'dur-desc': return (c) => 0; // 时长排序需要 detail，由 selectClips 注入
    case 'name-asc': return (c) => [c.name];
    default: return (c) => [c.date, c.time, c.seq ?? 0];
  }
}

/** 通用过滤 + 排序；detailOf 是 (clip) => detail|null 的取数函数 */
export function selectClips(clips, f, sort, detailOf) {
  const out = clips.filter((c) => matches(c, f, detailOf(c)));
  const key = sortKey(sort);
  const desc = sort === 'time-desc' || sort === 'size-desc' || sort === 'dur-desc';
  out.sort((a, b) => {
    if (sort === 'dur-desc') {
      const da = (detailOf(a)?.duration || 0);
      const db = (detailOf(b)?.duration || 0);
      if (da !== db) return db - da;
      return String(a.date).localeCompare(String(b.date));
    }
    const ka = key(a); const kb = key(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i += 1) {
      const x = ka[i]; const y = kb[i];
      if (x === y) continue;
      let cmp;
      if (typeof x === 'number' && typeof y === 'number') cmp = x - y;
      else cmp = String(x).localeCompare(String(y));
      // desc 时取反：让"降序"= 排序键自然序的反向
      return desc ? -cmp : cmp;
    }
    return 0;
  });
  return out;
}

export function groupByDay(clips, sort, detailOf) {
  const map = new Map();
  for (const c of clips) {
    if (!map.has(c.date)) map.set(c.date, []);
    map.get(c.date).push(c);
  }
  const days = Array.from(map.entries()).map(([date, items]) => ({
    date,
    items,
    size: items.reduce((s, c) => s + (c.size || 0), 0),
    duration: items.reduce((s, c) => s + (detailOf(c)?.duration || 0), 0),
  }));
  days.sort((a, b) => (sort === 'time-asc' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)));
  return days;
}

// ---------------------------------------------------------------- 连拍分组
/**
 * 把连拍照片折叠成"一组一张卡"。
 *
 * DJI 连拍/包围曝光是 `DJI_xxx_0065_D_001.JPG` … `_010.JPG`，后端已经标好
 * `burst_key` / `burst_count` / `burst_pos`。这里只做**展示层**折叠：
 * 数据仍是一条素材一个 clip（导出、勾选、统计都按真实文件算），
 * 折叠只影响卡片怎么画。
 *
 * @param {Array} clips 已筛选排序后的素材
 * @param {{merge?: boolean, expanded?: Set<string>}} opts
 * @returns {Array<{kind:'clip'|'burst', key:string, clip?:object, clips?:Array, cover?:object}>}
 */
export function collapseBursts(clips, { merge = true, expanded } = {}) {
  if (!merge) return clips.map((c) => ({ kind: 'clip', key: c.id, clip: c }));
  const out = [];
  const byKey = new Map();
  for (const c of clips) {
    const isBurst = c.burst_key && (c.burst_count || 1) > 1;
    if (!isBurst) { out.push({ kind: 'clip', key: c.id, clip: c }); continue; }
    if (expanded && expanded.has(c.burst_key)) {
      out.push({ kind: 'clip', key: c.id, clip: c, inBurst: true });
      continue;
    }
    let item = byKey.get(c.burst_key);
    if (!item) {
      item = { kind: 'burst', key: `burst:${c.burst_key}`, burstKey: c.burst_key, clips: [], cover: c };
      byKey.set(c.burst_key, item);
      out.push(item);
    }
    item.clips.push(c);
  }
  for (const item of out) {
    if (item.kind !== 'burst') continue;
    item.clips.sort((a, b) => (a.burst_pos || 0) - (b.burst_pos || 0));
    item.cover = item.clips[0];
    item.size = item.clips.reduce((s, c) => s + (c.size || 0), 0);
  }
  return out;
}

/** 一个展示项对应的真实素材列表（单张 = 1 条，连拍组 = N 条） */
export function itemClips(item) {
  return item.kind === 'burst' ? item.clips : [item.clip];
}

/** 连拍组内是否全部已勾选等状态 */
export function burstSelectState(selection, item) {
  return selectState(selection, itemClips(item));
}

// ---------------------------------------------------------------- 选择逻辑
/** 全选/取消：只作用于"通过筛选"的素材（直接改传进来的 selection 集合） */
export function selectAllFiltered(selection, clips) {
  if (!clips.length) return { count: 0, mode: 'none' };
  const all = clips.every((c) => selection.has(c.id));
  for (const c of clips) {
    if (all) selection.delete(c.id);
    else selection.add(c.id);
  }
  return { count: clips.length, mode: all ? 'removed' : 'added' };
}

export function invertSelection(selection, clips) {
  for (const c of clips) {
    if (selection.has(c.id)) selection.delete(c.id);
    else selection.add(c.id);
  }
  return clips.length;
}

/** 选中某批素材（on=true 选中，false 取消）——注意别和上面的 selectClips 排序函数混淆 */
export function setClipsSelected(selection, clips, on) {
  for (const c of clips) {
    if (on) selection.add(c.id);
    else selection.delete(c.id);
  }
  return clips.length;
}

/** 某个集合的勾选态：all | partial | none */
export function selectState(selection, clips) {
  if (!clips.length) return 'none';
  let on = 0;
  for (const c of clips) if (selection.has(c.id)) on += 1;
  if (on === 0) return 'none';
  return on === clips.length ? 'all' : 'partial';
}

/** 选中若干日期（在给定素材集合内的部分） */
export function clipsOfDates(clips, dates) {
  const set = new Set(dates);
  return clips.filter((c) => set.has(c.date));
}
