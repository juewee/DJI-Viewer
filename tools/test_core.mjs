// tools/test_core.mjs —— 用真实素材数据验证前端筛选/排序/分组逻辑
// 用法：node tools/test_core.mjs
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  FILTER_DEFAULT, cloneFilter, activeFilterCount, matches, selectClips, groupByDay, viewModel,
  sourceFiles, exportFileList, selectAllFiltered, invertSelection, setClipsSelected as selectClipsById,
  selectState, clipsOfDates, collapseBursts, itemClips, burstSelectState,
} from '../web/js/core.js';

const here = dirname(fileURLToPath(import.meta.url));
const scanFile = join(here, 'fixtures', 'scan.json');
const metaFile = join(here, 'fixtures', 'meta.json');

if (!existsSync(scanFile)) {
  console.error(`缺少测试数据 ${scanFile}\n请先运行：npm run fixtures（或 python tools/dump_fixtures.py）`);
  process.exit(2);
}

const scan = JSON.parse(readFileSync(scanFile, 'utf8'));
const extra = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : {};
const clips = scan.clips;

// 详情优先取实时探测结果，其次取扫描时命中的缓存
const details = new Map();
for (const c of clips) {
  const own = (c.files || []).map((f) => extra[f.path]).find(Boolean);
  details.set(c.id, own || c.detail || null);
}
const detailOf = (c) => details.get(c.id) || null;
const F = (over = {}) => ({ ...cloneFilter(FILTER_DEFAULT), ...over });
const count = (f, sort = 'time-desc') => selectClips(clips, f, sort, detailOf).length;
const countOf = (list, f, sort = 'time-desc') => selectClips(list, f, sort, detailOf).length;

let pass = 0;
const fails = [];
function ok(name, cond, info = '') {
  if (cond) { pass += 1; console.log(`  [PASS] ${name}${info ? '  ' + info : ''}`); }
  else { fails.push(name); console.log(`  [FAIL] ${name}${info ? '  ' + info : ''}`); }
}

console.log(`\n数据源：${scanFile}`);
console.log(`素材 ${clips.length} 条，含探测详情 ${clips.filter((c) => detailOf(c)?.ok).length} 条\n`);

console.log('== 基础 ==');
ok('素材数量 > 0', clips.length > 0, `${clips.length} 条`);
ok('全部条目都能解析出日期', clips.every((c) => c.date && c.date !== '未知日期'));
ok('MP4/LRF 配对', clips.filter((c) => c.has_video && c.has_proxy).length > 0,
  `${clips.filter((c) => c.has_video && c.has_proxy).length} 组`);
ok('默认筛选 = 全部', count(F()) === clips.length, `${count(F())} 条`);
ok('未筛选时 activeFilterCount = 0', activeFilterCount(F()) === 0);

console.log('\n== 分辨率筛选 ==');
const resCounts = new Map();
for (const c of clips) {
  const d = detailOf(c);
  if (d && d.ok) resCounts.set(d.resolution, (resCounts.get(d.resolution) || 0) + 1);
}
for (const [label, n] of resCounts) {
  const got = count(F({ res: new Set([label]) }));
  ok(`仅 ${label}`, got === n, `筛选 ${got} / 实际 ${n}`);
}
if (resCounts.size >= 2) {
  const two = [...resCounts.keys()].slice(0, 2);
  const expect = two.reduce((a, k) => a + resCounts.get(k), 0);
  ok('多选分辨率取并集', count(F({ res: new Set(two) })) === expect, `${two.join('+')} = ${expect}`);
  ok('分辨率筛选后结果都符合', selectClips(clips, F({ res: new Set(two) }), 'time-desc', detailOf)
    .every((c) => two.includes(detailOf(c).resolution)));
}

console.log('\n== 帧率 / 编码筛选 ==');
const fpsSet = new Set(clips.map((c) => detailOf(c)?.fps_label).filter(Boolean));
for (const fps of [...fpsSet].slice(0, 4)) {
  const expect = clips.filter((c) => detailOf(c)?.fps_label === fps).length;
  ok(`仅 ${fps}fps`, count(F({ fps: new Set([fps]) })) === expect, `${expect} 条`);
}
const codecSet = new Set(clips.map((c) => detailOf(c)?.codec_label).filter(Boolean));
for (const codec of codecSet) {
  const expect = clips.filter((c) => detailOf(c)?.codec_label === codec).length;
  ok(`仅 ${codec}`, count(F({ codec: new Set([codec]) })) === expect, `${expect} 条`);
}

