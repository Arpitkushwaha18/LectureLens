// Explicit one-lecture paid integration check. Local PostgreSQL only; never hosted migrations.
// Captions cost at most one credit on success. No audio, Gemini, or automatic retry.
import '../dist/config/load-env.js';
import {PGlite} from '@electric-sql/pglite';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createDatabase,embeddedRepository} from '../tests/helpers/database.mjs';
import {createFencedTranscriptProvider} from '../dist/services/transcript-extraction.service.js';
import {createTranscriptFetchProvider} from '../dist/modules/extraction/transcriptfetch-transcript.js';
import {createVideoVerifier} from '../dist/services/video-verification.js';
if(!process.argv.includes('--paid-caption-check'))throw new Error('Requires --paid-caption-check: one credit maximum; local database only.');
if(!process.env.TRANSCRIPTFETCH_API_KEY)throw new Error('Backend caption credential is missing.');
const root=fileURLToPath(new URL('../.cache/caption-control/',import.meta.url));
await mkdir(root,{recursive:true,mode:0o700});
// An interrupted run cannot be rerun with a new paid identity.
await writeFile(`${root}one-request.lock`,'Controlled caption verification reserved. Do not delete or resend an uncertain request.\n',{flag:'wx',mode:0o600});
const db=new PGlite(`${root}postgres`);
try{
 await createDatabase(7,db);
 for(const name of ['20261122000900_automatic_captions.sql','20261122001100_final_youtube_workflow.sql','20261122001200_caption_retry_safety.sql'])await db.exec(await readFile(new URL(`../../supabase/migrations/${name}`,import.meta.url),'utf8'));
 const scalar=async(sql,args)=>(await db.query(sql,args)).rows[0]?.value;
 const resources={...embeddedRepository(db),findBestTranscript:async id=>(await db.query("select id,text_content,content_hash,language,metadata from public.transcripts where source_id=$1 and provenance='licensed_provider' and (expires_at is null or expires_at>now()) order by version desc limit 1",[id])).rows[0]??null};
 const jobs={reserve:async id=>(await db.query('select * from public.reserve_automatic_captions($1)',[id])).rows[0],recordRun:(id,_language,token,run)=>scalar('select public.record_automatic_caption_run($1,$2,$3) as value',[id,token,run]),finish:(id,_language,token,text,metadata)=>scalar('select public.finish_automatic_captions($1,$2,$3,$4::jsonb) as value',[id,token,text,JSON.stringify(metadata)]),fail:(id,_language,token,code)=>scalar('select public.fail_automatic_captions($1,$2,$3) as value',[id,token,code])};
 let requests=0;
 const raw=createTranscriptFetchProvider({apiKey:process.env.TRANSCRIPTFETCH_API_KEY},{maxRetries:0,timeoutMs:45000,fetch:async(url,init)=>{requests++;return fetch(url,init);}});
 const provider=createFencedTranscriptProvider(raw,resources,jobs);
 const verifier=createVideoVerifier({resources,provider,metadata:async()=>({title:'Controlled English lecture'}),preflight:async()=>{if(!(await scalar('select public.youtube_storage_health() as value')).ready)throw new Error('Local storage unavailable.');}});
 const results=await Promise.all([verifier.verify('https://youtu.be/WUvTyaaNkzM'),verifier.verify('https://www.youtube.com/watch?v=WUvTyaaNkzM&si=duplicate')]);
 const source=await resources.ensureSource('WUvTyaaNkzM');
 const saved=await resources.findBestTranscript(source);
 const summary={verified:results.every(r=>r.status==='verified'),providerRequests:requests,stored:!!saved,language:saved?.language??null,characters:saved?.text_content.length??0,segments:saved?.metadata?.segments?.length??0,creditsSpent:saved?.metadata?.usage?.creditsSpent??null,studentMessage:results[0].message};
 if(saved){await verifier.verify('https://www.youtube.com/live/WUvTyaaNkzM');summary.reusedWithoutRequest=requests===1;}
 await writeFile(`${root}result.json`,JSON.stringify(summary,null,2),{mode:0o600});
 console.log(JSON.stringify(summary));
}finally{await db.close();}
