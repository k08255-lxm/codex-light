// Appearance and notification preferences.
// Desktop host: preferences are read/written through the local desktop API; the browser build
// uses its own local storage.
import { readPreferences, savePreferences, effectiveAppearance, validatePreferences, DEFAULT_PREFERENCES } from '../preferences.js';

export function createPreferences({ document, window, state, $, el, api, notice, confirm, onChange=()=>{} }) {
  let preferenceStorage;try{preferenceStorage=window.localStorage;}catch{preferenceStorage={getItem(){throw new Error('unavailable');},setItem(){throw new Error('unavailable');}};}
  const loadedPreferences=readPreferences(preferenceStorage);let preferences=loadedPreferences.preferences;
  const colorMedia=window.matchMedia('(prefers-color-scheme: dark)'),motionMedia=window.matchMedia('(prefers-reduced-motion: reduce)');
  let nativeThemePending=null,nativeThemeBusy=false,nativeThemeApplied=null;
  const powerControls=[
    [$('preference-awake-task'),'keepAwakeDuringTask'],
    [$('preference-awake-remote'),'keepAwakeDuringRemote'],
  ];
  function applyPowerPreferences(){
    $('desktop-power-preferences').hidden=!state.desktop;
    for(const [control,key] of powerControls)control.checked=preferences[key];
  }
  async function syncNativeTheme(theme,visualStyle,force=false){
   if(!state.desktop)return;
   const signature=theme+':'+visualStyle;
   if(!force&&nativeThemeApplied===signature&&!nativeThemeBusy)return;
   nativeThemePending={theme,visualStyle};if(nativeThemeBusy)return;nativeThemeBusy=true;
   try{while(nativeThemePending){const desired=nativeThemePending;nativeThemePending=null;try{await api('/api/desktop/theme',desired);nativeThemeApplied=desired.theme+':'+desired.visualStyle;}catch{nativeThemeApplied=null;$('preference-status').textContent='外观已应用，标题栏同步失败。刷新连接可重试。';}}}finally{nativeThemeBusy=false;}
  }
  function applyPreferences(){const effective=effectiveAppearance(preferences,{dark:colorMedia.matches,reduced:motionMedia.matches});const root=document.documentElement;root.dataset.theme=effective.theme;root.dataset.visualStyle=effective.visualStyle;root.dataset.fontScale=effective.fontScale;root.dataset.reducedMotion=String(effective.reducedMotion);for(const button of document.querySelectorAll('[data-theme-choice]'))button.setAttribute('aria-pressed',String(button.dataset.themeChoice===preferences.theme));for(const button of document.querySelectorAll('[data-style-choice]'))button.setAttribute('aria-pressed',String(button.dataset.styleChoice===effective.visualStyle));$('preference-font').value=String(preferences.fontScale);$('preference-motion').value=preferences.motion;$('preference-completion').checked=preferences.completionNotice;$('preference-approval').checked=preferences.approvalNotice;applyPowerPreferences();onChange();if(state.desktop)syncNativeTheme(effective.theme,effective.visualStyle);}
  let desktopStateInstance=null,preferenceSaving=false,desktopPreferencesLoading=false;
  let firstRun=loadedPreferences.firstRun===true,firstThemeOffered=false;
  const dialog=$('first-theme'),form=$('first-theme-form');
  function previewFirstTheme(){
    const draft={...preferences,theme:form.elements.scheme.value,visualStyle:form.elements.skin.value};
    const look=effectiveAppearance(draft,{dark:colorMedia.matches});
    document.documentElement.dataset.theme=look.theme;
    document.documentElement.dataset.visualStyle=look.visualStyle;
  }
  function offerFirstTheme(){
    if(firstThemeOffered||desktopPreferencesLoading)return;
    const androidTheme=window.CodexLightNative?.getPreferredTheme?.();
    if(['system','light','dark'].includes(androidTheme)){
      firstThemeOffered=true;firstRun=false;preferences={...preferences,theme:androidTheme};applyPreferences();return;
    }
    if(!firstRun||typeof dialog.showModal!=='function')return;
    firstThemeOffered=true;
    dialog.showModal();
    previewFirstTheme();
  }
  form.addEventListener('change',previewFirstTheme);
  dialog.addEventListener('cancel',event=>event.preventDefault());
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if(preferenceSaving)return;
    const ok=await changePreferences({theme:form.elements.scheme.value,visualStyle:form.elements.skin.value});
    if(ok){firstRun=false;dialog.close();}
    else $('first-theme-status').textContent='无法保存主题，请重试。';
  });
  async function loadDesktopState(){if(!state.desktop||desktopStateInstance===state.serverInstance)return;$('preference-native-reload').classList.remove('hidden');desktopStateInstance=state.serverInstance;desktopPreferencesLoading=true;firstRun=false;try{const result=await api('/api/desktop/preferences');preferences=validatePreferences(result.preferences);firstRun=result.firstRun===true;applyPreferences();$('preference-status').textContent='';}catch{preferences={...DEFAULT_PREFERENCES};applyPreferences();$('preference-status').textContent='无法读取本机偏好，暂用默认外观。';notice('无法读取本机偏好，请重新加载。',true);}finally{desktopPreferencesLoading=false;}}
  $('preference-native-reload').addEventListener('click',async()=>{if(preferenceSaving)return;desktopStateInstance=null;await loadDesktopState();});
  async function changePreferences(change){if(preferenceSaving||desktopPreferencesLoading){applyPreferences();notice('本机偏好正在读取或保存，请完成后再修改。');return;}const next=validatePreferences({...preferences,...change});preferenceSaving=true;try{if(state.desktop){const result=await api('/api/desktop/preferences',{preferences:next});preferences=validatePreferences(result.preferences);applyPreferences();$('preference-status').textContent='已保存到本机持久偏好。';}else{preferences=savePreferences(preferenceStorage,next);if(change.theme)window.CodexLightNative?.setPreferredTheme?.(next.theme);applyPreferences();$('preference-status').textContent='已保存在当前浏览器的本应用存储。';}firstRun=false;return true;}catch{applyPreferences();notice(state.desktop?'未收到本机偏好的保存回执，可在设置中重新读取。':'无法保存浏览器偏好，未宣称已保存。',true);}finally{preferenceSaving=false;}}
  for(const button of document.querySelectorAll('[data-theme-choice]'))button.addEventListener('click',()=>changePreferences({theme:button.dataset.themeChoice}));for(const button of document.querySelectorAll('[data-style-choice]'))button.addEventListener('click',()=>changePreferences({visualStyle:button.dataset.styleChoice}));
  $('preference-font').addEventListener('change',()=>changePreferences({fontScale:Number($('preference-font').value)}));$('preference-motion').addEventListener('change',()=>changePreferences({motion:$('preference-motion').value}));$('preference-completion').addEventListener('change',()=>changePreferences({completionNotice:$('preference-completion').checked}));$('preference-approval').addEventListener('change',()=>changePreferences({approvalNotice:$('preference-approval').checked}));
  for(const [control,key] of powerControls)control.addEventListener('change',()=>{if(state.desktop)void changePreferences({[key]:control.checked});});
  colorMedia.addEventListener('change',applyPreferences);motionMedia.addEventListener('change',applyPreferences);applyPreferences();if(loadedPreferences.error)$('preference-status').textContent=loadedPreferences.error;

  /** Current preferences (read-only snapshot for other controllers). */
  function current() { return { ...preferences }; }
  /** Pushes the effective theme to the native caption after a (re)connection. */
  function syncHostTheme() { const appearance = effectiveAppearance(preferences, { dark: colorMedia.matches, reduced: motionMedia.matches }); syncNativeTheme(appearance.theme, appearance.visualStyle, true); }
  return { loadDesktopState, applyPreferences, syncHostTheme, offerFirstTheme, current };
}
