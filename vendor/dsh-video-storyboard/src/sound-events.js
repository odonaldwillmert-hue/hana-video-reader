/** Optional local semantic sound evidence. Never downloads or calls a network service. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
const exec = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../python/sound_events.py', import.meta.url));
export const MAX_SOUND_SECONDS = 30;
const DISCLAIMER = 'Sound labels are uncalibrated model predictions, not confirmed events. Empty predictions do not establish silence; timing precision has not been calibrated. Intervals are classification contexts, not measured onsets/offsets; short and final chunks may be zero-padded. Silence is also only a predicted label.';

export function validateSoundResult(value, { from, to }) {
  if (!value || value.status !== 'ok' || !Array.isArray(value.events)) throw new Error('invalid sound backend result');
  if (value.events.length > 12) throw new Error('sound backend exceeded event budget');
  const events = value.events.map(event => {
    if (!event || !Number.isFinite(event.from) || !Number.isFinite(event.to)
      || event.from < from - 0.001 || event.to > to + 0.001 || event.to <= event.from
      || typeof event.label !== 'string' || !event.label.trim() || event.label.length > 120
      || !Number.isFinite(event.score) || event.score < 0 || event.score > 1) {
      throw new Error('invalid or out-of-window sound prediction');
    }
    return { from: event.from, to: event.to, label: event.label, score: event.score,
      source: 'yamnet-onnx', semantics: 'predicted', accuracySeconds: null,
      intervalMeaning: 'classification-context',
      paddedSeconds: Number.isFinite(event.paddedSeconds) && event.paddedSeconds >= 0 && event.paddedSeconds <= 0.98 ? event.paddedSeconds : null }; 
  });
  return {
    status: 'ok', model: 'yamnet-onnx', source: 'local-onnxruntime',
    modelSha256: typeof value.modelSha256 === 'string' && /^[a-f0-9]{64}$/i.test(value.modelSha256) ? value.modelSha256 : null,
    modelDataSha256: typeof value.modelDataSha256 === 'string' && /^[a-f0-9]{64}$/i.test(value.modelDataSha256) ? value.modelDataSha256 : null,
    labelsSha256: typeof value.labelsSha256 === 'string' && /^[a-f0-9]{64}$/i.test(value.labelsSha256) ? value.labelsSha256 : null,
    modelSha256Scope: 'ONNX graph only; external weights have a separate hash',
    eventsTruncated: value.eventsTruncated === true,
    window: {from,to}, events,
    limitations: [DISCLAIMER],
  };
}

export async function classifySounds({ input, from = 0, to, modelPath, labelsPath,
  pythonPath = process.env.DSH_VIDEO_PYTHON || 'python', ffmpegPath,
  threshold = 0.5, run = exec } = {}) {
  const base = {status:'not-configured',events:[],window:{from,to},limitations:[DISCLAIMER]};
  if (!modelPath) return base;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) {
    return {...base,status:'failed',error:'sound classification requires an explicit finite window'};
  }
  if (to-from > MAX_SOUND_SECONDS) {
    return {...base,status:'not-analyzed',reason:'window-too-long',error:'narrow the sound window to at most 30 seconds'};
  }
  try {
    for (const [name,path] of Object.entries({input,modelPath,labelsPath})) {
      if (typeof path !== 'string' || !isAbsolute(path) || /^https?:/i.test(path) || path.startsWith('\\\\') || path.startsWith('//')) throw new Error(`${name} must be an absolute local path`);
      const file = await stat(path);
      if (!file.isFile()) throw new Error(`${name} is not a file`);
      if (name === 'modelPath' && file.size > 100*1024*1024) throw new Error('sound model exceeds 100 MiB safety limit');
      if (name === 'labelsPath' && file.size > 1024*1024) throw new Error('sound label map exceeds 1 MiB safety limit');
    }
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('sound threshold must be 0..1');
    const args = [SCRIPT,'--input',input,'--model',modelPath,'--labels',labelsPath,'--from',String(from),'--to',String(to),'--threshold',String(threshold),'--max-events','12'];
    if(ffmpegPath) args.push('--ffmpeg',ffmpegPath);
    const {stdout} = await run(pythonPath,args,{timeout:120_000,maxBuffer:1024*1024,windowsHide:true,encoding:'utf8'});
    return {...validateSoundResult(JSON.parse(stdout),{from,to}), threshold, thresholdOperator: '>'};
  } catch(error) {
    let detail = String(error?.message??error);
    try {
      const failure = JSON.parse(String(error?.stdout ?? ''));
      if (failure.status === 'failed' && typeof failure.error?.message === 'string') {
        detail = `${failure.error.code ?? 'backend-failed'}: ${failure.error.message}`;
      }
    } catch { /* preserve process error if stdout is not structured */ }
    return {...base,status:'failed',error:detail.slice(0,300)};
  }
}

export function describeSoundEvidence(value) {
  if(!value || value.status==='not-configured') return 'semantic sound classifier not configured; no semantic sound labels were obtained';
  if(value.status!=='ok') return `semantic sound classification ${value.status}: ${value.error??value.reason??'unavailable'}; this does not establish silence`;
  const rows = value.events.map(e=>`${e.from.toFixed(2)}-${e.to.toFixed(2)}s ${JSON.stringify(e.label)} score=${e.score.toFixed(3)}${e.paddedSeconds > 0 ? ` (zero-padded ${e.paddedSeconds.toFixed(3)}s)` : ''}`);
  return `semantic sound predictions (local YAMNet; uncalibrated scores): ${rows.join('; ')||'none above threshold'}${value.eventsTruncated ? ' [event list truncated to budget]' : ''}\n${DISCLAIMER}`;
}
