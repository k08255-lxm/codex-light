// One process-wide owner covers both updater writes and cleanup snapshots/mutations.
export class StorageOperationReservation {
 owner=null;
 async run(owner,fn){
  if(this.owner)throw Object.assign(new Error('Storage or update maintenance is already active'),{code:'STORAGE_BUSY',status:409,outcome:'notExecuted'});
  this.owner=owner;
  try{return await fn();}finally{this.owner=null;}
 }
}
