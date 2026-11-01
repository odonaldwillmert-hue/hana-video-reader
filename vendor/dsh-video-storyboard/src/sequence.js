/** Bounded temporal inspection, not automatic action recognition.
 * Each sample occupies its own full-sized cell; no nested micro-grids.
 *
 * 移植自 0.4.0-action.1（本仓库同一分支的旧补丁），代码逻辑未改，只补了这行出处。
 * 它回答的是"这段时间里画面的先后"，不回答"动作是什么"：
 * 等时槽仍可能漏掉两帧之间的短促动作，没看到不等于没发生。
 */
export const SEQUENCE_MAX_SECONDS = 12;
export const SEQUENCE_DEFAULT_CELLS = 9;
/** 取帧并发上限：九路 ffmpeg 同时 seek 会把机械盘打到超时，
 * 而这个模式的承诺是"解不出帧就报错"，不能把超时混进来。 */
export const SEQUENCE_FRAME_CONCURRENCY = 3;

export function validateSequenceOptions({ input, pick, cells, sheets, from = 0, to, sequencePhase = 0.5 } = {}) {
  if (pick !== 'sequence') return [];
  const errors = [];
  if (sequencePhase !== 0 && sequencePhase !== 0.5) errors.push('sequencePhase must be 0 or 0.5');
  if (/^https?:\/\//i.test(String(input ?? '').trim()) && !(Number.isFinite(to) && to > from)) {
    errors.push('sequence URL input requires explicit from/to before any download');
  }
  if (cells !== undefined && cells !== 0
      && (!Number.isInteger(cells) || cells < 3 || cells > 9)) {
    errors.push('sequence cells must be an integer 3..9 (or omitted for 9)');
  }
  if (sheets !== undefined && sheets !== 0 && sheets !== 1) {
    errors.push('sequence uses one image; sheets must be 1 or omitted');
  }
  if (!Number.isFinite(from) || from < 0
      || (to !== undefined && to !== 0 && (!Number.isFinite(to) || to <= from))) {
    errors.push('sequence requires a finite, non-negative, increasing time window');
  } else if (to > 0 && to - from > SEQUENCE_MAX_SECONDS) {
    errors.push(`sequence window exceeds ${SEQUENCE_MAX_SECONDS}s; narrow from/to`);
  }
  return errors;
}

export function sequenceRanges(from, to, count = SEQUENCE_DEFAULT_CELLS) {
  const errors = validateSequenceOptions({ pick: 'sequence', from, to, cells: count });
  if (!(to > from) || !Number.isInteger(count) || count < 3 || count > 9 || errors.length) {
    throw new RangeError(errors.join('; ') || 'invalid sequence range/count');
  }
  const step = (to - from) / count;
  return Array.from({ length: count }, (_, i) => ({
    from: from + step * i,
    to: i === count - 1 ? to : from + step * (i + 1),
    density: 1,
  }));
}
