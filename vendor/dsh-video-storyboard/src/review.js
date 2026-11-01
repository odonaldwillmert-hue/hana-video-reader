/**
 * review.js — 有界复核控制器（协议层：只管预算、状态、来源校验，不碰宿主）。
 *
 * 把「概览 → 局部复核 → 结束」做成有上限的会话：每份 review 最多 3 张图
 * （概览 1 + 复核 2）、最多 5 次 run；同样的窗口+模式再来一次只回上次的文本与证据。
 *
 * 三条硬约束：只接本地绝对路径（永不下载、不碰网络盘）；默认 transcript:'off'
 * （不擅自上传音频）；预算在 await 之前扣（保留），失败只留下 attempt，不虚增图数。
 * run 由调用方注入（宿主传 runStoryboard），所以这里不 import pipeline，测试可用 fakeRun。
 */

import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

export const REVIEW_ACTIONS = ['start', 'inspect', 'status', 'finish'];
export const REVIEW_MODES = ['sequence', 'detail'];
export const REVIEW_MAX_SECONDS = 12;
export const REVIEW_IMAGE_BUDGET = 3;
export const REVIEW_ATTEMPT_BUDGET = 5;
export const REVIEW_MAX_ENTRIES = 32;
export const REVIEW_TTL_MS = 3_600_000;

/** 概览固定 9 格单图；detail 3 格（格子更大，用于读画面里的字/脸）。 */
const OVERVIEW_PLAN = { cells: 9, sheets: 1, pick: 'sharp' };
const MODE_PLAN = {
  sequence: { cells: 9, pick: 'sequence' },
  detail: { cells: 3, pick: 'sharp' },
};

/** start 时固定下来、inspect 复用且不可改的本地工具/模型参数。 */
const ENV_FIELDS = ['ffmpegPath', 'ffprobePath', 'pythonPath', 'soundModelPath', 'soundLabelsPath'];

const messageOf = (e) => String(e?.message ?? e).slice(0, 300);

const BUDGET_HINT = 'stop reviewing and report what remains unconfirmed; opening another review needs ' +
  'a new task or explicit authorization';

/** 只接受**绝对本地路径**：拒绝任何 scheme、拒绝 UNC 网络路径（这里不做下载，也不该碰共享盘）。 */
function localPathOrThrow(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  const p = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) || /^(file|https?|ftp|s3|gs|smb):/i.test(p)) {
    throw new Error(`${field} must be a local absolute path; video_review never downloads — ` +
      'fetch the file first, then pass the path');
  }
  if (/^[\\/]{2}/.test(p)) {
    throw new Error(`${field} must be a local path on this machine; network (UNC) paths are refused`);
  }
  if (!isAbsolute(p)) throw new Error(`${field} must be an absolute path, got: ${p}`);
  return p;
}

/** 只判断存在与"是普通文件"；不执行、不检查权限位（跨平台不可靠）。 */
async function statFile(path) {
  const st = await stat(path);
  if (!st.isFile()) throw new Error(`not a regular file: ${path}`);
  return { size: st.size, mtimeMs: st.mtimeMs };   // 保留原始精度，四舍五入会吞掉亚毫秒改动
}

/** 给模型看的证据：每格的时间槽、实际取帧时刻（真实解码 PTS）与请求时刻。 */
function metadataOf(result, role) {
  const sheet = result?.sheets?.[0] ?? null;
  const cells = (Array.isArray(sheet?.cells) ? sheet.cells : []).map((c) => ({
    i: c.i, t_start: c.t_start, t_end: c.t_end,
    ...(Number.isFinite(c.t_frame) ? { t_frame: c.t_frame } : {}),
    ...(Number.isFinite(c.t_requested) ? { t_requested: c.t_requested } : {}),
    ...(c.timestampSource ? { timestampSource: c.timestampSource } : {}),
    ...(c.sub ? { sub: c.sub } : {}),
    ...(Array.isArray(c.subFrames) ? { subFrames: c.subFrames.map((f) => ({ ...f })) } : {}),
    ...(c.cuts ? { cuts: c.cuts } : {}),
  }));
  return {
    role,
    window: result?.window ? { from: result.window.from, to: result.window.to } : null,
    grid: sheet ? `${sheet.cols}x${sheet.rows}` : null,
    cell: sheet ? `${sheet.cellW}x${sheet.cellH}` : null,
    cells,
  };
}

