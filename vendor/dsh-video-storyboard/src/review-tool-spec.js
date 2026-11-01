/**
 * review-tool-spec.js — video_review 的工具定义（不含 execute）。
 *
 * 与 src/tool-spec.js 里的四个旧工具并列，但**独立成文件**：主代理决定怎么接进
 * index.js / tool-spec.js，这里只提供被测过的声明与一个纯文本渲染器。
 *
 * schema 只用宿主认的基本类型（string / number / boolean / object / array / json），
 * 不写 minimum、maximum、pattern 之类的注解式约束 —— 那些会让 ctx.tools.register()
 * 在 apply() 阶段抛错，整棵插件树起不来。取值范围写在 description 里，由 execute 兜底。
 */

import { REVIEW_ACTIONS, REVIEW_MAX_SECONDS, REVIEW_MODES } from './review.js';

export const REVIEW_TOOL_NAME = 'video_review';

export function reviewToolSpec() {
  return {
    name: REVIEW_TOOL_NAME,
    description: [
      'Bounded second-pass review of a LOCAL video. Four actions:',
      '- start:   one 9-cell overview image + a reviewId. Optional from/to choose the window.',
      `- inspect: re-read one <=${REVIEW_MAX_SECONDS}s window inside that overview window.`,
      '           mode "sequence" (default) = equal-time samples, 9 cells;',
      '           mode "detail" = 3 big cells (read on-screen text / faces).',
      '- status:  counters only, no image.',
      '- finish:  close the review, no image.',
      '',
      'Hard limits per review: at most 3 images (1 overview + 2 inspections) and 5 run attempts.',
      'Repeating the same window+mode returns the previous text and evidence without re-running',
      'or re-sending an image. Nothing is downloaded: only absolute local paths are accepted, and',
      'network (UNC) paths are refused. Audio is not transcribed unless you pass transcriptFile',
      '(a local SRT/JSON); cloud ASR stays off. When the image budget is spent, stop and report what',
      'remains unconfirmed — opening another review needs a new task or explicit authorization.',
      'The window you inspect must lie inside the window start actually covered.',
    ].join('\n'),
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: REVIEW_ACTIONS,
        description: 'start | inspect | status | finish',
      },
      input: {
        type: 'string',
        description: 'start only: ABSOLUTE path of a local video file (mp4/mov/mkv/webm...). '
          + 'Links, file: URLs and UNC network paths are refused.',
      },
      reviewId: {
        type: 'string',
        description: 'inspect / status / finish: the id returned by start.',
      },
      from: {
        type: 'number',
        description: `inspect: window start in seconds (must be inside the overview window, ` +
          `and to - from <= ${REVIEW_MAX_SECONDS}s). start: optional overview window start.`,
      },
      to: {
        type: 'number',
        description: 'inspect: window end in seconds (required). start: optional overview window end.',
      },
      mode: {
        type: 'string',
        enum: REVIEW_MODES,
        description: 'inspect only: "sequence" (default, 9 equal-time cells) or "detail" ' +
          '(3 larger cells, sharpest frame per slot).',
      },
      transcriptFile: {
        type: 'string',
        description: 'start only: local SRT/JSON transcript for this video. Without it, no speech is ' +
          'transcribed at all (no cloud ASR is called).',
      },
      ffmpegPath: {
        type: 'string',
        description: 'start only: absolute path of the ffmpeg executable to use for this review. '
          + 'Fixed at start; inspect reuses it.',
      },
      ffprobePath: {
        type: 'string',
        description: 'start only: absolute path of the ffprobe executable. Fixed at start.',
      },
      pythonPath: {
        type: 'string',
        description: 'start only: absolute path of a local python executable (used only if a local ' +
          'sound model is configured). Fixed at start.',
      },
      soundModelPath: {
        type: 'string',
        description: 'start only: absolute path of a local sound-event model file. Must be given '
          + 'together with soundLabelsPath; when absent, semantic sound classification stays OFF.',
      },
      soundLabelsPath: {
        type: 'string',
        description: 'start only: absolute path of the label list for soundModelPath (paired with it).',
      },
      soundThreshold: {
        type: 'number',
        description: 'start only: sound-event threshold between 0 and 1. Requires soundModelPath and '
          + 'soundLabelsPath; a threshold alone will not switch classification on.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true, description: 'Counters plus, for a first result, the cell index.' },
          images: {
            type: 'array',
            required: true,
            items: { type: 'json' },
            description: 'Committed images; empty for duplicate/status/finish.',
          },
        },
      },
      render(args, value) {
        return [
          ...(value.images ?? []).map((attachment) => ({ type: 'image', attachment })),
          { type: 'text', text: value.text },
        ];
      },
    },
    timeoutMs: 300_000,
    // 同一份 review 的并发由控制器的 busy 占位挡住，跨 review 互不共享状态。
    isConcurrencySafe() {
      return true;
    },
  };
}

