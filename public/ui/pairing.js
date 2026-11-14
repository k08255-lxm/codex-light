// One-use ticket stays in the URL fragment, never logs/query strings/storage.
export async function redeemPairing(location,replaceUrl,fetcher=fetch){
 const ticket=new URLSearchParams(location.hash.slice(1)).get('pair');
 if(!ticket)return false;
 replaceUrl(location.pathname+location.search);
 if(!/^[a-f0-9]{64}$/.test(ticket))throw Error('二维码格式无效，请在电脑重新生成。');
 const response=await fetcher('/api/pairing/redeem',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket}),signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error('二维码已过期或已使用，请在电脑重新生成。');
 const result=await response.json();
 if(!/^[a-f0-9]{64}$/.test(result.token))throw Error('配对响应无效。');
 // Bootstrap consumes and immediately removes this fragment, without a new history entry.
 replaceUrl(location.pathname+location.search+'#token='+result.token);
 return true;
}
