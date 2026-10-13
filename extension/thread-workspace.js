'use strict';

(() => {
  const DB_NAME = 'thread-to-markdown.workspace.v2';
  const DB_VERSION = 1;
  const STORE = 'threads';
  const PROMPT_STORAGE_KEY = 'thread-to-markdown.prompt-library.v1';
  const MAX_RECORDS = 2000;
  const MAX_FOLDER = 80;
  const MAX_PROJECT = 120;
  const MAX_TAG = 48;
  const MAX_NOTE = 16000;
  const MEMORY_CONTEXT_LIMIT = 16000;

  const root = document.getElementById('thread-workspace');
  if (!root) return;

  const nodes = {
    count: document.getElementById('workspace-count'),
    currentTitle: document.getElementById('workspace-current-title'),
    project: document.getElementById('workspace-project'),
    projectList: document.getElementById('workspace-project-list'),
    folder: document.getElementById('workspace-folder'),
    tags: document.getElementById('workspace-tags'),
    note: document.getElementById('workspace-note'),
    folderList: document.getElementById('workspace-folder-list'),
    save: document.getElementById('workspace-save-current'),
    snapshot: document.getElementById('workspace-snapshot-now'),
    syncProject: document.getElementById('workspace-sync-project'),
    clear: document.getElementById('workspace-clear-meta'),
    search: document.getElementById('workspace-search'),
    folderFilter: document.getElementById('workspace-folder-filter'),
    projectFilter: document.getElementById('workspace-project-filter'),
    list: document.getElementById('workspace-list'),
    empty: document.getElementById('workspace-empty'),
    export: document.getElementById('workspace-export-selected'),
    remove: document.getElementById('workspace-delete-selected'),
    backup: document.getElementById('workspace-backup'),
    restore: document.getElementById('workspace-restore'),
    restoreFile: document.getElementById('workspace-restore-file'),
    autoMemory: document.getElementById('workspace-auto-memory'),
    autoStatus: document.getElementById('workspace-auto-status'),
    memoryQuery: document.getElementById('workspace-memory-query'),
    memoryFind: document.getElementById('workspace-memory-find'),
    memoryInsert: document.getElementById('workspace-memory-insert'),
    memoryStatus: document.getElementById('workspace-memory-status'),
    memoryResults: document.getElementById('workspace-memory-results'),
    summaryTitle: document.getElementById('workspace-summary-title'),
    readyStatus: document.getElementById('workspace-ready-status'),
    readyBadge: document.getElementById('workspace-ready-badge'),
    readyHelp: document.getElementById('workspace-ready-help'),
    autoLabel: document.getElementById('workspace-auto-label'),
    syncProgress: document.getElementById('workspace-sync-progress'),
    syncStage: document.getElementById('workspace-sync-stage'),
    syncPercent: document.getElementById('workspace-sync-percent'),
    syncProgressBar: document.getElementById('workspace-sync-progress-bar'),
    syncDetail: document.getElementById('workspace-sync-detail'),
    serviceSyncNote: document.getElementById('workspace-service-sync-note'),
    metaSummary: document.getElementById('workspace-meta-summary'),
    manualSummary: document.getElementById('workspace-manual-summary'),
    librarySummary: document.getElementById('workspace-library-summary'),
    backupSummary: document.getElementById('workspace-backup-summary'),
    serviceSummary: document.getElementById('workspace-service-summary'),
    projectLabel: document.getElementById('workspace-project-label'),
    folderLabel: document.getElementById('workspace-folder-label'),
    tagsLabel: document.getElementById('workspace-tags-label'),
    noteLabel: document.getElementById('workspace-note-label'),
    memoryQueryLabel: document.getElementById('workspace-memory-query-label'),
    searchLabel: document.getElementById('workspace-search-label'),
    projectFilterLabel: document.getElementById('workspace-project-filter-label'),
    folderFilterLabel: document.getElementById('workspace-folder-filter-label')
  };
  if (Object.values(nodes).some((node) => !node)) return;

  const uk = /^uk\b/i.test(chrome.i18n.getUILanguage?.() || navigator.language || '');
  const t = uk ? {
    current:'Поточний чат', saved:'Збережено локально', updated:'Оновлено локально', save:'Зберегти чат', update:'Оновити чат',
    empty:'Збережених чатів ще немає.', noResults:'Відповідних чатів не знайдено.', open:'Відкрити', loading:'Створюю локальний знімок…',
    needThread:'Спочатку відкрийте розмову ChatGPT.', storageError:'Не вдалося відкрити локальне сховище.', limit:`Досягнуто ліміту ${MAX_RECORDS} чатів.`,
    select:'Виберіть хоча б один чат.', exportDone:'ZIP Workspace створено.', deleteConfirm:'Видалити вибрані чати?', deleted:'Вибрані чати видалено.',
    backupDone:'Резервну копію Workspace створено.', restoreConfirm:'Замінити локальний Workspace та бібліотеку промптів цією копією?', restoreDone:'Копію відновлено.',
    restoreError:'Некоректна резервна копія.', allFolders:'Усі папки', allProjects:'Усі проєкти', noFolder:'Без папки', noProject:'Без проєкту',
    snapshotMissing:'У записі немає локального знімка.', autoOn:'Автопам’ять увімкнена.', autoOff:'Автопам’ять вимкнена.', autoDenied:'Доступ до chatgpt.com не надано.',
    memoryNoQuery:'Введіть запит або використайте текст у полі ChatGPT.', memoryNone:'Релевантного контексту не знайдено.', memoryFound:'Знайдено фрагментів:',
    memoryInserted:'Контекст вставлено в поле ChatGPT.', snapshotDone:'Локальну пам’ять оновлено.', syncDone:'Проєкт синхронізовано локально.', syncNeedProject:'Відкрийте чат усередині ChatGPT Project.',
    summary:'Локальна пам’ять проєкту', autoLabel:'Автоматична пам’ять', sync:'Синхронізувати зараз', meta:'Метадані чату', manual:'Ручний пошук пам’яті', library:'Збережені чати', backup:'Резервні копії', service:'Сервіс і ручне керування',
    project:'Проєкт', folder:'Папка', tags:'Теги', note:'Нотатка', refresh:'Оновити пам’ять', clear:'Очистити', memoryQuery:'Запит до пам’яті', find:'Знайти контекст', insert:'Вставити в ChatGPT', search:'Пошук', exportSelected:'Експорт вибраних', deleteSelected:'Видалити вибрані', createBackup:'Створити копію', restoreBackup:'Відновити',
    projectPlaceholder:'Назва проєкту', folderPlaceholder:'Напр. Research / Releases', tagsPlaceholder:'research, release, important', notePlaceholder:'Локальна нотатка', memoryPlaceholder:'Що треба згадати з проєкту?', searchPlaceholder:'Пошук у тексті, назвах, тегах і нотатках…',
    readyNoProject:'Відкрийте чат у проєкті ChatGPT', readyOff:'Автопам’ять вимкнена', readyPartial:'Пам’ять проєкту неповна', readyPass:'Пам’ять готова',
    helpNoProject:'Workspace працює, але автоматична пам’ять проєкту доступна лише всередині ChatGPT Project.', helpOff:'Увімкніть автоматичну пам’ять. Після цього новий чат сам отримає релевантний контекст.', helpPartial:'Пам’ять ще оновлюється у фоні. Можна працювати далі, ручна синхронізація не потрібна.', helpReady:'Працюйте як завжди. Синхронізація і релевантна пам’ять працюють автоматично у фоні.',
    syncing:'Синхронізую проєкт…', syncStarting:'Запускаю синхронізацію…', syncDiscovering:'Шукаю гілки проєкту…', syncState:'Синхронізація', syncManual:'Ручне оновлення пам’яті', syncPass:'PASS', failed:'помилок', updatedShort:'оновлено', unchangedShort:'без змін', processedShort:'оброблено'
  } : {
    current:'Current chat', saved:'Saved locally', updated:'Updated locally', save:'Save chat', update:'Update chat',
    empty:'No saved chats yet.', noResults:'No matching chats.', open:'Open', loading:'Preparing a local snapshot…',
    needThread:'Open a ChatGPT conversation first.', storageError:'The local workspace could not be opened.', limit:`The limit of ${MAX_RECORDS} chats has been reached.`,
    select:'Select at least one chat.', exportDone:'Workspace ZIP created.', deleteConfirm:'Delete selected chats?', deleted:'Selected chats deleted.',
    backupDone:'Workspace backup created.', restoreConfirm:'Replace the local Workspace and prompt library with this backup?', restoreDone:'Backup restored.',
    restoreError:'Invalid backup file.', allFolders:'All folders', allProjects:'All projects', noFolder:'No folder', noProject:'No project',
    snapshotMissing:'This record has no local snapshot.', autoOn:'Automatic memory is enabled.', autoOff:'Automatic memory is disabled.', autoDenied:'Access to chatgpt.com was not granted.',
    memoryNoQuery:'Enter a query or use the text already typed in ChatGPT.', memoryNone:'No relevant context was found.', memoryFound:'Relevant excerpts:', memoryInserted:'Context inserted into ChatGPT.',
    snapshotDone:'Local memory updated.', syncDone:'Project synchronized locally.', syncNeedProject:'Open a chat inside a ChatGPT Project.',
    summary:'Local project memory', autoLabel:'Automatic memory', sync:'Sync now', meta:'Chat metadata', manual:'Manual memory search', library:'Saved chats', backup:'Backups', service:'Service & manual controls',
    project:'Project', folder:'Folder', tags:'Tags', note:'Note', refresh:'Refresh memory', clear:'Clear', memoryQuery:'Memory query', find:'Find context', insert:'Insert into ChatGPT', search:'Search', exportSelected:'Export selected', deleteSelected:'Delete selected', createBackup:'Create backup', restoreBackup:'Restore backup',
    projectPlaceholder:'Project name', folderPlaceholder:'e.g. Research / Releases', tagsPlaceholder:'research, release, important', notePlaceholder:'Local note', memoryPlaceholder:'What should I remember from this project?', searchPlaceholder:'Search text, titles, tags and notes…',
    readyNoProject:'Open a ChatGPT Project chat', readyOff:'Automatic memory is off', readyPartial:'Project memory is incomplete', readyPass:'Memory ready',
    helpNoProject:'Workspace still works, but automatic project memory is available only inside a ChatGPT Project.', helpOff:'Enable automatic memory. New chats will then receive relevant local context automatically.', helpPartial:'Memory is still updating in the background. You can keep working; manual sync is not required.', helpReady:'Work normally. Project sync and relevant local memory run automatically in the background.',
    syncing:'Synchronizing project…', syncStarting:'Starting synchronization…', syncDiscovering:'Finding project chats…', syncState:'Synchronizing', syncManual:'Manual memory refresh', syncPass:'PASS', failed:'failed', updatedShort:'updated', unchangedShort:'unchanged', processedShort:'processed'
  };

  function localizeWorkspaceUi() {
    const set=(node,text)=>{ if(node) node.textContent=text; };
    set(nodes.summaryTitle,t.summary); set(nodes.autoLabel,t.autoLabel); set(nodes.syncProject,t.sync); set(nodes.serviceSyncNote,t.syncManual); set(nodes.metaSummary,t.meta); set(nodes.manualSummary,t.manual); set(nodes.librarySummary,t.library); set(nodes.backupSummary,t.backup); set(nodes.serviceSummary,t.service);
    set(nodes.projectLabel,t.project); set(nodes.folderLabel,t.folder); set(nodes.tagsLabel,t.tags); set(nodes.noteLabel,t.note); set(nodes.memoryQueryLabel,t.memoryQuery); set(nodes.searchLabel,t.search); set(nodes.projectFilterLabel,t.project); set(nodes.folderFilterLabel,t.folder);
    set(nodes.snapshot,t.refresh); set(nodes.clear,t.clear); set(nodes.memoryFind,t.find); set(nodes.memoryInsert,t.insert); set(nodes.export,t.exportSelected); set(nodes.remove,t.deleteSelected); set(nodes.backup,t.createBackup); set(nodes.restore,t.restoreBackup);
    nodes.project.placeholder=t.projectPlaceholder; nodes.folder.placeholder=t.folderPlaceholder; nodes.tags.placeholder=t.tagsPlaceholder; nodes.note.placeholder=t.notePlaceholder; nodes.memoryQuery.placeholder=t.memoryPlaceholder; nodes.search.placeholder=t.searchPlaceholder;
  }


  let db = null;
  let records = [];
  let currentUrl = '';
  let currentRecordId = '';
  let currentProjectContext = { project:'', projectId:'', confidence:'none' };
  let busy = false;
  let memoryHits = [];
  let lastAutoSyncKickAt = 0;
  let autoSyncKickInFlight = false;
  let lastObservedTabUrl = '';

  const normalize = (value) => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const searchNormalize = (value) => normalize(value).toLocaleLowerCase();
  const createId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const status = (message, kind = '') => { if (typeof setStatus === 'function') setStatus(message, kind); };


  function detectProjectIdentityInPage() {
    const clean = (value) => String(value || '').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
    const url = location.href;
    const projectId = url.match(/\b(g-p-[a-z0-9_-]+)\b/i)?.[1] || url.match(/\/projects?\/([^/?#]+)/i)?.[1] || '';
    if (!projectId) return { ok:false, projectId:'', projectName:'', projectNameConfidence:'none', links:[] };
    const currentTitle = clean(
      document.querySelector('[data-testid*="conversation-title"]')?.textContent ||
      document.querySelector('main h1')?.textContent ||
      document.title?.replace(/\s*[|–-]\s*ChatGPT.*$/i,'') || ''
    );
    const scored = [];
    for (const node of [...document.querySelectorAll('a[href],nav a[href],[data-testid*="project"],[aria-label]')].slice(0,800)) {
      const href = String(node.getAttribute?.('href') || '');
      const testid = String(node.getAttribute?.('data-testid') || '');
      const aria = String(node.getAttribute?.('aria-label') || '');
      const text = clean(node.textContent || aria || '');
      if (!text || text.length > 120 || text === currentTitle || /^(?:projects?|проєкти?|project|new chat|новий чат)$/iu.test(text)) continue;
      let score = 0;
      if (href.includes(projectId) && !/\/c\//i.test(href)) score += 100;
      if (href.includes(`/g/${projectId}`) && !/\/c\//i.test(href)) score += 40;
      if (/project/i.test(testid) && !/conversation|thread|chat/i.test(testid)) score += 25;
      if (/project|проєкт/i.test(aria) && !/conversation|thread|chat|гілк/i.test(aria)) score += 15;
      if (node.closest?.('nav,[aria-label*="breadcrumb" i],[data-testid*="breadcrumb" i]')) score += 15;
      if (/\/c\//i.test(href)) score -= 120;
      if (score > 0) scored.push({ text, score });
    }
    scored.sort((a,b)=>b.score-a.score || a.text.length-b.text.length);
    const projectName = scored[0]?.text || '';
    const projectNameConfidence = scored[0]?.score >= 80 ? 'high' : (scored[0] ? 'medium' : 'none');
    const links = [...new Set([...document.querySelectorAll('a[href*="/c/"]')]
      .map((a)=>{try{return new URL(a.href,location.href).href;}catch(_){return'';}})
      .filter((href)=>href && href.includes(projectId) && /\/c\/[a-z0-9-]{8,}/i.test(href)))].slice(0,100);
    if (/\/c\/[a-z0-9-]{8,}/i.test(url) && !links.includes(url)) links.unshift(url);
    return { ok:true, projectId, projectName, projectNameConfidence, links };
  }

  function setBusy(value) {
    busy = value;
    [nodes.save,nodes.snapshot,nodes.syncProject,nodes.backup,nodes.restore,nodes.memoryFind,nodes.memoryInsert].forEach((button) => { button.disabled = value; });
    updateBulkButtons();
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE)) {
          const store = database.createObjectStore(STORE, { keyPath:'id' });
          store.createIndex('url','url',{ unique:false });
          store.createIndex('updatedAt','updatedAt',{ unique:false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error(t.storageError));
    });
  }

  function transaction(mode, operation) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode); const store = tx.objectStore(STORE); let result;
      try { result = operation(store); } catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(result?.result); tx.onerror = () => reject(tx.error || result?.error || new Error(t.storageError)); tx.onabort = () => reject(tx.error || new Error(t.storageError));
    });
  }

  function cleanRecord(record) {
    return {
      ...record,
      id:String(record?.id || createId()), url:String(record?.url || ''), title:normalize(record?.title || 'ChatGPT conversation').slice(0,240),
      project:normalize(record?.project || '').slice(0,MAX_PROJECT), projectId:normalize(record?.projectId || '').slice(0,180),
      folder:normalize(record?.folder || '').slice(0,MAX_FOLDER),
      tags:Array.isArray(record?.tags) ? [...new Set(record.tags.map((tag) => normalize(tag).slice(0,MAX_TAG)).filter(Boolean))].slice(0,30) : [],
      note:String(record?.note || '').trim().slice(0,MAX_NOTE), markdown:String(record?.markdown || ''), searchText:String(record?.searchText || record?.markdown || ''),
      messageCount:Number(record?.messageCount || 0), savedAt:String(record?.savedAt || new Date().toISOString()), updatedAt:String(record?.updatedAt || record?.savedAt || new Date().toISOString()),
      fingerprint:String(record?.fingerprint || ''), autoSaved:Boolean(record?.autoSaved)
    };
  }

  async function reloadRecords() {
    records = await new Promise((resolve,reject) => {
      const tx=db.transaction(STORE,'readonly'); const request=tx.objectStore(STORE).getAll();
      request.onsuccess=()=>resolve(Array.isArray(request.result)?request.result.map(cleanRecord):[]); request.onerror=()=>reject(request.error || new Error(t.storageError));
    });
    records.sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  const parseTags = (value) => [...new Set(String(value || '').split(',').map((tag)=>normalize(tag).slice(0,MAX_TAG)).filter(Boolean))].slice(0,30);
  const currentRecord = () => records.find((item)=>item.id===currentRecordId) || records.find((item)=>item.url===currentUrl) || null;

  function fillCurrent(record) {
    currentRecordId = record?.id || '';
    const detectedProject = currentProjectContext.projectId && record?.projectId === currentProjectContext.projectId
      ? currentProjectContext.project
      : '';
    nodes.project.value = detectedProject || record?.project || currentProjectContext.project || '';
    nodes.folder.value = record?.folder || '';
    nodes.tags.value = record?.tags?.join(', ') || '';
    nodes.note.value = record?.note || '';
    nodes.save.textContent = record ? t.update : t.save;
  }

  function syncCurrentMetadata() { fillCurrent(records.find((item)=>item.url===currentUrl) || null); }
  const valuesOf = (key) => [...new Set(records.map((item)=>item[key]).filter(Boolean))].sort((a,b)=>a.localeCompare(b));

  function renderFilters() {
    const projects = valuesOf('project'); nodes.projectList.textContent=''; projects.forEach((value)=>{ const option=document.createElement('option'); option.value=value; nodes.projectList.append(option); });
    const folders = valuesOf('folder'); nodes.folderList.textContent=''; folders.forEach((value)=>{ const option=document.createElement('option'); option.value=value; nodes.folderList.append(option); });

    const currentProject = nodes.projectFilter.value; nodes.projectFilter.textContent='';
    const allProjects=document.createElement('option'); allProjects.value=''; allProjects.textContent=t.allProjects; nodes.projectFilter.append(allProjects);
    projects.forEach((value)=>{ const option=document.createElement('option'); option.value=value; option.textContent=value; nodes.projectFilter.append(option); });
    if ([...nodes.projectFilter.options].some((o)=>o.value===currentProject)) nodes.projectFilter.value=currentProject;

    const currentFolder = nodes.folderFilter.value; nodes.folderFilter.textContent='';
    const allFolders=document.createElement('option'); allFolders.value=''; allFolders.textContent=t.allFolders; nodes.folderFilter.append(allFolders);
    folders.forEach((value)=>{ const option=document.createElement('option'); option.value=value; option.textContent=value; nodes.folderFilter.append(option); });
    if ([...nodes.folderFilter.options].some((o)=>o.value===currentFolder)) nodes.folderFilter.value=currentFolder;
  }

  function filteredRecords() {
    const query = searchNormalize(nodes.search.value); const project=nodes.projectFilter.value; const folder=nodes.folderFilter.value;
    return records.filter((record)=>{
      if (project && record.project !== project) return false; if (folder && record.folder !== folder) return false; if (!query) return true;
      return searchNormalize(`${record.title}\n${record.project}\n${record.folder}\n${record.tags.join(' ')}\n${record.note}\n${record.searchText || record.markdown}`).includes(query);
    });
  }

  function createCard(record) {
    const card=document.createElement('article'); card.className='workspace-card'; card.dataset.workspaceId=record.id;
    const checkbox=document.createElement('input'); checkbox.type='checkbox'; checkbox.className='workspace-select'; checkbox.dataset.workspaceId=record.id;
    const main=document.createElement('div'); main.className='workspace-card-main';
    const title=document.createElement('strong'); title.className='workspace-card-title'; title.textContent=record.title; title.title=record.title;
    const meta=document.createElement('div'); meta.className='workspace-card-meta'; const date=new Date(record.updatedAt);
    meta.textContent=`${record.project || t.noProject} · ${record.folder || t.noFolder} · ${record.messageCount || 0} · ${Number.isNaN(date.getTime())?'':date.toLocaleDateString()}`;
    main.append(title,meta);
    if (record.tags.length) { const tags=document.createElement('div'); tags.className='workspace-tags'; record.tags.forEach((value)=>{ const tag=document.createElement('span'); tag.className='workspace-tag'; tag.textContent=value; tags.append(tag); }); main.append(tags); }
    if (record.note) { const note=document.createElement('p'); note.className='workspace-card-note'; note.textContent=record.note; main.append(note); }
    const actions=document.createElement('div'); actions.className='workspace-card-actions'; const open=document.createElement('button'); open.type='button'; open.className='workspace-button'; open.dataset.workspaceAction='open'; open.textContent=t.open; actions.append(open);
    card.append(checkbox,main,actions); return card;
  }

  function render() {
    nodes.count.textContent=String(records.length); renderFilters(); nodes.list.textContent=''; const visible=filteredRecords(); const fragment=document.createDocumentFragment();
    visible.forEach((record)=>fragment.append(createCard(record))); nodes.list.append(fragment); nodes.empty.hidden=visible.length!==0; nodes.empty.textContent=records.length?t.noResults:t.empty; syncCurrentMetadata(); updateBulkButtons();
  }

  const selectedIds = () => [...nodes.list.querySelectorAll('.workspace-select:checked')].map((node)=>node.dataset.workspaceId).filter(Boolean);
  function updateBulkButtons(){ const count=selectedIds().length; nodes.export.disabled=busy||count===0; nodes.remove.disabled=busy||count===0; }

  function buildMarkdown(payload) {
    const labels={user:'User',assistant:'ChatGPT',system:'System',tool:'Tool'}; const parts=[`# ${payload.title || 'ChatGPT conversation'}`,'',`> Source: ${payload.source || currentUrl}`,''];
    for (const message of payload.messages || []) parts.push(`## ${labels[message.role] || 'Message'}`,'',String(message.markdown || message.text || '').trim(),'','---','');
    return parts.join('\n').trim();
  }

  async function prepareCurrentSnapshot() {
    if (!Number.isInteger(activeTabId) || !Array.isArray(messages) || !messages.length) throw new Error(t.needThread);
    const indices=messages.map((message)=>Number(message.index)).filter(Number.isInteger);
    const response=await chrome.runtime.sendMessage({ type:'prepare-thread',tabId:activeTabId,selectedIndices:indices,format:'json' });
    if (!response?.ok || !response.content) throw new Error(response?.error || t.needThread);
    const payload=JSON.parse(response.content); const markdown=buildMarkdown(payload);
    return { markdown, searchText:(payload.messages||[]).map((m)=>`${m.role||''}\n${m.text||''}\n${m.markdown||''}`).join('\n'), messageCount:Number(response.messageCount || indices.length) };
  }

  async function saveCurrent() {
    if (!currentUrl) throw new Error(t.needThread); const existing=currentRecord(); if (!existing && records.length>=MAX_RECORDS) throw new Error(t.limit);
    status(t.loading); setBusy(true);
    try {
      const snapshot=await prepareCurrentSnapshot(); const now=new Date().toISOString(); const title=normalize(threadTitleNode?.textContent || document.title || 'ChatGPT conversation').slice(0,240);
      const record=cleanRecord({ ...(existing||{}), id:existing?.id||createId(),url:currentUrl,title,project:currentProjectContext.project || nodes.project.value,projectId:currentProjectContext.projectId || existing?.projectId || '',folder:nodes.folder.value,tags:parseTags(nodes.tags.value),note:nodes.note.value,markdown:snapshot.markdown,searchText:snapshot.searchText,messageCount:snapshot.messageCount,savedAt:existing?.savedAt||now,updatedAt:now,autoSaved:false });
      await transaction('readwrite',(store)=>store.put(record)); currentRecordId=record.id; await reloadRecords(); render(); status(`${existing?t.updated:t.saved}: ${record.title}`,'success');
    } finally { setBusy(false); }
  }

  async function snapshotNow() {
    if (!Number.isInteger(activeTabId)) throw new Error(t.needThread); setBusy(true);
    try {
      const response=await chrome.runtime.sendMessage({ type:'project-memory-snapshot-now',tabId:activeTabId,context:{ projectName:normalize(currentProjectContext.project || nodes.project.value),projectId:currentProjectContext.projectId,projectNameConfidence:currentProjectContext.confidence === 'high' ? 'high' : 'manual' } });
      if (!response?.ok) throw new Error(response?.error || t.needThread); await reloadRecords(); render(); status(t.snapshotDone,'success');
    } finally { setBusy(false); }
  }

  async function syncProjectNow() {
    if (!Number.isInteger(activeTabId)) throw new Error(t.needThread);
    setBusy(true);
    try {
      const granted = await chrome.permissions.contains({ origins:['https://chatgpt.com/*','https://chat.openai.com/*'] }) ||
        await chrome.permissions.request({ origins:['https://chatgpt.com/*','https://chat.openai.com/*'] });
      if (!granted) throw new Error(t.autoDenied);

      const runs = await chrome.scripting.executeScript({ target:{ tabId:activeTabId }, func:detectProjectIdentityInPage });
      const discovery = runs?.[0]?.result || {};
      if (!discovery?.ok || !discovery.projectId) { nodes.memoryStatus.textContent=t.syncNeedProject; return; }

      const projectName=normalize(discovery.projectName || currentProjectContext.project || nodes.project.value || '');
      nodes.memoryStatus.textContent=t.syncing;
      const result=await chrome.runtime.sendMessage({
        type:'project-memory-sync-project', tabId:activeTabId,
        context:{projectName,projectId:discovery.projectId,projectNameConfidence:discovery.projectNameConfidence || currentProjectContext.confidence || 'none'},
        links:Array.isArray(discovery.links)?discovery.links:[]
      });
      if(!result?.ok) throw new Error(result?.error || 'Project synchronization failed.');
      currentProjectContext={project:normalize(result.projectName || projectName || discovery.projectName),projectId:normalize(result.projectId || discovery.projectId),confidence:result.projectName?'stored':(discovery.projectNameConfidence||'none')};
      if(!nodes.project.value) nodes.project.value=currentProjectContext.project;
      await reloadRecords(); render();
      const synced=Number(result.synced||0),found=Number(result.foundLinks||0),failed=Array.isArray(result.failed)?result.failed.length:Number(result.failedCount||0);
      nodes.memoryStatus.textContent=`${t.syncDone} ${synced}/${found||synced}${failed?` · ${t.failed} ${failed}`:` · ${t.syncPass}`}`;
      await refreshAutoStatus();
    } finally { setBusy(false); }
  }


  async function exportSelected() {
    const ids=new Set(selectedIds()); const items=records.filter((record)=>ids.has(record.id)); if(!items.length)throw new Error(t.select); if(items.some((item)=>!item.markdown))throw new Error(t.snapshotMissing);
    setBusy(true); try { const response=await chrome.runtime.sendMessage({ type:'workspace-bulk-export',items }); if(!response?.ok)throw new Error(response?.error||'Bulk export failed.'); status(`${t.exportDone} ${response.filename||''}`.trim(),'success'); } finally { setBusy(false); }
  }

  async function deleteSelected() {
    const ids=selectedIds(); if(!ids.length)throw new Error(t.select); if(!window.confirm(t.deleteConfirm))return; setBusy(true);
    try { await Promise.all(ids.map((id)=>transaction('readwrite',(store)=>store.delete(id)))); await reloadRecords(); render(); status(t.deleted,'success'); } finally { setBusy(false); }
  }

  function downloadJson(filename,value){ const blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json;charset=utf-8'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000); }
  function readPrompts(){ try{const value=JSON.parse(localStorage.getItem(PROMPT_STORAGE_KEY)||'[]');return Array.isArray(value)?value:[];}catch{return[];} }
  function backup(){ const payload={schema:'chatextra-local-workspace-backup',version:3,exportedAt:new Date().toISOString(),workspace:records,prompts:readPrompts()}; const stamp=new Date().toISOString().slice(0,10);downloadJson(`gpt-project-memory-tools-backup-${stamp}.json`,payload);status(t.backupDone,'success'); }
  async function restore(file){ const parsed=JSON.parse(await file.text()); const legacy=parsed?.schema==='thread-to-markdown-local-backup'&&Number(parsed?.version)===2; const current=parsed?.schema==='chatextra-local-workspace-backup'&&Number(parsed?.version)===3; if((!legacy&&!current)||!Array.isArray(parsed?.workspace))throw new Error(t.restoreError); if(!window.confirm(t.restoreConfirm))return; const restored=parsed.workspace.map(cleanRecord).slice(0,MAX_RECORDS);setBusy(true);try{await new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');const store=tx.objectStore(STORE);store.clear();restored.forEach((record)=>store.put(record));tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});if(Array.isArray(parsed.prompts))localStorage.setItem(PROMPT_STORAGE_KEY,JSON.stringify(parsed.prompts));await reloadRecords();render();status(t.restoreDone,'success');setTimeout(()=>location.reload(),350);}finally{setBusy(false);} }

  async function detectProjectContext() {
    if (!Number.isInteger(activeTabId)) return { project:'',projectId:'',confidence:'none' };
    try {
      const runs=await chrome.scripting.executeScript({target:{tabId:activeTabId},func:detectProjectIdentityInPage});
      const result=runs?.[0]?.result || {};
      const projectId=normalize(result.projectId || '');
      let project=normalize(result.projectName || '');
      let confidence=String(result.projectNameConfidence || 'none');
      if (projectId) {
        const key=`gptpm.projectName.${projectId}`;
        const stored=await chrome.storage.local.get(key);
        const mapped=normalize(stored[key] || '');
        if (project && confidence === 'high') await chrome.storage.local.set({ [key]:project });
        else if (mapped) { project=mapped; confidence='stored'; }
      }
      return { project, projectId, confidence };
    } catch (_) { return {project:'',projectId:'',confidence:'none'}; }
  }

  async function migrateCurrentProjectIdentity(context) {
    if (!context?.projectId || !context?.project || context.confidence === 'none') return 0;
    const updates=[];
    for (const record of records) {
      let matches = record.projectId === context.projectId;
      if (!matches && record.url) {
        try { matches = new URL(record.url).href.includes(context.projectId); } catch (_) {}
      }
      if (!matches || record.project === context.project) continue;
      updates.push(cleanRecord({ ...record, project:context.project, projectId:context.projectId }));
    }
    if (!updates.length) return 0;
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(STORE,'readwrite'); const store=tx.objectStore(STORE);
      updates.forEach((record)=>store.put(record));
      tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error || new Error(t.storageError)); tx.onabort=()=>reject(tx.error || new Error(t.storageError));
    });
    await chrome.storage.local.set({ [`gptpm.projectName.${context.projectId}`]:context.project });
    await reloadRecords();
    return updates.length;
  }

  async function refreshAutoStatus() {
    const response=await chrome.runtime.sendMessage({type:'project-memory-status',context:{projectId:currentProjectContext.projectId,projectName:currentProjectContext.project}});
    nodes.autoMemory.checked=Boolean(response?.ok&&response.enabled);
    nodes.autoStatus.textContent=nodes.autoMemory.checked?'':t.autoOff;
    updateReadyStatus(response);
    return response;
  }

  function updateReadyStatus(response={}) {
    const projectId=currentProjectContext.projectId;
    const stored=Number(response.projectCount || records.filter((r)=>projectId ? r.projectId===projectId : (currentProjectContext.project && r.project===currentProjectContext.project)).length || 0);
    const sync=response.syncStatus || {};
    const total=Math.max(Number(sync.found || 0), stored);
    const synced=Math.max(Number(sync.synced || 0), stored);
    const inProgress=Boolean(sync.inProgress);
    const processed=Math.max(0,Number(sync.processed || 0));
    nodes.readyBadge.classList.remove('warn','off');

    if (inProgress && projectId) {
      const discovered=Number(sync.found || 0);
      const denominator=Math.max(0,discovered);
      const pct=denominator ? Math.max(0,Math.min(100,(processed/denominator)*100)) : 0;
      nodes.syncProgress.hidden=false;
      nodes.syncStage.textContent=sync.phase==='starting' ? t.syncStarting : (sync.phase==='discovering' ? t.syncDiscovering : t.syncing);
      if (denominator) {
        nodes.syncProgressBar.setAttribute('value',String(pct));
        nodes.syncProgressBar.value=pct;
        nodes.syncPercent.textContent=`${Math.round(pct)}%`;
        nodes.syncDetail.textContent=`${t.processedShort} ${processed}/${denominator} · ${t.updatedShort} ${Number(sync.updated||0)} · ${t.unchangedShort} ${Number(sync.unchanged||0)} · ${t.failed} ${Number(sync.failed||0)}`;
        nodes.readyBadge.textContent=`${processed}/${denominator}`;
      } else {
        nodes.syncProgressBar.removeAttribute('value');
        nodes.syncPercent.textContent='…';
        nodes.syncDetail.textContent=t.syncDiscovering;
        nodes.readyBadge.textContent='…';
      }
      nodes.readyStatus.textContent=`${currentProjectContext.project || t.syncState} · ${t.syncState}`;
      nodes.readyBadge.classList.add('warn');
      nodes.readyHelp.textContent=t.helpPartial;
      return;
    }

    nodes.syncProgress.hidden=true;
    nodes.syncProgressBar.setAttribute('value','0');
    nodes.syncProgressBar.value=0;
    if(!projectId){nodes.readyStatus.textContent=t.readyNoProject;nodes.readyBadge.textContent=`${records.length}`;nodes.readyBadge.classList.add('off');nodes.readyHelp.textContent=t.helpNoProject;return;}
    if(!nodes.autoMemory.checked){nodes.readyStatus.textContent=t.readyOff;nodes.readyBadge.textContent=total?`${synced}/${total}`:`${stored}`;nodes.readyBadge.classList.add('off');nodes.readyHelp.textContent=t.helpOff;return;}
    if(total && synced>=total && Number(sync.failed || 0)===0){nodes.readyStatus.textContent=`${currentProjectContext.project || t.readyPass} · ${t.readyPass}`;nodes.readyBadge.textContent=`${synced}/${total}`;nodes.readyHelp.textContent=t.helpReady;return;}
    nodes.readyStatus.textContent=`${currentProjectContext.project || t.readyPartial} · ${t.readyPartial}`;nodes.readyBadge.textContent=total?`${synced}/${total}`:`${stored}`;nodes.readyBadge.classList.add('warn');nodes.readyHelp.textContent=t.helpPartial;
  }

  async function kickAutomaticProjectSync(response={}) {
    if(autoSyncKickInFlight || !Number.isInteger(activeTabId) || !currentProjectContext.projectId || !response?.ok || !response.enabled)return;
    const sync=response.syncStatus || {};
    if(sync.inProgress)return;
    const now=Date.now();
    const total=Math.max(Number(sync.found || 0),Number(response.projectCount || 0));
    const synced=Math.max(Number(sync.synced || 0),Number(response.projectCount || 0));
    const healthy=total>0 && synced>=total && Number(sync.failed || 0)===0;
    const minGap=healthy ? 60*1000 : 8*1000;
    if(now-lastAutoSyncKickAt<minGap)return;
    lastAutoSyncKickAt=now; autoSyncKickInFlight=true;
    try{
      const runs=await chrome.scripting.executeScript({target:{tabId:activeTabId},func:detectProjectIdentityInPage});
      const discovery=runs?.[0]?.result || {};
      if(!discovery?.projectId){autoSyncKickInFlight=false;return;}
      const projectName=normalize(discovery.projectName || currentProjectContext.project || '');
      void chrome.runtime.sendMessage({
        type:'project-memory-auto-sync-project',tabId:activeTabId,
        context:{projectName,projectId:discovery.projectId,projectNameConfidence:discovery.projectNameConfidence || currentProjectContext.confidence || 'none'},
        links:Array.isArray(discovery.links)?discovery.links:[]
      }).then(async(result)=>{
        if(result?.ok){
          currentProjectContext={project:normalize(result.projectName || projectName || currentProjectContext.project),projectId:normalize(result.projectId || discovery.projectId),confidence:result.projectName?'stored':(discovery.projectNameConfidence||currentProjectContext.confidence||'none')};
          await reloadRecords(); render(); await refreshAutoStatus();
        }
      }).catch(()=>{}).finally(()=>{autoSyncKickInFlight=false;});
    }catch(_){autoSyncKickInFlight=false;}
  }

  async function refreshActiveProjectContext() {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const url=/^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\//i.test(tab?.url||'')?String(tab.url):'';
    if(!url || !Number.isInteger(tab?.id))return false;
    const changed=tab.id!==activeTabId || url!==lastObservedTabUrl;
    activeTabId=tab.id; currentUrl=url;
    if(!changed)return false;
    lastObservedTabUrl=url;
    const next=await detectProjectContext();
    const projectChanged=next.projectId!==currentProjectContext.projectId || next.project!==currentProjectContext.project;
    currentProjectContext=next;
    if(projectChanged){await migrateCurrentProjectIdentity(currentProjectContext);render();}
    return true;
  }

  async function pollAutomaticMemory() {
    await refreshActiveProjectContext().catch(()=>false);
    const response=await refreshAutoStatus();
    void kickAutomaticProjectSync(response);
  }

  async function toggleAuto() {
    const enabled=nodes.autoMemory.checked;
    if(enabled){ const granted=await chrome.permissions.request({origins:['https://chatgpt.com/*','https://chat.openai.com/*']}); if(!granted){nodes.autoMemory.checked=false;nodes.autoStatus.textContent=t.autoDenied;return;} }
    const response=await chrome.runtime.sendMessage({type:'project-memory-set-auto',enabled:nodes.autoMemory.checked}); if(!response?.ok)throw new Error(response?.error||'Auto-memory setting failed.'); nodes.autoStatus.textContent=nodes.autoMemory.checked?'':t.autoOff; await refreshAutoStatus();
  }

  async function composerDraft() {
    if(!Number.isInteger(activeTabId))return'';
    try{const runs=await chrome.scripting.executeScript({target:{tabId:activeTabId},func:()=>{const editor=document.querySelector('#prompt-textarea,[contenteditable="true"][data-composer-markdown],[contenteditable="true"][data-lexical-editor="true"],[contenteditable="true"][role="textbox"],textarea');return String(editor?.innerText||editor?.textContent||editor?.value||'').trim();}});return String(runs?.[0]?.result||'').trim();}catch{return'';}
  }

  const tokens=(value)=>[...new Set(searchNormalize(value).match(/[\p{L}\p{N}_-]{2,}/gu)||[])].slice(0,40);
  function chunks(text){ const paragraphs=String(text||'').split(/\n{2,}/).map((p)=>p.trim()).filter(Boolean);const out=[];let current='';for(const p of paragraphs){if((current+'\n\n'+p).length>1900&&current){out.push(current);current=p;}else{current=current?`${current}\n\n${p}`:p;}}if(current)out.push(current);return out.slice(0,300); }
  function scoreChunk(chunk,record,queryTerms,queryText){ const hay=searchNormalize(chunk);let score=0;for(const term of queryTerms){const matches=hay.split(term).length-1;if(matches)score+=Math.min(8,matches)*2;if(searchNormalize(record.title).includes(term))score+=5;if(searchNormalize(`${record.tags.join(' ')} ${record.note}`).includes(term))score+=3;}if(queryText.length>5&&hay.includes(searchNormalize(queryText)))score+=15;const ageDays=Math.max(0,(Date.now()-new Date(record.updatedAt).getTime())/86400000);score+=Math.max(0,3-Math.log10(ageDays+1));return score; }

  async function findMemory() {
    let query=nodes.memoryQuery.value.trim(); if(!query)query=await composerDraft(); if(!query){nodes.memoryStatus.textContent=t.memoryNoQuery;memoryHits=[];renderMemoryHits();return[];}
    const project=normalize(nodes.project.value || currentRecord()?.project || currentProjectContext.project); const terms=tokens(query); const hits=[];
    for(const record of records){ if(project&&record.project!==project)continue; if(record.url===currentUrl)continue; for(const chunk of chunks(record.markdown||record.searchText)){const score=scoreChunk(chunk,record,terms,query);if(score>1)hits.push({record,chunk,score});} }
    hits.sort((a,b)=>b.score-a.score); const perChat=new Map(); memoryHits=[]; for(const hit of hits){const count=perChat.get(hit.record.id)||0;if(count>=2)continue;perChat.set(hit.record.id,count+1);memoryHits.push(hit);if(memoryHits.length>=8)break;}
    nodes.memoryStatus.textContent=memoryHits.length?`${t.memoryFound} ${memoryHits.length}${project?` · ${project}`:''}`:t.memoryNone;renderMemoryHits();return memoryHits;
  }

  function renderMemoryHits(){nodes.memoryResults.textContent='';for(const hit of memoryHits){const card=document.createElement('article');card.className='memory-hit';const title=document.createElement('strong');title.textContent=hit.record.title;const meta=document.createElement('span');meta.textContent=`${hit.record.project||t.noProject} · ${new Date(hit.record.updatedAt).toLocaleDateString()}`;const excerpt=document.createElement('p');excerpt.textContent=hit.chunk.slice(0,700);card.append(title,meta,excerpt);nodes.memoryResults.append(card);}nodes.memoryInsert.disabled=busy||memoryHits.length===0;}

  async function insertMemory() {
    if(!memoryHits.length)await findMemory(); if(!memoryHits.length)return;
    const project=normalize(nodes.project.value || currentRecord()?.project || currentProjectContext.project || 'Workspace'); let used=0;const sections=[];
    for(const hit of memoryHits){const heading=`Source: ${hit.record.title} (${hit.record.updatedAt.slice(0,10)})`;const section=`${heading}\n${hit.chunk}`;if(used+section.length>MEMORY_CONTEXT_LIMIT)break;sections.push(section);used+=section.length;}
    const block=[`[LOCAL PROJECT MEMORY: ${project}]`,'This context was retrieved locally from saved project chats. It is not a ChatGPT Project source and may be stale.','',...sections.flatMap((s)=>[s,'','---','']),'[/LOCAL PROJECT MEMORY]'].join('\n');
    const runs=await chrome.scripting.executeScript({target:{tabId:activeTabId},args:[block],func:(memoryBlock)=>{const editor=document.querySelector('#prompt-textarea,[contenteditable="true"][data-composer-markdown],[contenteditable="true"][data-lexical-editor="true"],[contenteditable="true"][role="textbox"],textarea');if(!editor)return false;const existing=String(editor.innerText||editor.textContent||editor.value||'').trim();const value=`${memoryBlock}\n\n${existing}`.trim();editor.focus();if('value'in editor){editor.value=value;editor.dispatchEvent(new Event('input',{bubbles:true}));}else{let inserted=false;try{const selection=getSelection();const range=document.createRange();range.selectNodeContents(editor);selection.removeAllRanges();selection.addRange(range);inserted=document.execCommand('insertText',false,value);selection.removeAllRanges();}catch(_){}if(!inserted)editor.textContent=value;editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:null}));}return true;}});
    if(!runs?.[0]?.result)throw new Error('ChatGPT composer was not found.'); nodes.memoryStatus.textContent=t.memoryInserted;
  }

  nodes.save.addEventListener('click',()=>saveCurrent().catch((error)=>status(String(error?.message||error),'error')));
  nodes.snapshot.addEventListener('click',()=>snapshotNow().catch((error)=>status(String(error?.message||error),'error')));
  nodes.syncProject.addEventListener('click',()=>syncProjectNow().catch((error)=>{nodes.memoryStatus.textContent=String(error?.message||error);}));
  nodes.clear.addEventListener('click',()=>fillCurrent(null));
  nodes.search.addEventListener('input',render); nodes.folderFilter.addEventListener('change',render); nodes.projectFilter.addEventListener('change',render); nodes.list.addEventListener('change',updateBulkButtons);
  nodes.list.addEventListener('click',(event)=>{const button=event.target.closest('[data-workspace-action="open"]');const card=button?.closest('[data-workspace-id]');const record=records.find((item)=>item.id===card?.dataset?.workspaceId);if(button&&record?.url)chrome.tabs.create({url:record.url});});
  nodes.export.addEventListener('click',()=>exportSelected().catch((error)=>status(String(error?.message||error),'error'))); nodes.remove.addEventListener('click',()=>deleteSelected().catch((error)=>status(String(error?.message||error),'error')));
  nodes.backup.addEventListener('click',backup); nodes.restore.addEventListener('click',()=>nodes.restoreFile.click()); nodes.restoreFile.addEventListener('change',()=>{const file=nodes.restoreFile.files?.[0];if(file)restore(file).catch((error)=>status(String(error?.message||error),'error'));nodes.restoreFile.value='';});
  nodes.autoMemory.addEventListener('change',()=>toggleAuto().catch((error)=>{nodes.autoMemory.checked=false;nodes.autoStatus.textContent=String(error?.message||error);}));
  nodes.memoryFind.addEventListener('click',()=>findMemory().catch((error)=>{nodes.memoryStatus.textContent=String(error?.message||error);}));
  nodes.memoryInsert.addEventListener('click',()=>insertMemory().catch((error)=>{nodes.memoryStatus.textContent=String(error?.message||error);}));

  void(async()=>{try{localizeWorkspaceUi();db=await openDatabase();await reloadRecords();const[tab]=await chrome.tabs.query({active:true,currentWindow:true});currentUrl=/^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\//i.test(tab?.url||'')?String(tab.url):'';if(currentUrl&&Number.isInteger(tab?.id)){activeTabId=tab.id;lastObservedTabUrl=currentUrl;}currentProjectContext=await detectProjectContext();await migrateCurrentProjectIdentity(currentProjectContext);nodes.currentTitle.textContent=t.current;render();await pollAutomaticMemory(); setInterval(()=>{void pollAutomaticMemory().catch(()=>{});},1500);}catch(error){status(String(error?.message||error||t.storageError),'error');root.open=false;}})();
})();