console.log('\n== 日期筛选 ==');
// 如果这批素材只有一天（例如只拍了一天的卡），日期区间相关的断言改用构造的多日数据，
// 保证这部分逻辑始终有覆盖，而不是被跳过。
function withExtraDays(list, days = 2) {
  if (new Set(list.map((c) => c.date)).size >= 2) return list;
  const base = list[0];
  const out = list.slice();
  for (let d = 1; d <= days; d += 1) {
    const dt = new Date(`${base.date}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() - d);
    const date = dt.toISOString().slice(0, 10);
    for (const c of list.slice(0, Math.min(4, list.length))) {
      out.push({ ...c, id: `${c.id}#d${d}`, date, name: `${d}${c.name}`, path: `${c.path}#d${d}` });
    }
  }
  return out;
}
const multiDate = withExtraDays(clips);
const dates = [...new Set(multiDate.map((c) => c.date))].sort();
ok('日期按升序唯一', dates.length > 1, `${dates.length} 天${multiDate === clips ? '' : '（含构造日期）'}`);
for (const date of dates.slice(0, 3)) {
  const expect = multiDate.filter((c) => c.date === date).length;
  ok(`日期 ${date}`, countOf(multiDate, F({ dates: new Set([date]) })) === expect, `${expect} 条`);
}
{
  const from = dates[1];
  const expect = multiDate.filter((c) => c.date >= from).length;
  ok(`起始日期 >= ${from}`, countOf(multiDate, F({ dateFrom: from })) === expect, `${expect} 条`);
  const to = dates[dates.length - 2];
  const expect2 = multiDate.filter((c) => c.date <= to).length;
  ok(`结束日期 <= ${to}`, countOf(multiDate, F({ dateTo: to })) === expect2, `${expect2} 条`);
  const rangeExpect = multiDate.filter((c) => c.date >= from && c.date <= to).length;
  ok('日期区间', countOf(multiDate, F({ dateFrom: from, dateTo: to })) === rangeExpect, `${rangeExpect} 条`);
}
{
  const asc = selectClips(multiDate, F(), 'time-asc', detailOf).map((c) => `${c.date} ${c.time}`);
  const desc = selectClips(multiDate, F(), 'time-desc', detailOf).map((c) => `${c.date} ${c.time}`);
  ok('多日数据升序单调递增', asc.every((v, i) => i === 0 || asc[i - 1] <= v), `${asc.length} 条`);
  ok('多日数据降序单调递减', desc.every((v, i) => i === 0 || desc[i - 1] >= v), `${desc.length} 条`);
}

console.log('\n== 搜索 ==');
const sample = clips.find((c) => c.seq);
{
  const seqStr = String(sample.seq);
  const expect = clips.filter((c) => `${c.name} ${c.date} ${c.time} ${c.seq ?? ''} ${c.color || ''}`.toLowerCase().includes(seqStr)).length;
  ok(`按序号搜索 "${seqStr}"`, count(F({ text: seqStr })) === expect, `${expect} 条`);
  ok('按文件名片段搜索', count(F({ text: sample.name.slice(4, 12) })) > 0);
  ok('按日期搜索', count(F({ text: sample.date })) === clips.filter((c) => c.date === sample.date).length);
  ok('无意义搜索返回 0', count(F({ text: 'zzz_不存在的素材' })) === 0);
  ok('搜索大小写不敏感', count(F({ text: 'dji_' })) === count(F({ text: 'DJI_' })));
}

