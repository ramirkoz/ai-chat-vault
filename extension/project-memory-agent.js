'use strict';

(() => {
  let lastUrl=location.href;
  let timer=null;
  let lastSignature='';
  let lastProjectDispatch=0;
  let lastProjectId='';
  let navigationGeneration=0;
  let sending=false;
  let bypassSend=false;
  const injectedKeys=new Set();

  const clean=(value)=>String(value || '').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();

  const projectContext=()=>{
    const url=location.href;
    const projectId=url.match(/\b(g-p-[a-z0-9_-]+)\b/i)?.[1] || url.match(/\/projects?\/([^/?#]+)/i)?.[1] || '';
    const currentTitle=clean(document.querySelector('[data-testid*="conversation-title"]')?.textContent || document.querySelector('main h1')?.textContent || document.title?.replace(/\s*[|–-]\s*ChatGPT.*$/i,'') || '');
    let projectName=''; let projectNameConfidence='none';
    if(projectId){
      const scored=[];
      for(const node of [...document.querySelectorAll('a[href],nav a[href],[data-testid*="project"],[aria-label]')].slice(0,800)){
        const href=String(node.getAttribute?.('href') || ''); const testid=String(node.getAttribute?.('data-testid') || ''); const aria=String(node.getAttribute?.('aria-label') || ''); const text=clean(node.textContent || aria || '');
        if(!text || text.length>120 || text===currentTitle || /^(?:projects?|проєкти?|project|new chat|новий чат)$/iu.test(text)) continue;
        let score=0; if(href.includes(projectId)&&!/\/c\//i.test(href))score+=100; if(href.includes(`/g/${projectId}`)&&!/\/c\//i.test(href))score+=40; if(/project/i.test(testid)&&!/conversation|thread|chat/i.test(testid))score+=25; if(/project|проєкт/i.test(aria)&&!/conversation|thread|chat|гілк/i.test(aria))score+=15; if(node.closest?.('nav,[aria-label*="breadcrumb" i],[data-testid*="breadcrumb" i]'))score+=15; if(/\/c\//i.test(href))score-=120;
        if(score>0)scored.push({text,score});
      }
      scored.sort((a,b)=>b.score-a.score || a.text.length-b.text.length);
      if(scored[0]){projectName=scored[0].text;projectNameConfidence=scored[0].score>=80?'high':'medium';}
    }
    const links=projectId?[...new Set([...document.querySelectorAll('a[href*="/c/"]')].map((a)=>{try{return new URL(a.href,location.href).href;}catch(_){return'';}}).filter((href)=>href&&href.includes(projectId)&&/\/c\/[a-z0-9-]{8,}/i.test(href)))].slice(0,200):[];
    if(projectId&&/\/c\/[a-z0-9-]{8,}/i.test(url)&&!links.includes(url))links.unshift(url);
    return {projectId,projectName,projectNameConfidence,url,links};
  };

  // 2.33.0 UI: message units live in the visible selection target; hidden copies of
  // previously opened chats stay mounted and must not count as turns.
  const isShown=(element)=>Boolean(element&&element.getClientRects().length&&element.offsetHeight>0);
  const messageUnits=()=>{const thread=[...document.querySelectorAll('[data-chatgpt-conversation-selection-target]')].filter(isShown).pop();const units=thread?[...thread.querySelectorAll('[data-chatgpt-search-unit-key]')]:[];return units.length?units:[...document.querySelectorAll('main [data-message-author-role="user"],main [data-message-author-role="assistant"]')].filter(isShown);};
  const signature=()=>{const turns=messageUnits();const last=turns[turns.length-1];const tail=String(last?.textContent || '').replace(/\s+/g,' ').trim().slice(-800);return `${location.href}|${turns.length}|${tail}`;};

  const dispatchProjectSync=async(context,{force=false}={})=>{
    if(!context?.projectId)return;
    const now=Date.now();
    const projectChanged=context.projectId!==lastProjectId;
    if(!force&&!projectChanged&&now-lastProjectDispatch<45*1000)return;
    lastProjectId=context.projectId; lastProjectDispatch=now;
    try{await chrome.runtime.sendMessage({type:'project-memory-auto-sync-project',context:{projectId:context.projectId,projectName:context.projectName,projectNameConfidence:context.projectNameConfidence},links:context.links});}catch(_){}
  };

  // Conversation autosave may wait for DOM stability. Whole-project sync must not.
  const scheduleAutosave=(delay=5000)=>{clearTimeout(timer);timer=setTimeout(async()=>{const next=signature();if(!next||next===lastSignature)return;lastSignature=next;const context=projectContext();try{await chrome.runtime.sendMessage({type:'project-memory-autosave',context});}catch(_){}},delay);};

  const startProjectSyncNow=()=>{const context=projectContext();if(context.projectId)void dispatchProjectSync(context,{force:true});};

  function composer(){return document.querySelector('#prompt-textarea,[contenteditable="true"][data-composer-markdown],[contenteditable="true"][data-lexical-editor="true"],[contenteditable="true"][role="textbox"],textarea');}
  function composerText(editor=composer()){return clean(editor?.value ?? editor?.innerText ?? editor?.textContent ?? '');}
  function visibleTurns(){return messageUnits().length || (/\/c\/[a-z0-9-]{8,}/i.test(location.pathname)?1:0);}
  function isSendButton(node){const button=node?.closest?.('button');if(!button)return null;const descriptor=`${button.getAttribute('data-testid') || ''} ${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''}`;return /send-button|send message|send prompt|надісл|відправ|отправ/i.test(descriptor)?button:null;}
  function findSendButton(){return [...document.querySelectorAll('button')].find((button)=>isSendButton(button)===button && !button.disabled) || null;}
  function currentConversationKey(context){const conversationId=location.pathname.match(/\/c\/([a-z0-9-]{8,})/i)?.[1] || '';return conversationId?`${context.projectId}|${conversationId}`:`${context.projectId}|new|${navigationGeneration}`;}

  function setComposerText(editor,value){
    editor.focus();
    if('value' in editor){
      const proto=Object.getPrototypeOf(editor); const descriptor=Object.getOwnPropertyDescriptor(proto,'value');
      if(descriptor?.set) descriptor.set.call(editor,value); else editor.value=value;
      editor.dispatchEvent(new Event('input',{bubbles:true}));
      return true;
    }
    try{
      const selection=getSelection(); const range=document.createRange(); range.selectNodeContents(editor); selection.removeAllRanges(); selection.addRange(range); document.execCommand('insertText',false,value); selection.removeAllRanges();
    }catch(_){editor.textContent=value;}
    editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:null}));
    return true;
  }

  async function injectAndSend(triggerButton=null){
    if(bypassSend||sending)return false;
    const context=projectContext(); if(!context.projectId)return false;
    const editor=composer(); const draft=composerText(editor); if(!editor||!draft)return false;
    if(/\[LOCAL PROJECT MEMORY:/i.test(draft))return false;
    if(visibleTurns()>0)return false;
    const key=currentConversationKey(context); if(injectedKeys.has(key))return false;
    sending=true;
    try{
      const response=await chrome.runtime.sendMessage({type:'project-memory-retrieve-context',context:{projectId:context.projectId,projectName:context.projectName,projectNameConfidence:context.projectNameConfidence},links:context.links,query:draft,currentUrl:location.href});
      const block=String(response?.contextBlock || '').trim();
      if(block)setComposerText(editor,`${block}\n\n[CURRENT REQUEST]\n${draft}`);
      injectedKeys.add(key);
      bypassSend=true;
      await new Promise((resolve)=>setTimeout(resolve,40));
      const button=triggerButton && !triggerButton.disabled ? triggerButton : findSendButton();
      if(button) button.click();
      else {
        editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}));
        editor.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}));
      }
      setTimeout(()=>{bypassSend=false;},120);
      return true;
    }catch(_){
      bypassSend=true;
      const button=triggerButton && !triggerButton.disabled ? triggerButton : findSendButton();
      if(button)button.click();
      setTimeout(()=>{bypassSend=false;},120);
      return true;
    }finally{sending=false;}
  }

  document.addEventListener('click',(event)=>{
    if(bypassSend)return;
    const button=isSendButton(event.target); if(!button)return;
    const context=projectContext(); if(!context.projectId||visibleTurns()>0)return;
    const draft=composerText(); if(!draft)return;
    event.preventDefault(); event.stopImmediatePropagation(); void injectAndSend(button);
  },true);

  document.addEventListener('keydown',(event)=>{
    if(bypassSend||event.key!=='Enter'||event.shiftKey||event.ctrlKey||event.metaKey||event.altKey||event.isComposing)return;
    const editor=composer(); if(!editor||!(event.target===editor||editor.contains?.(event.target)))return;
    const context=projectContext(); if(!context.projectId||visibleTurns()>0||!composerText(editor))return;
    event.preventDefault(); event.stopImmediatePropagation(); void injectAndSend(findSendButton());
  },true);

  const observer=new MutationObserver(()=>scheduleAutosave(6500)); observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true});

  // Project synchronization is deliberately independent of ChatGPT's streaming/rendering DOM.
  setTimeout(startProjectSyncNow,250);
  setInterval(()=>{
    const nextUrl=location.href;
    const context=projectContext();
    const urlChanged=nextUrl!==lastUrl;
    const projectChanged=Boolean(context.projectId)&&context.projectId!==lastProjectId;
    if(urlChanged){lastUrl=nextUrl;lastSignature='';navigationGeneration+=1;scheduleAutosave(1800);}
    if(context.projectId&&(urlChanged||projectChanged))void dispatchProjectSync(context,{force:true});
  },800);
  setInterval(()=>{const context=projectContext();if(context.projectId)void dispatchProjectSync(context);},60*1000);
  scheduleAutosave(1600);
})();
