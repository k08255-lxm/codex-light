// JSON-RPC integer and string ids are different identities, including 1 and "1".
export const validServerRequestId=id=>typeof id==='string'||Number.isSafeInteger(id);
export const serverRequestKey=id=>JSON.stringify([typeof id,id]);
export function findServerRequest(requests,id){
 if(!validServerRequestId(id))return undefined;
 for(const request of requests.values())if(request.id===id)return request;
}
export function removeServerRequest(requests,id){
 if(!validServerRequestId(id))return undefined;
 for(const [key,request]of requests)if(request.id===id){requests.delete(key);return request;}
}
export const serverRequestThread=request=>request.params?.threadId??request.params?.conversationId;