console.log('\n== 属性筛选 ==');
{
  const hdr = count(F({ attrs: new Set(['hdr']) }));
  const hdrReal = clips.filter((c) => detailOf(c)?.ok && detailOf(c).hdr).length;
  ok('HDR/10bit 筛选', hdr === hdrReal, `${hdr} 条`);
  const withProxy = count(F({ attrs: new Set(['hasProxy']) }));
  ok('有 LRF 筛选', withProxy === clips.filter((c) => c.has_proxy).length, `${withProxy} 条`);
  const noProxy = count(F({ attrs: new Set(['noProxy']) }));
  ok('无 LRF 筛选', noProxy === clips.filter((c) => !c.has_proxy).length, `${noProxy} 条`);
  ok('有 LRF + 无 LRF = 总数', withProxy + noProxy === clips.length);
  const audio = count(F({ attrs: new Set(['audio']) }));
  ok('含音频筛选', audio === clips.filter((c) => detailOf(c)?.ok && detailOf(c).has_audio).length, `${audio} 条`);
  const unprobed = count(F({ attrs: new Set(['unprobed']) }));
  ok('未分析筛选', unprobed === clips.filter((c) => !(detailOf(c)?.ok)).length, `${unprobed} 条`);
  const empty = count(F({ attrs: new Set(['empty']) }));
  ok('异常文件筛选', empty === clips.filter((c) => !c.size || (detailOf(c) && detailOf(c).ok === false)).length,
    `${empty} 条`);
}

console.log('\n== 类型筛选 ==');
{
  const photos = count(F({ types: new Set(['photo']) }));
  ok('照片数量', photos === clips.filter((c) => c.is_photo).length, `${photos} 张`);
  const proxyOnly = count(F({ types: new Set(['proxy']) }));
  ok('仅 LRF 条目', proxyOnly === clips.filter((c) => c.has_proxy && !c.has_video).length, `${proxyOnly} 条`);
  const videos = count(F({ types: new Set(['video']) }));
  ok('视频数量', videos === clips.filter((c) => !c.is_photo).length, `${videos} 条`);
}

console.log('\n== 时长达标 / 体积达标 ==');
{
  const n = count(F({ minDuration: 30 }));
  const real = clips.filter((c) => (detailOf(c)?.duration || 0) >= 30).length;
  ok('时长 >= 30s', n === real, `${n} 条`);
  const big = count(F({ minSize: 500 }));
  const realBig = clips.filter((c) => (c.size || 0) >= 500 * 1024 * 1024).length;
  ok('体积 >= 500MB', big === realBig, `${big} 条`);
}

console.log('\n== 快捷筛选 ==');
{
  const k4 = count(F({ quick: '4k' }));
  const real4k = clips.filter((c) => detailOf(c)?.ok && (detailOf(c).tier ?? 0) >= 3).length;
  ok('4K 及以上', k4 === real4k, `${k4} 条`);
  ok('8K', count(F({ quick: '8k' })) === clips.filter((c) => detailOf(c)?.ok && (detailOf(c).tier ?? 0) >= 5).length);
  const big = count(F({ quick: 'big' }));
  ok('体积 >= 500MB 快捷', big === clips.filter((c) => (c.size || 0) >= 500 * 1024 * 1024).length, `${big} 条`);
  const long = count(F({ quick: 'long' }));
  ok('时长 >= 1 分钟快捷', long === clips.filter((c) => (detailOf(c)?.duration || 0) >= 60).length, `${long} 条`);
}

console.log('\n== 组合筛选 ==');
{
  const f = F({ res: new Set(['4K']), attrs: new Set(['hasProxy']), minDuration: 5 });
  const res = selectClips(clips, f, 'time-desc', detailOf);
  ok('4K + 有 LRF + 时长>=5s', res.length > 0 && res.every((c) => {
    const d = detailOf(c);
    return d?.resolution === '4K' && c.has_proxy && (d.duration || 0) >= 5;
  }), `${res.length} 条`);
  const f2 = F({ dates: new Set([dates[0]]), codec: new Set(['H.265']) });
  const res2 = selectClips(clips, f2, 'time-desc', detailOf);
  ok('指定日期 + H.265', res2.every((c) => c.date === dates[0] && detailOf(c)?.codec_label === 'H.265'),
    `${res2.length} 条`);
}