/** 恰好一张、且有真实 PNG 字节 —— 否则这张图不能被算作"提交成功"。 */
function committedSheet(result) {
  const sheets = Array.isArray(result?.sheets) ? result.sheets : [];
  if (sheets.length !== 1) {
    return { error: `returned ${sheets.length} sheet(s); expected exactly 1 — image not committed` };
  }
  const png = sheets[0]?.png;
  const isBytes = (Buffer.isBuffer(png) || png instanceof Uint8Array) && png.length > 0;
  if (!isBytes) return { error: 'sheet has no PNG bytes — image not committed' };
  return { sheet: sheets[0] };
}

function imageOf(sheet) {
  return [{ mediaType: 'image/png', data: sheet.png, name: 'review-sheet-1.png' }];
}

export function createReviewController({
  run,
  format = (result) => String(result?.text ?? ''),
  now = () => Date.now(),
  makeId = () => randomUUID(),
  ttlMs = REVIEW_TTL_MS,
  maxEntries = REVIEW_MAX_ENTRIES,
  imageBudget = REVIEW_IMAGE_BUDGET,
  attemptBudget = REVIEW_ATTEMPT_BUDGET,
} = {}) {
  if (typeof run !== 'function') throw new TypeError('createReviewController({ run }) needs a run function');
  const reviews = new Map();

  const snapshot = (r, status = r.phase) => ({
    reviewId: r.id,
    status,
    input: r.input,
    window: r.window ? { ...r.window } : null,
    imagesUsed: r.imagesUsed,
    imagesRemaining: Math.max(0, imageBudget - r.imagesUsed),
    attemptsUsed: r.attemptsUsed,
    attemptsRemaining: Math.max(0, attemptBudget - r.attemptsUsed),
    inspections: [...r.slots.keys()],
    ...(r.lastError ? { error: r.lastError } : {}),
  });
  /** 不落盘的拒绝：给 status + 原因，但不污染 review 的持久状态。 */
  const refuse = (r, status, error) => ({ ...snapshot(r, status), error });

  function expireIfStale(r) {
    if (r.busy) return false;      // 运行中的会话不参与过期判定（不能把正在跑的标成 expired）
    if (r.phase !== 'finished' && now() - r.lastAt > ttlMs) {
      r.phase = 'expired';
      r.lastError = `review expired after ${Math.round(ttlMs / 1000)}s of inactivity`;
    }
    return r.phase === 'expired';
  }

  /** 过期清理与容量淘汰都**跳过 busy 的 review**：不能把正在跑的会话删掉。 */
  function prune() {
    for (const [id, r] of reviews) {
      if (r.busy) continue;
      if (now() - r.lastAt > ttlMs) reviews.delete(id);
    }
  }

  function evictOne() {
    let victim = null;
    for (const r of reviews.values()) {
      if (r.busy) continue;
      if (r.phase === 'finished' || r.phase === 'expired') { victim = r; break; }
    }
    if (!victim) {
      for (const r of reviews.values()) {
        if (r.busy) continue;
        if (!victim || r.lastAt < victim.lastAt) victim = r;
      }
    }
    if (victim) reviews.delete(victim.id);
    return Boolean(victim);
  }

  function entry(reviewId) {
    if (typeof reviewId !== 'string' || !reviewId.trim()) throw new Error('reviewId is required');
    const r = reviews.get(reviewId);
    if (!r) throw new Error(`unknown reviewId: ${reviewId}`);
    return r;
  }

  /** 源变了就别再拿旧概览当参照：size+mtime 任一变化都拒绝。 */
  async function verifySource(r) {
    try {
      const key = await statFile(r.input);
      if (key.size !== r.source.size || key.mtimeMs !== r.source.mtimeMs) {
        return 'source file changed (size/mtime) since start; this review is no longer valid';
      }
    } catch (e) {
      return `source file is no longer readable: ${messageOf(e)}`;
    }
    return null;
  }

  /** start 才能设的运行参数：本地绝对路径、存在、且（工具类）必须是普通文件。 */
  async function resolveRunEnv(args) {
    const env = {};
    for (const field of ENV_FIELDS) {
      const value = args[field];
      if (value === undefined || value === null) continue;
      const path = localPathOrThrow(value, field);
      await statFile(path);                          // 不存在/不是文件 → 直接失败，不建 review
      env[field] = path;
    }
    if (Boolean(env.soundModelPath) !== Boolean(env.soundLabelsPath)) {
      throw new Error('soundModelPath and soundLabelsPath must be provided together');
    }
    // 没有模型对时不要传阈值：语义分类保持默认关闭，别让一个孤立的阈值把开关打开。
    if (args.soundThreshold !== undefined && args.soundThreshold !== null) {
      if (!Number.isFinite(args.soundThreshold) || args.soundThreshold < 0 || args.soundThreshold > 1) {
        throw new Error('soundThreshold must be a number between 0 and 1');
      }
      if (!env.soundModelPath) {
        throw new Error('soundThreshold requires soundModelPath and soundLabelsPath');
      }
      env.soundThreshold = args.soundThreshold;
    }
    return env;
  }

  async function start(args = {}) {
    const input = localPathOrThrow(args.input, 'input');
    const transcriptFile = args.transcriptFile === undefined || args.transcriptFile === null
      ? null
      : localPathOrThrow(args.transcriptFile, 'transcriptFile');
    // 给了就必须合法：非法值时静默当成"没给"会让调用方以为窗口生效了。
    let from;
    let to;
    if (args.from !== undefined && args.from !== null) {
      if (!Number.isFinite(args.from) || args.from < 0) throw new Error('from must be a finite number >= 0');
      from = args.from;
    }
    if (args.to !== undefined && args.to !== null) {
      if (!Number.isFinite(args.to)) throw new Error('to must be a finite number');
      if (!(args.to > (from ?? 0))) throw new Error('to must be greater than from');
      to = args.to;
    }
    const env = await resolveRunEnv(args);
    const source = await statFile(input);             // 文件不存在就立刻失败，不建 review
    if (transcriptFile) await statFile(transcriptFile);

    prune();
    while (reviews.size >= maxEntries && evictOne()) { /* 腾位置 */ }
    if (reviews.size >= maxEntries) {
      throw new Error(`review capacity reached (${maxEntries}); ${BUDGET_HINT}`);
    }

    const r = {
      id: String(makeId()), input, source, transcriptFile, env,
      phase: 'open', imagesUsed: 0, attemptsUsed: 0,
      window: null, slots: new Map(), overview: null,
      busy: false, lastError: null, lastAt: now(),
    };
    reviews.set(r.id, r);

    r.busy = true;
    r.attemptsUsed += 1;
    r.imagesUsed += 1;                                // 保留：先扣再 await
    try {
      let result;
      try {
        result = await run({
          input,
          ...(from !== undefined ? { from } : {}),
          ...(to !== undefined ? { to } : {}),
          cells: OVERVIEW_PLAN.cells,
          sheets: OVERVIEW_PLAN.sheets,
          pick: OVERVIEW_PLAN.pick,
          // 默认不联网：没配 ASR 就上传音频不是这里该做的决定。
          transcript: transcriptFile ? 'auto' : 'off',
          ...(transcriptFile ? { transcriptFile } : {}),
          ...env,
        });
      } catch (e) {
        r.imagesUsed -= 1;                          // 没出图就不占图预算
        r.lastError = `overview failed: ${messageOf(e)}`;
        return snapshot(r, 'error');
      }
      const committed = committedSheet(result);
      if (committed.error) {
        r.imagesUsed -= 1;                          // 不提交：预算既没被用掉，也没被绕过
        r.lastError = `overview ${committed.error}`;
        return snapshot(r, 'error');
      }
      r.window = { from: Number(result?.window?.from ?? 0), to: Number(result?.window?.to ?? 0) };
      r.overview = { text: format(result), metadata: metadataOf(result, 'overview') };
      r.lastError = null;
      r.lastAt = now();
      return {
        ...snapshot(r, 'open'),
        result: { ...r.overview, images: imageOf(committed.sheet) },
      };
    } finally {
      r.busy = false;
    }
  }

  async function inspect(args = {}) {
    const r = entry(args.reviewId);
    if (expireIfStale(r)) return snapshot(r);
    if (r.phase === 'finished' || r.phase === 'error') return snapshot(r);
    if (r.busy) return refuse(r, 'busy', 'another attempt is still running for this review');

    // 运行参数在 start 就固定了：inspect 改它们等于换了一台机器/一套模型。
    for (const field of [...ENV_FIELDS, 'soundThreshold', 'transcriptFile', 'input']) {
      if (args[field] !== undefined && args[field] !== null) {
        throw new Error(`inspect reuses the parameters fixed at start; ${field} cannot change`);
      }
    }
    const from = Number(args.from);
    const to = Number(args.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new Error('inspect needs finite from/to seconds');
    }
    if (to <= from) throw new Error('inspect needs to > from');
    if (to - from > REVIEW_MAX_SECONDS) {
      throw new Error(`inspect window exceeds ${REVIEW_MAX_SECONDS}s; narrow from/to`);
    }
    const mode = args.mode ?? 'sequence';
    if (!REVIEW_MODES.includes(mode)) throw new Error(`mode must be one of ${REVIEW_MODES.join('/')}`);
    if (!r.window) return refuse(r, 'error', 'this review has no overview window to inspect');

    r.lastAt = now();
    if (from < r.window.from - 1e-6 || to > r.window.to + 1e-6) {
      return refuse(r, 'error', `inspect ${from}-${to}s is outside the overview window ` +
        `${r.window.from}-${r.window.to}s; run start again to widen it`);
    }

    r.busy = true;                                   // 同步占位：并发请求只有一个能过
    try {
      // 先核源再判重：源变了的话"上次的证据"已经不是这段视频的证据了。
      const sourceError = await verifySource(r);
      if (sourceError) {
        r.phase = 'error';
        r.lastError = sourceError;
        return snapshot(r, 'error');
      }

      const slotKey = `${mode}:${from.toFixed(3)}-${to.toFixed(3)}`;
      const prior = r.slots.get(slotKey);
      if (prior) {
        return {
          ...snapshot(r, 'duplicate'),
          priorText: prior.text,
          metadata: prior.metadata,
          note: 'same window and mode already inspected: no new run, no new image',
        };
      }
      if (Math.max(0, imageBudget - r.imagesUsed) < 1) {
        return refuse(r, 'error', `image budget exhausted (${imageBudget} images per review): ${BUDGET_HINT}`);
      }
      if (Math.max(0, attemptBudget - r.attemptsUsed) < 1) {
        return refuse(r, 'error', `attempt budget exhausted (${attemptBudget} attempts per review): ${BUDGET_HINT}`);
      }

      r.attemptsUsed += 1;
      r.imagesUsed += 1;                             // 保留：先扣再 await
      const plan = MODE_PLAN[mode];
      const complementMicrogrid = mode === 'sequence' && r.overview.metadata.cells.some((cell) =>
        cell.subFrames?.length && Math.abs(cell.t_start - from) < 1e-6 && Math.abs(cell.t_end - to) < 1e-6);
      let result;
      try {
        result = await run({
          input: r.input, from, to,
          cells: plan.cells, sheets: 1, pick: plan.pick,
          ...(complementMicrogrid ? { sequencePhase: 0 } : {}),
          transcript: 'off',
          ...(r.transcriptFile ? { transcriptFile: r.transcriptFile } : {}),
          ...r.env,
        });
      } catch (e) {
        r.imagesUsed -= 1;
        return refuse(r, 'error', `inspect failed: ${messageOf(e)}`);
      }
      const committed = committedSheet(result);
      if (committed.error) {
        r.imagesUsed -= 1;
        return refuse(r, 'error', `inspect ${committed.error}`);
      }
      const text = format(result);
      const metadata = metadataOf(result, mode);
      r.slots.set(slotKey, { text, metadata, mode, from, to });
      r.lastAt = now();
      return {
        ...snapshot(r, 'ok'),
        result: { role: mode, text, metadata, images: imageOf(committed.sheet) },
      };
    } finally {
      r.busy = false;
    }
  }

  async function status(args = {}) {
    const r = entry(args.reviewId);
    if (expireIfStale(r)) return snapshot(r);
    return snapshot(r);
  }

  async function finish(args = {}) {
    const r = entry(args.reviewId);
    if (expireIfStale(r)) return snapshot(r);
    // 运行还没结束就封单，会让"封单后不再出图"变成谎话：直接拒，且不改 phase。
    if (r.busy) return refuse(r, 'busy', 'an attempt is still running; finish refused and the review stays open');
    if (r.phase !== 'finished' && r.phase !== 'error') {
      r.phase = 'finished';
      r.lastAt = now();
    }
    return snapshot(r, r.phase === 'finished' ? 'finished' : 'error');
  }

  return { start, inspect, status, finish };
}
