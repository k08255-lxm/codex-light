const LABELS={minimal:'最少',low:'低',medium:'中',high:'高',xhigh:'极高',max:'Max',ultra:'Ultra'};
const AX={minimal:'最少',low:'轻度',medium:'标准',high:'深度',xhigh:'极高',max:'Max',ultra:'Ultra'};
export const effortLabel=value=>LABELS[value]||String(value||'默认');
export const effortAccessibleLabel=value=>AX[value]||effortLabel(value);
export function reasoningChoices(model){return [...new Set((model?.supportedReasoningEfforts||[]).map(e=>typeof e==='string'?e:e.reasoningEffort).filter(v=>typeof v==='string'&&v))];}
export function nextEffort(model,previous=''){return reasoningChoices(model).includes(previous)?previous:'';}
export function reasoningView(model,selected='') {const choices=reasoningChoices(model);const effective=choices.includes(selected)?selected:choices.includes(model?.defaultReasoningEffort)?model.defaultReasoningEffort:null;return {choices,effective,index:effective===null?-1:choices.indexOf(effective),isDefault:!choices.includes(selected)};}
export function restoredReasoning(value){return {inherited:typeof value==='string'&&value?value:null,override:null};}
export function selectedReasoningView(model,selection){const choices=reasoningChoices(model);const effective=selection?.override??selection?.inherited??null;return {choices,effective,index:choices.indexOf(effective),inherited:selection?.override==null};}
export function resetReasoning(model,selection){return {inherited:selection?.inherited??null,override:catalogDefault(model)};}
export function switchedReasoning(model,selection,{configuredModel=null,selectedModel=null}={}){const value=selection?.override??selection?.inherited;const choices=reasoningChoices(model);if(selectedModel==='')return {inherited:null,override:null};if(!value&&configuredModel&&selectedModel===configuredModel)return {inherited:null,override:null};return {inherited:null,override:choices.includes(value)?value:catalogDefault(model)};}
export function reasoningParameter(selection){return selection?.override||undefined;}
export function activeModelId(selected,defaults){const explicit=typeof selected==='string'&&selected?selected:null;return explicit||(typeof defaults?.model==='string'&&defaults.model?defaults.model:null);}
// The model catalog default is only sent after an explicit user reset/model switch.
// It must never stand in for the user's own Codex configuration default.
function catalogDefault(model){const choices=reasoningChoices(model);return typeof model?.defaultReasoningEffort==='string'&&choices.includes(model.defaultReasoningEffort)?model.defaultReasoningEffort:null;}
export function configuredReasoningView(model,selection,defaults,activeModel=defaults?.model??null){
 const view=selectedReasoningView(model,selection);
 if(view.effective!=null)return {...view,source:selection?.override!=null?'override':selection?.inherited!=null?'inherited':'unknown',configured:null,configUnsupported:false,configSupport:null};
 const configured=typeof defaults?.reasoningEffort==='string'&&defaults.reasoningEffort?defaults.reasoningEffort:null;
 const matched=!!configured&&typeof defaults?.model==='string'&&!!defaults.model&&activeModel===defaults.model;
 if(!matched)return {...view,source:'unknown',configured:null,configUnsupported:false,configSupport:null};
 const supported=view.choices.includes(configured),known=!!model;
 return {choices:view.choices,effective:supported?configured:null,index:supported?view.choices.indexOf(configured):-1,inherited:false,source:supported?'config':'unknown',configured,configUnsupported:known&&!supported,configSupport:supported?'supported':known?'unsupported':'unknown'};
}
export function defaultModelView(models,selected,defaults){
 const list=Array.isArray(models)?models:[];
 const explicit=typeof selected==='string'&&selected?selected:null;
 const configured=typeof defaults?.model==='string'&&defaults.model?defaults.model:null;
 const id=explicit||configured;
 const entry=id?list.find(model=>model?.model===id):null;
 const name=entry?.displayName||entry?.model||id||null;
 const outsideCatalog=!!id&&!entry&&list.length>0;
 return {id,name,displayName:name?(outsideCatalog?name+'（目录外）':name):null,source:explicit?'selected':configured?'config':'unknown',outsideCatalog};
}
