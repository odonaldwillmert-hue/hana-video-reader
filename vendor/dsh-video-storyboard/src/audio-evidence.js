/**
 * audio-evidence.js — 声音证据的**语义层**。纯函数，不碰文件系统、不跑 ffmpeg、不发网络请求。
 *
 * 为什么要有这一层：`audio.js` 只会测量（响度曲线、静音段、电平跳变），它回答不了
 * 「这份测量结果能不能当证据」。而证据有三个必须显式声明的维度，缺一个模型就会过度解读：
 *
 *   1. **状态**：没有音轨 / 没做分析 / 分析失败 / 部分成功 / 成功。这五种在旧返回值里
 *      最多只有两种形状（对象或 null），「失败」和「无声」因此长得一样。
 *   2. **来源**：每个数字是哪个工具量出来的（ebur128 / silencedetect / 字幕轨 / 转写文件 / ASR）。
 *   3. **精度**：采样分辨率与判定窗口。这两者是**测量装置的刻度**，不是准确率。
 *      `accuracySeconds` 恒为 null —— 没人对这套管线做过时间精度校准，
 *      把 0.1s 的采样间隔说成「±0.1s 准确」、把字幕的毫秒小数位说成「毫秒级准确」都是伪造。
 *
 * 还有一条边界必须写死在输出里：rise / drop / silence 是**声学**事件，不是语义识别。
 * 它们能说「这里突然变响」，不能说「这里有人笑了」。笑声、哭声、叹气、敲门、音乐
 * 都不在本模块能力范围内，空事件表也不等于「什么声音都没有」。
 */

import {
  LOUDNESS_STEP_SEC,
  ONSET_WINDOW_SEC,
  SILENCE_DB,
  SILENCE_MIN,
} from './audio.js';

/** 五种状态。字符串而不是数字，便于直接进清单与日志。 */
export const AUDIO_EVIDENCE_STATUS = {
  NO_AUDIO_TRACK: 'no-audio-track',
  NOT_ANALYZED: 'not-analyzed',
  FAILED: 'failed',
  PARTIAL: 'partial',
  OK: 'ok',
};

/** 声学事件的类别白名单。任何语义类别（laughter/knock/music…）都不在这里。 */
export const ACOUSTIC_EVENT_KINDS = ['rise', 'drop', 'silence'];

/** 一条固定的能力声明，进清单时原样带出，不做措辞变体。 */
export const ACOUSTIC_ONLY_NOTE =
  'acoustic only: rise/drop/silence measure level changes, not what produced them; ' +
  'laughter, crying, sighs, knocks and music are not identified';

/** 一条固定的空结果免责声明。 */
export const EMPTY_IS_NOT_SILENT_NOTE =
  'an empty event list is not evidence that no sound occurred; only successful measurements ' +
  'can establish that no level change crossed the thresholds';

/** 精度字段：分辨率与窗口可给数，accuracy 一律 null。 */
function measurement({ resolutionSeconds = null, windowSeconds = null, threshold = null } = {}) {
  return { resolutionSeconds, windowSeconds, threshold, accuracySeconds: null };
}

/**
 * 没有可用响度时的 loudness 形状：字段全在、数值全为 null。
 * 为什么不用缺字段：读方（以及序列化后的清单）看到 undefined 与看到 null
 * 是两种不同的信号，前者像「忘了写」，后者才是「明确未知」。
 */
function absentLoudness() {
  return {
    series: [], step: LOUDNESS_STEP_SEC, mean: null, peak: null, dynamic: null, samples: 0,
    source: null, accuracySeconds: null,
  };
}

/**
 * 把 detectOnsets 的裸事件（`{t, kind, delta}`）装饰成带来源与精度的证据条目。
 * 只加字段，不改数值，不改顺序，因此旧的断言（kind / t / delta）继续成立。
 *
 * @param {Array<{t:number,kind:'rise'|'drop',delta:number}>} onsets
 * @param {{source?:string, resolutionSeconds?:number|null, windowSeconds?:number|null,
 *          riseDb?:number|null, dropDb?:number|null, window?:{from:number,to:number}}} [opts]
 * @returns {Array<object>}
 */
