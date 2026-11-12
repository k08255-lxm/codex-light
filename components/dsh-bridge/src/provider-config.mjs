import {readFileSync} from 'node:fs';

// Reuse only provider declarations, never the desktop tool tree or secret data.
export function providerOverlay(file) {
  if (!file) return '';
  const source = readFileSync(file,'utf8');
  const blocks = source.split(/(?=^- id: )/m);
  const block = blocks.find(row => /^- id: llm-pi-ai\s*$/m.test(row));
  if (!block || !/name: ['"]?@deepseek-ai\/dsh-llm-pi-ai['"]?\s*$/m.test(block)) throw new Error('Desktop provider configuration not found');
  if (/^\s*(?:apiKey|api_key|authorization|headers|token|password|secret|credentials)\s*:/im.test(block) || /!!js\b/.test(block)) {
    throw new Error('Provider configuration contains inline credentials or code; refusing to copy it');
  }
  // The source row patches a desktop entry; the SDK profile needs an insertion.
  return '- insert:\n'+block.trimEnd().split('\n').map(line=>'    '+line).join('\n')+'\n';
}
