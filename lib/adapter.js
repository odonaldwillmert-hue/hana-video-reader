import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, extname, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createReviewController } from '../vendor/dsh-video-storyboard/src/review.js';

export const VERSION = '0.1.0';
export const ENGINE_VERSION = '0.4.3-action.3';
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_LIVE_REVIEWS = 32;
const TTL = 3600000;
const VIDEO_EXTENSIONS = new Set(['.mp4','.mov','.mkv','.webm','.avi','.m4v','.mpeg','.mpg']);
export const parameters = {
  type: 'object', additionalProperties: false, required: ['action'],
  properties: {
    action: {type:'string', enum:['health','configure','start','inspect','status','finish','export']},
    input: {type:'string', description:'已获授权的本地视频绝对路径；与fileId二选一，拒绝URL和网络盘。'},
    fileId: {type:'string', description:'当前会话的视频SessionFile ID，优先使用。'},
    from: {type:'number', minimum:0, description:'秒；start/inspect必填。'},
    to: {type:'number', description:'秒；大于from，窗口不超过12秒。'},
    reviewId: {type:'string', description:'start返回的ID，限原会话使用。'},
    mode: {type:'string', enum:['sequence','detail'], description:'sequence看前后；detail为少量大格，不是ROI裁剪。'},
    ffmpegPath: {type:'string', description:'仅configure：现有FFmpeg绝对路径。'},
    ffprobePath: {type:'string', description:'仅configure：现有FFprobe绝对路径。'}
  }
};
export const description = 'Hana原生本地视频读取。health检查环境；configure保存现有FFmpeg路径；start返回9格概览PNG与真实时间，窗口<=12秒；inspect按需补看（sequence或detail），同微网格区间采用互补采样。每review累计最多3图、5次生成，重复补看不重新送图；预算满就报告未知，不开新review绕过。status/finish/export。它只提供证据，不识别动作或计算准确率；必须实际读取图片、分清直接可见与推断。不上传音频、不下载、不OCR、不调用模型。';
export const permission = {kind:'write',auto:'allow',description:'在App自有目录生成视频证据，执行本地FFmpeg；不修改源视频。'};