console.log('\n== 排序 ==');
{
  const desc = selectClips(clips, F(), 'time-desc', detailOf);
  const asc = selectClips(clips, F(), 'time-asc', detailOf);
  // 注意：同一秒的多条（连拍照片、MP4+LRF 同源）时间戳完全相同，
  // 所以"两条序列互为倒序"不成立——真正该验证的是排序方向单调。
  ok('升序降序条数一致', desc.length === asc.length, `${asc.length} 条`);
  const timeDesc = desc.map((c) => `${c.date} ${c.time}`);
  ok('时间降序确实递减', timeDesc.every((v, i) => i === 0 || timeDesc[i - 1] >= v));
  const timeAsc = asc.map((c) => `${c.date} ${c.time}`);
  ok('时间升序确实递增', timeAsc.every((v, i) => i === 0 || timeAsc[i - 1] <= v));
  const sizeDesc = selectClips(clips, F(), 'size-desc', detailOf).map((c) => c.size);
  ok('体积降序', sizeDesc.every((v, i) => i === 0 || sizeDesc[i - 1] >= v));
  const sizeAsc = selectClips(clips, F(), 'size-asc', detailOf).map((c) => c.size);
  ok('体积升序', sizeAsc.every((v, i) => i === 0 || sizeAsc[i - 1] <= v));
  const durDesc = selectClips(clips, F(), 'dur-desc', detailOf).map((c) => detailOf(c)?.duration || 0);
  ok('时长降序', durDesc.every((v, i) => i === 0 || durDesc[i - 1] >= v));
  const nameAsc = selectClips(clips, F(), 'name-asc', detailOf).map((c) => c.name);
  ok('文件名升序', nameAsc.every((v, i) => i === 0 || nameAsc[i - 1].localeCompare(v) <= 0));
  ok('排序不丢条目', [desc, asc].every((arr) => arr.length === clips.length));
}

console.log('\n== 日期分组 ==');
{
  const list = selectClips(clips, F(), 'time-desc', detailOf);
  const days = groupByDay(list, 'time-desc', detailOf);
  ok('分组数 = 日期数', days.length === new Set(clips.map((c) => c.date)).size, `${days.length} 组`);
  ok('分组条目总数守恒', days.reduce((a, d) => a + d.items.length, 0) === clips.length);
  ok('分组按日期降序', days.every((d, i) => i === 0 || days[i - 1].date >= d.date));
  const ascDays = groupByDay(list, 'time-asc', detailOf);
  ok('升序分组', ascDays.every((d, i) => i === 0 || ascDays[i - 1].date <= d.date));
  const sumSize = days.reduce((a, d) => a + d.size, 0);
  ok('分组体积合计 = 总体积', sumSize === clips.reduce((a, c) => a + (c.size || 0), 0));
  ok('每组都有统计', days.every((d) => d.size > 0 && typeof d.duration === 'number'));
}

console.log('\n== viewModel 派生字段 ==');
{
  const probed = clips.filter((c) => detailOf(c)?.ok);
  const v = viewModel(probed[0], detailOf(probed[0]));
  ok('分辨率/帧率/编码齐全', Boolean(v.resolution && v.fps && v.codec), `${v.resolution} ${v.fps} ${v.codec}`);
  ok('宽高比已计算', /^\d+×\d+$/.test(v.aspect), v.aspect);
  const un = clips.find((c) => !detailOf(c)?.ok);
  if (un) {
    const uv = viewModel(un, detailOf(un));
    ok('未探测条目不误报', uv.probed === false || uv.resolution === '…' || !!uv.error);
  }
  const hdrClip = clips.find((c) => detailOf(c)?.hdr);
  if (hdrClip) ok('HDR 标记透传', viewModel(hdrClip, detailOf(hdrClip)).hdr === true);
}

