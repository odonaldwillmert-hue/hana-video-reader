import { defineApp } from './sdk/app-contract/server-client.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createVideoTool, parameters, description, permission } from './lib/adapter.js';

export default defineApp(async sdk => {
  // Scope the vendored engine's caches/temp files to this App, never to DSHana's profile.
  const tmp=join(sdk.dataDir,'tmp');
  const home=join(sdk.dataDir,'engine-home');
  const cache=join(sdk.dataDir,'cache');
  await Promise.all([tmp,home,cache].map(p=>mkdir(p,{recursive:true})));
  process.env.TEMP=tmp; process.env.TMP=tmp; process.env.TMPDIR=tmp;
  process.env.DSH_HOME=home; process.env.DSH_VIDEO_CACHE_DIR=cache;
  // Explicit local empty ASR config prevents the engine probing unrelated ~/.dsh settings.
  try { await writeFile(join(home,'asr.json'),'{}',{flag:'wx'}); } catch(e) { if(e.code!=='EEXIST') throw e; }
  const {runStoryboard,formatManifest}=await import('./vendor/dsh-video-storyboard/src/pipeline.js');
  const execute=createVideoTool(sdk,{run:runStoryboard,format:formatManifest});
  await sdk.tools.register({name:'video_evidence',description,parameters,sessionPermission:permission,execute});
  await sdk.logger.info('Hana视频读取 0.1.2 ready; engine action.3; audio/network acquisition disabled');
});