export function localVideoRef(args) {
  if (Boolean(args.input) === Boolean(args.fileId)) throw new Error('input 与 fileId 必须且只能提供一个');
  if (args.fileId) {
    if (typeof args.fileId !== 'string' || args.fileId.length > 256) throw new Error('invalid fileId');
    return {kind:'session-file',fileId:args.fileId};
  }
  const p = String(args.input).trim();
  if (!isAbsolute(p) || /^[\\/]{2}/.test(p) || /^[a-z][a-z0-9+.-]*:\/\//i.test(p)) throw new Error('只接受本机绝对路径，不下载URL或访问UNC');
  if (!VIDEO_EXTENSIONS.has(extname(p).toLowerCase())) throw new Error('不支持该视频扩展名；不接受播放列表、脚本或目录');
  return {kind:'local-file',path:p};
}
export function checkWindow(from,to) {
  if (!Number.isFinite(from)||!Number.isFinite(to)||from<0||to<=from||to-from>12) throw new Error('必须提供0<=from<to且窗口不超过12秒');
}
const json = (value) => JSON.stringify(value,null,2);
const textResult = (data,isError=false) => ({content:[{type:'text',text:json(data)}],details:data,...(isError?{isError:true}:{})});
const ownerOf = (args) => {
  const owner = args.context?.sessionPath;
  if (typeof owner !== 'string' || !owner) throw new Error('此操作需要真实Hana会话上下文；直接runTool不能代替会话实测');
  return owner;
};
// Avoid presenting upstream's constant token estimate as measured Hana token use.
export function cleanManifest(text) { return String(text).replace(/tokens="[^"]*"/g,'tokens="unknown (Hana provider usage not measured)"'); }

export function createVideoTool(sdk,{run,format,now=()=>Date.now()}={}) {
  if (typeof run!=='function'||typeof format!=='function') throw new Error('run and format required');
  const reviews = new Map();
  const starting = new Set();
  const dataRoot = join(sdk.dataDir,'evidence');
  async function executables(overrides={}) {
    const cfg = await sdk.config.getAll();
    const result = {};
    for (const [key,command] of [['ffmpegPath','ffmpeg'],['ffprobePath','ffprobe']]) {
      const choice = overrides[key] ?? cfg[key] ?? '';
      if (choice && (!isAbsolute(choice) || /^[\\/]{2}/.test(choice))) throw new Error(`${key} 必须是本机绝对路径`);
      const found = await sdk.process.resolveExecutable({candidates:[choice||command]});
      if (!found) throw new Error(`未找到${command}；请通过应用设置或configure指定现有程序，不自动安装`);
      result[key]=found.path;
    }
    return result;
  }
  function getReview(args) {
    const owner=ownerOf(args);
    const entry=reviews.get(args.reviewId);
    if (!entry || entry.owner!==owner) throw new Error('reviewId不存在、已重启失效或不属于当前会话');
    entry.lastAt=now();
    return entry;
  }
  async function record(entry,action,response) {
    const {result,...state}=response;
    const seq=entry.events.length+1;
    const pictures=[];
    for (const image of result?.images??[]) {
      const bytes=Buffer.from(image.data);
      if (bytes.length<8 || bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a') throw new Error('内核没有返回真实PNG字节');
      const filename=`${String(seq).padStart(2,'0')}-${pictures.length+1}.png`;
      await writeFile(join(entry.directory,filename),bytes,{flag:'wx'});
      pictures.push({file:filename,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
    }
    const event={sequence:seq,at:new Date(now()).toISOString(),action,state,manifest:result?.text??null,metadata:result?.metadata??null,images:pictures};
    entry.events.push(event);
    const evidence={schemaVersion:1,appVersion:VERSION,engineVersion:ENGINE_VERSION,reviewId:response.reviewId,source:entry.source,sourceSha256:entry.sourceSha256,sourceBytes:entry.sourceBytes,sourceSnapshot:true,audioStatus:'not-analyzed-no-cloud-upload',actualTokens:null,accuracyStatus:'not-evaluated',events:entry.events};
    await writeFile(join(entry.directory,'evidence.json'),json(evidence));
    const content=[{type:'text',text:json({...state,appVersion:VERSION,engineVersion:ENGINE_VERSION,audioStatus:evidence.audioStatus,actualTokens:null,accuracyStatus:'not-evaluated',metadata:result?.metadata??null})+(result?.text?'\n\n'+result.text:'')}];
    for (const image of result?.images??[]) content.push({type:'image',mimeType:'image/png',data:Buffer.from(image.data).toString('base64')});
    return {content,details:{reviewId:response.reviewId,status:response.status,imagesUsed:response.imagesUsed,attemptsUsed:response.attemptsUsed,evidencePath:join(entry.directory,'evidence.json'),imageCount:pictures.length},...(response.error?{isError:true}:{})};
  }
  return async function execute(args={}) {
    try {
      if (args.action==='health') return textResult({appVersion:VERSION,engineVersion:ENGINE_VERSION,executables:await executables(),limits:{maxWindowSeconds:12,images:3,attempts:5,maxSourceBytes:MAX_SOURCE_BYTES},audio:'disabled',network:'no app network calls; external FFmpeg has OS-user process rights',accuracy:'not-established'});
      if (args.action==='configure') {
        if (!args.ffmpegPath||!args.ffprobePath) throw new Error('configure须同时给出ffmpegPath与ffprobePath');
        const tools=await executables(args);
        await sdk.config.setMany(tools);
        return textResult({status:'saved',executables:tools,effect:'下一个start使用；已有review保持原工具路径'});
      }
      if (args.action==='start') {
        const owner=ownerOf(args); checkWindow(args.from,args.to);
        const source=localVideoRef(args);
        if (starting.has(owner)) throw new Error('本会话已有start正在执行，请等待');
        for (const [id,e] of reviews) if (!e.busy&&now()-e.lastAt>TTL) reviews.delete(id);
        if (reviews.size+starting.size>=MAX_LIVE_REVIEWS) throw new Error('活跃复核已达32份上限；请先结束旧任务或等待过期');
        starting.add(owner);
        try {
          const tools=await executables();
          const materialized=await sdk.resources.materialize(source);
          const path=materialized?.filePath;
          if (typeof path!=='string'||!isAbsolute(path)) throw new Error('ResourceIO没有返回合法filePath');
          const extension=extname(path).toLowerCase();
          if (!VIDEO_EXTENSIONS.has(extension)) throw new Error('SessionFile不是支持的视频文件');
          const info=await sdk.resources.stat({kind:'local-file',path});
          const size=info?.size??info?.stat?.size??info?.metadata?.size;
          if (Number.isFinite(size)&&size>MAX_SOURCE_BYTES) throw new Error('源视频超过512MiB，请先由用户选择较短本地片段');
          const directory=join(dataRoot,randomUUID());
          await mkdir(directory,{recursive:true});
          const local=join(directory,'source'+extension);
          await sdk.resources.copy({kind:'local-file',path},{kind:'local-file',path:local});
          const imported=await stat(local);
          if (!imported.isFile()||imported.size>MAX_SOURCE_BYTES) throw new Error('导入后文件不是普通视频或超过512MiB');
          const entry={owner,directory,source,sourceBytes:imported.size,sourceSha256:null,events:[],lastAt:now(),busy:true};
          entry.controller=createReviewController({run:async opts=>{
            const r=await run({...opts,...tools,cache:false,sourceHash:true,frameConcurrency:3,audioStrip:false,transcript:'off'});
            entry.sourceSha256=r.provenance?.sha256??entry.sourceSha256;
            return r;
          },format:r=>cleanManifest(format(r)),maxEntries:1});
          const response=await entry.controller.start({input:local,from:args.from,to:args.to});
          entry.busy=false;
          if (!response.reviewId) throw new Error('未取得reviewId');
          reviews.set(response.reviewId,entry);
          return await record(entry,'start',response);
        } finally { starting.delete(owner); }
      }
      if (!['inspect','status','finish','export'].includes(args.action)) throw new Error('未知action');
      const entry=getReview(args);
      if (entry.busy) throw new Error('本review正在生成，请等待，不重复提交');
      if (args.action==='export') {
        const receipt=await sdk.resources.stage({path:join(entry.directory,'evidence.json'),name:'video-evidence.json',mime:'application/json'});
        return textResult({status:'exported',reviewId:args.reviewId,receipt});
      }
      if (args.action==='inspect') checkWindow(args.from,args.to);
      entry.busy=true;
      try {
        const response=await entry.controller[args.action]({reviewId:args.reviewId,...(args.action==='inspect'?{from:args.from,to:args.to,mode:args.mode??'sequence'}:{})});
        return await record(entry,args.action,response);
      } finally { entry.busy=false; }
    } catch (error) {
      return textResult({status:'error',error:String(error?.message??error).slice(0,700),accuracyStatus:'not-evaluated'},true);
    }
  };
}