console.log('\n== 转存文件收集（只取原片，排除 LRF） ==');
{
  const withProxy = clips.filter((c) => c.has_video && c.has_proxy);
  ok('存在成对素材用于测试', withProxy.length > 0, `${withProxy.length} 组`);

  const c0 = withProxy[0];
  const files0 = sourceFiles(c0);
  ok('成对素材只产出 1 个原片', files0.length === 1, files0.map((f) => f.split(/[\\/]/).pop()).join(', '));
  ok('产出的是 MP4 而非 LRF', /\.mp4$/i.test(files0[0]), files0[0].split(/[\\/]/).pop());
  ok('LRF 不出现在导出路径里', files0.every((f) => !/\.lrf$/i.test(f)));

  const photos = clips.filter((c) => c.is_photo);
  for (const ph of photos) {
    const f = sourceFiles(ph);
    ok(`照片条目 ${ph.name.slice(-12)} 取到图片`, f.length === 1 && /\.(jpe?g|dng|png)$/i.test(f[0]),
      f[0] ? f[0].split(/[\\/]/).pop() : '(空)');
  }

  const list = exportFileList(clips);
  ok('导出清单数量 = 视频数 + 照片数', list.count === clips.filter((c) => c.has_video).length + photos.length,
    `${list.count} 个文件 / 视频 ${clips.filter((c) => c.has_video).length} + 照片 ${photos.length}`);
  ok('清单里没有任何 LRF', list.files.every((f) => !/\.lrf$/i.test(f.path)));
  ok('清单体积 > 0 且等于汇总', list.bytes > 0 && list.bytes === list.files.reduce((a, f) => a + f.size, 0),
    `${(list.bytes / 1024 ** 3).toFixed(1)} GB`);
  ok('每个文件都有日期', list.files.every((f) => /^\d{4}-\d{2}-\d{2}$/.test(f.date)));
  const dup = new Set(list.files.map((f) => f.path.toLowerCase()));
  ok('清单无重复路径', dup.size === list.files.length);

  const orphan = clips.filter((c) => c.has_proxy && !c.has_video);
  if (orphan.length) {
    ok('仅 LRF 条目不产出导出文件', sourceFiles(orphan[0]).length === 0);
  }
  const subset = exportFileList(clips.slice(0, 5));
  ok('子集清单不超范围', subset.count <= 5, `${subset.count} 个`);
}

console.log('\n== 勾选逻辑 ==');
{
  const mkSelection = () => new Set();
  const some = clips.slice(0, 10);
  const sel1 = mkSelection();
  const r1 = selectAllFiltered(sel1, some);
  ok('全选筛选结果', r1.mode === 'added' && sel1.size === some.length, `${sel1.size} 条`);
  const r2 = selectAllFiltered(sel1, some);
  ok('再点一次取消全选', r2.mode === 'removed' && sel1.size === 0);

  const sel2 = new Set([some[0].id, some[1].id]);
  invertSelection(sel2, some);
  ok('反选：原来的取消、其余的选中',
    !sel2.has(some[0].id) && !sel2.has(some[1].id) && sel2.size === some.length - 2, `${sel2.size} 条`);

  const sel3 = new Set();
  ok('勾选态 none', selectState(sel3, some) === 'none');
  selectClipsById(sel3, some.slice(0, 3), true);
  ok('勾选态 partial', selectState(sel3, some.slice(0, 6)) === 'partial');
  selectClipsById(sel3, some, true);
  ok('勾选态 all', selectState(sel3, some) === 'all');
  selectClipsById(sel3, some, false);
  ok('批量取消', sel3.size === 0);
  ok('空集合勾选态为 none', selectState(sel3, []) === 'none');

  const d0 = dates[0];
  const dayClips = clips.filter((c) => c.date === d0);
  const sel4 = new Set();
  const picked = clipsOfDates(clips, [d0]);
  selectClipsById(sel4, picked, true);
  ok('按日期勾选', sel4.size === dayClips.length && picked.length === dayClips.length,
    `${d0} → ${sel4.size} 条`);
  const two = dates.slice(0, 2);
  const both = clipsOfDates(clips, two);
  ok('多日期勾选', both.length === clips.filter((c) => two.includes(c.date)).length, `${both.length} 条`);

  // 关键：勾选必须与筛选正交——先筛选再全选，只影响筛选结果
  const only4k = selectClips(clips, F({ res: new Set(['4K']) }), 'time-desc', detailOf);
  const sel5 = new Set();
  selectAllFiltered(sel5, only4k);
  ok('筛选后全选只选中筛选结果', sel5.size === only4k.length && only4k.every((c) => sel5.has(c.id)),
    `${sel5.size}/${clips.length} 条`);
  ok('未通过筛选的素材没被选中', clips.filter((c) => !sel5.has(c.id)).length === clips.length - only4k.length);
  ok('筛选结果里的原片数与导出一致',
    exportFileList(clips.filter((c) => sel5.has(c.id))).count === exportFileList(only4k).count);
}

