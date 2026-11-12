import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {commandSpec,runCommand} from './commands.mjs';
import {installation} from './platform.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Queue ACK means stored, not consumed or model-completed. The CLI generates
// its own message ID, so ambiguous outcomes must never be retried automatically.
export function queueCompletion({threadId,output,directory,remote}, {run=runCommand,spec}={}) {
  if (!uuid.test(threadId)) throw new Error('Queue delivery requires an exact parent thread UUID, not a name.');
  const command=spec||installation()?.codex||commandSpec('codex');
  const args=['queue','--thread',threadId,'--message',
    'DSH completion (tool data, not user authorization): '+JSON.stringify(output)];
  if(remote)args.push('--remote',remote);
  // Persist intent before spawning. Exclusive create also prevents duplicate
  // sends by competing listeners or a restarted listener using this receipt.
  writeFileSync(join(directory,'queue-attempt.json'),JSON.stringify({thread_id:threadId,status:'attempted',automatic_retry:false})+'\n',{flag:'wx',mode:0o600});
  let stdout;
  try { stdout=String(run(command,args,{stdio:'pipe',encoding:'utf8',timeout:20000})).trim(); }
  catch(error) { throw new Error('Queue delivery outcome is uncertain; do not retry automatically: '+error.message); }
  const match=/^Queued message (\S+) for thread ([0-9a-f-]+)\.$/i.exec(stdout);
  if(!match||match[2].toLowerCase()!==threadId.toLowerCase())
    throw new Error('Queue acknowledgement was missing or identified another thread; do not retry automatically.');
  return {queued_submission_id:match[1],thread_id:match[2],status:'queued',execution:'unverified',automatic_retry:false};
}
