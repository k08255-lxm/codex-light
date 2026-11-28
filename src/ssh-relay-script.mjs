import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const setupBody = readFileSync(new URL('./relay-setup.sh', import.meta.url), 'utf8').replace(/\r\n/g,'\n').trimEnd()+'\n';
const digest = createHash('sha256').update(setupBody).digest('hex');
const version = JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
const releaseSource = 'https://raw.githubusercontent.com/k08255-lxm/codex-light/v'+encodeURIComponent(version)+'/src/relay-setup.sh';

const ed25519Header = Buffer.from('0000000b7373682d6564323535313900000020', 'hex');
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function buildRelayInstaller({ hostname, publicKey, hostId, httpsPort = 443, randomPorts = false }) {
  const labels = typeof hostname === 'string' ? hostname.split('.') : [];
  if (labels.length < 2 || hostname.length > 253 || labels.some(label => !dnsLabel.test(label))
    || isIP(hostname) || !/[a-z]/.test(labels.at(-1))
    || /(?:^|\.)(?:localhost|local|internal|home\.arpa|trycloudflare\.com)$/.test(hostname)
    || new URL('https://' + hostname).hostname !== hostname) {
    throw new TypeError('请输入固定的公网 HTTPS 域名');
  }
  if (!Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535 || typeof randomPorts !== 'boolean' ||
      typeof hostId !== 'string' || !/^[0-9a-f]{32}$/.test(hostId) || hostId.length !== 32) {
    throw new RangeError('主机标识或公网端口无效');
  }
  const encoded = typeof publicKey === 'string' && publicKey.startsWith('ssh-ed25519 ') ? publicKey.slice(12) : '';
  const blob = Buffer.from(encoded, 'base64');
  if (blob.length !== 51 || blob.toString('base64') !== encoded || !blob.subarray(0, 19).equals(ed25519Header)) {
    throw new TypeError('需要无注释的 OpenSSH Ed25519 公钥');
  }
  const args = [hostname,publicKey,hostId,randomPorts ? 'auto' : httpsPort].map(value=>"'"+value+"'").join(' ');
  const script = "bash -s -- "+args+" <<'CODECANG_RELAY_SETUP'\n"+setupBody+'CODECANG_RELAY_SETUP\n';
  const command = "( f=$(mktemp) && trap 'rm -f -- \"$f\"' EXIT && curl -fsSL --proto '=https' '"+releaseSource+"' -o \"$f\" && printf '%s  %s\\n' '"+
    digest+"' \"$f\" | sha256sum -c - && bash \"$f\" "+args+" )";
  return {script,command};
}

export function buildRelaySetupScript(options) { return buildRelayInstaller(options).script; }

// Only the generic, tagged file goes to GitHub. Device identifiers and keys stay in the command.
export function createRelaySourceCheck(fetchSource=fetch) {
  let pending, expires=0, published=false;
  return async function available() {
    if(Date.now()<expires)return published;
    if(pending)return pending;
    pending=(async()=>{
      const response=await fetchSource(releaseSource,{signal:AbortSignal.timeout(3500),redirect:'error'});
      if(!response.ok){await response.body?.cancel();return false;}
      const hash=createHash('sha256'), limit=Buffer.byteLength(setupBody);
      let length=0;
      for await(const chunk of response.body){
        length+=chunk.length;
        if(length>limit)return false;
        hash.update(chunk);
      }
      return length===limit && hash.digest('hex')===digest;
    })().catch(()=>false);
    try {published=await pending;expires=Date.now()+(published?3600000:60000);return published;}
    finally {pending=null;}
  };
}