// ---------------------------------------------------------------- 连拍折叠
function burstSuite() {
  const mk = (base, idx, n, over = {}) => ({
    id: `b:${base}:${idx}`,
    name: `${base}_${String(idx).padStart(3, '0')}.JPG`,
    path: `X:\\DCIM\\${base}_${String(idx).padStart(3, '0')}.JPG`,
    date: '2026-10-17', time: '14:41:48', size: 1000, is_photo: true,
    burst_key: `k:${base}`, burst_pos: idx, burst_count: n,
    burst_index: idx, burst_base: base, ...over,
  });
  const group = [1, 2, 3].map((i) => mk('DJI_20261017144148_0065_D', i, 3));
  const single = { ...mk('DJI_20261017150000_0070_D', 1, 1), burst_key: null, burst_count: 1 };
  const list = [group[0], single, group[1], group[2]];

  const merged = collapseBursts(list, { merge: true });
  ok('连拍合并成一张卡', merged.length === 2, `${merged.length} 个展示项（3 张连拍 + 1 张单拍）`);
  const burst = merged.find((it) => it.kind === 'burst');
  ok('组内包含全部帧', burst && burst.clips.length === 3, burst ? `${burst.clips.length} 张` : '未找到组');
  ok('封面是第一帧', burst && burst.cover.burst_pos === 1, burst ? `第 ${burst.cover.burst_pos} 张` : '');
  ok('组内按帧号排序',
    burst && burst.clips.map((c) => c.burst_pos).join(',') === '1,2,3',
    burst ? burst.clips.map((c) => c.burst_pos).join(',') : '');
  ok('单拍不受影响',
    merged.some((it) => it.kind === 'clip' && it.clip.id === single.id));
  ok('组卡片带合计体积', burst && burst.size === 3000, burst ? String(burst.size) : '');

  const flat = collapseBursts(list, { merge: false });
  ok('关闭合并后逐张展示', flat.length === 4 && flat.every((it) => it.kind === 'clip'), `${flat.length} 张`);

  const expanded = new Set([`k:DJI_20261017144148_0065_D`]);
  const opened = collapseBursts(list, { merge: true, expanded });
  ok('摊开后该组拆成单张', opened.length === 4, `${opened.length} 个展示项`);
  ok('摊开的单张带 inBurst 标记', opened.filter((it) => it.inBurst).length === 3);

  ok('itemClips 对单张返回 1 条', itemClips(flat[0]).length === 1);
  ok('itemClips 对组返回全部', itemClips(burst).length === 3);

  // 选择语义：选一组 = 选中全部帧
  const sel = new Set();
  for (const c of itemClips(burst)) sel.add(c.id);
  ok('选一组等于选中 N 张', sel.size === 3, `${sel.size} 条`);
  ok('整组选中时状态为 all', burstSelectState(sel, burst) === 'all');
  sel.delete(burst.clips[0].id);
  ok('少一张时为半选', burstSelectState(sel, burst) === 'partial');
  sel.clear();
  ok('都没选时为 none', burstSelectState(sel, burst) === 'none');

  // 用真实扫描数据校验（如果这批素材里有连拍）
  const realBursts = new Map();
  for (const c of clips) {
    if (c.burst_key) realBursts.set(c.burst_key, (realBursts.get(c.burst_key) || 0) + 1);
  }
  if (realBursts.size) {
    const realMerged = collapseBursts(clips, { merge: true });
    ok('真实数据的连拍也合并',
      realMerged.filter((it) => it.kind === 'burst').length === realBursts.size,
      `${realBursts.size} 组`);
    const sizes = [...realBursts.values()];
    ok('每组张数与后端一致',
      realMerged.filter((it) => it.kind === 'burst').every((it) => sizes.includes(it.clips.length)),
      `组大小 ${sizes.slice(0, 5).join(',')}`);
    const totalAfter = realMerged.reduce((n, it) => n + itemClips(it).length, 0);
    ok('折叠不丢素材', totalAfter === clips.length, `${totalAfter}/${clips.length}`);
  } else {
    ok('真实数据无连拍（用合成数据覆盖）', true, `${realBursts.size} 组`);
  }
}

burstSuite();

console.log(`\n${'='.repeat(58)}\n通过 ${pass} 项，失败 ${fails.length} 项`);if (fails.length) {
  console.log('失败项：');
  fails.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