/** 参数形状兜底（schema 子集不支持范围约束，只能在这里挡）。 */
export function validateReviewArgs(args) {
  const problems = [];
  const action = args?.action;
  if (!REVIEW_ACTIONS.includes(action)) {
    problems.push(`action must be one of ${REVIEW_ACTIONS.join('/')}`);
    return problems;
  }
  const pathFields = ['input', 'transcriptFile', 'ffmpegPath', 'ffprobePath', 'pythonPath',
    'soundModelPath', 'soundLabelsPath'];
  if (action === 'start') {
    if (!args?.input || typeof args.input !== 'string') problems.push('start requires input (a local file path)');
  } else if (!args?.reviewId || typeof args.reviewId !== 'string') {
    problems.push(`${action} requires reviewId`);
  }
  if (action !== 'start') {
    for (const field of [...pathFields, 'soundThreshold']) {
      if (args?.[field] !== undefined && args[field] !== null) {
        problems.push(`${field} is fixed at start and cannot be passed to ${action}`);
      }
    }
  }
  if (action === 'start') {
    for (const field of pathFields) {
      if (args?.[field] !== undefined && args[field] !== null
        && (typeof args[field] !== 'string' || args[field].trim() === '')) {
        problems.push(`${field} must be a non-empty local path`);
      }
    }
    const hasModel = Boolean(args?.soundModelPath);
    const hasLabels = Boolean(args?.soundLabelsPath);
    if (hasModel !== hasLabels) problems.push('soundModelPath and soundLabelsPath must be given together');
    if (args?.from !== undefined && args.from !== null
      && (typeof args.from !== 'number' || !Number.isFinite(args.from) || args.from < 0)) {
      problems.push('from must be a finite number >= 0');
    }
    if (args?.to !== undefined && args.to !== null
      && (typeof args.to !== 'number' || !Number.isFinite(args.to))) {
      problems.push('to must be a finite number');
    }
    if (args?.soundThreshold !== undefined && args.soundThreshold !== null) {
      if (typeof args.soundThreshold !== 'number' || !Number.isFinite(args.soundThreshold)
        || args.soundThreshold < 0 || args.soundThreshold > 1) {
        problems.push('soundThreshold must be a number between 0 and 1');
      }
      if (!hasModel) problems.push('soundThreshold requires soundModelPath and soundLabelsPath');
    }
  }
  if (action === 'inspect') {
    if (typeof args?.from !== 'number' || typeof args?.to !== 'number') {
      problems.push('inspect requires numeric from and to');
    } else if (args.to - args.from > REVIEW_MAX_SECONDS + 1e-9) {
      problems.push(`inspect window must be <= ${REVIEW_MAX_SECONDS}s`);
    }
  }
  if (args?.mode !== undefined && !REVIEW_MODES.includes(args.mode)) {
    problems.push(`mode must be one of ${REVIEW_MODES.join('/')}`);
  }
  return problems;
}

/**
 * 把控制器的返回值渲染成一段稳定的文本 —— 结构化字段仍留在 JSON 里，
 * 这里只保证模型能读到"还剩几张图、第几次、是不是复用"。
 */
export function formatReviewEnvelope(payload) {
  const lines = [
    `<review id="${payload.reviewId ?? ''}" status="${payload.status ?? ''}" ` +
      `images="${payload.imagesUsed ?? 0}/${(payload.imagesUsed ?? 0) + (payload.imagesRemaining ?? 0)}" ` +
      `attempts="${payload.attemptsUsed ?? 0}"` +
      `${payload.window ? ` window="${payload.window.from.toFixed(2)}-${payload.window.to.toFixed(2)}"` : ''}>`,
  ];
  if (payload.error) lines.push(`error: ${payload.error}`);
  if (payload.note) lines.push(`note: ${payload.note}`);
  if (payload.status === 'duplicate') {
    lines.push('reused previous inspection for this window and mode; no new frames were decoded.');
    if (payload.priorText) lines.push(`prior text: ${payload.priorText}`);
  }
  const result = payload.result;
  if (result?.text) lines.push(result.text);
  if (result?.metadata?.cells?.length) {
    lines.push(result.metadata.cells
      .map((c) => `cell ${c.i} = ${c.t_start}-${c.t_end}s` + (Number.isFinite(c.t_frame) ? ` frame@${c.t_frame}s` : ''))
      .join('; '));
  }
  if (payload.imagesRemaining === 0) {
    lines.push('image budget for this review is spent: stop reviewing and report what remains '
      + 'unconfirmed; opening another review needs a new task or explicit authorization.');
  }
  lines.push('</review>');
  return lines.join('\n');
}
