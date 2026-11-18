const MAX_HIGHLIGHT_CHARS = 16000;
const MAX_HIGHLIGHT_TOKENS = 700;

const words = value => new Set(value.split(' '));
const cKeywords = words('abstract as async await break case catch class const continue default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try type typeof undefined using var void while with yield');
const pythonKeywords = words('and as assert async await break case class continue def del elif else except False finally for from global if import in is lambda match None nonlocal not or pass raise return True try while with yield');
const shellKeywords = words('begin break case continue do done elif else end esac exit fi for foreach function if in local readonly return set then trap unset until while');
const jsonKeywords = words('false null true');
const profiles = {
  c: { comments: String.raw`//[^\n]*|/\*[\s\S]*?(?:\*/|$)`, keywords: cKeywords },
  python: { comments: '#[^\n]*', keywords: pythonKeywords },
  shell: { comments: '#[^\n]*', keywords: shellKeywords },
  json: { comments: '', keywords: jsonKeywords },
};
const aliases = new Map([
  ...['c','cpp','csharp','cs','go','java','js','javascript','jsx','kt','kotlin','rs','rust','swift','ts','tsx','typescript'].map(name=>[name,'c']),
  ...['py','python'].map(name=>[name,'python']),
  ...['bash','bat','cmd','fish','powershell','ps1','pwsh','sh','shell','zsh'].map(name=>[name,'shell']),
  ['json','json'],['jsonc','json'],
]);
const strings = String.raw`"(?:\\[^\n]|[^"\\\n])*"|'(?:\\[^\n]|[^'\\\n])*'|\x60(?:\\[^\n]|[^\x60\\\n])*\x60`;
const number = String.raw`\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b`;
const identifiers = String.raw`[A-Za-z_$][\w$-]*`;
const logLevels = /\b(?<error>ERROR|FATAL|EXCEPTION|FAIL(?:ED|URE)?)\b|\b(?<warning>WARN(?:ING)?)\b|\b(?<success>PASS(?:ED)?|SUCCESS)\b/g;

export function displayConsoleText(source) {
  return String(source ?? '').replace(/\u001b\][^\u0007\u001b\n]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

export function syntaxParts(source, language) {
  if (!source || source.length > MAX_HIGHLIGHT_CHARS) return null;
  const profile = profiles[aliases.get(String(language || '').toLowerCase())];
  if (!profile && language !== 'log') return null;
  const comments = profile?.comments ? `(?<comment>${profile.comments})|` : '';
  const pattern = language === 'log' ? logLevels : new RegExp(`${comments}(?<string>${strings})|(?<number>${number})|(?<word>${identifiers})`, 'g');
  const parts = [];
  let end = 0;
  for (const match of source.matchAll(pattern)) {
    const kind = Object.keys(match.groups).find(key => match.groups[key] !== undefined);
    if (kind === 'word' && !profile.keywords.has(match[0])) continue;
    if (parts.length > MAX_HIGHLIGHT_TOKENS) return null;
    if (match.index > end) parts.push({ text: source.slice(end, match.index) });
    parts.push({ kind: kind === 'word' ? 'keyword' : kind, text: match[0] });
    end = match.index + match[0].length;
  }
  if (!parts.length) return null;
  if (end < source.length) parts.push({ text: source.slice(end) });
  return parts;
}

const codeText = new WeakMap();
export function updateConsoleCode(pre, source, language = 'log') {
  const text = displayConsoleText(source);
  if (codeText.get(pre) === text) return;
  codeText.set(pre, text);
  const document = pre.ownerDocument;
  const code = document.createElement('code');
  const parts = syntaxParts(text, language);
  if (!parts) code.textContent = text;
  else for (const part of parts) {
    if (!part.kind) code.append(document.createTextNode(part.text));
    else {
      const token = document.createElement('span');
      token.className = `syntax-${part.kind}`;
      token.textContent = part.text;
      code.append(token);
    }
  }
  const scroll = pre.scrollLeft;
  pre.replaceChildren(code);
  pre.scrollLeft = scroll;
}

export function createConsoleCode(document, className = '', text = '', language = 'log') {
  const pre = document.createElement('pre');
  pre.className = ['console-output', className].filter(Boolean).join(' ');
  pre.tabIndex = 0;
  updateConsoleCode(pre, text, language);
  return pre;
}
