export const PREFERENCE_KEY='codex-light-preferences-v1';
export const DEFAULT_PREFERENCES=Object.freeze({version:1,theme:'dark',fontScale:100,motion:'system',completionNotice:true,approvalNotice:true,visualStyle:'codex',keepAwakeDuringTask:false,keepAwakeDuringRemote:false,desktopCompanion:'off'});
const REQUIRED_KEYS=Object.freeze(['version','theme','fontScale','motion','completionNotice','approvalNotice']);
export const VISUAL_STYLES=Object.freeze(['codex','claude','dsh']);
const invalid=()=>new Error('本地偏好格式无效；没有应用损坏或未知字段。');
export function validatePreferences(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!Object.hasOwn(DEFAULT_PREFERENCES,key))||REQUIRED_KEYS.some(key=>!Object.hasOwn(value,key)))throw invalid();
 const normalized={...DEFAULT_PREFERENCES,...value};
 if(normalized.version!==1||!['dark','light','system'].includes(normalized.theme)||![90,100,110,125].includes(normalized.fontScale)||!['system','on','off'].includes(normalized.motion)||!VISUAL_STYLES.includes(normalized.visualStyle))throw invalid();
 if(['completionNotice','approvalNotice','keepAwakeDuringTask','keepAwakeDuringRemote'].some(key=>typeof normalized[key]!=='boolean'))throw invalid();
 if(!['off','nailong','lulu'].includes(normalized.desktopCompanion))throw invalid();
 return normalized;
}
export function readPreferences(storage){try{const raw=storage.getItem(PREFERENCE_KEY);return{preferences:raw?validatePreferences(JSON.parse(raw)):{...DEFAULT_PREFERENCES},error:null,...(raw===null?{firstRun:true}:{})};}catch{return{preferences:{...DEFAULT_PREFERENCES},error:'本地偏好无法读取，已使用默认设置；原记录未删除。'};}}
export function savePreferences(storage,value){const prefs=validatePreferences(value);storage.setItem(PREFERENCE_KEY,JSON.stringify(prefs));return prefs;}
export function effectiveAppearance(preferences,{dark=false,reduced=false}={}){return{theme:preferences.theme==='system'?(dark?'dark':'light'):preferences.theme,fontScale:String(preferences.fontScale),reducedMotion:preferences.motion==='system'?reduced:preferences.motion==='on',visualStyle:preferences.visualStyle??'codex'};}
