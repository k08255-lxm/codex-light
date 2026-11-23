// Match the CLI engines of the two 0.2.3 releases. Desktop probes pass the
// actual Electron Node version, while WSL passes the selected Linux Node.
const supported = '0.2.2 / 0.2.3-alpha.1 / 0.2.3-alpha.2';
function nodeRequirement(version) {
  if (/^0\.2\.2(?:-[\w.-]+)?$/.test(version)) return '>=22.15.0';
  if (version === '0.2.3-alpha.1') return '>=24.9.0';
  if (version === '0.2.3-alpha.2') return '^24.22.3 || >=26.13.1';
  return null;
}
function supportsNode(version,node) {
  if (!/^\d+\.\d+\.\d+$/.test(node)) return false;
  const [major,minor,patch] = node.split('.').map(Number);
  const atLeast = (m,n,p) => major > m || (major === m && (minor > n || (minor === n && patch >= p)));
  switch (nodeRequirement(version)) {
    case '>=22.15.0': return atLeast(22,15,0);
    case '>=24.9.0': return atLeast(24,9,0);
    case '^24.22.3 || >=26.13.1': return (major === 24 && atLeast(24,22,3)) || atLeast(26,13,1);
    default: return false;
  }
}
module.exports = {supported,nodeRequirement,supportsNode};
