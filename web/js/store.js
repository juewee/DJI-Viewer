// store.js —— 应用状态；筛选/排序逻辑复用 core.js（纯函数，可被 Node 单测）
import {
  FILTER_DEFAULT, cloneFilter, activeFilterCount as countActive,
  matches as coreMatches, selectClips, groupByDay as coreGroupByDay, viewModel,
  sourceFiles, exportFileList,
  collapseBursts as coreCollapseBursts, itemClips, burstSelectState, isDLog,
} from './core.js';

export {
  FILTER_DEFAULT, cloneFilter, viewModel, sourceFiles, exportFileList,
  itemClips, burstSelectState, isDLog,
};

export const store = {
  folder: '',
  recursive: true,
  clips: [],
  meta: new Map(),        // clip.id -> detail
  summary: null,
  /** 待探测文件路径 -> clip.id */
  pendingPaths: new Map(),
  pendingIds: new Set(),
  /** 还没有缩略图的文件路径 -> clip.id（缩略图阶段边生成边贴图用） */
  thumbPending: new Map(),
  thumbReadyCount: 0,
  polling: false,
  sort: 'time-desc',
  filter: cloneFilter(FILTER_DEFAULT),
  selection: new Set(),
  /** 连拍折叠：true=每组一张卡；expandedBursts 里的是被单独摊开的组 */
  mergeBursts: true,
  expandedBursts: new Set(),
  /**
   * 参数分析时机：
   *   'on-open'  = 点开哪条分析哪条（默认，最省 CPU）
   *   'viewport' = 只分析当前屏幕里出现的
   *   'all'      = 扫描后全部分析（以前的默认，会短时间占满 CPU）
   */
  analysisMode: 'on-open',
  /** 色彩还原：用项目里的 .cube LUT（D-Log M → Rec.709）作用于缩略图与播放 */
  lutEnabled: false,
  /** 当前视口内的 clip.id（viewport 模式用） */
  visibleIds: new Set(),
  collapsedDays: new Set(),
  focusId: null,
  current: null,
  srcMode: 'mp4',
  autoLrf: false,
  serverInfo: null,
  clipSize: 264,
};

export function activeFilterCount() { return countActive(store.filter); }

export function detailOf(clip) {
  return store.meta.get(clip.id) || clip.detail || null;
}

export function vmOf(clip) {
  return viewModel(clip, detailOf(clip));
}

export function probedCount() {
  let n = 0;
  for (const clip of store.clips) if (detailOf(clip)?.ok) n += 1;
  return n;
}

export function matches(clip, f = store.filter) {
  return coreMatches(clip, f, detailOf(clip));
}

export function filteredClips() {
  return selectClips(store.clips, store.filter, store.sort, detailOf);
}

export function groupByDay(clips) {
  return coreGroupByDay(clips, store.sort, detailOf);
}

/** 当前筛选结果的展示项：连拍按需折叠 */
export function displayItems() {
  return coreCollapseBursts(filteredClips(), {
    merge: store.mergeBursts,
    expanded: store.expandedBursts,
  });
}

/** 动态聚合筛选项（只列出素材里真实存在的档位） */
export function facets() {
  const res = new Map();
  const fps = new Map();
  const codec = new Map();
  for (const clip of store.clips) {
    const d = detailOf(clip);
    if (!d || !d.ok) continue;
    bump(res, d.resolution);
    bump(fps, d.fps_label);
    bump(codec, d.codec_label);
  }
  const sortNum = (m) => Array.from(m.entries()).sort((a, b) => {
    const na = parseFloat(String(a[0])) || 0;
    const nb = parseFloat(String(b[0])) || 0;
    if (na !== nb) return nb - na;
    return String(a[0]).localeCompare(String(b[0]));
  });
  return {
    res: sortNum(res),
    fps: sortNum(fps),
    codec: Array.from(codec.entries()).sort((a, b) => b[1] - a[1]),
  };
}

function bump(map, key) {
  const k = key || '未知';
  map.set(k, (map.get(k) || 0) + 1);
}

export function selectedClips() {
  return store.clips.filter((c) => store.selection.has(c.id));
}

/** 当前选中项里真正要导出的原片（排除 LRF） */
export function selectedExportFiles() {
  return exportFileList(selectedClips());
}

/** 某批素材里可导出的原片数量（用于界面上提示"其中原片 N 个"） */
export function exportableCount(clips) {
  return exportFileList(clips).count;
}