export function decorateOnsets(onsets, {
  source = 'ebur128',
  resolutionSeconds = LOUDNESS_STEP_SEC,
  windowSeconds = ONSET_WINDOW_SEC,
  riseDb = null,
  dropDb = null,
  window,
} = {}) {
  const list = Array.isArray(onsets) ? onsets : [];
  return list
    .filter((e) => e && ACOUSTIC_EVENT_KINDS.includes(e.kind) && Number.isFinite(e.t))
    .map((e) => {
      const base = {
        t: e.t,
        kind: e.kind,
        delta: e.delta,
        semantics: 'acoustic',
        source,
        resolutionSeconds,
        windowSeconds,
        accuracySeconds: null,
        // 阈值不是准确率，但它决定了「没触发」意味着什么，必须一起给
        threshold: e.kind === 'rise' ? riseDb : dropDb,
      };
      if (window && Number.isFinite(window.from) && Number.isFinite(window.to)) {
        base.window = { from: window.from, to: window.to };
      }
      return base;
    });
}

/**
 * 把静音段装饰成证据条目。silencedetect 的时间边界分辨率没有被校准过，
 * 所以 `resolutionSeconds` 给 null，`windowSeconds` 给最小持续时长（判定门槛）。
 *
 * @param {Array<{from:number,to:number}>} silences
 * @param {{source?:string, noise?:number, minDur?:number, window?:{from:number,to:number}}} [opts]
 */
export function decorateSilences(silences, {
  source = 'silencedetect',
  noise = SILENCE_DB,
  minDur = SILENCE_MIN,
  window,
} = {}) {
  const list = Array.isArray(silences) ? silences : [];
  return list
    .filter((s) => s && Number.isFinite(s.from) && Number.isFinite(s.to) && s.to > s.from)
    .map((s) => {
      const base = {
        t: s.from,
        kind: 'silence',
        from: s.from,
        to: s.to,
        semantics: 'acoustic',
        source,
        resolutionSeconds: null,          // 边界精度未校准，不假装有
        windowSeconds: minDur,            // 判定门槛：短于它的静音不会被报出来
        accuracySeconds: null,
        threshold: noise,
      };
      if (window && Number.isFinite(window.from) && Number.isFinite(window.to)) {
        base.window = { from: window.from, to: window.to };
      }
      return base;
    });
}

/**
 * 由 probe 结果 + analyzeAudio 结果 + 是否要求分析，合成一份完整的证据块。
 *
 * **纯函数**：不读文件、不调用 ffmpeg、不依赖时间与随机数。相同入参永远相同输出。
 *
 * 判定顺序（顺序本身就是语义，不能调换）：
 *   1. `info.hasAudio !== true` → no-audio-track（没音轨，任何测量都无意义）
 *   2. `analysisRequested !== true` → not-analyzed（有音轨但本次没做）
 *   3. `audio == null` → failed（做了但一项都没成）
 *   4. `audio.status === 'partial'` 或 `parts` 里有一项 false → partial
 *   5. 其余 → ok
 *
 * @param {object} input
 * @param {{hasAudio?:boolean, duration?:number}|null} [input.info] probeVideo 的结果
 * @param {object|null} [input.audio] analyzeAudio 的返回值（可能为 null）
 * @param {boolean} [input.analysisRequested] 本次是否要求做音频分析
 * @param {string} [input.notAnalyzedReason] 没做分析的原因（'text-only' / 'transcript-off' / …）
 * @param {{from:number,to:number}} [input.window] 分析窗口（秒）
 * @param {Array} [input.onsets] 已算好的电平事件；不给则视为空（不在这里现算）
 * @param {object} [input.thresholds] `{riseDb, dropDb, noise, minDur}`，用于回填阈值
 * @returns {object} 证据块
 */
