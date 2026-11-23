// Authenticates only through the documented free /api/v2/me endpoint. No captions or generation.
import {config} from 'dotenv';
import {fileURLToPath} from 'node:url';
import {TranscriptFetch,APIError,VERSION} from 'transcriptfetch';
config({path:fileURLToPath(new URL('../.env',import.meta.url)),quiet:true});
if(!process.env.TRANSCRIPTFETCH_API_KEY){console.error('TranscriptFetch credential is missing from backend/.env.');process.exitCode=1;}
else try{
 const me=await new TranscriptFetch({apiKey:process.env.TRANSCRIPTFETCH_API_KEY,timeout:15000,maxRetries:0}).me();
 console.log(`TranscriptFetch SDK ${VERSION}: authenticated; caption credits ${me.credits}. Free check, no caption requests.`);
}catch(error){console.error(`TranscriptFetch authentication check: ${error instanceof APIError?`${error.status}/${error.code}`:'connection or timeout'}. No caption requests.`);process.exitCode=1;}
