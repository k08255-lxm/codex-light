export function editProjectName(document, group) {
  return new Promise(resolve => {
    const dialog=document.createElement('dialog');const form=document.createElement('form');form.method='dialog';
    const heading=document.createElement('h2');heading.id='project-name-heading';heading.textContent='编辑项目名称';dialog.setAttribute('aria-labelledby',heading.id);
    const label=document.createElement('label');label.className='field';label.textContent='项目名称';const input=document.createElement('input');input.value=group.name;input.maxLength=120;input.required=true;input.autocomplete='off';label.append(input);
    const actions=document.createElement('div');actions.className='work-row end';const cancel=document.createElement('button');cancel.type='button';cancel.className='btn';cancel.textContent='取消';const save=document.createElement('button');save.type='submit';save.className='btn primary';save.textContent='保存';actions.append(cancel,save);form.append(heading,label,actions);dialog.append(form);document.body.append(dialog);
    let result=null;cancel.addEventListener('click',()=>dialog.close());input.addEventListener('input',()=>input.setCustomValidity(''));
    form.addEventListener('submit',event=>{if(!input.value.trim()||/[\u0000-\u001f\u007f]/.test(input.value)){event.preventDefault();input.setCustomValidity('请输入有效的项目名称');input.reportValidity();return;}result=input.value.trim();});
    dialog.addEventListener('close',()=>{dialog.remove();resolve(result);},{once:true});dialog.showModal();input.focus();input.select();
  });
}