export function buildAudioEvidence({
  info = null,
  audio = null,
  analysisRequested = true,
  notAnalyzedReason = null,
  window = null,
  onsets = null,
  thresholds = {},
} = {}) {
  const hasAudioTrack = info?.hasAudio === true;
  const {
    riseDb = null, dropDb = null,
    noise = SILENCE_DB, minDur = SILENCE_MIN,
  } = thresholds ?? {};

  const base = {
    hasAudioTrack,
    analysisRequested: analysisRequested === true,
    semanticSoundRecognition: false,
    acousticOnly: true,
    capability: {
      reports: [...ACOUSTIC_EVENT_KINDS],
      doesNotReport: ['laughter', 'crying', 'sigh', 'knock', 'music', 'speech-content'],
    },
    notes: [ACOUSTIC_ONLY_NOTE, EMPTY_IS_NOT_SILENT_NOTE],
  };

  /* 1. 没音轨：这是唯一可以确定「不存在」的结论 */
  if (!hasAudioTrack) {
    return {
      ...base,
      status: AUDIO_EVIDENCE_STATUS.NO_AUDIO_TRACK,
      sources: [],
      parts: { loudness: false, silence: false },
      measurements: measurement(),
      loudness: absentLoudness(),
      events: [],
      silences: [],
      failures: [],
      limitations: ['this file has no audio track: sound cannot contribute evidence here'],
    };
  }

  /* 2. 有音轨但没做分析：不是无声，是没看 */
  if (analysisRequested !== true) {
    return {
      ...base,
      status: AUDIO_EVIDENCE_STATUS.NOT_ANALYZED,
      reason: notAnalyzedReason ?? 'not-requested',
      sources: [],
      parts: { loudness: false, silence: false },
      measurements: measurement(),
      loudness: absentLoudness(),
      events: [],
      silences: [],
      failures: [],
      limitations: [
        'audio analysis was not run for this window, so the absence of sound events is not a finding',
        notAnalyzedReason ? `reason: ${notAnalyzedReason}` : null,
      ].filter(Boolean),
    };
  }

  /* 3. 做了但一项都没成：不能写成「零响度」或「没有静音」 */
  if (!audio) {
    return {
      ...base,
      status: AUDIO_EVIDENCE_STATUS.FAILED,
      sources: [],
      parts: { loudness: false, silence: false },
      measurements: measurement(),
      loudness: absentLoudness(),
      events: [],
      failures: [{ part: 'all', source: null, error: 'audio analysis produced no usable signal' }],
      silences: null,                                     // 失败：未知，不是「没有静音」
      limitations: [
        'audio analysis failed: no loudness value and no silence map exist for this window',
        'this is a measurement gap, not a quiet passage — do not describe the window as silent',
      ],
    };
  }

  /* 4/5. 用 analyzeAudio 自己报的成败，不猜 */
  const parts = {
    loudness: audio.parts?.loudness === true
      || (audio.parts === undefined && Number.isFinite(audio.mean) && (audio.samples ?? 0) > 0),
    silence: audio.parts?.silence === true
      || (audio.parts === undefined && Array.isArray(audio.silences)),
  };
  const failures = Array.isArray(audio.failures) ? audio.failures : [];
  const status = (audio.status === 'partial' || failures.length > 0 || !parts.loudness || !parts.silence)
    ? AUDIO_EVIDENCE_STATUS.PARTIAL
    : AUDIO_EVIDENCE_STATUS.OK;

  const sources = [];
  if (parts.loudness) sources.push(audio.source === 'ebur128' ? 'ebur128' : (audio.source ?? 'ebur128'));
  if (parts.silence) sources.push('silencedetect');

  const loudness = parts.loudness
    ? measurement({ resolutionSeconds: Number.isFinite(audio.step) ? audio.step : LOUDNESS_STEP_SEC })
    : measurement();
  const silenceMeasure = parts.silence
    ? measurement({ windowSeconds: minDur, threshold: noise })
    : measurement();

  const events = parts.loudness
    ? decorateOnsets(onsets ?? [], {
      source: 'ebur128', resolutionSeconds: loudness.resolutionSeconds, windowSeconds: ONSET_WINDOW_SEC,
      riseDb, dropDb, window: window ?? undefined,
    })
    : [];
  // 静音条目**装饰后**直接作为 silences 交出：它仍带 from/to（sheet.js 的 addAudioStrip 只读这两个字段），
  // 额外多了 source / windowSeconds / accuracySeconds，于是「静音也是证据」这件事在数据上成立，
  // 而不是只写在注释里。
  const silences = parts.silence
    ? decorateSilences(audio.silences ?? [], {
      source: 'silencedetect', noise, minDur, window: window ?? undefined,
    })
    : null;

  const limitations = [];
  if (!parts.loudness) {
    limitations.push('loudness measurement unavailable: no rise/drop events were computed, and this is not a quiet passage');
  }
  if (!parts.silence) {
    limitations.push('silence detection unavailable: the absence of silence gaps is unknown, not zero');
  }
  if (status === AUDIO_EVIDENCE_STATUS.PARTIAL) {
    limitations.push('audio evidence is partial: only the sources listed in `sources` contributed');
  }
  limitations.push(EMPTY_IS_NOT_SILENT_NOTE);

  return {
    ...base,
    status,
    sources,
    parts,
    measurements: {
      loudness: loudness,
      silence: silenceMeasure,
      // 顶层这一组是最常被误读的位置，所以单独放一份并保持 accuracySeconds: null
      resolutionSeconds: loudness.resolutionSeconds,
      windowSeconds: ONSET_WINDOW_SEC,
      accuracySeconds: null,
    },
    // 兼容上游形状：loudness 与 silences 原样带出，pipeline 的旧读法不受影响
    loudness: {
      series: Array.isArray(audio.series) ? audio.series : [],
      step: Number.isFinite(audio.step) ? audio.step : LOUDNESS_STEP_SEC,
      mean: parts.loudness ? audio.mean : null,      // 失败时是 null，不是 0
      peak: parts.loudness ? audio.peak : null,
      dynamic: parts.loudness ? audio.dynamic : null,
      samples: Number.isFinite(audio.samples) ? audio.samples : 0,
      source: parts.loudness ? 'ebur128' : null,
      accuracySeconds: null,
    },
    silences,                                          // 装饰后的静音条目；失败时为 null（不是 []）
    events,
    failures,
    limitations,
  };
}

/**
 * 证据块的一句话摘要，给清单用。
 * 明确区分「测出来的」与「没测到的」，且从不把空事件表说成无声。
 */
export function describeAudioEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return 'audio evidence unavailable';
  const status = evidence.status;
  if (status === AUDIO_EVIDENCE_STATUS.NO_AUDIO_TRACK) return 'no audio track';
  if (status === AUDIO_EVIDENCE_STATUS.NOT_ANALYZED) {
    return `audio not analyzed${evidence.reason ? ` (${evidence.reason})` : ''}; no sound evidence either way`;
  }
  if (status === AUDIO_EVIDENCE_STATUS.FAILED) {
    return 'audio analysis failed; no loudness or silence map (not a quiet passage)';
  }
  const parts = [];
  const l = evidence.measurements?.loudness;
  if (evidence.parts?.loudness && l?.resolutionSeconds) {
    parts.push(`loudness at ${l.resolutionSeconds}s sampling`);
  }
  const nEvents = evidence.events?.length ?? 0;
  const nSilences = evidence.silences?.length ?? 0;
  if (evidence.parts?.loudness) parts.push(`${nEvents} level event(s)`);
  if (evidence.parts?.silence) parts.push(`${nSilences} silence gap(s)`);
  const head = `${status}: ${parts.join(', ')}`;
  return `${head}; acoustic only, no semantic sound labels`;
}
