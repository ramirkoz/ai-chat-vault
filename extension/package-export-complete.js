'use strict';

(() => {
  const baseExportThread = self.exportThread;
  const prepare = self.prepareThread;

  if (typeof baseExportThread !== 'function' || typeof prepare !== 'function' ||
      typeof buildPortablePackage !== 'function' || typeof bytesToDataUrl !== 'function') {
    throw new Error('Complete ZIP export dependencies were not initialized.');
  }

  self.exportThread = async function exportThreadComplete(tabId, selectedIndices, requestedFormat, exportId = null) {
    if (requestedFormat !== 'zip') return baseExportThread(tabId, selectedIndices, requestedFormat, exportId);

    const progressId = String(exportId || `zip-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const emitProgress = (progress) => chrome.runtime.sendMessage({ type:'zip-export-progress', exportId:progressId, ...progress }).catch(() => {});
    await emitProgress({ stage:'preparing', percent:3, current:0, total:0, included:0, skipped:0 });

    // 2.17.0: snapshot file identities before the transcript reader runs. ChatGPT may
    // virtualize or replace file cards while export preparation is reading the thread.
    // The snapshot is message-bound and also asks the current conversation payload for
    // structured attachment objects, so off-screen user uploads are not dependent on DOM.
    let earlyHints = [];
    try {
      const earlyRuns = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: collectEarlyMessageAttachmentSnapshot,
        // 2.33.0: collectors index messages differently from the transcript reader,
        // so they scan everything and hints are re-bound to transcript turns below.
        args: [null]
      });
      earlyHints = Array.isArray(earlyRuns?.[0]?.result?.hints) ? earlyRuns[0].result.hints : [];
    } catch (error) {
      console.warn('GPT Project & Memory Tools: early attachment snapshot unavailable.', error);
    }

    const jsonResult = await prepare(tabId, selectedIndices, 'json');
    const payload = JSON.parse(jsonResult.content);
    const turnIndexById = await readTurnIndexById(tabId, payload);
    earlyHints = remapHintsToTranscriptTurns(earlyHints, turnIndexById, selectedIndices);

    let apiHints = [...earlyHints];
    let lateHints = [];
    try {
      const hintRuns = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: collectConversationAttachmentHints,
        args: [null]
      });
      lateHints = Array.isArray(hintRuns?.[0]?.result?.hints) ? hintRuns[0].result.hints : [];
      lateHints = remapHintsToTranscriptTurns(lateHints, turnIndexById, selectedIndices);
      apiHints = mergeMessageBoundHints(apiHints, lateHints);
    } catch (error) {
      console.warn('GPT Project & Memory Tools: conversation attachment hints unavailable.', error);
    }

    let interactiveAssets = [];
    try {
      const interactionRuns = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: collectInteractiveAttachmentAssets,
        args: [selectedIndices, apiHints]
      });
      interactiveAssets = Array.isArray(interactionRuns?.[0]?.result?.assets)
        ? interactionRuns[0].result.assets
        : [];
    } catch (error) {
      console.warn('GPT Project & Memory Tools: interactive attachment capture unavailable.', error);
    }

    let captureDiagnostics = null;
    let capturedAssets = [];
    let captureWorkerError = '';
    try {
      const candidateResult = buildAttachmentCandidateDescriptorsFromHints(apiHints, selectedIndices);
      const candidates = Array.isArray(candidateResult?.candidates) ? candidateResult.candidates : [];
      captureDiagnostics = {
        status:'candidates-ready',
        rawHints:Array.isArray(apiHints) ? apiHints.length : 0,
        promotedHints:Number(candidateResult?.diagnostics?.promotedHints || 0),
        identityCandidates:Number(candidateResult?.diagnostics?.identityCandidates || 0),
        unresolvedCandidates:Number(candidateResult?.diagnostics?.unresolvedCandidates || 0),
        rejectedUnsafeUrls:Number(candidateResult?.diagnostics?.rejectedUnsafeUrls || 0),
        downloadCandidates:candidates.length,
        candidateErrors:0,
        candidateErrorSamples:[]
      };
      const downloaded = await downloadAttachmentCandidatesModular(tabId, candidates, progressId, emitProgress);
      capturedAssets = Array.isArray(downloaded?.assets) ? downloaded.assets : [];
      captureDiagnostics = {
        ...captureDiagnostics,
        ...(downloaded?.diagnostics || {}),
        status:downloaded?.cancelled ? 'cancelled' : 'completed',
        finalAssets:capturedAssets.filter((item) => item && item.type !== 'notice').length,
        included:capturedAssets.filter((item) => item?.included === true).length,
        skipped:capturedAssets.filter((item) => item && item.type !== 'notice' && item.included === false).length
      };
    } catch (error) {
      captureWorkerError = String(error?.message || error || 'Unknown attachment pipeline error');
      console.warn('GPT Project & Memory Tools: modular attachment pipeline failed; building a fault-safe partial archive.', error);
      capturedAssets = buildFaultSafeAttachmentAssetsFromHints(apiHints, selectedIndices, captureWorkerError);
      captureDiagnostics = {
        status:'pipeline-crash',
        fatalError:captureWorkerError,
        rawHints:Array.isArray(apiHints) ? apiHints.length : 0,
        fallbackAssets:capturedAssets.length,
        finalAssets:capturedAssets.length,
        included:0,
        skipped:capturedAssets.length
      };
      await emitProgress({ stage:'recovering', percent:91, current:capturedAssets.length, total:capturedAssets.length, included:0, skipped:capturedAssets.length, detail:captureWorkerError });
    }

    capturedAssets = mergeAssetCollections(interactiveAssets, capturedAssets);
    capturedAssets = suppressResolvedAttachmentFallbacks(capturedAssets);

    // 2.4.0: do not invoke ChatGPT's React download handlers. Triggering them caused
    // visible side-panel/toast errors and still returned metadata instead of file bytes.
    // Attachment recovery is now non-interactive and uses file IDs plus the current
    // ChatGPT file-download route inside collectCompletePortableAssets().

    capturedAssets = capturedAssets.filter((item) => item?.type === 'notice' || !isServiceAttachmentName(item?.filename || item?.label));
    capturedAssets = mergeTranscriptAttachmentReferences(capturedAssets, payload);
    capturedAssets = suppressResolvedAttachmentFallbacks(capturedAssets);
    capturedAssets = normalizeAttachmentLabels(capturedAssets);
    const contentDedupe = await dedupeIncludedAssetsByContent(capturedAssets);
    capturedAssets = contentDedupe.assets;

    payload.exportDiagnostics = {
      attachmentDetection: {
        version: '2.33.0',
        transcriptReader: String(payload.reader || ''),
        boundMessageIds: turnIndexById.size,
        early: summarizeAttachmentDiagnostics(earlyHints),
        late: summarizeAttachmentDiagnostics(lateHints),
        mergedHints: summarizeAttachmentDiagnostics(apiHints),
        candidatePipeline: captureDiagnostics,
        workerError: captureWorkerError || '',
        contentDedupe: contentDedupe.diagnostics,
        finalAssets: summarizeAttachmentDiagnostics(capturedAssets)
      }
    };

    await emitProgress({ stage:'building', percent:94, current:capturedAssets.length, total:capturedAssets.length, included:capturedAssets.filter((item) => item?.included).length, skipped:capturedAssets.filter((item) => item && item.type !== 'notice' && !item.included).length });
    const packageResult = buildPortablePackage(payload, capturedAssets, jsonResult.filename);
    const detectedAssets = capturedAssets.filter((item) => item?.type !== 'notice').length;

    await emitProgress({ stage:'saving', percent:98, current:detectedAssets, total:detectedAssets, included:packageResult.includedAssets, skipped:packageResult.skippedAssets });
    const downloadId = await chrome.downloads.download({
      url: bytesToDataUrl(packageResult.bytes, 'application/zip'),
      filename: packageResult.filename,
      saveAs: false,
      conflictAction: 'uniquify'
    });

    await chrome.action.setBadgeBackgroundColor({ tabId, color: packageResult.skippedAssets ? '#b45309' : '#166534' });
    await chrome.action.setBadgeText({ tabId, text: packageResult.skippedAssets ? '!' : '✓' });
    setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 3000);
    await emitProgress({ stage:'done', percent:100, current:detectedAssets, total:detectedAssets, included:packageResult.includedAssets, skipped:packageResult.skippedAssets });

    return {
      filename: packageResult.filename,
      messageCount: Number(payload.selectedCount || payload.messages?.length || 0),
      format: 'zip',
      detectedAssets,
      includedAssets: packageResult.includedAssets,
      skippedAssets: packageResult.skippedAssets,
      complete: packageResult.skippedAssets === 0,
      downloadId
    };
  };
})();


// 2.33.0: the transcript is a list of turns read from the conversation API, where
// one assistant turn spans several API messages (tool calls, tool output, final
// answer). Attachment hints carry the API message id, so they are bound to the
// turn containing that id. Hints without an id keep their DOM-derived index.
async function readTurnIndexById(tabId, payload) {
  const map = new Map();
  const add = (messages) => {
    for (const message of Array.isArray(messages) ? messages : []) {
      if (!Number.isInteger(message?.index)) continue;
      for (const id of Array.isArray(message.messageIds) ? message.messageIds : []) {
        if (id && !map.has(String(id))) map.set(String(id), message.index);
      }
    }
  };
  try {
    const inspected = await self.readThread(tabId, { includeContent: false });
    if (inspected?.ok) add(inspected.messages);
  } catch (error) {
    console.warn('GPT Project & Memory Tools: transcript turn map unavailable.', error);
  }
  if (!map.size) add(payload?.messages);
  return map;
}

function remapHintsToTranscriptTurns(hints, turnIndexById, selectedIndices) {
  const selected = Array.isArray(selectedIndices) ? new Set(selectedIndices.filter(Number.isInteger)) : null;
  const out = [];
  for (const hint of Array.isArray(hints) ? hints : []) {
    if (!hint || typeof hint !== 'object') continue;
    const messageId = String(hint.messageId || '').trim();
    let messageIndex = Number.isInteger(hint.messageIndex) ? hint.messageIndex : -1;
    if (messageId && turnIndexById.size) {
      // An id outside the current branch belongs to an edited/regenerated
      // version of the conversation and must not be exported with this one.
      if (!turnIndexById.has(messageId)) continue;
      messageIndex = turnIndexById.get(messageId);
    }
    if (selected && messageIndex >= 0 && !selected.has(messageIndex)) continue;
    out.push({ ...hint, messageIndex });
  }
  return out;
}

function buildFaultSafeAttachmentAssetsFromHints(rawHints, selectedIndices, workerError = '') {
  const selected = Array.isArray(selectedIndices) ? new Set(selectedIndices.filter(Number.isInteger)) : null;
  const hints = Array.isArray(rawHints) ? rawHints : [];
  const assets = [];
  const seen = new Set();
  const clean = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const sanitize = (value, fallback) => clean(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) || fallback;
  const fileIdFrom = (value) => clean(value).match(/file[-_][a-z0-9_-]{12,}/i)?.[0] || '';
  const filenameFromPath = (value) => {
    const raw = clean(value).replace(/^sandbox:/i, '').replace(/\\/g, '/');
    const part = raw.split('/').pop() || '';
    return /\.[a-z0-9]{1,10}$/i.test(part) ? sanitize(part, '') : '';
  };
  for (const hint of hints) {
    if (!hint || typeof hint !== 'object') continue;
    const messageIndex = Number.isInteger(hint.messageIndex) ? hint.messageIndex : -1;
    if (messageIndex < 0 || (selected && !selected.has(messageIndex))) continue;
    const detector = clean(hint.detectedBy || '');
    const realCard = Boolean(hint.fileCard || hint.generatedCard || /(?:early-|message-bound|global-file-card|conversation-)/i.test(detector));
    if (!realCard) continue;
    const sandboxPaths = Array.isArray(hint.sandboxPaths) ? hint.sandboxPaths : [];
    const filename = sanitize(hint.filename || filenameFromPath(sandboxPaths[0]) || hint.label, `attachment-message-${messageIndex + 1}.bin`);
    const fileId = fileIdFrom(hint.fileId || '');
    const key = `${messageIndex}|${fileId || filename.toLocaleLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    assets.push({ messageIndex, type:'attachment', label:clean(hint.label || filename), filename, sourceUrl:clean(hint.url || ''), included:false, reason:`Attachment worker failed before this message-bound file could be processed: ${clean(workerError) || 'unknown worker error'}`, detectedBy:'fault-safe-worker-fallback' });
    if (assets.length >= 120) break;
  }
  return assets;
}


function mergeMessageBoundHints(...collections) {
  const out = [];
  const byKey = new Map();
  const clean = (value) => String(value || '').trim();
  const fileIdOf = (value) => clean(value).match(/file[-_][a-z0-9_-]{12,}/i)?.[0] || '';
  const sandboxOf = (hint) => [...new Set((hint?.sandboxPaths || []).map((value) => String(value || '').replace(/^sandbox:/i,'').trim()).filter(Boolean))];
  for (const item of collections.flat()) {
    if (!item || typeof item !== 'object') continue;
    const fileId = fileIdOf(item.fileId);
    const sandboxPaths = sandboxOf(item);
    const messageIndex = Number.isInteger(item.messageIndex) ? item.messageIndex : -1;
    const messageId = clean(item.messageId);
    const filename = clean(item.filename);
    const url = clean(item.url);
    const identity = fileId || sandboxPaths[0] || url || filename;
    if (!identity) continue;
    const key = `${messageIndex}|${messageId}|${fileId || sandboxPaths[0] || url || filename.toLocaleLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing) {
      const copy = { ...item, fileId, sandboxPaths };
      byKey.set(key, copy); out.push(copy); continue;
    }
    if (!existing.filename && filename) existing.filename = filename;
    if (!existing.url && url) existing.url = url;
    if (!existing.label && item.label) existing.label = item.label;
    if (!existing.messageId && messageId) existing.messageId = messageId;
    existing.sandboxPaths = [...new Set([...(existing.sandboxPaths || []), ...sandboxPaths])];
    existing.fileCard = Boolean(existing.fileCard || item.fileCard);
    existing.generatedCard = Boolean(existing.generatedCard || item.generatedCard);
    existing.detectedBy = existing.detectedBy || item.detectedBy;
  }
  return out;
}

function summarizeAttachmentDiagnostics(items) {
  const list = (Array.isArray(items) ? items : []).filter((item) => item && item.type !== 'notice');
  const byDetector = {};
  let domCards = 0, reactIdentities = 0, apiAttachments = 0, globalBound = 0, included = 0, skipped = 0;
  for (const item of list) {
    const detector = String(item.detectedBy || 'unknown');
    byDetector[detector] = (byDetector[detector] || 0) + 1;
    if (/dom|card/i.test(detector)) domCards += 1;
    if (/react/i.test(detector)) reactIdentities += 1;
    if (/conversation|api/i.test(detector)) apiAttachments += 1;
    if (/global/i.test(detector)) globalBound += 1;
    if (item.included === true) included += 1;
    if (item.included === false) skipped += 1;
  }
  return { total:list.length, domCards, reactIdentities, apiAttachments, globalBound, included, skipped, byDetector };
}


const gptpmCancelledZipExports = new Set();
self.cancelZipExport = function cancelZipExport(exportId) {
  const id = String(exportId || '');
  if (id) gptpmCancelledZipExports.add(id);
};

function buildAttachmentCandidateDescriptorsFromHints(rawHints, selectedIndices) {
  const selected = Array.isArray(selectedIndices) ? new Set(selectedIndices.filter(Number.isInteger)) : null;
  const hints = Array.isArray(rawHints) ? rawHints : [];
  const clean = (value) => String(value || '').normalize('NFKC').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const normalizeName = (value) => clean(value).replace(/^_+/, '').toLocaleLowerCase();
  const sanitize = (value, fallback = 'attachment.bin') => clean(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) || fallback;
  const fileIdOf = (value) => clean(value).match(/file[-_][a-z0-9_-]{12,}/i)?.[0] || '';
  const normalizeSandbox = (value) => {
    let raw = String(value || '').trim().replace(/^sandbox:/i, '');
    try { raw = decodeURIComponent(raw); } catch (_) {}
    raw = raw.replace(/\\/g, '/').replace(/[.,;:!?]+$/g, '');
    if (!raw.startsWith('/mnt/data/') || raw.includes('\0') || /(?:^|\/)\.\.(?:\/|$)/.test(raw)) return '';
    return raw.slice(0, 1200);
  };
  const extOf = (value) => clean(value).match(/\.([a-z0-9]{1,10})$/i)?.[1]?.toLowerCase() || '';
  const filenamePattern = /[^\\/\s<>:"|?*]+\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|tar|gz|tgz|bz2|txt|csv|tsv|jsonl?|md|html?|xml|ya?ml|ini|log|har|sql|php|m?js|cjs|tsx?|jsx|css|scss|py|ipynb|java|c|cpp|h|hpp|cs|go|rs|rb|sh|ps1|bat|cmd|exe|msi|dmg|pkg|apk|deb|rpm|png|jpe?g|gif|webp|svg|mp3|wav|flac|m4a|mp4|mov|webm|avi|mkv|woff2?|ttf|otf)/iu;
  const filenameOf = (hint) => {
    const sandbox = (hint?.sandboxPaths || []).map(normalizeSandbox).filter(Boolean)[0] || '';
    for (const source of [hint?.filename, sandbox.split('/').pop()]) {
      const exact = clean(source);
      if (exact && exact.length <= 220 && /\.[a-z0-9]{1,10}$/i.test(exact) && !/[<>:"|?*\x00-\x1f]/.test(exact)) return sanitize(exact, '');
    }
    const label = clean(hint?.label);
    const match = label.match(filenamePattern)?.[0] || '';
    return match ? sanitize(match, '') : '';
  };
  const urlInfo = (value) => {
    const raw = clean(value);
    if (!/^https?:\/\//i.test(raw)) return { url:'', fileId:'' };
    try {
      const url = new URL(raw);
      if (!/(?:backend-api\/estuary\/content|backend-api\/files|files\.oaiusercontent\.com|oaiusercontent\.com|\/download(?:\/|\?|$)|\/attachment(?:\/|$))/i.test(url.href)) return { url:'', fileId:'' };
      const id = fileIdOf(url.href);
      return { url:url.href, fileId:id };
    } catch (_) { return { url:'', fileId:'' }; }
  };
  const isService = (value) => /^(?:sprites?[-_.]|favicon[-_.]|icon[-_.]|attachment-(?:file-)?(?:icon|tile|radius)[-_.])|(?:^|[-_.])sprites?(?:[-_.]|$)/i.test(clean(value));
  const groups = new Map();
  const diagnostics = { rawHints:hints.length, promotedHints:0, identityCandidates:0, unresolvedCandidates:0, rejectedUnsafeUrls:0, pairedIdentityOnly:0, coalescedAliases:0, suppressedAliases:0, matchedResourceUrls:0, matchedResourceFilenames:0, rejectedDomainAliases:0 };

  // 2.32.0: resource timing entries are intentionally collected without a message index.
  // Prefer exact file_id rebinding, but also keep a filename index when the signed resource
  // itself exposes an exact filename (for example through ?fn=...). This safely recovers
  // cards whose DOM lost file_id while the browser still has the signed download URL.
  const resourceUrlsByFileId = new Map();
  const resourceIdentityByFilename = new Map();
  const filenameFromResource = (hint, url) => {
    const explicit = filenameOf(hint);
    if (explicit) return explicit;
    try {
      const parsed = new URL(url);
      const fn = clean(parsed.searchParams.get('fn') || parsed.searchParams.get('filename') || parsed.searchParams.get('file_name') || '');
      if (fn && /\.[a-z0-9]{1,10}$/i.test(fn)) return sanitize(fn, '');
      const tail = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
      if (tail && /\.[a-z0-9]{1,10}$/i.test(tail) && !/^(?:download|content|attachment)$/i.test(tail)) return sanitize(tail, '');
    } catch (_) {}
    return '';
  };
  for (const hint of hints) {
    if (!hint || typeof hint !== 'object') continue;
    if (Number.isInteger(hint.messageIndex) && hint.messageIndex >= 0) continue;
    if (!/resource-by-file-id/i.test(clean(hint.detectedBy || ''))) continue;
    const info = urlInfo(hint.url || '');
    const id = fileIdOf(hint.fileId || info.fileId || '');
    if (!id || !info.url) continue;
    const current = resourceUrlsByFileId.get(id) || [];
    if (!current.includes(info.url)) current.push(info.url);
    resourceUrlsByFileId.set(id, current.slice(-12));

    const resourceFilename = filenameFromResource(hint, info.url);
    const nameKey = normalizeName(resourceFilename);
    if (nameKey) {
      const byName = resourceIdentityByFilename.get(nameKey) || new Map();
      const identityKey = `${id}|${info.url}`;
      if (!byName.has(identityKey)) byName.set(identityKey, { fileId:id, url:info.url });
      resourceIdentityByFilename.set(nameKey, byName);
    }
  }

  const add = (item) => {
    if (!Number.isInteger(item.messageIndex) || item.messageIndex < 0 || (selected && !selected.has(item.messageIndex))) return;
    const filename = sanitize(item.filename || '', '');
    if (!filename || isService(filename)) return;
    const nameKey = normalizeName(filename);
    const key = `${item.messageIndex}|${nameKey}`;
    let current = groups.get(key);
    if (!current) {
      current = { messageIndex:item.messageIndex, messageId:clean(item.messageId), type:'attachment', filename, label:clean(item.label || filename), fileIds:[], sandboxPaths:[], urls:[], detectedBy:[], unresolvedCard:false };
      groups.set(key, current);
    }
    if (!current.messageId && item.messageId) current.messageId = clean(item.messageId);
    if (item.fileId) current.fileIds.push(item.fileId);
    current.sandboxPaths.push(...(item.sandboxPaths || []));
    current.urls.push(...(item.urls || []));
    current.detectedBy.push(item.detectedBy || 'hint');
    current.unresolvedCard = Boolean(current.unresolvedCard || item.unresolvedCard);
  };

  const identityOnlyByMessage = new Map();
  for (const hint of hints) {
    if (!hint || typeof hint !== 'object') continue;
    const messageIndex = Number.isInteger(hint.messageIndex) ? hint.messageIndex : -1;
    if (messageIndex < 0 || (selected && !selected.has(messageIndex))) continue;
    const filename = filenameOf(hint);
    const explicitFileId = fileIdOf(hint.fileId || '');
    const sandboxPaths = [...new Set((hint.sandboxPaths || []).map(normalizeSandbox).filter(Boolean))];
    const info = urlInfo(hint.url || '');
    const detector = clean(hint.detectedBy || '');
    const cardEvidence = Boolean(hint.fileCard || hint.generatedCard || /(?:early-|message-bound|global-file-card|conversation-)/i.test(detector));
    if (!cardEvidence) continue;

    // Never let a signed URL from a neighbouring card become the identity of a different
    // non-image filename. Only trust it when it agrees with an explicit file_id, or when
    // the candidate itself is an image. Metadata validation in the per-file worker is stricter again.
    const extension = extOf(filename);
    const imageName = /^(?:png|jpe?g|gif|webp|svg)$/i.test(extension);
    let trustedUrl = '';
    if (info.url) {
      if (explicitFileId && info.fileId && explicitFileId === info.fileId) trustedUrl = info.url;
      else if (imageName) trustedUrl = info.url;
      else if (!info.fileId && explicitFileId) trustedUrl = info.url;
      else diagnostics.rejectedUnsafeUrls += 1;
    }
    const fileId = explicitFileId || ((imageName && trustedUrl) ? info.fileId : '');
    const matchedResourceUrls = fileId ? (resourceUrlsByFileId.get(fileId) || []) : [];
    if (matchedResourceUrls.length) diagnostics.matchedResourceUrls += matchedResourceUrls.length;
    const trustedUrls = [...new Set([...(trustedUrl ? [trustedUrl] : []), ...matchedResourceUrls])];
    const hasIdentity = Boolean(fileId || sandboxPaths.length || trustedUrls.length);
    if (filename) {
      add({ messageIndex, messageId:hint.messageId, filename, label:hint.label, fileId, sandboxPaths, urls:trustedUrls, detectedBy:detector, unresolvedCard:!hasIdentity });
      diagnostics.promotedHints += 1;
    } else if (hasIdentity) {
      const list = identityOnlyByMessage.get(messageIndex) || [];
      list.push({ messageIndex, messageId:clean(hint.messageId), fileId, sandboxPaths, urls:trustedUrls, detectedBy:detector });
      identityOnlyByMessage.set(messageIndex, list);
    }
  }

  // Pair identity-only React refs to unresolved visible cards only when the cardinality is
  // unambiguous. This is deliberately conservative: wrong bytes are worse than MISSING_FILES.
  for (const [messageIndex, refsRaw] of identityOnlyByMessage) {
    const refsMap = new Map();
    for (const ref of refsRaw) {
      const idKey = ref.fileId || ref.sandboxPaths?.[0] || ref.urls?.[0] || '';
      if (idKey && !refsMap.has(idKey)) refsMap.set(idKey, ref);
    }
    const refs = [...refsMap.values()];
    const unresolved = [...groups.values()].filter((c) => c.messageIndex === messageIndex && !(c.fileIds.length || c.sandboxPaths.length || c.urls.length));
    if (refs.length && refs.length === unresolved.length) {
      unresolved.forEach((candidate, index) => {
        const ref = refs[index];
        if (ref.fileId) candidate.fileIds.push(ref.fileId);
        candidate.sandboxPaths.push(...(ref.sandboxPaths || []));
        candidate.urls.push(...(ref.urls || []));
        candidate.detectedBy.push(ref.detectedBy || 'paired-react-identity');
        diagnostics.pairedIdentityOnly += 1;
      });
    }
  }

  let candidates = [...groups.values()].map((candidate) => ({
    ...candidate,
    type:/^(?:png|jpe?g|gif|webp|svg)$/i.test(extOf(candidate.filename)) ? 'image' : 'attachment',
    fileIds:[...new Set(candidate.fileIds.map(fileIdOf).filter(Boolean))],
    sandboxPaths:[...new Set(candidate.sandboxPaths.map(normalizeSandbox).filter(Boolean))],
    urls:[...new Set(candidate.urls.filter(Boolean))],
    detectedBy:[...new Set(candidate.detectedBy.filter(Boolean))].join('+')
  }));

  // 2.32.0: exact-filename resource rescue. Only bind when one unique signed resource
  // identity exists for that exact filename. Ambiguous same-name resources remain missing.
  for (const candidate of candidates) {
    if (candidate.fileIds.length || candidate.sandboxPaths.length || candidate.urls.length) continue;
    const nameKey = normalizeName(candidate.filename);
    const matches = nameKey ? resourceIdentityByFilename.get(nameKey) : null;
    if (!matches || matches.size !== 1) continue;
    const match = [...matches.values()][0];
    if (match.fileId) candidate.fileIds = [match.fileId];
    if (match.url) candidate.urls = [match.url];
    candidate.detectedBy = [...new Set(`${candidate.detectedBy || ''}+resource-filename-exact`.split('+').filter(Boolean))].join('+');
    candidate.unresolvedCard = false;
    diagnostics.matchedResourceFilenames += 1;
  }

  // Avoid obvious URL/domain fragments being misclassified as files, e.g. www.postman.c
  // parsed out of a normal web link. Concrete file identities are never removed here.
  candidates = candidates.filter((candidate) => {
    const hasIdentity = candidate.fileIds.length || candidate.sandboxPaths.length || candidate.urls.length;
    if (hasIdentity) return true;
    const filename = clean(candidate.filename);
    const label = clean(candidate.label);
    const domainAlias = /^www\.[a-z0-9-]+\.[a-z]{1,4}$/i.test(filename) || (/^[a-z0-9-]+\.[a-z]{1,4}$/i.test(filename) && /\+\d+$/i.test(label));
    if (domainAlias) diagnostics.rejectedDomainAliases += 1;
    return !domainAlias;
  });

  // 2.24.0: coalesce a short filename parsed from a card label into the longer filename
  // from the same message when the card label itself contains that longer filename, or
  // when both candidates share a concrete file identity. This fixes cases such as
  // "Pryvitannya.mp4" + "Dniprorudne Pryvitannya.mp4" without weakening identity checks.
  const identityKeys = (candidate) => new Set([
    ...(candidate.fileIds || []).map((value) => `id:${fileIdOf(value)}`).filter((value) => value !== 'id:'),
    ...(candidate.sandboxPaths || []).map((value) => `sandbox:${normalizeSandbox(value)}`).filter((value) => value !== 'sandbox:'),
    ...(candidate.urls || []).map((value) => {
      const info = urlInfo(value);
      return info.fileId ? `id:${info.fileId}` : (info.url ? `url:${info.url}` : '');
    }).filter(Boolean)
  ]);
  const mergeCandidateIdentity = (target, source) => {
    target.fileIds = [...new Set([...(target.fileIds || []), ...(source.fileIds || [])].map(fileIdOf).filter(Boolean))];
    target.sandboxPaths = [...new Set([...(target.sandboxPaths || []), ...(source.sandboxPaths || [])].map(normalizeSandbox).filter(Boolean))];
    target.urls = [...new Set([...(target.urls || []), ...(source.urls || [])].filter(Boolean))];
    target.detectedBy = [...new Set(`${target.detectedBy || ''}+${source.detectedBy || ''}+coalesced-alias`.split('+').filter(Boolean))].join('+');
    if (!target.messageId && source.messageId) target.messageId = source.messageId;
    target.unresolvedCard = Boolean(target.unresolvedCard && source.unresolvedCard);
  };
  const removedAliases = new Set();
  for (let i = 0; i < candidates.length; i += 1) {
    if (removedAliases.has(i)) continue;
    const short = candidates[i];
    const shortName = normalizeName(short.filename);
    const shortExt = extOf(short.filename);
    if (!shortName || !shortExt) continue;
    for (let j = 0; j < candidates.length; j += 1) {
      if (i === j || removedAliases.has(j)) continue;
      const long = candidates[j];
      if (long.messageIndex !== short.messageIndex || extOf(long.filename) !== shortExt) continue;
      const longName = normalizeName(long.filename);
      if (!longName || longName.length <= shortName.length + 4 || !longName.endsWith(shortName)) continue;
      const labelEvidence = normalizeName(short.label || '').includes(longName);
      const shortKeys = identityKeys(short);
      const longKeys = identityKeys(long);
      const sharedIdentity = [...shortKeys].some((key) => longKeys.has(key));
      if (!labelEvidence && !sharedIdentity) continue;
      mergeCandidateIdentity(long, short);
      removedAliases.add(i);
      diagnostics.coalescedAliases += 1;
      break;
    }
  }
  if (removedAliases.size) candidates = candidates.filter((_, index) => !removedAliases.has(index));

  // Remove short alias fragments such as "(eng).pdf" or "Pryvitannya.mp4" when a more
  // specific filename from the same message ends with that fragment and the short alias
  // carries no unique identity of its own.
  candidates = candidates.filter((candidate, index, all) => {
    const name = normalizeName(candidate.filename);
    const hasUniqueIdentity = candidate.fileIds.length || candidate.sandboxPaths.length || candidate.urls.length;
    if (hasUniqueIdentity) return true;
    const ext = extOf(name);
    const alias = all.some((other, j) => j !== index && other.messageIndex === candidate.messageIndex && extOf(other.filename) === ext && normalizeName(other.filename).endsWith(name) && normalizeName(other.filename).length > name.length + 4);
    if (alias) diagnostics.suppressedAliases += 1;
    return !alias;
  });

  diagnostics.identityCandidates = candidates.filter((c) => c.fileIds.length || c.sandboxPaths.length || c.urls.length).length;
  diagnostics.unresolvedCandidates = candidates.length - diagnostics.identityCandidates;
  return { candidates:candidates.slice(0, 120), diagnostics };
}

async function downloadAttachmentCandidatesModular(tabId, candidates, exportId, emitProgress) {
  const list = Array.isArray(candidates) ? candidates.slice(0, 120) : [];
  const MAX_CONCURRENCY = 2;
  const MAX_TOTAL_BYTES = 640 * 1024 * 1024;
  const id = String(exportId || '');
  const assets = new Array(list.length);
  let cursor = 0;
  let done = 0;
  let included = 0;
  let skipped = 0;
  let totalBytes = 0;
  const diagnostics = { modular:true, perFileWorkers:list.length, candidateErrors:0, candidateErrorSamples:[], totalBytes:0 };
  const cancelled = () => id && gptpmCancelledZipExports.has(id);

  await emitProgress({ stage:'files', percent:list.length ? 24 : 90, current:0, total:list.length, included:0, skipped:0 });

  const worker = async () => {
    while (!cancelled()) {
      const index = cursor++;
      if (index >= list.length) break;
      const candidate = list[index];
      let result = null;
      try {
        const runs = await chrome.scripting.executeScript({
          target:{ tabId },
          world:'MAIN',
          func:downloadSingleAttachmentDescriptor,
          args:[candidate]
        });
        const injection = runs?.[0] || null;
        if (injection?.error) throw new Error(String(injection.error));
        result = injection?.result || null;
        if (!result || typeof result !== 'object') throw new Error('Per-file worker returned no result.');
      } catch (error) {
        const reason = String(error?.message || error || 'Unknown per-file worker error');
        diagnostics.candidateErrors += 1;
        if (diagnostics.candidateErrorSamples.length < 8) diagnostics.candidateErrorSamples.push(`${candidate.filename}: ${reason}`.slice(0, 700));
        result = { included:false, reason:`Per-file worker error: ${reason}`, filename:candidate.filename, label:candidate.label, messageIndex:candidate.messageIndex, type:candidate.type || 'attachment', detectedBy:'modular-worker-error' };
      }

      let asset = { ...result, messageIndex:Number.isInteger(result.messageIndex) ? result.messageIndex : candidate.messageIndex, type:result.type || candidate.type || 'attachment', filename:result.filename || candidate.filename, label:result.label || candidate.label || candidate.filename, detectedBy:result.detectedBy || 'modular-per-file' };
      const size = Number(asset.size || 0);
      if (asset.included && size > 0 && totalBytes + size > MAX_TOTAL_BYTES) {
        asset = { ...asset, included:false, dataUrl:'', reason:'Archive asset budget of 640 MB was reached.', detectedBy:'modular-budget' };
      }
      if (asset.included) { totalBytes += size; included += 1; } else skipped += 1;
      assets[index] = asset;
      done += 1;
      const percent = list.length ? 24 + Math.round((done / list.length) * 66) : 90;
      await emitProgress({ stage:'files', percent, current:done, total:list.length, included, skipped, filename:candidate.filename || candidate.label || '' });
    }
  };

  await Promise.all(Array.from({ length:Math.min(MAX_CONCURRENCY, Math.max(1, list.length)) }, () => worker()));

  if (cancelled()) {
    for (let i = 0; i < list.length; i += 1) {
      if (assets[i]) continue;
      const candidate = list[i];
      assets[i] = { messageIndex:candidate.messageIndex, type:candidate.type || 'attachment', label:candidate.label || candidate.filename, filename:candidate.filename, included:false, reason:'Export cancelled before this file was downloaded.', detectedBy:'cancelled' };
      skipped += 1;
    }
    await emitProgress({ stage:'cancelled', percent:92, current:done, total:list.length, included, skipped });
  }
  const wasCancelled = cancelled();
  if (id) gptpmCancelledZipExports.delete(id);
  diagnostics.totalBytes = totalBytes;
  diagnostics.completed = done;
  return { assets:assets.filter(Boolean), diagnostics, cancelled:wasCancelled };
}

async function downloadSingleAttachmentDescriptor(candidateInput) {
  const MAX_ASSET_BYTES = 192 * 1024 * 1024;
  const MAX_VIDEO_ASSET_BYTES = 768 * 1024 * 1024;
  const REQUEST_TIMEOUT_MS = 30000;
  const FILE_BUDGET_MS = 45000;
  const LARGE_FILE_BUDGET_MS = 120000;
  const VIDEO_FILE_BUDGET_MS = 300000;
  const LEGACY_DISCOVERY_BUDGET_MS = 18000;
  const CONVERSATION_ENRICH_TIMEOUT_MS = 2500;
  const SANDBOX_DESCRIPTOR_TIMEOUT_MS = 15000;
  const FILE_DESCRIPTOR_TIMEOUT_MS = 6000;
  const candidate = candidateInput && typeof candidateInput === 'object' ? candidateInput : {};
  const started = Date.now();
  let deadline = started + FILE_BUDGET_MS;
  const clean = (value) => String(value || '').normalize('NFKC').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const sanitize = (value, fallback = 'attachment.bin') => clean(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) || fallback;
  const fileIdOf = (value) => clean(value).match(/file[-_][a-z0-9_-]{12,}/i)?.[0] || '';
  const normalizeSandbox = (value) => {
    let raw = String(value || '').trim().replace(/^sandbox:/i, '');
    try { raw = decodeURIComponent(raw); } catch (_) {}
    raw = raw.replace(/\\/g, '/').replace(/[.,;:!?]+$/g, '');
    if (!raw.startsWith('/mnt/data/') || raw.includes('\0') || /(?:^|\/)\.\.(?:\/|$)/.test(raw)) return '';
    return raw.slice(0, 1200);
  };
  const extOf = (value) => clean(value).match(/\.([a-z0-9]{1,10})$/i)?.[1]?.toLowerCase() || '';
  const normName = (value) => clean(value).replace(/^_+/, '').toLocaleLowerCase();
  const basename = (value) => {
    const raw = clean(value).replace(/\\/g, '/');
    return sanitize(raw.split('/').pop() || '', '');
  };
  const filenamePattern = /[^\\/\s<>:"|?*]+\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|tar|gz|tgz|bz2|txt|csv|tsv|jsonl?|md|html?|xml|ya?ml|ini|log|har|sql|php|m?js|cjs|tsx?|jsx|css|scss|py|ipynb|java|c|cpp|h|hpp|cs|go|rs|rb|sh|ps1|bat|cmd|exe|msi|dmg|pkg|apk|deb|rpm|png|jpe?g|gif|webp|svg|mp3|wav|flac|m4a|mp4|mov|webm|avi|mkv|woff2?|ttf|otf)/iu;
  const filenameOf = (value) => clean(value).match(filenamePattern)?.[0] || '';
  const normalizeUrl = (value) => {
    const raw = clean(value);
    if (!raw || /^(?:javascript|about|sandbox):/i.test(raw)) return '';
    try { const url = new URL(raw, location.href).href; return /^(?:https?:|blob:|data:)/i.test(url) ? url : ''; } catch (_) { return ''; }
  };
  const isAssetUrl = (value) => /backend-api\/estuary\/content|backend-api\/files|files\.oaiusercontent\.com|oaiusercontent\.com|\/download(?:\/|\?|$)|\/attachment(?:\/|$)/i.test(String(value || ''));
  const conversationId = location.pathname.match(/\/c\/([a-z0-9-]{8,})/i)?.[1] || '';
  const projectId = location.href.match(/\b(g-p-[a-z0-9_-]+)\b/i)?.[1] || '';
  let filename = sanitize(candidate.filename || candidate.label, 'attachment.bin');
  const candidateExt = extOf(filename);
  const videoCandidate = /^(?:mp4|mov|webm|avi|mkv|m4v)$/i.test(candidateExt);
  const largeBinaryCandidate = /^(?:zip|rar|7z|tar|gz|tgz|bz2|exe|msi|dmg|pkg|apk|deb|rpm)$/i.test(candidateExt);
  const fullBudgetMs = videoCandidate ? VIDEO_FILE_BUDGET_MS : (largeBinaryCandidate ? LARGE_FILE_BUDGET_MS : FILE_BUDGET_MS);
  const errors = [];
  let fileIds = [...new Set((candidate.fileIds || []).map(fileIdOf).filter(Boolean))];
  let sandboxPaths = [...new Set((candidate.sandboxPaths || []).map(normalizeSandbox).filter(Boolean))];
  let urls = [...new Set((candidate.urls || []).map(normalizeUrl).filter((url) => url && isAssetUrl(url)))];
  const initialHasIdentity = Boolean(fileIds.length || sandboxPaths.length || urls.length);
  // Legacy cards with no reusable identity get one bounded discovery window. If a real
  // file_id, sandbox path or signed URL is recovered, the normal large-file budget is restored.
  deadline = started + (initialHasIdentity ? fullBudgetMs : Math.min(fullBudgetMs, LEGACY_DISCOVERY_BUDGET_MS));
  const messageId = clean(candidate.messageId || '');

  const sessionAuth = await (async () => {
    try {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 3000);
      const response = await fetch('/api/auth/session', { credentials:'include', cache:'no-store', headers:{ accept:'application/json' }, signal:controller.signal }).finally(() => clearTimeout(timer));
      if (!response.ok) return null;
      const session = await response.json();
      const accessToken = clean(session?.accessToken || '');
      let accountId = clean(session?.account?.id || session?.user?.account_id || session?.user?.accountId || '');
      if (!accountId && accessToken.includes('.')) {
        try { const payload=accessToken.split('.')[1]||''; const decoded=JSON.parse(atob(payload.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(payload.length/4)*4,'='))); accountId=clean(decoded?.['https://api.openai.com/auth']?.chatgpt_account_id || decoded?.chatgpt_account_id || ''); } catch (_) {}
      }
      return accessToken ? { accessToken, accountId } : null;
    } catch (_) { return null; }
  })();

  const authHeaders = (url, accept='*/*') => {
    const headers = { accept };
    try {
      const target = new URL(url, location.href);
      if (sessionAuth?.accessToken && target.origin === location.origin) {
        headers.authorization = `Bearer ${sessionAuth.accessToken}`;
        if (sessionAuth.accountId) headers['chatgpt-account-id'] = sessionAuth.accountId;
        if (projectId && target.pathname.startsWith('/backend-api/')) headers['chatgpt-project-id'] = projectId;
      }
    } catch (_) {}
    return headers;
  };
  const fetchWithTimeout = async (url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) => {
    const remaining = Math.max(250, Math.min(timeoutMs, deadline - Date.now()));
    if (remaining <= 250) throw new Error('File time budget exceeded.');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const fetchOptions = { ...options };
      return await fetch(url, { credentials:'include', redirect:'follow', cache:'no-store', ...fetchOptions, signal:controller.signal, headers:{ ...authHeaders(url, fetchOptions?.headers?.accept || '*/*'), ...(fetchOptions.headers || {}) } });
    } finally { clearTimeout(timer); }
  };
  const blobValid = async (blob, expectedName) => {
    const ext = extOf(expectedName);
    const maxBytes = /^(?:mp4|mov|webm|avi|mkv|m4v)$/i.test(ext) ? MAX_VIDEO_ASSET_BYTES : MAX_ASSET_BYTES;
    if (!blob?.size || blob.size > maxBytes) return false;
    const mime = clean(blob.type).toLowerCase();
    if (mime.includes('text/html') && !['html','htm'].includes(ext)) return false;
    if (mime.includes('application/json') && !['json','jsonl','har','ipynb'].includes(ext)) return false;
    const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    if (ext === 'pdf') return mime.includes('pdf') || String.fromCharCode(...bytes.slice(0,5)).startsWith('%PDF-');
    if (['zip','docx','xlsx','pptx'].includes(ext)) return mime.includes('zip') || (bytes[0] === 0x50 && bytes[1] === 0x4b);
    if (ext === 'exe') return bytes[0] === 0x4d && bytes[1] === 0x5a;
    if (ext === 'png') return mime === 'image/png' || (bytes[0]===0x89 && bytes[1]===0x50 && bytes[2]===0x4e && bytes[3]===0x47);
    if (['jpg','jpeg'].includes(ext)) return mime === 'image/jpeg' || (bytes[0]===0xff && bytes[1]===0xd8);
    if (['mp4','mov','m4v'].includes(ext)) {
      if (mime.startsWith('video/')) return true;
      const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 4096)).arrayBuffer());
      const ascii = String.fromCharCode(...head);
      const trimmed = ascii.replace(/^\s+/, '').slice(0, 32).toLowerCase();
      if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html') || trimmed.startsWith('{') || trimmed.startsWith('[')) return false;
      const knownBoxes = ['ftyp','moov','mdat','moof','styp','sidx'];
      let hits = 0;
      for (const box of knownBoxes) {
        const pos = ascii.indexOf(box);
        if (pos >= 4 && pos < 1024) hits += 1;
      }
      return hits >= 1;
    }
    if (ext === 'webm') return mime.includes('webm') || (bytes[0]===0x1a&&bytes[1]===0x45&&bytes[2]===0xdf&&bytes[3]===0xa3);
    return true;
  };
  const toDataUrl = (blob) => new Promise((resolve, reject) => { const reader=new FileReader(); reader.onload=()=>resolve(String(reader.result||'')); reader.onerror=()=>reject(reader.error||new Error('FileReader failed.')); reader.readAsDataURL(blob); });
  const fetchBinary = async (url, expectedName) => {
    try {
      const expectedExt = extOf(expectedName);
      const expectedVideo = /^(?:mp4|mov|webm|avi|mkv|m4v)$/i.test(expectedExt);
      const videoHeaders = expectedVideo ? {
        accept:'video/mp4,video/*;q=0.9,application/octet-stream;q=0.8,*/*;q=0.5',
        range:'bytes=0-'
      } : {};
      const maxBytes = expectedVideo ? MAX_VIDEO_ASSET_BYTES : MAX_ASSET_BYTES;
      const largeBinary = /^(?:zip|rar|7z|tar|gz|tgz|bz2|exe|msi|dmg|pkg|apk|deb|rpm)$/i.test(expectedExt);
      const response = await fetchWithTimeout(url, { headers:videoHeaders }, expectedVideo ? 60000 : (largeBinary ? 90000 : REQUEST_TIMEOUT_MS));
      if (!response.ok) return { error:`HTTP ${response.status}` };
      const declared = Number(response.headers.get('content-length') || 0);
      const contentRange = clean(response.headers.get('content-range') || '');
      const totalFromRange = Number(contentRange.match(/\/(\d+)$/)?.[1] || 0);
      if (declared > maxBytes || totalFromRange > maxBytes) return { error:`File exceeds ${Math.round(maxBytes / 1024 / 1024)} MB per-file archive limit.` };
      const blob = await response.blob();
      if (!(await blobValid(blob, expectedName))) return { error:'Returned bytes do not match the expected file type.' };
      return { blob, url:response.url || url };
    } catch (error) { return { error:String(error?.message || error) }; }
  };
  const descriptorUrls = (data, expectedName = filename) => {
    // File descriptors can expose several signed URLs at once. Video descriptors in
    // particular may contain a poster/preview URL beside the original media URL. 2.24.0
    // ranks every explicit candidate instead of trusting the first generic content URL.
    const seenObjects = new WeakSet();
    const found = [];
    const expectedExt = extOf(expectedName);
    const expectedVideo = /^(?:mp4|mov|webm|avi|mkv|m4v)$/i.test(expectedExt);
    const normalizeDescriptorUrl = (value) => {
      const url = normalizeUrl(value);
      if (!url) return '';
      try {
        const parsed = new URL(url, location.href);
        return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && parsed.hostname === location.hostname) ? parsed.href : '';
      } catch (_) { return ''; }
    };
    const scoreUrl = (url, keyHint = '') => {
      const key = clean(keyHint).toLowerCase();
      let score = 0;
      if (/(?:original|source)/i.test(key)) score += 70;
      if (/(?:download)/i.test(key)) score += 60;
      if (expectedVideo && /(?:video|media|movie|stream)/i.test(key)) score += 55;
      if (/(?:signed)/i.test(key)) score += 35;
      if (/(?:file)/i.test(key)) score += 25;
      if (/(?:content)/i.test(key)) score += expectedVideo ? 5 : 20;
      if (/^(?:url|href)$/i.test(key)) score += 1;
      try {
        const parsed = new URL(url, location.href);
        const pathExt = extOf(decodeURIComponent(parsed.pathname || ''));
        if (expectedExt && pathExt === expectedExt) score += 90;
        if (expectedVideo && /\.(?:mp4|mov|webm|m4v)(?:$|[?#])/i.test(parsed.href)) score += 80;
        if (expectedVideo && /(?:thumbnail|poster|preview|image|sprite)/i.test(parsed.href)) score -= 120;
        if (expectedVideo && /\.(?:png|jpe?g|gif|webp)(?:$|[?#])/i.test(parsed.href)) score -= 150;
      } catch (_) {}
      return score;
    };
    const add = (value, keyHint = '') => {
      const url = normalizeDescriptorUrl(value);
      if (!url) return;
      found.push({ url, score:scoreUrl(url, keyHint), key:keyHint });
    };
    const walk = (value, depth = 0, keyHint = '') => {
      if (depth > 8 || value == null) return;
      if (typeof value === 'string') {
        if (/^(?:https?:)?\/\//i.test(value)) add(value, keyHint);
        return;
      }
      if (typeof value !== 'object' || seenObjects.has(value)) return;
      seenObjects.add(value);
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 160)) walk(item, depth + 1, keyHint);
        return;
      }
      for (const [key, item] of Object.entries(value).slice(0, 180)) {
        if (typeof item === 'string' && /(?:url|href|link|download|content|file|video|media|source|original|signed)/i.test(key)) add(item, key);
        else walk(item, depth + 1, key);
      }
    };
    walk(data);
    const unique = new Map();
    for (const item of found) {
      const prev = unique.get(item.url);
      if (!prev || item.score > prev.score) unique.set(item.url, item);
    }
    return [...unique.values()].sort((a,b) => b.score - a.score).map((item) => item.url);
  };
  const descriptorUrl = (data, expectedName = filename) => descriptorUrls(data, expectedName)[0] || '';
  const structuredRefs = (message) => {
    const refs=[]; const seenObjects=new WeakSet(); const seenRefs=new Set();
    const add=(obj, inherited='') => {
      if(!obj||typeof obj!=='object')return;
      const id=[obj.file_id,obj.fileId,obj.asset_pointer,obj.assetPointer,obj.attachment_id,obj.attachmentId].map(fileIdOf).find(Boolean)||'';
      const sps=[obj.sandbox_path,obj.sandboxPath,obj.path,obj.href,obj.url].map(normalizeSandbox).filter(Boolean);
      const directUrls=[]; for(const [k,v] of Object.entries(obj)){if(typeof v==='string'&&/(?:url|href|download|content)/i.test(k)){const u=normalizeUrl(v);if(u&&isAssetUrl(u))directUrls.push(u);}}
      const name=filenameOf(obj.file_name||obj.filename||obj.name||obj.title||obj.label||obj.metadata?.file_name||obj.metadata?.filename||inherited||basename(sps[0]||''));
      if(!id&&!sps.length&&!directUrls.length)return;
      const key=`${id}|${sps[0]||''}|${directUrls[0]||''}|${normName(name)}`; if(seenRefs.has(key))return; seenRefs.add(key);
      refs.push({fileId:id,sandboxPaths:[...new Set(sps)],urls:[...new Set(directUrls)],filename:name,libraryFileId:clean(obj.library_file_id||obj.libraryFileId||''),gizmoId:clean(obj.gizmo_id||obj.gizmoId||'')});
    };
    const visit=(value,inherited='',depth=0,keyHint='')=>{
      if(depth>8||value==null)return;
      if(typeof value==='string'){
        const id=fileIdOf(value); const sp=normalizeSandbox(value); const u=normalizeUrl(value);
        if(id&&/(?:file|asset|attachment|pointer|id)/i.test(keyHint)) add({file_id:id},inherited);
        if(sp) add({sandbox_path:sp},inherited);
        if(u&&isAssetUrl(u)&&/(?:url|href|download|content|asset|attachment)/i.test(keyHint)) add({url:u},inherited);
        return;
      }
      if(typeof value!=='object'||seenObjects.has(value))return; seenObjects.add(value);
      if(Array.isArray(value)){for(const item of value.slice(0,240))visit(item,inherited,depth+1,keyHint);return;}
      const name=filenameOf(value.file_name||value.filename||value.name||value.title||inherited||'')||inherited;
      add(value,name);
      for(const [k,v] of Object.entries(value).slice(0,220)){if(v==null)continue;if(depth===0&&!/(?:metadata|attachments?|files?|parts|content|results?|assets?|references?)/i.test(k))continue;visit(v,name,depth+1,k);}
    };
    visit(message?.metadata||{},'',0,'metadata'); visit(message?.content||{},'',0,'content'); if(Array.isArray(message?.attachments))visit(message.attachments,'',0,'attachments');
    return refs;
  };
  const stripCopySuffix = (value) => normName(value)
    .replace(/\s*\(\d+\)(?=\.[a-z0-9]{1,10}$)/i,'')
    .replace(/\s+(?:copy|копія)(?=\.[a-z0-9]{1,10}$)/iu,'');
  const filenameMatches = (a,b) => {
    const na=normName(a), nb=normName(b); if(!na||!nb)return false;
    if(na===nb)return true;
    if(extOf(na)!==extOf(nb))return false;
    const ca=stripCopySuffix(na), cb=stripCopySuffix(nb);
    if(ca===cb)return true;
    return ca.endsWith(cb)||cb.endsWith(ca);
  };

  // Per-file DOM/React enrichment. We search only cards whose compact visible text contains
  // THIS candidate filename, then inspect a very small ancestor chain. This avoids the old
  // failure where one image URL leaked into every XLSX/DOCX/PDF/PPTX card in the message.
  try {
    const main=document.querySelector('main')||document.body;
    const targetName=normName(filename);
    const selector='[data-file-id],[data-attachment-id],[data-download-url],[data-thread-export-filename],[data-testid*=\"file\"],[data-testid*=\"attachment\"],[data-testid*=\"upload\"],[data-testid*=\"download\"],a[href],a[download],button,[role=\"button\"],[role=\"link\"]';
    const matched=[];
    for(const node of [...main.querySelectorAll(selector)].slice(0,2600)){
      const text=clean([node.getAttribute?.('download'),node.getAttribute?.('data-thread-export-filename'),node.getAttribute?.('aria-label'),node.getAttribute?.('title'),node.innerText,node.textContent].filter(Boolean).join(' '));
      if(!text)continue; const n=normName(text); if(!n.includes(targetName)&&!targetName.includes(n))continue; matched.push(node); if(matched.length>=12)break;
    }
    const localRefs=[]; const refSeen=new Set();
    const addLocalRef=(ref)=>{
      const id=fileIdOf(ref?.fileId||''); const sps=[...new Set((ref?.sandboxPaths||[]).map(normalizeSandbox).filter(Boolean))]; const rus=[...new Set((ref?.urls||[]).map(normalizeUrl).filter((u)=>u&&isAssetUrl(u)))]; const nm=filenameOf(ref?.filename||'');
      if(nm&&!filenameMatches(nm,filename))return;
      if(!id&&!sps.length&&!rus.length)return;
      const key=`${id}|${sps[0]||''}|${rus[0]||''}|${normName(nm)}`; if(refSeen.has(key))return; refSeen.add(key); localRefs.push({fileId:id,sandboxPaths:sps,urls:rus,filename:nm});
    };
    const walkReact=(value,nameHint='',depth=0,seen=new WeakSet(),keyHint='')=>{
      if(depth>6||value==null)return;
      if(typeof value==='string'){
        const id=fileIdOf(value), sp=normalizeSandbox(value), u=normalizeUrl(value), nm=filenameOf(nameHint)||filenameOf(value);
        if((id&&/(?:file|asset|attachment|pointer|id)/i.test(keyHint))||sp||(u&&isAssetUrl(u)&&/(?:url|href|download|content|asset|attachment)/i.test(keyHint)))addLocalRef({fileId:id,sandboxPaths:sp?[sp]:[],urls:u&&isAssetUrl(u)?[u]:[],filename:nm});
        return;
      }
      if(typeof value!=='object'||seen.has(value))return; seen.add(value);
      if(Array.isArray(value)){for(const item of value.slice(0,100))walkReact(item,nameHint,depth+1,seen,keyHint);return;}
      const nm=filenameOf(value.file_name||value.filename||value.name||value.title||value.label||nameHint||'')||nameHint;
      const id=[value.file_id,value.fileId,value.asset_pointer,value.assetPointer,value.attachment_id,value.attachmentId].map(fileIdOf).find(Boolean)||'';
      const sps=[value.sandbox_path,value.sandboxPath,value.path,value.href,value.url].map(normalizeSandbox).filter(Boolean);
      const rus=[];for(const [k,v] of Object.entries(value)){if(typeof v==='string'&&/(?:url|href|download|content)/i.test(k)){const u=normalizeUrl(v);if(u&&isAssetUrl(u))rus.push(u);}}
      if(id||sps.length||rus.length)addLocalRef({fileId:id,sandboxPaths:sps,urls:rus,filename:nm});
      for(const [k,v] of Object.entries(value).slice(0,130)){if(v==null)continue;if(depth>1&&!/(?:file|asset|attachment|sandbox|download|href|url|path|metadata|result|content|props|children|name|title|label|id|pointer)/i.test(k))continue;walkReact(v,nm,depth+1,seen,k);}
    };
    for(const node of matched){
      const chain=[];let cur=node;
      for(let d=0;cur&&d<5;d+=1){chain.push(cur);const parent=cur.parentElement;if(!parent)break;const pt=clean(parent.innerText||parent.textContent||'');if(d>=1&&pt.length>520)break;cur=parent;}
      const attrs=chain.flatMap((el)=>[...(el?.attributes||[])].map((a)=>String(a.value||'')));
      for(const raw of attrs){const id=fileIdOf(raw),sp=normalizeSandbox(raw),u=normalizeUrl(raw);if(id||sp||(u&&isAssetUrl(u)))addLocalRef({fileId:id,sandboxPaths:sp?[sp]:[],urls:u&&isAssetUrl(u)?[u]:[],filename});}
      for(const el of chain){try{for(const key of Object.getOwnPropertyNames(el)){if(/^__react(?:Props|Fiber)\$/i.test(key)&&el[key])walkReact(el[key],filename,0,new WeakSet(),'react');}}catch(_){}}
    }
    const exactRefs=localRefs.filter((r)=>!r.filename||filenameMatches(r.filename,filename));
    const uniqueIds=[...new Set(exactRefs.map((r)=>r.fileId).filter(Boolean))];
    const uniqueSps=[...new Set(exactRefs.flatMap((r)=>r.sandboxPaths||[]))];
    const uniqueUrls=[...new Set(exactRefs.flatMap((r)=>r.urls||[]))];
    if(uniqueIds.length===1)fileIds.push(uniqueIds[0]); else if(uniqueIds.length&&fileIds.length)fileIds.push(...uniqueIds.filter((id)=>fileIds.includes(id)));
    if(uniqueSps.length===1)sandboxPaths.push(uniqueSps[0]); else if(uniqueSps.length&&sandboxPaths.length)sandboxPaths.push(...uniqueSps.filter((p)=>sandboxPaths.includes(p)));
    // URL-only enrichment is safe for images. For non-images it must carry a file_id that
    // agrees with an identity found on the same card.
    for(const u of uniqueUrls){const id=fileIdOf(u);if(/^(?:png|jpe?g|gif|webp|svg)$/i.test(extOf(filename))||(id&&fileIds.includes(id)))urls.push(u);}
  } catch (error) { errors.push(`card enrichment: ${String(error?.message||error)}`); }

  // Enrich this one candidate from the actual conversation payload. This is intentionally
  // done per file, so one strange message cannot crash the entire archive pipeline.
  // 2.28.0: when a message-bound sandbox path is already known, do not burn the
  // per-file budget re-fetching the whole conversation before trying that exact path.
  if (conversationId && !sandboxPaths.length && fileIds.length && !urls.length) {
    try {
      const response = await fetchWithTimeout(`${location.origin}/backend-api/conversation/${encodeURIComponent(conversationId)}`, { headers:{ accept:'application/json' } }, CONVERSATION_ENRICH_TIMEOUT_MS);
      if (response.ok) {
        const conversation = await response.json();
        const mapping = conversation?.mapping && typeof conversation.mapping === 'object' ? conversation.mapping : {};
        const chain=[]; let nodeId=conversation?.current_node; const guard=new Set();
        while(nodeId&&mapping[nodeId]&&!guard.has(nodeId)){guard.add(nodeId);const node=mapping[nodeId];if(node?.message)chain.unshift(node.message);nodeId=node?.parent||'';}
        const branch=chain.length?chain:Object.values(mapping).map((node)=>node?.message).filter(Boolean).sort((a,b)=>Number(a?.create_time||0)-Number(b?.create_time||0));
        const visible=branch.filter((m)=>['user','assistant'].includes(String(m?.author?.role||''))&&!m?.metadata?.is_visually_hidden_from_conversation);
        let target = messageId ? branch.find((m)=>String(m?.id||'')===messageId) : null;
        if(!target && Number.isInteger(candidate.messageIndex)) target=visible[candidate.messageIndex]||null;
        const refs=[];
        if(target) refs.push(...structuredRefs(target));
        if(target?.author?.role==='assistant') {
          const targetIndex=branch.findIndex((m)=>String(m?.id||'')===String(target?.id||''));
          for(let i=Math.max(0,targetIndex-6);i<targetIndex;i+=1){const m=branch[i];if(['user','assistant'].includes(String(m?.author?.role||'')))continue;refs.push(...structuredRefs(m));}
        }
        const named=refs.filter((r)=>r.filename&&filenameMatches(r.filename,filename));
        const chosen=named.length?named:(refs.length===1?refs:[]);
        for(const ref of chosen){if(ref.fileId)fileIds.push(ref.fileId);sandboxPaths.push(...(ref.sandboxPaths||[]));urls.push(...(ref.urls||[]));if(ref.filename&&/^attachment-|\.bin$/i.test(filename))filename=sanitize(ref.filename,filename);if(ref.gizmoId)candidate.gizmoId=ref.gizmoId;}
      }
    } catch (error) { errors.push(`conversation enrichment: ${String(error?.message||error)}`); }
  }
  fileIds=[...new Set(fileIds.map(fileIdOf).filter(Boolean))]; sandboxPaths=[...new Set(sandboxPaths.map(normalizeSandbox).filter(Boolean))]; urls=[...new Set(urls.map(normalizeUrl).filter((u)=>u&&isAssetUrl(u)))];
  if (!initialHasIdentity && (fileIds.length || sandboxPaths.length || urls.length)) {
    deadline = Math.max(deadline, started + fullBudgetMs);
  }

  // Metadata validation prevents the same signed image URL/file_id being reused for XLSX,
  // DOCX, PDF, PPTX cards that happen to share a React ancestor.
  const validFileIds=[];
  for(const fileId of fileIds.slice(0,6)){
    if(Date.now()>=deadline)break;
    const metaUrls=[]; if(conversationId)metaUrls.push(`${location.origin}/backend-api/files/${encodeURIComponent(fileId)}/simple?conversation_id=${encodeURIComponent(conversationId)}`); metaUrls.push(`${location.origin}/backend-api/files/${encodeURIComponent(fileId)}/simple`);
    let metadataSeen=false, mismatch=false;
    for(const url of metaUrls){
      try{const response=await fetchWithTimeout(url,{headers:{accept:'application/json'}},1800);if(!response.ok)continue;metadataSeen=true;const data=await response.json();const metaName=filenameOf(data?.file_name||data?.filename||data?.name||'');if(metaName&&!filenameMatches(metaName,filename)){errors.push(`file_id ${fileId} belongs to ${metaName}, not ${filename}`);mismatch=true;continue;}if(metaName&&normName(metaName)===normName(filename))filename=sanitize(metaName,filename);candidate.gizmoId=clean(data?.gizmo_id||candidate.gizmoId||'');mismatch=false;break;}catch(_){}
    }
    if(!metadataSeen||!mismatch)validFileIds.push(fileId);
  }
  fileIds=validFileIds;

  // 2.26.0: replay exact live resource URLs for the validated file_id. Video cards often
  // load a working signed Estuary/media URL into Resource Timing even when the generic
  // /files/download descriptor later yields a stale or access-denied URL.
  try {
    const liveUrls=[];
    for(const entry of performance.getEntriesByType?.('resource')||[]){
      const u=normalizeUrl(entry?.name);
      if(!u||!isAssetUrl(u))continue;
      const id=fileIdOf(u);
      if(id&&fileIds.includes(id)&&!liveUrls.includes(u))liveUrls.push(u);
    }
    if(liveUrls.length) urls=[...new Set([...liveUrls.reverse(),...urls])];
  }catch(_){}

  const emitIncluded = async (blob, sourceUrl, detectedBy, outputName=filename) => ({ messageIndex:candidate.messageIndex, type:'attachment', label:candidate.label||outputName, filename:sanitize(outputName,filename), sourceUrl:sourceUrl||'', mimeType:blob.type||'application/octet-stream', size:blob.size, dataUrl:await toDataUrl(blob), included:true, detectedBy });

  // Use a direct URL only if it agrees with a validated file_id or this is an image candidate.
  for(const url of urls.slice(0,videoCandidate ? 10 : 4)){
    if(Date.now()>=deadline)break;
    const urlId=fileIdOf(url); const image=/^(?:png|jpe?g|gif|webp|svg)$/i.test(extOf(filename));
    if(urlId&&fileIds.length&&!fileIds.includes(urlId))continue;
    if(urlId&&!fileIds.length&&!image)continue;
    const direct=await fetchBinary(url,filename); if(direct.blob)return emitIncluded(direct.blob,direct.url||url,'modular-direct-url'); if(direct.error)errors.push(`direct: ${direct.error}`);
  }

  if(conversationId&&messageId){
    for(const sandboxPath of sandboxPaths.slice(0,4)){
      if(Date.now()>=deadline)break;
      const params=new URLSearchParams({message_id:messageId,sandbox_path:sandboxPath});
      const route=`${location.origin}/backend-api/conversation/${encodeURIComponent(conversationId)}/interpreter/download?${params}`;
      try{
        const response=await fetchWithTimeout(route,{headers:{accept:'application/json'}},SANDBOX_DESCRIPTOR_TIMEOUT_MS);
        if(!response.ok){errors.push(`sandbox HTTP ${response.status}`);continue;}
        const ct=clean(response.headers.get('content-type')).toLowerCase();
        if(!ct.includes('application/json')){const blob=await response.blob();const out=basename(sandboxPath)||filename;if(await blobValid(blob,out))return emitIncluded(blob,response.url||route,'modular-sandbox',out);errors.push('sandbox returned non-file bytes');continue;}
        const data=await response.json(); const out=filenameOf(data?.file_name||data?.filename||'')||basename(sandboxPath)||filename; const signedUrls=descriptorUrls(data,out);
        if(!signedUrls.length){errors.push('sandbox descriptor had no signed URL');continue;}
        for(const signed of signedUrls.slice(0, videoCandidate ? 8 : 3)){
          if(Date.now()>=deadline)break;
          const direct=await fetchBinary(signed,out);if(direct.blob)return emitIncluded(direct.blob,direct.url||signed,'modular-sandbox',out);if(direct.error)errors.push(`sandbox bytes: ${direct.error}`);
        }
      }catch(error){errors.push(`sandbox: ${String(error?.message||error)}`);}
    }
  }

  for(const fileId of fileIds.slice(0,6)){
    if(Date.now()>=deadline)break;
    const routes=[]; const gizmoId=clean(candidate.gizmoId||projectId||'');
    const encodedFileId=encodeURIComponent(fileId);
    const isVideo=/^(?:mp4|mov|webm|avi|mkv|m4v)$/i.test(extOf(filename));
    const addRoute=(url,label)=>{if(url&&!routes.some(([existing])=>existing===url))routes.push([url,label]);};
    if(gizmoId){
      addRoute(`${location.origin}/backend-api/files/download/${encodedFileId}?gizmo_id=${encodeURIComponent(gizmoId)}&inline=false`,'project');
      if(isVideo) addRoute(`${location.origin}/backend-api/files/${encodedFileId}/download?gizmo_id=${encodeURIComponent(gizmoId)}&inline=false`,'project-alt');
    }
    if(conversationId){
      addRoute(`${location.origin}/backend-api/files/download/${encodedFileId}?conversation_id=${encodeURIComponent(conversationId)}&inline=false`,'conversation');
      if(isVideo) addRoute(`${location.origin}/backend-api/files/${encodedFileId}/download?conversation_id=${encodeURIComponent(conversationId)}&inline=false`,'conversation-alt');
    }
    addRoute(`${location.origin}/backend-api/files/download/${encodedFileId}?inline=false`,'generic');
    if(isVideo) addRoute(`${location.origin}/backend-api/files/${encodedFileId}/download?inline=false`,'generic-alt');
    for(const [route,label] of routes){
      if(Date.now()>=deadline)break;
      try{
        const response=await fetchWithTimeout(route,{headers:{accept:'application/json'}},FILE_DESCRIPTOR_TIMEOUT_MS);
        if(!response.ok){errors.push(`${label} HTTP ${response.status}`);continue;}
        const ct=clean(response.headers.get('content-type')).toLowerCase();
        if(!ct.includes('application/json')){const blob=await response.blob();if(await blobValid(blob,filename))return emitIncluded(blob,response.url||route,`modular-${label}`);errors.push(`${label} returned wrong bytes`);continue;}
        const data=await response.json(); const returnedName=filenameOf(data?.file_name||data?.filename||''); const out=returnedName&&filenameMatches(returnedName,filename)?filename:(returnedName||filename); const signedUrls=descriptorUrls(data,out);
        if(!signedUrls.length){errors.push(`${label} descriptor had no signed URL`);continue;}
        for(const signed of signedUrls.slice(0,isVideo ? 10 : 3)){
          if(Date.now()>=deadline)break;
          const direct=await fetchBinary(signed,out);if(direct.blob)return emitIncluded(direct.blob,direct.url||signed,`modular-${label}`,out);if(direct.error)errors.push(`${label} bytes: ${direct.error}`);
        }
      }catch(error){errors.push(`${label}: ${String(error?.message||error)}`);}
    }
    const estuary=`${location.origin}/backend-api/estuary/content?id=${encodeURIComponent(fileId)}`; const direct=await fetchBinary(estuary,filename); if(direct.blob)return emitIncluded(direct.blob,direct.url||estuary,'modular-estuary'); if(direct.error)errors.push(`estuary: ${direct.error}`);
  }

  if(Date.now()>=deadline)errors.push(`File time budget ${Math.round((initialHasIdentity || fileIds.length || sandboxPaths.length || urls.length ? fullBudgetMs : LEGACY_DISCOVERY_BUDGET_MS)/1000)}s exceeded.`);
  const uniqueErrors = [...new Set(errors)];
  const hasIdentity = Boolean(fileIds.length || sandboxPaths.length || urls.length);
  const terminalHttp = uniqueErrors.filter((item) => /\bHTTP (?:403|404|410|422)\b/i.test(item));
  const availabilityStatus = !hasIdentity ? 'metadata-unavailable' : (terminalHttp.length ? 'expired-or-access-denied' : 'download-failed');
  const retryRecommended = availabilityStatus === 'download-failed';
  const reason = !hasIdentity
    ? 'ChatGPT no longer exposes a reusable file_id, sandbox path, or signed URL for this legacy file card.'
    : availabilityStatus === 'expired-or-access-denied'
      ? `ChatGPT still exposes the file reference, but the available download routes now return terminal access/not-found responses (${terminalHttp.slice(0,4).join('; ')}).`
      : `Message-bound file could not be downloaded: ${uniqueErrors.slice(0,8).join('; ') || 'download route unavailable'}`;
  return { messageIndex:candidate.messageIndex, type:'attachment', label:candidate.label||filename, filename, included:false, reason, availabilityStatus, retryRecommended, detectedBy:'modular-unresolved' };
}

async function collectEarlyMessageAttachmentSnapshot(selectedIndices) {
  const selected = Array.isArray(selectedIndices) ? new Set(selectedIndices.filter(Number.isInteger)) : null;
  const hints = [];
  const seen = new Set();
  const FILE_ID_RE = /file[-_][a-z0-9_-]{12,}/ig;
  const FILE_END_RE = /\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|tar|gz|tgz|bz2|txt|csv|tsv|jsonl?|md|html?|xml|ya?ml|ini|log|har|sql|php|m?js|cjs|tsx?|jsx|css|scss|py|ipynb|java|c|cpp|h|hpp|cs|go|rs|rb|sh|ps1|bat|cmd|exe|msi|dmg|pkg|apk|deb|rpm|png|jpe?g|gif|webp|svg|mp3|wav|flac|m4a|mp4|mov|webm|avi|mkv|woff2?|ttf|otf)$/iu;
  const clean = (v) => String(v || '').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim().slice(0,1800);
  const normalizeSandbox = (value) => {
    let raw=String(value||'').trim().replace(/^sandbox:/i,'');
    try{raw=decodeURIComponent(raw);}catch(_){}
    raw=raw.replace(/\\/g,'/').replace(/[.,;:!?]+$/g,'');
    while(/[\]}]$/.test(raw)) raw=raw.slice(0,-1);
    if(!raw.startsWith('/mnt/data/') || raw.includes('\0') || /(?:^|\/)\.\.(?:\/|$)/.test(raw)) return '';
    return raw.slice(0,1200);
  };
  const sandboxPathsFrom = (value) => {
    const text=String(value||''); const out=[];
    const direct=normalizeSandbox(text); if(direct) out.push(direct);
    for(const pattern of [/sandbox:\/mnt\/data\/[^\s<>'"`]+/giu,/\/mnt\/data\/[^\s<>'"`]+/gu]) {
      for(const token of text.match(pattern)||[]) { const p=normalizeSandbox(token); if(p) out.push(p); }
    }
    const unique=[...new Set(out)];
    return unique.filter((path)=>!unique.some((other)=>other!==path&&other.startsWith(`${path} `)));
  };
  const filenameExact = (value) => {
    let text=clean(value).replace(/^(?:download|завантажити|скачати|отримати)\s+(?:file|файл)?\s*[:—-]?\s*/iu,'').trim();
    if(!text || text.length>240 || !FILE_END_RE.test(text) || /[<>:"|?*\x00-\x1f]/.test(text)) return '';
    return text;
  };
  const filenamesFrom = (value) => {
    const text=String(value||''); const out=[]; const exact=filenameExact(text); if(exact) out.push(exact);
    const re=/[^\\/\s<>:"|?*]+\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|tar|gz|tgz|bz2|txt|csv|tsv|jsonl?|md|html?|xml|ya?ml|ini|log|har|sql|php|m?js|cjs|tsx?|jsx|css|scss|py|ipynb|java|c|cpp|h|hpp|cs|go|rs|rb|sh|ps1|bat|cmd|exe|msi|dmg|pkg|apk|deb|rpm|png|jpe?g|gif|webp|svg|mp3|wav|flac|m4a|mp4|mov|webm|avi|mkv|woff2?|ttf|otf)/giu;
    for(const token of text.match(re)||[]) out.push(clean(token));
    return [...new Set(out.filter(Boolean))];
  };
  const normalizeUrl=(value)=>{ const raw=String(value||'').trim(); if(!raw||/^(?:javascript|about|sandbox):/i.test(raw))return''; try{const u=new URL(raw,location.href).href;return /^(?:https?:|blob:|data:)/i.test(u)?u:'';}catch(_){return'';} };
  const isAssetUrl=(url)=>/backend-api\/estuary\/content|backend-api\/files|files\.oaiusercontent\.com|oaiusercontent\.com|\/download(?:\/|\?|$)|\/attachment(?:\/|$)/i.test(String(url||''));
  const add=(hint)=>{
    const fileId=(String(hint.fileId||'').match(/file[-_][a-z0-9_-]{12,}/i)||[])[0]||'';
    const sandboxPaths=[...new Set([...(hint.sandboxPaths||[]),...sandboxPathsFrom(hint.sandboxPath||'')].map(normalizeSandbox).filter(Boolean))];
    const sandboxName=sandboxPaths[0]?.split('/').pop()||'';
    const filename=filenameExact(hint.filename||sandboxName)||filenamesFrom(hint.filename||sandboxName)[0]||'';
    const url=normalizeUrl(hint.url); const messageIndex=Number.isInteger(hint.messageIndex)?hint.messageIndex:-1; const messageId=clean(hint.messageId); const label=clean(hint.label);
    const unresolvedCard = !fileId && !sandboxPaths.length && !url && Boolean((hint.fileCard || hint.generatedCard) && filename);
    if(!fileId && !sandboxPaths.length && !url && !unresolvedCard) return;
    if(url && !isAssetUrl(url)) return;
    const key=`${messageIndex}|${messageId}|${fileId||sandboxPaths[0]||url||`card:${filename.toLocaleLowerCase()}`}`;
    if(seen.has(key)) return; seen.add(key);
    hints.push({filename,fileId,url,sandboxPaths,messageIndex,messageId,label,fileCard:Boolean(hint.fileCard),generatedCard:Boolean(hint.generatedCard),detectedBy:hint.detectedBy||'early-snapshot'});
  };
  const idFromPointer=(value)=>String(value||'').match(/(?:file-service:\/\/|sediment:\/\/)?(file[-_][a-z0-9_-]{12,})/i)?.[1]||'';
  const collectObjectRefs=(value, inheritedName='', depth=0, seenObjects=new WeakSet(), keyHint='')=>{
    const refs=[]; let visits=0; const keysFileish=/(?:file|asset|attachment|upload|sandbox|download|href|url|path|metadata|result|content|parts|props|children|name|title|label|id|pointer)/i;
    const walk=(item,nameHint,level,hint)=>{
      if(level>8||item==null||visits>550) return;
      if(typeof item==='string') {
        const fileId=idFromPointer(item); const sps=sandboxPathsFrom(item); const url=normalizeUrl(item);
        if((fileId && keysFileish.test(hint)) || sps.length || (url&&isAssetUrl(url)&&keysFileish.test(hint))) refs.push({fileId,sandboxPaths:sps,url:url&&isAssetUrl(url)?url:'',filename:nameHint});
        return;
      }
      if(typeof item!=='object'||seenObjects.has(item)) return; seenObjects.add(item); visits+=1;
      if(Array.isArray(item)){ for(const child of item.slice(0,260)) walk(child,nameHint,level+1,hint); return; }
      const directId=[item.file_id,item.fileId,item.asset_pointer,item.assetPointer,item.attachment_id,item.attachmentId].map(idFromPointer).find(Boolean)||'';
      const sps=[...new Set([item.sandbox_path,item.sandboxPath,item.path,item.href,item.url].flatMap(sandboxPathsFrom))];
      const directUrls=[]; for(const [k,v] of Object.entries(item)){ if(typeof v==='string'&&/(?:url|href|download|content)/i.test(k)){const u=normalizeUrl(v);if(u&&isAssetUrl(u))directUrls.push(u);} }
      const names=[item.file_name,item.filename,item.name,item.title,item.label,item.metadata?.file_name,item.metadata?.filename,nameHint].flatMap(filenamesFrom).filter(Boolean);
      if(directId||sps.length||directUrls.length) refs.push({fileId:directId,sandboxPaths:sps,url:directUrls[0]||'',filename:names[0]||''});
      const nextName=names[0]||nameHint;
      for(const [k,v] of Object.entries(item).slice(0,260)){ if(v==null)continue; if(level===0&&!keysFileish.test(k))continue; if(level>0&&!keysFileish.test(k)&&level>2)continue; walk(v,nextName,level+1,k); }
    };
    walk(value,inheritedName,depth,keyHint); return refs;
  };
  const deepReactRefs=(root)=>{
    const refs=[]; const all=[...root.querySelectorAll('*')].slice(0,2200); const scan=new Set();
    const marker=/(?:file|asset|attachment|upload|download|sandbox|вкладенн|завантаж|\.(?:pdf|docx?|xlsx?|pptx?|zip|txt|log|har|png|jpe?g|mp4|mov|webm)\b)/iu;
    for(const node of all){
      const attrs=[...(node.attributes||[])].map(a=>`${a.name}=${a.value}`).join(' ');
      const ownText=(node.children?.length||0)<=5 ? clean(node.textContent||'').slice(0,300) : '';
      if(!marker.test(`${attrs} ${ownText}`)) continue;
      let cursor=node; for(let depth=0;cursor&&depth<6;depth+=1){scan.add(cursor);if(cursor===root)break;cursor=cursor.parentElement;}
      if(scan.size>=180) break;
    }
    // The root itself is not scanned unless a file-like descendant led us to it. This
    // avoids walking the entire conversation fiber and keeps export responsive.
    let objects=0;
    for(const node of scan){
      let reactRoots=[]; try{
        const keys=Object.getOwnPropertyNames(node);
        for(const key of keys){ if(/^__reactProps\$/i.test(key)) reactRoots.unshift(node[key]); else if(/^__reactFiber\$/i.test(key)) reactRoots.push(node[key]); }
      }catch(_){}
      if(!reactRoots.length) continue;
      for(const rr of reactRoots.slice(0,2)){
        const found=collectObjectRefs(rr,'',0,new WeakSet(),'react'); refs.push(...found); objects+=found.length;
        if(objects>500) return refs;
      }
    }
    return refs;
  };
  const main=document.querySelector('main')||document.body; const roots=[]; const seenRoots=new Set();
  for(const roleNode of main.querySelectorAll('[data-message-author-role]')){ const root=roleNode.closest('article,[data-testid^="conversation-turn-"],[data-message-id],[class*="group/conversation-turn"]')||roleNode; if(!seenRoots.has(root)){seenRoots.add(root);roots.push(root);} }
  if(!roots.length){for(const root of main.querySelectorAll('[data-testid^="conversation-turn-"],[data-message-id],article,[class*="group/conversation-turn"]')){if(!seenRoots.has(root)){seenRoots.add(root);roots.push(root);}}}
  roots.forEach((root,messageIndex)=>{
    if(selected&&!selected.has(messageIndex))return; const messageId=clean(root.getAttribute?.('data-message-id')||root.querySelector?.('[data-message-id]')?.getAttribute?.('data-message-id')||'');
    // Attributes cover ordinary user-upload cards and currently visible generated links.
    for(const node of [root,...root.querySelectorAll('*')].slice(0,2200)){
      const values=[...(node.attributes||[])].map(a=>String(a.value||'')); const joined=values.join('\n');
      const ids=[...new Set(joined.match(FILE_ID_RE)||[])]; FILE_ID_RE.lastIndex=0;
      const sps=sandboxPathsFrom(joined); const urls=values.map(normalizeUrl).filter(u=>u&&isAssetUrl(u));
      if(!ids.length&&!sps.length&&!urls.length)continue;
      const text=clean([node.getAttribute?.('download'),node.getAttribute?.('aria-label'),node.getAttribute?.('title'),node.textContent].filter(Boolean).join(' '));
      const name=filenamesFrom(sps[0]?.split('/').pop()||'')[0]||filenamesFrom(text)[0]||'';
      for(const id of ids)add({fileId:id,sandboxPaths:sps,url:urls[0]||'',filename:name,label:text,messageIndex,messageId,fileCard:true,detectedBy:'early-dom-identity'});
      if(!ids.length&&(sps.length||urls.length))add({fileId:'',sandboxPaths:sps,url:urls[0]||'',filename:name,label:text,messageIndex,messageId,fileCard:true,generatedCard:sps.length>0,detectedBy:'early-dom-identity'});
    }
    // Important 2.17 path: scan React data for the entire selected message, not only
    // clickable descendants. Still message-bound, so unrelated chats cannot leak in.
    for(const ref of deepReactRefs(root)) add({...ref,messageIndex,messageId,label:ref.filename||'',fileCard:true,generatedCard:Boolean(ref.sandboxPaths?.length),detectedBy:'early-message-react'});
  });

  // 2.18.0: ChatGPT can render a file card as a sibling of the visual message turn.
  // Scan file-like controls across <main>, then bind each real file identity to the nearest
  // selected message by containment/geometry/document order. Plain filename prose still
  // cannot create a candidate because a file ID, sandbox path or asset URL is required.
  const rootInfos=roots.map((root,messageIndex)=>({root,messageIndex,messageId:clean(root.getAttribute?.('data-message-id')||root.querySelector?.('[data-message-id]')?.getAttribute?.('data-message-id')||'')}));
  const bindGlobalNode=(node)=>{
    const eligible=rootInfos.filter((info)=>!selected||selected.has(info.messageIndex));
    const direct=eligible.find((info)=>info.root===node||info.root.contains?.(node)); if(direct)return {info:direct,method:'containment'};
    let nodeRect=null; try{nodeRect=node.getBoundingClientRect?.();}catch(_){}
    if(nodeRect&&Number.isFinite(nodeRect.top)&&Number.isFinite(nodeRect.bottom)){
      let best=null;
      for(const info of eligible){
        let rect=null; try{rect=info.root.getBoundingClientRect?.();}catch(_){}
        if(!rect||!Number.isFinite(rect.top)||!Number.isFinite(rect.bottom))continue;
        const gap=nodeRect.bottom<rect.top?rect.top-nodeRect.bottom:(nodeRect.top>rect.bottom?nodeRect.top-rect.bottom:0);
        const center=Math.abs(((nodeRect.top+nodeRect.bottom)/2)-((rect.top+rect.bottom)/2));
        const score=gap*4+center; if(!best||score<best.score)best={info,score,gap};
      }
      if(best&&best.gap<=520)return {info:best.info,method:'geometry'};
    }
    let preceding=null;
    for(const info of eligible){try{if(info.root.compareDocumentPosition(node)&Node.DOCUMENT_POSITION_FOLLOWING)preceding=info;}catch(_){}}
    return preceding?{info:preceding,method:'document-order'}:null;
  };
  const globalSelector='a[download],a[href],button,[role="button"],[role="link"],[data-file-id],[data-attachment-id],[data-download-url],[data-thread-export-filename],[data-testid*="attachment"],[data-testid*="file"],[data-testid*="upload"],[data-testid*="download"]';
  for(const node of [...main.querySelectorAll(globalSelector)].slice(0,2600)){
    if(rootInfos.some((info)=>info.root.contains?.(node)))continue;
    const binding=bindGlobalNode(node); if(!binding)continue; const {messageIndex,messageId}=binding.info;
    const chain=[]; let cursor=node;
    for(let depth=0;cursor&&depth<6;depth+=1){chain.push(cursor);if(cursor===main)break;const parent=cursor.parentElement;if(!parent)break;const text=clean(parent.textContent||'');if(depth>=2&&text.length>900)break;cursor=parent;}
    const values=chain.flatMap((item)=>[...(item.attributes||[])].map((a)=>String(a.value||''))); const joined=values.join('\n');
    const ids=[...new Set(joined.match(FILE_ID_RE)||[])]; FILE_ID_RE.lastIndex=0;
    const sps=[...new Set(values.flatMap(sandboxPathsFrom))]; const urls=[...new Set(values.map(normalizeUrl).filter((u)=>u&&isAssetUrl(u)))];
    const reactRefs=[];
    for(const item of chain){try{for(const key of Object.getOwnPropertyNames(item)){if(/^__react(?:Props|Fiber)\$/i.test(key)&&item[key])reactRefs.push(...collectObjectRefs(item[key],'',0,new WeakSet(),'react'));}}catch(_){}}
    const text=clean([node.getAttribute?.('download'),node.getAttribute?.('aria-label'),node.getAttribute?.('title'),node.textContent].filter(Boolean).join(' '));
    const attrName=filenamesFrom(sps[0]?.split('/').pop()||'')[0]||filenamesFrom(text)[0]||'';
    if(ids.length||sps.length||urls.length){
      if(ids.length)for(const id of ids)add({fileId:id,sandboxPaths:sps,url:urls[0]||'',filename:attrName,label:text,messageIndex,messageId,fileCard:true,generatedCard:sps.length>0,detectedBy:`early-global-card-${binding.method}`});
      else add({fileId:'',sandboxPaths:sps,url:urls[0]||'',filename:attrName,label:text,messageIndex,messageId,fileCard:true,generatedCard:sps.length>0,detectedBy:`early-global-card-${binding.method}`});
    }
    for(const ref of reactRefs){
      const identity=ref.fileId||(ref.sandboxPaths||[]).length||ref.url; if(!identity)continue;
      add({...ref,messageIndex,messageId,label:ref.filename||text,fileCard:true,generatedCard:Boolean(ref.sandboxPaths?.length),detectedBy:`early-global-react-${binding.method}`});
    }
  }

  // Off-screen/virtualized messages: capture structured file objects from the actual
  // conversation payload before transcript preparation mutates or replaces the page.
  const conversationId=location.pathname.match(/\/c\/([a-z0-9-]{8,})/i)?.[1]||'';
  let conversation=null;
  if(conversationId){
    const paths=[`/backend-api/conversation/${encodeURIComponent(conversationId)}`];
    for(const path of paths){
      try{ let response=await fetch(path,{credentials:'include',cache:'no-store',headers:{accept:'application/json'}});
        if(response.status===401||response.status===403){
          try{const sessionResp=await fetch('/api/auth/session',{credentials:'include',cache:'no-store'});if(sessionResp.ok){const session=await sessionResp.json();const token=String(session?.accessToken||'');if(token){const headers={accept:'application/json',authorization:`Bearer ${token}`};const account=String(session?.account?.id||session?.user?.account_id||session?.user?.accountId||'');if(account)headers['chatgpt-account-id']=account;response=await fetch(path,{credentials:'include',cache:'no-store',headers});}}}catch(_){}
        }
        if(response.ok){conversation=await response.json();break;}
      }catch(_){}
    }
  }
  if(conversation?.mapping&&typeof conversation.mapping==='object'){
    const chain=[]; let nodeId=conversation.current_node; const guard=new Set();
    while(nodeId&&conversation.mapping[nodeId]&&!guard.has(nodeId)){guard.add(nodeId);const node=conversation.mapping[nodeId];if(node?.message)chain.unshift(node.message);nodeId=node?.parent||'';}
    const branch=chain.length?chain:Object.values(conversation.mapping).map(n=>n?.message).filter(Boolean).sort((a,b)=>Number(a?.create_time||0)-Number(b?.create_time||0));
    const visible=branch.filter(m=>['user','assistant'].includes(String(m?.author?.role||''))&&!m?.metadata?.is_visually_hidden_from_conversation);
    visible.forEach((message,messageIndex)=>{
      if(selected&&!selected.has(messageIndex))return; const messageId=clean(message?.id||''); const role=String(message?.author?.role||'');
      const refs=[]; refs.push(...collectObjectRefs(message?.metadata||{},'',0,new WeakSet(),'metadata')); refs.push(...collectObjectRefs(message?.content||{},'',0,new WeakSet(),'content')); if(Array.isArray(message?.attachments))refs.push(...collectObjectRefs(message.attachments,'',0,new WeakSet(),'attachments'));
      for(const ref of refs)add({...ref,messageIndex,messageId,label:ref.filename||'',fileCard:true,generatedCard:role==='assistant'&&Boolean(ref.sandboxPaths?.length),detectedBy:'early-conversation-message'});
    });
    // Tool-generated artifacts commonly live in a tool message immediately before the
    // assistant message that presents the download link. Bind only to that assistant.
    for(let i=0;i<branch.length;i+=1){const message=branch[i];if(['user','assistant'].includes(String(message?.author?.role||'')))continue;const refs=[...collectObjectRefs(message?.metadata||{},'',0,new WeakSet(),'metadata'),...collectObjectRefs(message?.content||{},'',0,new WeakSet(),'content')];if(!refs.length)continue;const next=branch.slice(i+1).find(m=>String(m?.author?.role||'')==='assistant');if(!next)continue;const messageIndex=visible.findIndex(m=>String(m?.id||'')===String(next?.id||''));if(messageIndex<0||(selected&&!selected.has(messageIndex)))continue;for(const ref of refs)add({...ref,messageIndex,messageId:clean(next.id||''),label:ref.filename||'',fileCard:true,generatedCard:true,detectedBy:'early-conversation-tool'});}
  }
  return {hints};
}

async function collectConversationAttachmentHints(selectedIndices) {
  const selected = Array.isArray(selectedIndices) ? new Set(selectedIndices.filter(Number.isInteger)) : null;
  const hints = [];
  const seen = new Set();
  const filePattern = /[^\\/\s<>:"|?*]+\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|tar|gz|tgz|bz2|txt|csv|tsv|jsonl?|md|html?|xml|ya?ml|ini|log|har|sql|php|m?js|cjs|tsx?|jsx|css|scss|py|ipynb|java|c|cpp|h|hpp|cs|go|rs|rb|sh|ps1|bat|cmd|exe|msi|dmg|pkg|apk|deb|rpm|png|jpe?g|gif|webp|svg|mp3|wav|flac|m4a|mp4|mov|webm|avi|mkv|woff2?|ttf|otf)/iu;
  const fileEndingPattern = /\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|tar|gz|tgz|bz2|txt|csv|tsv|jsonl?|md|html?|xml|ya?ml|ini|log|har|sql|php|m?js|cjs|tsx?|jsx|css|scss|py|ipynb|java|c|cpp|h|hpp|cs|go|rs|rb|sh|ps1|bat|cmd|exe|msi|dmg|pkg|apk|deb|rpm|png|jpe?g|gif|webp|svg|mp3|wav|flac|m4a|mp4|mov|webm|avi|mkv|woff2?|ttf|otf)$/iu;
  const fileIdPattern = /file[-_][a-z0-9_-]{12,}/ig;
  const clean = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1600);
  const exactFilename = (value) => {
    let text = clean(value).replace(/^(?:download|завантажити|скачати|отримати)\s+(?:file|файл)?\s*[:—-]?\s*/iu, '').trim();
    if (!text || text.length > 220 || !fileEndingPattern.test(text) || /[<>:"|?*\x00-\x1f]/.test(text)) return '';
    return text;
  };
  const normalizeSandboxPath = (value) => {
    let raw = String(value || '').trim();
    if (!raw) return '';
    raw = raw.replace(/^sandbox:/i, '');
    try { raw = decodeURIComponent(raw); } catch (_) {}
    raw = raw.replace(/\\/g, '/').replace(/[.,;:!?]+$/g, '');
    if (!raw.startsWith('/mnt/data/')) return '';
    if (raw.includes('\0') || /(?:^|\/)\.\.(?:\/|$)/.test(raw)) return '';
    return raw.slice(0, 1200);
  };
  const extractSandboxPaths = (value) => {
    const text = String(value || '');
    const out = [];
    const direct = normalizeSandboxPath(text);
    if (direct) out.push(direct);
    for (const pattern of [/sandbox:\/mnt\/data\/[^\s<>'"`]+/giu, /\/mnt\/data\/[^\s<>'"`]+/gu]) {
      for (const match of text.match(pattern) || []) {
        const normalized = normalizeSandboxPath(match);
        if (normalized) out.push(normalized);
      }
    }
    return [...new Set(out)];
  };
  const normalizeUrl = (value) => {
    const raw = String(value || '').trim();
    if (!raw || /^(?:javascript|about|sandbox):/i.test(raw)) return '';
    try {
      const url = new URL(raw, location.href).href;
      return /^(?:https?:|blob:|data:)/i.test(url) ? url : '';
    } catch (_) { return ''; }
  };
  const isServiceName = (value) => /^(?:sprites?[-_.]|favicon[-_.]|icon[-_.]|attachment-(?:file-)?(?:icon|tile|radius)[-_.])|(?:^|[-_.])sprites?(?:[-_.]|$)/i.test(String(value || '').trim());
  const isAssetUrl = (url) => /backend-api\/estuary\/content|backend-api\/files|files\.oaiusercontent\.com|oaiusercontent\.com|\/download(?:\/|\?|$)|\/attachment(?:\/|$)/i.test(String(url || ''));
  const messageIdFor = (root) => clean(root?.getAttribute?.('data-message-id') || root?.querySelector?.('[data-message-id]')?.getAttribute?.('data-message-id') || '');
  const generatedPrefix = /^(?:download|завантажити|скачати|отримати)(?:\s|[:—-]|$)/iu;
  const generatedMarker = /(?:attachment|file[-_ ]?(?:card|tile|download)|download[-_ ]?file|generated[-_ ]?file|вкладенн|завантаж.*файл|файл.*завантаж)/iu;
  const add = (hint) => {
    const sandboxPaths = [...new Set([...(hint.sandboxPaths || []), ...extractSandboxPaths(hint.sandboxPath || '')].map(normalizeSandboxPath).filter(Boolean))];
    const sandboxName = sandboxPaths[0] ? sandboxPaths[0].split('/').pop() : '';
    const filename = exactFilename(hint.filename || sandboxName) || clean(hint.filename || sandboxName).match(filePattern)?.[0] || '';
    const fileId = (clean(hint.fileId).match(fileIdPattern) || [])[0] || '';
    const url = normalizeUrl(hint.url);
    const messageIndex = Number.isInteger(hint.messageIndex) ? hint.messageIndex : -1;
    const messageId = clean(hint.messageId);
    const label = clean(hint.label);
    if (isServiceName(filename)) return;
    const unresolvedCard = !fileId && !url && !sandboxPaths.length && Boolean((hint.fileCard || hint.generatedCard) && filename);
    if (!fileId && !url && !sandboxPaths.length && !unresolvedCard) return;
    if (url && !isAssetUrl(url)) return;
    const key = `${messageIndex}|${messageId}|${fileId}|${url}|${sandboxPaths.join('|')}|${unresolvedCard ? filename.toLocaleLowerCase() : ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    hints.push({
      filename, fileId, url, sandboxPaths, messageIndex, messageId, label,
      generatedCard:Boolean(hint.generatedCard),
      fileCard:Boolean(hint.fileCard),
      detectedBy:hint.detectedBy || 'message-bound-dom'
    });
  };

  // 2.14.0: ChatGPT generated-file cards can show a human label such as
  // “Download … Portable” while the real .zip name/file_id exists only in React props.
  // Inspect only the interactive control and its compact ancestors inside THIS message.
  // No clicks and no global React walk are performed.
  const reactRefsForNodes = (nodes) => {
    const refs = { fileIds:[], sandboxPaths:[], filenames:[], urls:[] };
    const roots = [];
    const seenRoots = new Set();
    for (const node of nodes || []) {
      if (!node || seenRoots.has(node)) continue;
      seenRoots.add(node);
      try {
        for (const key of Object.getOwnPropertyNames(node)) {
          if (/^__react(?:Props|Fiber)\$/i.test(key) && node[key]) roots.push(node[key]);
        }
      } catch (_) {}
    }
    if (!roots.length) return refs;
    const seenObjects = new WeakSet();
    let visited = 0;
    const walk = (value, keyHint = '', depth = 0) => {
      if (depth > 6 || value == null || visited > 520) return;
      if (typeof value === 'string') {
        refs.fileIds.push(...(value.match(fileIdPattern) || []));
        refs.sandboxPaths.push(...extractSandboxPaths(value));
        if (/(?:url|href|download|content|attachment|asset)/i.test(keyHint)) {
          const url = normalizeUrl(value);
          if (url && isAssetUrl(url)) refs.urls.push(url);
        }
        if (/(?:file[_ -]?name|filename|download|attachment|sandbox|path|href|url|title|label|name)/i.test(keyHint)) {
          const match = exactFilename(value) || clean(value).match(filePattern)?.[0] || '';
          if (match) refs.filenames.push(match);
        }
        return;
      }
      if (typeof value !== 'object' || seenObjects.has(value)) return;
      seenObjects.add(value); visited += 1;
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 80)) walk(item, keyHint, depth + 1);
        return;
      }
      for (const [key, item] of Object.entries(value).slice(0, 120)) {
        if (item == null) continue;
        const relevant = /(?:file|asset|attachment|sandbox|download|href|url|path|metadata|result|content|props|children|name|title|label|id)/i.test(key);
        if (depth <= 1 || relevant) walk(item, key, depth + 1);
      }
    };
    roots.forEach((root) => walk(root));
    refs.fileIds = [...new Set(refs.fileIds)];
    refs.sandboxPaths = [...new Set(refs.sandboxPaths.map(normalizeSandboxPath).filter(Boolean))];
    refs.filenames = [...new Set(refs.filenames.filter((name) => !isServiceName(name)))];
    refs.urls = [...new Set(refs.urls.filter(Boolean))];
    return refs;
  };

  // 2.16.0: user-upload cards and assistant output-file cards are not always marked
  // as "Download" and often keep the real file_id/asset_pointer only in React props.
  // Inspect compact interactive/file-like subtrees inside ONE selected message. A candidate
  // is emitted only when that subtree exposes real file identity/path/asset URL, so prose
  // mentioning "something.pdf" still cannot become a fake attachment.
  const fileCardHintsFor = (root, messageIndex, messageId) => {
    const selector = [
      '[data-file-id]','[data-attachment-id]','[data-download-url]','[data-testid*="file"]',
      '[data-testid*="attachment"]','[data-testid*="upload"]','[data-testid*="preview"]',
      'a[href]','a[download]','button','[role="button"]','[role="link"]','img'
    ].join(',');
    const controls = [...root.querySelectorAll(selector)].slice(0, 1200);
    const visitedControls = new Set();
    for (const control of controls) {
      if (!control || visitedControls.has(control)) continue;
      visitedControls.add(control);
      const chain = [];
      let cursor = control;
      for (let depth = 0; cursor && depth < 6; depth += 1) {
        chain.push(cursor);
        if (cursor === root) break;
        cursor = cursor.parentElement;
      }
      const descriptor = clean(chain.flatMap((node) => [
        node?.getAttribute?.('data-testid'), node?.getAttribute?.('aria-label'), node?.getAttribute?.('title'),
        node?.getAttribute?.('download'), node?.getAttribute?.('data-file-id'), node?.getAttribute?.('data-attachment-id'),
        node?.getAttribute?.('data-download-url'), node?.getAttribute?.('data-thread-export-filename'), node?.className
      ]).filter((value) => typeof value === 'string' && value).join(' '));
      const compactTexts = chain.map((node) => clean(node?.innerText || node?.textContent || '')).filter((text) => text && text.length <= 320);
      const label = compactTexts.find((text) => (clean(text).match(filePattern) || []).length) || compactTexts[0] || descriptor;
      const attrs = chain.flatMap((node) => [...(node?.attributes || [])].map((attr) => String(attr.value || '')));
      const reactRefs = reactRefsForNodes(chain);
      const fileIds = [...new Set([...attrs.flatMap((value) => value.match(fileIdPattern) || []), ...reactRefs.fileIds])];
      const sandboxPaths = [...new Set([...attrs.flatMap(extractSandboxPaths), ...reactRefs.sandboxPaths].map(normalizeSandboxPath).filter(Boolean))];
      const urls = [...new Set([...attrs.map(normalizeUrl).filter(Boolean).filter(isAssetUrl), ...reactRefs.urls])];
      const identityPresent = fileIds.length || sandboxPaths.length || urls.length;

      const marker = /(?:^|[\s_:/-])(?:file|files|attachment|attachments|upload|uploaded|preview|download)(?:[\s_:/-]|$)|вкладенн|завантаж|файл/iu;
      const sandboxName = sandboxPaths[0] ? sandboxPaths[0].split('/').pop() : '';
      const names = [...new Set([
        exactFilename(sandboxName) || clean(sandboxName).match(filePattern)?.[0] || '',
        ...reactRefs.filenames,
        ...compactTexts.flatMap((text) => exactFilename(text) ? [exactFilename(text)] : (clean(text).match(filePattern) || []))
      ].filter((name) => name && !isServiceName(name)))];
      filePattern.lastIndex = 0;
      // Require either an explicit file-ish UI marker or a genuine filename from the same
      // compact subtree. This keeps navigation/profile buttons with unrelated React data out.
      if (!marker.test(descriptor) && !names.length) continue;
      // 2.19.0: a real message-bound file card is itself evidence. Keep a filename-only
      // candidate even when ChatGPT has not exposed file_id/sandbox URL in this DOM world;
      // later React/API enrichment may resolve it, otherwise it becomes an honest missing file.
      if (!identityPresent && !names.length) continue;
      const filename = names[0] || '';
      if (fileIds.length) {
        for (const fileId of fileIds) add({ filename, label, fileId, url:urls[0] || '', sandboxPaths, messageIndex, messageId, fileCard:true, detectedBy:'message-bound-file-card-main' });
      } else if (urls.length) {
        for (const url of urls) add({ filename, label, fileId:(url.match(fileIdPattern) || [])[0] || '', url, sandboxPaths, messageIndex, messageId, fileCard:true, detectedBy:'message-bound-file-card-main' });
      } else {
        add({ filename, label, fileId:'', url:'', sandboxPaths, messageIndex, messageId, fileCard:true, detectedBy:'message-bound-file-card-main' });
      }
    }
  };

  const generatedCardHintsFor = (root, messageIndex, messageId) => {
    const interactiveSelector = [
      'a[href]','a[download]','button','[role="button"]','[role="link"]',
      '[tabindex]:not([tabindex="-1"])','[onclick]','[data-testid*="download"]',
      '[data-testid*="file"]','[data-testid*="attachment"]','[data-download-url]',
      '[data-file-id]','[data-attachment-id]','[class*="cursor-pointer"]','[class*="download"]'
    ].join(',');
    const controls = [...root.querySelectorAll(interactiveSelector)].slice(0, 900);
    for (const control of controls) {
      const descriptor = clean([
        control.getAttribute?.('data-testid'), control.getAttribute?.('aria-label'), control.getAttribute?.('title'),
        control.getAttribute?.('download'), control.getAttribute?.('data-download-url'), control.getAttribute?.('data-file-id'),
        control.getAttribute?.('data-attachment-id')
      ].filter(Boolean).join(' '));

      const chain = [control];
      let compactLabel = '';
      let cursor = control;
      for (let depth = 0; cursor && depth < 7; depth += 1) {
        if (!chain.includes(cursor)) chain.push(cursor);
        const text = clean(cursor.innerText || cursor.textContent || '');
        if (!compactLabel && text && text.length <= 260 && generatedPrefix.test(text)) compactLabel = text;
        if (cursor === root) break;
        cursor = cursor.parentElement;
      }

      const ownText = clean(control.innerText || control.textContent || '');
      const looksGenerated = generatedMarker.test(descriptor) || generatedPrefix.test(ownText) || Boolean(compactLabel);
      if (!looksGenerated) continue;

      const attrs = chain.flatMap((node) => [...(node?.attributes || [])].map((attr) => String(attr.value || '')));
      const reactRefs = reactRefsForNodes(chain);
      const fileIds = [...new Set([...attrs.flatMap((value) => value.match(fileIdPattern) || []), ...reactRefs.fileIds])];
      const sandboxPaths = [...new Set([...attrs.flatMap(extractSandboxPaths), ...reactRefs.sandboxPaths].map(normalizeSandboxPath).filter(Boolean))];
      const urls = [...new Set(attrs.map(normalizeUrl).filter(Boolean).filter(isAssetUrl))];
      const sandboxName = sandboxPaths[0] ? sandboxPaths[0].split('/').pop() : '';
      const label = compactLabel || ownText || descriptor;
      const filename = exactFilename(sandboxName) || clean(sandboxName).match(filePattern)?.[0] || reactRefs.filenames[0] || exactFilename(label) || clean(label).match(filePattern)?.[0] || '';

      // A prose phrase is still ignored, but a real interactive generated-file control with
      // a concrete filename is promoted even if this DOM world cannot see its file_id yet.
      // The candidate is enriched from React/API later or reported as missing instead of vanishing.
      if (!fileIds.length && !sandboxPaths.length && !urls.length && !filename) continue;
      if (fileIds.length) {
        for (const fileId of fileIds) add({ filename, label, fileId, url:urls[0] || '', sandboxPaths, messageIndex, messageId, generatedCard:true, detectedBy:'message-bound-generated-card-main' });
      } else if (urls.length) {
        for (const url of urls) add({ filename, label, fileId:(url.match(fileIdPattern) || [])[0] || '', url, sandboxPaths, messageIndex, messageId, generatedCard:true, detectedBy:'message-bound-generated-card-main' });
      } else {
        add({ filename, label, fileId:'', url:'', sandboxPaths, messageIndex, messageId, generatedCard:true, detectedBy:'message-bound-generated-card-main' });
      }
    }
  };

  const main = document.querySelector('main') || document.body;
  const roots = [];
  const seenRoots = new Set();
  for (const roleNode of main.querySelectorAll('[data-message-author-role]')) {
    const root = roleNode.closest('article,[data-testid^="conversation-turn-"],[data-message-id],[class*="group/conversation-turn"]') || roleNode;
    if (!seenRoots.has(root)) { seenRoots.add(root); roots.push(root); }
  }
  if (!roots.length) {
    for (const root of main.querySelectorAll('[data-testid^="conversation-turn-"],[data-message-id],article,[class*="group/conversation-turn"]')) {
      if (!seenRoots.has(root)) { seenRoots.add(root); roots.push(root); }
    }
  }

  roots.forEach((root, messageIndex) => {
    if (selected && !selected.has(messageIndex)) return;
    const messageId = messageIdFor(root);
    const selector = [
      '[data-file-id]','[data-attachment-id]','[data-download-url]','[data-thread-export-filename]',
      'a[download]','a[href*="/backend-api/files"]','a[href*="/backend-api/estuary/content"]',
      'a[href*="oaiusercontent"]','[data-testid*="attachment"]','[data-testid*="file"]'
    ].join(',');
    for (const node of root.querySelectorAll(selector)) {
      const attrs = [...(node.attributes || [])].map((attr) => String(attr.value || ''));
      const fileIds = [...new Set(attrs.flatMap((value) => value.match(fileIdPattern) || []))];
      const urls = [...new Set(attrs.map(normalizeUrl).filter(Boolean).filter(isAssetUrl))];
      const sandboxPaths = [...new Set(attrs.flatMap(extractSandboxPaths))];
      const label = [node.getAttribute?.('download'), node.getAttribute?.('data-thread-export-filename'), node.getAttribute?.('aria-label'), node.getAttribute?.('title'), node.innerText].filter(Boolean).join(' ');
      const sandboxName = sandboxPaths[0] ? sandboxPaths[0].split('/').pop() : '';
      const filename = exactFilename(sandboxName || label) || clean(sandboxName || label).match(filePattern)?.[0] || '';
      for (const fileId of fileIds) add({ filename, label, fileId, url:'', sandboxPaths, messageIndex, messageId, detectedBy:'message-bound-dom-id' });
      for (const url of urls) add({ filename, label, fileId:(url.match(fileIdPattern) || [])[0] || '', url, sandboxPaths, messageIndex, messageId, detectedBy:'message-bound-dom-url' });
      if (sandboxPaths.length) add({ filename, label, fileId:fileIds[0] || '', url:'', sandboxPaths, messageIndex, messageId, detectedBy:'message-bound-sandbox-dom' });
    }

    fileCardHintsFor(root, messageIndex, messageId);
    generatedCardHintsFor(root, messageIndex, messageId);
  });

  // 2.18.0: file cards may be DOM siblings of the message turn rather than descendants.
  // Bind compact, real-identity cards from all of <main> back to the nearest selected turn.
  const globalRootInfos = roots.map((root, messageIndex) => ({ root, messageIndex, messageId:messageIdFor(root) }));
  const bindGlobalControl = (control) => {
    const eligible = globalRootInfos.filter((info) => !selected || selected.has(info.messageIndex));
    const direct = eligible.find((info) => info.root === control || info.root.contains?.(control));
    if (direct) return { info:direct, method:'containment' };
    let cr = null; try { cr = control.getBoundingClientRect?.(); } catch (_) {}
    if (cr && Number.isFinite(cr.top) && Number.isFinite(cr.bottom)) {
      let best = null;
      for (const info of eligible) {
        let rr = null; try { rr = info.root.getBoundingClientRect?.(); } catch (_) {}
        if (!rr || !Number.isFinite(rr.top) || !Number.isFinite(rr.bottom)) continue;
        const gap = cr.bottom < rr.top ? rr.top - cr.bottom : (cr.top > rr.bottom ? cr.top - rr.bottom : 0);
        const center = Math.abs(((cr.top + cr.bottom) / 2) - ((rr.top + rr.bottom) / 2));
        const score = gap * 4 + center;
        if (!best || score < best.score) best = { info, score, gap };
      }
      if (best && best.gap <= 520) return { info:best.info, method:'geometry' };
    }
    let preceding = null;
    for (const info of eligible) { try { if (info.root.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING) preceding = info; } catch (_) {} }
    return preceding ? { info:preceding, method:'document-order' } : null;
  };
  const globalSelector = [
    '[data-file-id]','[data-attachment-id]','[data-download-url]','[data-thread-export-filename]',
    '[data-testid*="file"]','[data-testid*="attachment"]','[data-testid*="upload"]','[data-testid*="download"]',
    'a[href]','a[download]','button','[role="button"]','[role="link"]'
  ].join(',');
  for (const control of [...main.querySelectorAll(globalSelector)].slice(0, 2600)) {
    if (globalRootInfos.some((info) => info.root.contains?.(control))) continue;
    const binding = bindGlobalControl(control);
    if (!binding) continue;
    const chain = []; let cursor = control;
    for (let depth = 0; cursor && depth < 6; depth += 1) {
      chain.push(cursor); if (cursor === main) break;
      const parent = cursor.parentElement; if (!parent) break;
      const parentText = clean(parent.innerText || parent.textContent || '');
      if (depth >= 2 && parentText.length > 900) break;
      cursor = parent;
    }
    const attrs = chain.flatMap((node) => [...(node?.attributes || [])].map((attr) => String(attr.value || '')));
    const reactRefs = reactRefsForNodes(chain);
    const fileIds = [...new Set([...attrs.flatMap((value) => value.match(fileIdPattern) || []), ...reactRefs.fileIds])];
    const sandboxPaths = [...new Set([...attrs.flatMap(extractSandboxPaths), ...reactRefs.sandboxPaths].map(normalizeSandboxPath).filter(Boolean))];
    const urls = [...new Set([...attrs.map(normalizeUrl).filter(Boolean).filter(isAssetUrl), ...reactRefs.urls])];
    const compactTexts = chain.map((node) => clean(node?.innerText || node?.textContent || '')).filter((text) => text && text.length <= 320);
    const label = compactTexts.find((text) => (clean(text).match(filePattern) || []).length) || compactTexts[0] || '';
    const sandboxName = sandboxPaths[0] ? sandboxPaths[0].split('/').pop() : '';
    const names = [...new Set([
      exactFilename(sandboxName) || clean(sandboxName).match(filePattern)?.[0] || '',
      ...reactRefs.filenames,
      ...compactTexts.flatMap((text) => exactFilename(text) ? [exactFilename(text)] : (clean(text).match(filePattern) || []))
    ].filter((name) => name && !isServiceName(name)))];
    filePattern.lastIndex = 0;
    const filename = names[0] || '';
    if (!fileIds.length && !sandboxPaths.length && !urls.length && !filename) continue;
    const common = { filename, label, sandboxPaths, messageIndex:binding.info.messageIndex, messageId:binding.info.messageId, fileCard:true, generatedCard:Boolean(sandboxPaths.length), detectedBy:`global-file-card-${binding.method}` };
    if (fileIds.length) for (const fileId of fileIds) add({ ...common, fileId, url:urls[0] || '' });
    else if (urls.length) for (const url of urls) add({ ...common, fileId:(url.match(fileIdPattern) || [])[0] || '', url });
    else add({ ...common, fileId:'', url:'' });
  }

  // Global resource URLs are enrichment only and are usable later only if their file_id
  // matches an attachment already bound to a selected message.
  for (const entry of performance.getEntriesByType?.('resource') || []) {
    const url = normalizeUrl(entry?.name);
    if (!url || !isAssetUrl(url)) continue;
    const fileId = (url.match(fileIdPattern) || [])[0] || '';
    if (!fileId) continue;
    add({ filename:'', fileId, url, messageIndex:-1, messageId:'', detectedBy:'resource-by-file-id' });
  }

  return { hints };
}

async function collectInteractiveAttachmentAssets() {
  // 2.4.0 deliberately avoids all synthetic UI interaction. Static DOM/React-state
  // discovery plus file-ID download resolution is used instead.
  return { assets: [] };
}

async function collectReactTriggeredAttachmentAssets() {
  // Retained as a compatibility symbol for older helper code. 2.4.0 never invokes
  // ChatGPT UI/React download handlers because doing so produces visible UI errors.
  return { assets: [] };
}

async function collectCompletePortableAssets(selectedIndices, rawHints, exportId) {
  const MAX_ASSET_BYTES = 192 * 1024 * 1024;
  const MAX_VIDEO_ASSET_BYTES = 768 * 1024 * 1024;
  const MAX_TOTAL_BYTES = 640 * 1024 * 1024;
  const MAX_ASSETS = 120;
  const MAX_CONCURRENCY = 1;
  const REQUEST_TIMEOUT_MS = 30000;
  const METADATA_TIMEOUT_MS = 8000;
  const FILE_BUDGET_MS = 120000;
  const VIDEO_FILE_BUDGET_MS = 300000;
  const selected = Array.isArray(selectedIndices) ? new Set(selectedIndices.filter(Number.isInteger)) : null;
  const rawBoundHints = Array.isArray(rawHints) ? rawHints : [];
  let totalBytes = 0;
  let cancelled = false;
  const activeControllers = new Set();
  const startedAt = Date.now();
  const progressId = String(exportId || '');
  const reportProgress = (progress = {}) => {
    try { chrome.runtime.sendMessage({ type:'zip-export-progress', exportId:progressId, elapsedMs:Date.now() - startedAt, ...progress }).catch(() => {}); } catch (_) {}
  };
  const cancelListener = (message) => {
    if (message?.type !== 'gptpm-cancel-zip-export') return false;
    if (progressId && message.exportId && String(message.exportId) !== progressId) return false;
    cancelled = true;
    for (const controller of [...activeControllers]) { try { controller.abort(); } catch (_) {} }
    reportProgress({ stage:'cancelled', percent:92 });
    return false;
  };
  try { chrome.runtime.onMessage.addListener(cancelListener); } catch (_) {}
  try { setTimeout(() => { try { chrome.runtime.onMessage.removeListener(cancelListener); } catch (_) {} }, 180000); } catch (_) {}
  reportProgress({ stage:'scanning', percent:7, current:0, total:0, included:0, skipped:0 });

  const filePattern = /[^\\/\s<>:"|?*]+\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|tar|gz|tgz|bz2|txt|csv|tsv|jsonl?|md|html?|xml|ya?ml|ini|log|har|sql|php|m?js|cjs|tsx?|jsx|css|scss|py|ipynb|java|c|cpp|h|hpp|cs|go|rs|rb|sh|ps1|bat|cmd|exe|msi|dmg|pkg|apk|deb|rpm|png|jpe?g|gif|webp|svg|mp3|wav|flac|m4a|mp4|mov|webm|avi|mkv|woff2?|ttf|otf)/giu;
  const fileEndingPattern = /\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|tar|gz|tgz|bz2|txt|csv|tsv|jsonl?|md|html?|xml|ya?ml|ini|log|har|sql|php|m?js|cjs|tsx?|jsx|css|scss|py|ipynb|java|c|cpp|h|hpp|cs|go|rs|rb|sh|ps1|bat|cmd|exe|msi|dmg|pkg|apk|deb|rpm|png|jpe?g|gif|webp|svg|mp3|wav|flac|m4a|mp4|mov|webm|avi|mkv|woff2?|ttf|otf)$/iu;
  const fileIdPattern = /file[-_][a-z0-9_-]{12,}/ig;
  const cleanText = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const normalizeSandboxPath = (value) => {
    let raw = String(value || '').trim();
    if (!raw) return '';
    raw = raw.replace(/^sandbox:/i, '');
    try { raw = decodeURIComponent(raw); } catch (_) {}
    raw = raw.replace(/\\/g, '/');
    if (!raw.startsWith('/mnt/data/')) return '';
    if (raw.includes('\0') || /(?:^|\/)\.\.(?:\/|$)/.test(raw)) return '';
    return raw.slice(0, 1200);
  };
  const extractSandboxPaths = (value) => {
    const text = String(value || '');
    const out = [];
    const trimToken = (value) => {
      let raw = String(value || '').trim().replace(/[.,;:!?]+$/g, '');
      while (/[\]}]$/.test(raw)) raw = raw.slice(0, -1);
      const count = (ch) => [...raw].filter((item) => item === ch).length;
      while (raw.endsWith(')') && count(')') > count('(')) raw = raw.slice(0, -1);
      return raw;
    };
    const direct = normalizeSandboxPath(trimToken(text));
    if (direct) out.push(direct);
    const patterns = [
      /sandbox:\/mnt\/data\/[^\s<>'"`]+/giu,
      /\/mnt\/data\/[^\s<>'"`]+/gu
    ];
    for (const pattern of patterns) {
      for (const match of text.match(pattern) || []) {
        const normalized = normalizeSandboxPath(trimToken(match));
        if (normalized) out.push(normalized);
      }
    }
    const unique = [...new Set(out)];
    return unique.filter((path) => !unique.some((other) => other !== path && other.startsWith(`${path} `)));
  };
  const normalizeName = (value) => cleanText(value).normalize('NFKC').replace(/^_+/, '').toLocaleLowerCase();
  const sanitizeFilename = (value, fallback = 'attachment.bin') => cleanText(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) || fallback;
  const exactFilename = (value) => {
    let text = cleanText(value).replace(/^(?:download|завантажити|скачати|отримати)\s+(?:file|файл)?\s*[:—-]?\s*/iu, '').trim();
    if (!text || text.length > 220 || !fileEndingPattern.test(text) || /[<>:"|?*\x00-\x1f]/.test(text)) return '';
    return sanitizeFilename(text, '');
  };
  const extractFilenames = (value) => {
    const exact = exactFilename(value);
    const tokens = (String(value || '').match(filePattern) || []).map((item) => sanitizeFilename(item));
    return [...new Set([exact, ...tokens].filter(Boolean))];
  };
  const extractFileIds = (value) => [...new Set(String(value || '').match(fileIdPattern) || [])];
  const isServiceName = (value) => /^(?:sprites?[-_.]|favicon[-_.]|icon[-_.]|attachment-(?:file-)?(?:icon|tile|radius)[-_.])|(?:^|[-_.])sprites?(?:[-_.]|$)/i.test(String(value || '').trim());
  const normalizeUrl = (value) => {
    const raw = String(value || '').trim();
    if (!raw || /^(?:javascript|about|sandbox):/i.test(raw) || /^file[-_][a-z0-9_-]{12,}$/i.test(raw)) return '';
    try {
      const url = new URL(raw, location.href).href;
      return /^(?:https?:|blob:|data:)/i.test(url) ? url : '';
    } catch (_) { return ''; }
  };
  const isAssetUrl = (value) => /backend-api\/estuary\/content|backend-api\/files|files\.oaiusercontent\.com|oaiusercontent\.com|\/download(?:\/|\?|$)|\/attachment(?:\/|$)/i.test(String(value || ''));
  const filenameFromUrl = (url) => {
    try { return decodeURIComponent(new URL(url, location.href).pathname.split('/').filter(Boolean).pop() || ''); }
    catch (_) { return ''; }
  };
  const extensionForMime = (mime) => ({
    'application/pdf':'pdf','application/zip':'zip','application/json':'json','text/plain':'txt','text/csv':'csv','text/markdown':'md',
    'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp','image/svg+xml':'svg','audio/mpeg':'mp3','video/mp4':'mp4'
  }[String(mime || '').toLowerCase()] || 'bin');
  const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('FileReader failed.'));
    reader.readAsDataURL(blob);
  });
  const canvasFallback = async (image) => {
    if (!image?.complete || !image.naturalWidth || !image.naturalHeight) return null;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      canvas.getContext('2d').drawImage(image, 0, 0);
      return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    } catch (_) { return null; }
  };
  const runPool = async (items, worker, concurrency = MAX_CONCURRENCY, onDone = null) => {
    let cursor = 0, completed = 0;
    const results = new Array(items.length);
    const runner = async () => {
      while (!cancelled) {
        const index = cursor++;
        if (index >= items.length) break;
        try { results[index] = await worker(items[index], index); }
        catch (error) { results[index] = { error:String(error?.message || error) }; }
        completed += 1;
        try { onDone?.(completed, items.length, index, results[index]); } catch (_) {}
      }
    };
    await Promise.all(Array.from({ length:Math.min(concurrency, Math.max(1, items.length)) }, () => runner()));
    return results;
  };

  const roots = [];
  const seenRoots = new Set();
  const main = document.querySelector('main') || document.body;
  for (const roleNode of main.querySelectorAll('[data-message-author-role]')) {
    const root = roleNode.closest('article,[data-testid^="conversation-turn-"],[data-message-id],[class*="group/conversation-turn"]') || roleNode;
    if (!seenRoots.has(root)) { seenRoots.add(root); roots.push(root); }
  }
  if (!roots.length) {
    for (const root of main.querySelectorAll('[data-testid^="conversation-turn-"],[data-message-id],article,[class*="group/conversation-turn"]')) {
      if (!seenRoots.has(root)) { seenRoots.add(root); roots.push(root); }
    }
  }
  const messageIdForRoot = (root) => cleanText(root?.getAttribute?.('data-message-id') || root?.querySelector?.('[data-message-id]')?.getAttribute?.('data-message-id') || '');
  const roleForRoot = (root) => cleanText(root?.querySelector?.('[data-message-author-role]')?.getAttribute?.('data-message-author-role') || root?.getAttribute?.('data-message-author-role') || '');
  const messageInfo = roots.map((root, messageIndex) => ({ root, messageIndex, messageId:messageIdForRoot(root), role:roleForRoot(root) }));

  const candidates = [];
  const candidateKeys = new Set();
  const addCandidate = (candidate) => {
    const ids = [...new Set(candidate.fileIds || [])];
    const filename = sanitizeFilename(candidate.filename || candidate.label || '', candidate.type === 'image' ? 'image.png' : (ids[0] ? `attachment-${String(ids[0]).slice(-16)}.bin` : 'attachment.bin'));
    const candidateSandbox = [...new Set((candidate.sandboxPaths || []).map(normalizeSandboxPath).filter(Boolean))];
    const key = candidate.type === 'image'
      ? `${candidate.messageIndex}|image|${candidate.sourceUrl || normalizeName(filename)}`
      : `${candidate.messageIndex}|attachment|${ids[0] || candidateSandbox[0] || normalizeName(filename)}`;
    const existing = candidates.find((item) => item._candidateKey === key);
    if (existing) {
      existing.fileIds = [...new Set([...(existing.fileIds || []), ...ids])];
      existing.urls = [...new Set([...(existing.urls || []), ...(candidate.urls || []), candidate.sourceUrl || ''].map(normalizeUrl).filter(Boolean))];
      existing.sandboxPaths = [...new Set([...(existing.sandboxPaths || []), ...(candidate.sandboxPaths || [])].map(normalizeSandboxPath).filter(Boolean))];
      existing.sandboxMessageIds = [...new Set([...(existing.sandboxMessageIds || []), ...(candidate.sandboxMessageIds || [])].map(cleanText).filter(Boolean))];
      if (!existing.messageId && candidate.messageId) existing.messageId = candidate.messageId;
      if (/^attachment-[a-z0-9_-]+\.bin$/i.test(existing.filename) && !/^attachment-[a-z0-9_-]+\.bin$/i.test(filename)) existing.filename = filename;
      return existing;
    }
    if (candidateKeys.has(key) || candidates.length >= MAX_ASSETS * 3) return null;
    candidateKeys.add(key);
    const item = { ...candidate, _candidateKey:key, filename, fileIds:ids, urls:[...new Set([...(candidate.urls || []), candidate.sourceUrl || ''].map(normalizeUrl).filter(Boolean))], sandboxPaths:candidateSandbox, sandboxMessageIds:[...new Set((candidate.sandboxMessageIds || []).map(cleanText).filter(Boolean))] };
    candidates.push(item);
    return item;
  };

  const generatedFilenameFromLabel = (value, fallback = 'generated-file.bin') => {
    const text = cleanText(value).replace(/^(?:download|завантажити|скачати|отримати)\s+(?:file|файл)?\s*[:\-]?\s*/iu, '').trim();
    const explicit = extractFilenames(text)[0] || '';
    if (explicit) return explicit;
    if (!text || text.length > 150) return fallback;
    return sanitizeFilename(`${text}.bin`, fallback);
  };
  const pipelineDiagnostics = {
    status:'running',
    rawHints:rawBoundHints.length,
    promotedHints:0,
    promotedUnresolved:0,
    candidatesAfterPromotion:0,
    candidatesBeforeDownload:0,
    downloadCandidates:0,
    candidateErrors:0,
    candidateErrorSamples:[]
  };
  const resolveHintMessageIndex = (hint) => {
    const direct = Number.isInteger(hint?.messageIndex) ? hint.messageIndex : -1;
    if (direct >= 0 && (!selected || selected.has(direct))) return direct;
    const messageId = cleanText(hint?.messageId || '');
    if (messageId) {
      const info = messageInfo.find((item) => item.messageId && item.messageId === messageId);
      if (info && (!selected || selected.has(info.messageIndex))) return info.messageIndex;
    }
    return -1;
  };
  const promoteBoundHintCandidate = (hint) => {
    if (!hint || typeof hint !== 'object') return null;
    const messageIndex = resolveHintMessageIndex(hint);
    if (messageIndex < 0) return null;
    const detector = cleanText(hint.detectedBy || '');
    const cardEvidence = Boolean(hint.fileCard || hint.generatedCard || /(?:early-|message-bound|global-file-card|conversation-)/i.test(detector));
    if (!cardEvidence) return null;
    const fileId = cleanText(hint.fileId || '').match(/file[-_][a-z0-9_-]{12,}/i)?.[0] || '';
    const url = normalizeUrl(hint.url || '');
    const sandboxPaths = [...new Set((hint.sandboxPaths || []).map(normalizeSandboxPath).filter(Boolean))];
    const sandboxName = sandboxPaths[0] ? sandboxPaths[0].split('/').pop() : '';
    const label = cleanText(hint.label || '');
    const explicitFilename = extractFilenames(hint.filename || sandboxName)[0] || extractFilenames(label)[0] || extractFilenames(filenameFromUrl(url))[0] || '';
    const hasIdentity = Boolean(fileId || url || sandboxPaths.length);
    // Filename-only promotion is deliberately narrow: it must come from a real message-bound
    // card detector. Plain prose filenames never enter rawBoundHints as fileCard/generatedCard.
    if (!hasIdentity && !explicitFilename) return null;
    const fallback = `attachment-message-${messageIndex + 1}.bin`;
    const filename = sanitizeFilename(explicitFilename || (fileId ? `attachment-${String(fileId).slice(-16)}.bin` : fallback), fallback);
    const info = messageInfo.find((item) => item.messageIndex === messageIndex);
    const created = addCandidate({
      type:'attachment',
      messageIndex,
      messageId:cleanText(hint.messageId || info?.messageId || ''),
      filename,
      label:label || filename,
      sourceUrl:url,
      urls:url ? [url] : [],
      fileIds:fileId ? [fileId] : [],
      sandboxPaths,
      sandboxMessageIds:cleanText(hint.messageId || info?.messageId || '') ? [cleanText(hint.messageId || info?.messageId || '')] : [],
      unresolvedCard:!hasIdentity,
      detectedBy:`promoted-${detector || 'message-bound-hint'}`
    });
    if (created) {
      pipelineDiagnostics.promotedHints += 1;
      if (!hasIdentity) pipelineDiagnostics.promotedUnresolved += 1;
    }
    return created;
  };
  for (const hint of rawBoundHints) promoteBoundHintCandidate(hint);
  pipelineDiagnostics.candidatesAfterPromotion = candidates.length;

  const isGeneratedDownloadControl = (element, descriptor = '', visible = '') => {
    if (!element?.matches?.('a,button,[role="link"],[role="button"]')) return false;
    const markerText = cleanText(`${descriptor} ${visible}`);
    if (/(?:attachment|file[-_ ]?(?:card|tile|download)|download[-_ ]?file|generated[-_ ]?file|вкладенн|завантаж.*файл|файл.*завантаж)/iu.test(descriptor)) return true;
    return /^(?:download|завантажити|скачати|отримати)(?:\s|[:—-]|$)/iu.test(cleanText(visible));
  };
  const reactGeneratedRefs = (element) => {
    const refs = { fileIds:[], sandboxPaths:[], filenames:[] };
    if (!element) return refs;
    const roots = [];
    try {
      for (const key of Object.getOwnPropertyNames(element)) {
        if (/^__react(?:Props|Fiber)\$/i.test(key)) roots.push(element[key]);
      }
    } catch (_) {}
    if (!roots.length) return refs;
    const seenObjects = new WeakSet();
    let visited = 0;
    const walk = (value, keyHint = '', depth = 0) => {
      if (depth > 6 || value == null || visited > 420) return;
      if (typeof value === 'string') {
        refs.fileIds.push(...extractFileIds(value));
        refs.sandboxPaths.push(...extractSandboxPaths(value));
        if (/(?:file[_ -]?name|filename|download|attachment|sandbox|path|href|url|title|label)/i.test(keyHint)) refs.filenames.push(...extractFilenames(value));
        return;
      }
      if (typeof value !== 'object' || seenObjects.has(value)) return;
      seenObjects.add(value); visited += 1;
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 80)) walk(item, keyHint, depth + 1);
        return;
      }
      for (const [key, item] of Object.entries(value).slice(0, 120)) {
        if (item == null) continue;
        const relevant = /(?:file|asset|attachment|sandbox|download|href|url|path|metadata|result|content|props|children|name|title|label|id)/i.test(key);
        if (depth <= 1 || relevant) walk(item, key, depth + 1);
      }
    };
    roots.forEach((root) => walk(root));
    refs.fileIds = [...new Set(refs.fileIds)];
    refs.sandboxPaths = [...new Set(refs.sandboxPaths.map(normalizeSandboxPath).filter(Boolean))];
    refs.filenames = [...new Set(refs.filenames.filter((name) => !isServiceName(name)))];
    return refs;
  };

  // DOM candidates are message-bound. Plain filenames in prose are intentionally ignored.
  for (const info of messageInfo) {
    const { root, messageIndex, messageId } = info;
    if (selected && !selected.has(messageIndex)) continue;
    for (const image of root.querySelectorAll('img')) {
      const url = normalizeUrl(image.currentSrc || image.src || image.getAttribute('src'));
      const width = Number(image.naturalWidth || image.width || 0), height = Number(image.naturalHeight || image.height || 0);
      if (!url || (width && height && width <= 40 && height <= 40)) continue;
      addCandidate({ element:image, type:'image', messageIndex, messageId, filename:sanitizeFilename(image.getAttribute('alt') || filenameFromUrl(url), `image-${messageIndex + 1}.png`), label:cleanText(image.getAttribute('alt') || ''), sourceUrl:url, fileIds:extractFileIds(url), urls:[url], detectedBy:'message-bound-image' });
    }

    const selector = 'a[download],a[href],button,[role="link"],[role="button"],[data-testid],[data-href],[data-url],[data-download-url],[data-file-id],[data-attachment-id],[data-thread-export-filename]';
    for (const element of [...root.querySelectorAll(selector)].slice(0, 1200)) {
      const attributes = [...(element.attributes || [])].map((attr) => `${attr.name}=${attr.value}`);
      const joined = attributes.join('\n');
      let fileIds = extractFileIds(joined);
      const rawUrls = [...(element.attributes || [])].map((attr) => normalizeUrl(attr.value)).filter(Boolean);
      const urls = rawUrls.filter(isAssetUrl);
      let sandboxPaths = [...new Set([
        ...extractSandboxPaths(joined),
        ...extractSandboxPaths(element.getAttribute?.('href') || ''),
        ...extractSandboxPaths(element.getAttribute?.('data-href') || ''),
        ...extractSandboxPaths(element.getAttribute?.('data-url') || ''),
        ...extractSandboxPaths(element.getAttribute?.('data-download-url') || '')
      ].map(normalizeSandboxPath).filter(Boolean))];
      const descriptor = cleanText([
        element.getAttribute('data-testid'), element.getAttribute('aria-label'), element.getAttribute('title'),
        element.getAttribute('download'), element.getAttribute('data-thread-export-filename')
      ].join(' '));
      const visible = [element.getAttribute('download'), element.getAttribute('data-thread-export-filename'), element.getAttribute('aria-label'), element.getAttribute('title'), element.innerText].filter(Boolean).join(' ');
      const generatedControl = isGeneratedDownloadControl(element, descriptor, visible);

      // Generated ChatGPT files often keep sandbox:/mnt/data or file_id only inside the
      // React props attached to the *same interactive card*. Read those props, but never
      // click the control and never scan React state globally across other messages.
      if (generatedControl || sandboxPaths.length || fileIds.length) {
        const reactRefs = reactGeneratedRefs(element);
        fileIds = [...new Set([...fileIds, ...reactRefs.fileIds])];
        sandboxPaths = [...new Set([...sandboxPaths, ...reactRefs.sandboxPaths])];
        var reactNames = reactRefs.filenames;
      } else var reactNames = [];

      const strongMarker = Boolean(
        element.getAttribute('download') || element.getAttribute('data-file-id') || element.getAttribute('data-attachment-id') ||
        element.getAttribute('data-download-url') || element.getAttribute('data-thread-export-filename') || sandboxPaths.length ||
        /(?:attachment|download|file[-_ ]?(?:card|tile|upload|download)|вкладенн|завантаж.*файл|файл.*завантаж)/iu.test(descriptor) || generatedControl
      );
      if (!strongMarker && !fileIds.length && !urls.length && !sandboxPaths.length) continue;

      // A normal external hyperlink that merely starts with “Download …” is not an
      // attachment unless ChatGPT exposes file identity/sandbox data for this message.
      const rawHref = String(element.getAttribute?.('href') || '');
      const externalOrdinaryLink = /^https?:/i.test(rawHref) && !urls.length && !fileIds.length && !sandboxPaths.length;
      if (externalOrdinaryLink) continue;

      const sandboxName = sandboxPaths[0] ? sandboxPaths[0].split('/').pop() : '';
      const names = [...extractFilenames(visible), ...reactNames].filter((name) => !isServiceName(name));
      const filename = extractFilenames(sandboxName)[0] || names[0] || extractFilenames(filenameFromUrl(urls[0] || ''))[0] ||
        (fileIds[0] ? `attachment-${String(fileIds[0]).slice(-16)}.bin` : (generatedControl ? generatedFilenameFromLabel(visible, `generated-file-message-${messageIndex + 1}.bin`) : 'attachment.bin'));
      addCandidate({
        element, type:'attachment', messageIndex, messageId, filename, label:cleanText(visible) || filename,
        sourceUrl:urls[0] || '', urls, fileIds, sandboxPaths, sandboxMessageIds:messageId ? [messageId] : [],
        detectedBy:sandboxPaths.length ? 'message-bound-generated-sandbox' : (generatedControl ? 'message-bound-generated-card' : 'message-bound-dom')
      });
    }
  }

  // 2.18.0: bind file cards/images rendered beside a turn instead of inside it.
  const bindGlobalElement = (element) => {
    const eligible = messageInfo.filter((info) => !selected || selected.has(info.messageIndex));
    const direct = eligible.find((info) => info.root === element || info.root.contains?.(element));
    if (direct) return { info:direct, method:'containment' };
    let er = null; try { er = element.getBoundingClientRect?.(); } catch (_) {}
    if (er && Number.isFinite(er.top) && Number.isFinite(er.bottom)) {
      let best = null;
      for (const info of eligible) {
        let rr = null; try { rr = info.root.getBoundingClientRect?.(); } catch (_) {}
        if (!rr || !Number.isFinite(rr.top) || !Number.isFinite(rr.bottom)) continue;
        const gap = er.bottom < rr.top ? rr.top - er.bottom : (er.top > rr.bottom ? er.top - rr.bottom : 0);
        const center = Math.abs(((er.top + er.bottom) / 2) - ((rr.top + rr.bottom) / 2));
        const score = gap * 4 + center;
        if (!best || score < best.score) best = { info, score, gap };
      }
      if (best && best.gap <= 520) return { info:best.info, method:'geometry' };
    }
    let preceding = null;
    for (const info of eligible) { try { if (info.root.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) preceding = info; } catch (_) {} }
    return preceding ? { info:preceding, method:'document-order' } : null;
  };

  for (const image of [...main.querySelectorAll('img')].slice(0, 1800)) {
    if (messageInfo.some((info) => info.root.contains?.(image))) continue;
    const binding = bindGlobalElement(image); if (!binding) continue;
    const url = normalizeUrl(image.currentSrc || image.src || image.getAttribute('src'));
    const width = Number(image.naturalWidth || image.width || 0), height = Number(image.naturalHeight || image.height || 0);
    if (!url || (width && height && width <= 40 && height <= 40)) continue;
    addCandidate({ element:image, type:'image', messageIndex:binding.info.messageIndex, messageId:binding.info.messageId, filename:sanitizeFilename(image.getAttribute('alt') || filenameFromUrl(url), `image-${binding.info.messageIndex + 1}.png`), label:cleanText(image.getAttribute('alt') || ''), sourceUrl:url, fileIds:extractFileIds(url), urls:[url], detectedBy:`global-message-image-${binding.method}` });
  }

  const globalControlSelector = 'a[download],a[href],button,[role="link"],[role="button"],[data-testid],[data-href],[data-url],[data-download-url],[data-file-id],[data-attachment-id],[data-thread-export-filename]';
  for (const element of [...main.querySelectorAll(globalControlSelector)].slice(0, 2600)) {
    if (messageInfo.some((info) => info.root.contains?.(element))) continue;
    const binding = bindGlobalElement(element); if (!binding) continue;
    const chain = []; let cursor = element;
    for (let depth = 0; cursor && depth < 5; depth += 1) { chain.push(cursor); if (cursor === main) break; const parent = cursor.parentElement; if (!parent) break; const t = cleanText(parent.innerText || parent.textContent || ''); if (depth >= 2 && t.length > 900) break; cursor = parent; }
    const attributes = chain.flatMap((node) => [...(node?.attributes || [])].map((attr) => `${attr.name}=${attr.value}`));
    const joined = attributes.join('\n');
    const fileIds = extractFileIds(joined);
    const rawUrls = chain.flatMap((node) => [...(node?.attributes || [])].map((attr) => normalizeUrl(attr.value))).filter(Boolean);
    const urls = [...new Set(rawUrls.filter(isAssetUrl))];
    const sandboxPaths = [...new Set(attributes.flatMap(extractSandboxPaths).map(normalizeSandboxPath).filter(Boolean))];
    const visible = chain.map((node) => cleanText([node?.getAttribute?.('download'), node?.getAttribute?.('data-thread-export-filename'), node?.getAttribute?.('aria-label'), node?.getAttribute?.('title'), node?.innerText].filter(Boolean).join(' '))).find((text) => text && text.length <= 320) || '';
    const sandboxName = sandboxPaths[0] ? sandboxPaths[0].split('/').pop() : '';
    const visibleFilename = extractFilenames(sandboxName)[0] || extractFilenames(visible)[0] || extractFilenames(filenameFromUrl(urls[0] || ''))[0] || '';
    if (!fileIds.length && !urls.length && !sandboxPaths.length && !visibleFilename) continue;
    const filename = visibleFilename || (fileIds[0] ? `attachment-${String(fileIds[0]).slice(-16)}.bin` : `attachment-message-${binding.info.messageIndex + 1}.bin`);
    addCandidate({ element, type:'attachment', messageIndex:binding.info.messageIndex, messageId:binding.info.messageId, filename, label:visible || filename, sourceUrl:urls[0] || '', urls, fileIds, sandboxPaths, sandboxMessageIds:binding.info.messageId ? [binding.info.messageId] : [], detectedBy:`global-message-card-${binding.method}` });
  }

  const conversationId = location.pathname.match(/\/c\/([a-z0-9-]{8,})/i)?.[1] || '';
  const projectIdFromUrl = location.href.match(/\b(g-p-[a-z0-9_-]+)\b/i)?.[1] || '';

  const getSessionAuth = async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const response = await fetch('/api/auth/session', { credentials:'include', cache:'no-store', headers:{ accept:'application/json' }, signal:controller.signal }).finally(() => clearTimeout(timer));
      if (!response.ok) return null;
      const session = await response.json();
      const accessToken = String(session?.accessToken || '');
      if (!accessToken) return null;
      let accountId = String(session?.account?.id || session?.user?.account_id || session?.user?.accountId || '');
      if (!accountId) {
        try {
          const payload = accessToken.split('.')[1] || '';
          const decoded = JSON.parse(atob(payload.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(payload.length / 4) * 4, '=')));
          accountId = String(decoded?.['https://api.openai.com/auth']?.chatgpt_account_id || decoded?.chatgpt_account_id || '');
        } catch (_) {}
      }
      return { accessToken, accountId };
    } catch (_) { return null; }
  };
  const sessionAuth = await getSessionAuth();
  const headersFor = (url, accept = '*/*') => {
    const headers = { accept };
    try {
      const target = new URL(url, location.href);
      if (sessionAuth?.accessToken && target.origin === location.origin) {
        headers.authorization = `Bearer ${sessionAuth.accessToken}`;
        if (sessionAuth.accountId) headers['chatgpt-account-id'] = sessionAuth.accountId;
        if (projectIdFromUrl && target.pathname.startsWith('/backend-api/')) headers['chatgpt-project-id'] = projectIdFromUrl;
      }
    } catch (_) {}
    return headers;
  };
  const authenticatedFetch = async (url, options = {}) => {
    const timeoutMs = Math.max(250, Number(options.timeoutMs || REQUEST_TIMEOUT_MS));
    const controller = new AbortController();
    activeControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (cancelled) throw new Error('Export cancelled.');
      const fetchOptions = { ...options }; delete fetchOptions.timeoutMs;
      return await fetch(url, {
        credentials:'include', redirect:'follow', cache:'no-store', ...fetchOptions, signal:controller.signal,
        headers:{ ...headersFor(url, fetchOptions?.headers?.accept || '*/*'), ...(fetchOptions.headers || {}) }
      });
    } catch (error) {
      if (controller.signal.aborted && !cancelled) throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s.`);
      throw error;
    } finally {
      clearTimeout(timer); activeControllers.delete(controller);
    }
  };

  const extractIdFromPointer = (value) => String(value || '').match(/(?:sediment:\/\/|file-service:\/\/)?(file[-_][a-z0-9_-]{12,})/i)?.[1] || '';
  const directObjectUrls = (obj) => {
    const urls = [];
    if (!obj || typeof obj !== 'object') return urls;
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value !== 'string' || !/(?:url|href|download|content)/i.test(key)) continue;
      const url = normalizeUrl(value);
      if (url && isAssetUrl(url)) urls.push(url);
    }
    return [...new Set(urls)];
  };
  const structuredRefsFromMessage = (message) => {
    const refs = [];
    const seen = new Set();
    const addRef = (obj, inheritedName = '') => {
      if (!obj || typeof obj !== 'object') return;
      const directValues = [obj.file_id, obj.fileId, obj.asset_pointer, obj.assetPointer, obj.attachment_id, obj.attachmentId, obj.id];
      const fileId = directValues.map(extractIdFromPointer).find(Boolean) || '';
      const sandboxPaths = [...new Set([
        ...extractSandboxPaths(obj.sandbox_path),
        ...extractSandboxPaths(obj.sandboxPath),
        ...extractSandboxPaths(obj.path),
        ...extractSandboxPaths(obj.url),
        ...extractSandboxPaths(obj.href)
      ])];
      const urls = directObjectUrls(obj);
      if (!fileId && !sandboxPaths.length && !urls.length) return;
      const sandboxName = sandboxPaths[0] ? sandboxPaths[0].split('/').pop() : '';
      const nameSource = obj.file_name || obj.filename || obj.name || obj.title || obj.label || obj.metadata?.file_name || obj.metadata?.filename || inheritedName || sandboxName || '';
      const filename = extractFilenames(nameSource)[0] || (sandboxName ? sanitizeFilename(sandboxName, '') : '');
      const libraryFileId = cleanText(obj.library_file_id || obj.libraryFileId || obj.metadata?.library_file_id || '');
      const gizmoId = cleanText(obj.gizmo_id || obj.gizmoId || obj.metadata?.gizmo_id || '');
      const mimeType = cleanText(obj.mime_type || obj.mimeType || obj.content_type || '');
      const key = `${fileId}|${sandboxPaths.join('|')}|${urls.join('|')}|${normalizeName(filename)}`;
      if (seen.has(key)) return;
      seen.add(key);
      refs.push({ fileId, filename, libraryFileId, gizmoId, mimeType, urls, sandboxPaths, sourceMessageId:cleanText(message?.id || ''), detectedBy:sandboxPaths.length ? 'conversation-sandbox-object' : 'conversation-message-object' });
    };
    const visit = (value, inheritedName = '', depth = 0, visited = new WeakSet(), keyHint = '') => {
      if (depth > 8 || value == null) return;
      if (typeof value === 'string') {
        for (const sandboxPath of extractSandboxPaths(value)) addRef({ sandbox_path:sandboxPath }, inheritedName);
        for (const token of String(value).match(/\{\{file:(file[-_][a-z0-9_-]{12,})\}\}/ig) || []) {
          const fileId = token.match(/file[-_][a-z0-9_-]{12,}/i)?.[0] || '';
          if (fileId) addRef({ file_id:fileId }, inheritedName);
        }
        const pointerId = extractIdFromPointer(value);
        if (pointerId && (/^(?:file-service|sediment):\/\//i.test(value) || /(?:file|asset|attachment|pointer|id)/i.test(keyHint))) {
          addRef({ file_id:pointerId }, inheritedName);
        }
        const directUrl = normalizeUrl(value);
        if (directUrl && isAssetUrl(directUrl) && /(?:url|href|download|content|asset|attachment)/i.test(keyHint)) {
          addRef({ url:directUrl }, inheritedName);
        }
        return;
      }
      if (typeof value !== 'object' || visited.has(value)) return;
      visited.add(value);
      if (Array.isArray(value)) { value.slice(0, 240).forEach((item) => visit(item, inheritedName, depth + 1, visited, keyHint)); return; }
      const name = extractFilenames(value.file_name || value.filename || value.name || value.title || inheritedName || '')[0] || inheritedName;
      addRef(value, name);
      for (const [key, item] of Object.entries(value).slice(0, 220)) {
        if (item == null) continue;
        // Only structured message payloads are traversed. Plain filename prose is never scanned;
        // explicit sandbox:/mnt/data links are accepted because they are real generated-file pointers.
        if (depth === 0 && !/(?:metadata|attachments?|files?|parts|content|results?|assets?|references?)/i.test(key)) continue;
        visit(item, name, depth + 1, visited, key);
      }
    };
    visit(message?.metadata || {}, '', 0);
    visit(message?.content || {}, '', 0);
    if (Array.isArray(message?.attachments)) visit(message.attachments, '', 0);
    return refs;
  };
  const orderedBranchMessages = (conversation) => {
    const mapping = conversation?.mapping && typeof conversation.mapping === 'object' ? conversation.mapping : null;
    if (!mapping) return [];
    const chain = [];
    let nodeId = conversation?.current_node;
    const guard = new Set();
    while (nodeId && mapping[nodeId] && !guard.has(nodeId)) {
      guard.add(nodeId);
      const node = mapping[nodeId];
      if (node?.message) chain.unshift(node.message);
      nodeId = node?.parent || '';
    }
    if (chain.length) return chain;
    return Object.values(mapping).map((node) => node?.message).filter(Boolean).sort((a,b) => Number(a?.create_time || 0) - Number(b?.create_time || 0));
  };

  let conversation = null;
  if (conversationId) {
    try {
      const response = await authenticatedFetch(`${location.origin}/backend-api/conversation/${encodeURIComponent(conversationId)}`, { headers:{ accept:'application/json' }, timeoutMs:REQUEST_TIMEOUT_MS });
      if (response.ok) conversation = await response.json();
    } catch (_) {}
  }

  if (conversation) {
    const branch = orderedBranchMessages(conversation);
    const visibleApi = branch.filter((message) => ['user','assistant'].includes(String(message?.author?.role || '')) && !message?.metadata?.is_visually_hidden_from_conversation);
    const apiById = new Map(branch.filter((message) => message?.id).map((message) => [String(message.id), message]));
    const mappedApiByDomIndex = new Map();
    const usedApiIds = new Set();

    for (const info of messageInfo) {
      if (selected && !selected.has(info.messageIndex)) continue;
      let message = info.messageId ? apiById.get(info.messageId) : null;
      if (!message) {
        const direct = visibleApi[info.messageIndex];
        if (direct && (!info.role || String(direct?.author?.role || '') === info.role) && !usedApiIds.has(String(direct.id || ''))) message = direct;
      }
      if (!message) {
        message = visibleApi.find((item) => !usedApiIds.has(String(item?.id || '')) && (!info.role || String(item?.author?.role || '') === info.role)) || null;
      }
      if (message) {
        mappedApiByDomIndex.set(info.messageIndex, message);
        if (message.id) usedApiIds.add(String(message.id));
      }
    }

    const bindRefs = (messageIndex, messageId, refs) => {
      if (!refs.length || (selected && !selected.has(messageIndex))) return;
      const existing = candidates.filter((candidate) => candidate.type === 'attachment' && candidate.messageIndex === messageIndex);
      const unbound = existing.filter((candidate) => !(candidate.fileIds || []).length);
      const unnamedRefs = [];
      for (const ref of refs) {
        const refName = normalizeName(ref.filename || '');
        let target = refName ? existing.find((candidate) => normalizeName(candidate.filename) === refName) : null;
        if (!target && refName && unbound.length === 1 && refs.length === 1) target = unbound[0];
        if (target) {
          if (ref.fileId) target.fileIds = [...new Set([...(target.fileIds || []), ref.fileId])];
          target.urls = [...new Set([...(target.urls || []), ...(ref.urls || [])])];
          target.sandboxPaths = [...new Set([...(target.sandboxPaths || []), ...(ref.sandboxPaths || [])].map(normalizeSandboxPath).filter(Boolean))];
          if (ref.sourceMessageId) target.sandboxMessageIds = [...new Set([...(target.sandboxMessageIds || []), ref.sourceMessageId])];
          target.libraryFileId = ref.libraryFileId || target.libraryFileId || '';
          target.gizmoId = ref.gizmoId || target.gizmoId || '';
          if (/^attachment-[a-z0-9_-]+\.bin$/i.test(target.filename) && ref.filename) target.filename = sanitizeFilename(ref.filename);
        } else if (!refName) unnamedRefs.push(ref);
        else addCandidate({ type:'attachment', messageIndex, messageId, filename:ref.filename, label:ref.filename, sourceUrl:(ref.urls || [])[0] || '', urls:ref.urls || [], fileIds:ref.fileId ? [ref.fileId] : [], sandboxPaths:ref.sandboxPaths || [], sandboxMessageIds:ref.sourceMessageId ? [ref.sourceMessageId] : [], libraryFileId:ref.libraryFileId, gizmoId:ref.gizmoId, detectedBy:ref.detectedBy });
      }
      const remainingUnbound = unbound.filter((candidate) => !(candidate.fileIds || []).length);
      if (unnamedRefs.length && remainingUnbound.length === unnamedRefs.length) {
        unnamedRefs.forEach((ref, index) => {
          const target = remainingUnbound[index];
          if (ref.fileId) target.fileIds = [ref.fileId];
          target.urls = [...new Set([...(target.urls || []), ...(ref.urls || [])])];
          target.sandboxPaths = [...new Set([...(target.sandboxPaths || []), ...(ref.sandboxPaths || [])].map(normalizeSandboxPath).filter(Boolean))];
          if (ref.sourceMessageId) target.sandboxMessageIds = [...new Set([...(target.sandboxMessageIds || []), ref.sourceMessageId])];
          target.libraryFileId = ref.libraryFileId || '';
          target.gizmoId = ref.gizmoId || '';
        });
      } else {
        for (const ref of unnamedRefs) addCandidate({ type:'attachment', messageIndex, messageId, filename:ref.filename || (ref.fileId ? `attachment-${String(ref.fileId).slice(-16)}.bin` : 'attachment.bin'), label:'', sourceUrl:(ref.urls || [])[0] || '', urls:ref.urls || [], fileIds:ref.fileId ? [ref.fileId] : [], sandboxPaths:ref.sandboxPaths || [], sandboxMessageIds:ref.sourceMessageId ? [ref.sourceMessageId] : [], libraryFileId:ref.libraryFileId, gizmoId:ref.gizmoId, detectedBy:ref.detectedBy });
      }
    };

    for (const [messageIndex, message] of mappedApiByDomIndex) bindRefs(messageIndex, String(message?.id || ''), structuredRefsFromMessage(message));

    // Tool messages can carry generated-file pointers. Bind them only to the nearest following
    // visible assistant message in the current branch, never globally to the conversation.
    for (let i = 0; i < branch.length; i += 1) {
      const message = branch[i];
      if (['user','assistant'].includes(String(message?.author?.role || ''))) continue;
      const refs = structuredRefsFromMessage(message);
      if (!refs.length) continue;
      const nextAssistant = branch.slice(i + 1).find((item) => String(item?.author?.role || '') === 'assistant');
      if (!nextAssistant) continue;
      const targetEntry = [...mappedApiByDomIndex.entries()].find(([, apiMessage]) => String(apiMessage?.id || '') === String(nextAssistant?.id || ''));
      if (targetEntry) bindRefs(targetEntry[0], String(nextAssistant.id || ''), refs);
    }
  }

  // MAIN-world hints normally enrich an already message-bound candidate. 2.14.0 also
  // permits a MAIN-world generated-file card hint to create the candidate when the
  // isolated world cannot see React expando props. The hint is accepted only when it
  // is bound to a concrete selected message AND exposes real file identity/path/asset URL.
  for (const hint of rawBoundHints) {
    const hintFileId = String(hint?.fileId || '').match(/file[-_][a-z0-9_-]{12,}/i)?.[0] || '';
    const hintUrl = normalizeUrl(hint?.url || '');
    const hintSandboxPaths = [...new Set((hint?.sandboxPaths || []).map(normalizeSandboxPath).filter(Boolean))];
    const hintIndex = resolveHintMessageIndex(hint);
    const hintName = normalizeName(hint?.filename || '');
    const hasHintIdentity = Boolean(hintFileId || hintUrl || hintSandboxPaths.length);
    if (!hasHintIdentity && !(hintIndex >= 0 && (hint?.fileCard === true || hint?.generatedCard === true) && hintName)) continue;
    const hintLabel = cleanText(hint?.label || '');
    let targets = candidates.filter((candidate) => {
      if (candidate.type !== 'attachment' && candidate.type !== 'image') return false;
      if (hintIndex >= 0 && candidate.messageIndex !== hintIndex) return false;
      if (hintFileId && (candidate.fileIds || []).includes(hintFileId)) return true;
      return hintIndex >= 0 && hintName && normalizeName(candidate.filename) === hintName;
    });

    if (!targets.length && (hint?.generatedCard === true || hint?.fileCard === true) && hintIndex >= 0 && (!selected || selected.has(hintIndex))) {
      const info = messageInfo.find((item) => item.messageIndex === hintIndex);
      const sandboxName = hintSandboxPaths[0] ? hintSandboxPaths[0].split('/').pop() : '';
      const fallbackName = generatedFilenameFromLabel(hintLabel, `generated-file-message-${hintIndex + 1}.bin`);
      const filename = sanitizeFilename(hint?.filename || sandboxName || fallbackName, fallbackName);
      const created = addCandidate({
        type:'attachment',
        messageIndex:hintIndex,
        messageId:cleanText(hint?.messageId || info?.messageId || ''),
        filename,
        label:hintLabel || filename,
        sourceUrl:hintUrl,
        urls:hintUrl ? [hintUrl] : [],
        fileIds:hintFileId ? [hintFileId] : [],
        sandboxPaths:hintSandboxPaths,
        sandboxMessageIds:cleanText(hint?.messageId || info?.messageId || '') ? [cleanText(hint?.messageId || info?.messageId || '')] : [],
        detectedBy:hint?.generatedCard === true ? 'message-bound-generated-card-main' : 'message-bound-file-card-main'
      });
      if (created) targets = [created];
    }

    for (const target of targets) {
      if (hintFileId) target.fileIds = [...new Set([...(target.fileIds || []), hintFileId])];
      if (hintUrl) target.urls = [...new Set([...(target.urls || []), hintUrl])];
      if (hintSandboxPaths.length) {
        target.sandboxPaths = [...new Set([...(target.sandboxPaths || []), ...hintSandboxPaths].map(normalizeSandboxPath).filter(Boolean))];
        if (target.messageId) target.sandboxMessageIds = [...new Set([...(target.sandboxMessageIds || []), target.messageId])];
      }
      if ((!target.label || /^attachment-/i.test(String(target.label))) && hintLabel) target.label = hintLabel;
    }
  }

  const metadataById = new Map();
  const idsToResolve = [...new Set(candidates.flatMap((candidate) => candidate.fileIds || []))].slice(0, Math.min(MAX_ASSETS, 80));
  if (idsToResolve.length) {
    reportProgress({ stage:'metadata', percent:10, current:0, total:idsToResolve.length, included:0, skipped:0 });
    const metadataResults = await runPool(idsToResolve, async (fileId) => {
      const encoded = encodeURIComponent(fileId);
      const metadataUrls = [];
      if (conversationId) metadataUrls.push(`${location.origin}/backend-api/files/${encoded}/simple?conversation_id=${encodeURIComponent(conversationId)}`);
      metadataUrls.push(`${location.origin}/backend-api/files/${encoded}/simple`);
      for (const url of metadataUrls) {
        if (cancelled) break;
        try {
          const response = await authenticatedFetch(url, { headers:{ accept:'application/json' }, timeoutMs:METADATA_TIMEOUT_MS });
          if (!response.ok || !String(response.headers.get('content-type') || '').toLowerCase().includes('application/json')) continue;
          const meta = await response.json();
          const filename = sanitizeFilename(meta?.file_name || meta?.filename || meta?.name || '', '');
          const resolvedId = String(meta?.file_id || meta?.id || fileId || '').match(/file[-_][a-z0-9_-]{12,}/i)?.[0] || fileId;
          return {
            requestedFileId:fileId,
            fileId:resolvedId,
            filename,
            mimeType:String(meta?.mime_type || ''),
            libraryFileId:String(meta?.library_file_id || ''),
            gizmoId:String(meta?.gizmo_id || ''),
            isProject:Boolean(meta?.is_project),
            isLibraryFile:Boolean(meta?.is_library_file)
          };
        } catch (_) {}
      }
      return { fileId };
    }, MAX_CONCURRENCY, (done, total) => reportProgress({ stage:'metadata', percent:10 + Math.round((done / Math.max(1,total)) * 12), current:done, total, included:0, skipped:0 }));
    for (const meta of metadataResults) {
      if (!meta?.fileId) continue;
      metadataById.set(meta.fileId, meta);
      if (meta.requestedFileId) metadataById.set(meta.requestedFileId, meta);
    }
  }

  for (const candidate of candidates) {
    if (candidate.type !== 'attachment') continue;
    for (const fileId of candidate.fileIds || []) {
      const meta = metadataById.get(fileId);
      if (!meta) continue;
      if (meta.filename && /^attachment-[a-z0-9_-]+\.bin$/i.test(candidate.filename)) candidate.filename = meta.filename;
      candidate.libraryFileId = meta.libraryFileId || candidate.libraryFileId || '';
      candidate.gizmoId = meta.gizmoId || candidate.gizmoId || '';
      candidate.isProject = Boolean(meta.isProject || candidate.isProject);
      candidate.isLibraryFile = Boolean(meta.isLibraryFile || candidate.isLibraryFile);
      if (isServiceAttachmentName(candidate.label) || /^attachment-[a-z0-9_-]+\.bin$/i.test(String(candidate.label || ''))) candidate.label = candidate.filename;
    }
  }

  const blobLooksValid = async (blob, filename) => {
    if (!blob?.size) return false;
    const ext = String(filename || '').split('.').pop().toLowerCase();
    const mime = String(blob.type || '').toLowerCase();
    if (mime.includes('text/html') && !['html','htm'].includes(ext)) return false;
    if (mime.includes('application/json') && !['json','jsonl','har','ipynb'].includes(ext)) return false;
    const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    if (ext === 'pdf') return mime.includes('pdf') || String.fromCharCode(...bytes.slice(0,5)).startsWith('%PDF-');
    if (['zip','docx','xlsx','pptx'].includes(ext)) return mime.includes('zip') || (bytes[0] === 0x50 && bytes[1] === 0x4b);
    if (ext === 'exe') return bytes[0] === 0x4d && bytes[1] === 0x5a;
    if (ext === 'png') return mime === 'image/png' || (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47);
    if (['jpg','jpeg'].includes(ext)) return mime === 'image/jpeg' || (bytes[0] === 0xff && bytes[1] === 0xd8);
    return true;
  };

  const fetchBinary = async (url, filename, deadline) => {
    const normalized = normalizeUrl(url);
    if (!normalized) return { blob:null, error:'Invalid download URL.' };
    const remaining = Math.max(300, deadline - Date.now());
    try {
      const response = await authenticatedFetch(normalized, { timeoutMs:Math.min(REQUEST_TIMEOUT_MS, remaining) });
      if (!response.ok) return { blob:null, error:`HTTP ${response.status}` };
      const ext = String(filename || '').split('.').pop().toLowerCase();
      const maxBytes = /^(?:mp4|mov|webm|avi|mkv|m4v)$/i.test(ext) ? MAX_VIDEO_ASSET_BYTES : MAX_ASSET_BYTES;
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > maxBytes) return { blob:null, error:`File exceeds ${Math.round(maxBytes / 1024 / 1024)} MB per-file archive limit.` };
      const blob = await response.blob();
      if (blob.size > maxBytes) return { blob:null, error:`File exceeds ${Math.round(maxBytes / 1024 / 1024)} MB per-file archive limit.` };
      if (totalBytes + blob.size > MAX_TOTAL_BYTES) return { blob:null, error:`Archive asset budget of ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MB was reached.` };
      if (!(await blobLooksValid(blob, filename))) return { blob:null, error:'ChatGPT returned metadata/page instead of file bytes.' };
      return { blob, url:response.url || normalized };
    } catch (error) { return { blob:null, error:String(error?.message || error) }; }
  };

  const extractDescriptorUrl = (data) => {
    const seen = new WeakSet();
    const walk = (value, depth = 0) => {
      if (depth > 7 || value == null) return '';
      if (typeof value === 'string') {
        const url = normalizeUrl(value);
        return url && isAssetUrl(url) ? url : '';
      }
      if (typeof value !== 'object' || seen.has(value)) return '';
      seen.add(value);
      const preferred = ['download_url','downloadUrl','content_url','contentUrl','signed_url','signedUrl','url','href'];
      for (const key of preferred) {
        if (!(key in value)) continue;
        const found = walk(value[key], depth + 1);
        if (found) return found;
      }
      for (const item of Object.values(value).slice(0, 120)) {
        const found = walk(item, depth + 1);
        if (found) return found;
      }
      return '';
    };
    return walk(data);
  };
  const extractDescriptorFilename = (data, fallback = '') => {
    if (!data || typeof data !== 'object') return fallback;
    const values = [data.file_name, data.filename, data.name, data.title, data?.data?.file_name, data?.data?.filename];
    return values.map((value) => extractFilenames(value)[0] || '').find(Boolean) || fallback;
  };
  const resolveSandboxDescriptor = async (candidate, deadline) => {
    const errors = [];
    const messageIds = [...new Set([...(candidate.sandboxMessageIds || []), candidate.messageId || ''].map(cleanText).filter(Boolean))];
    if (!conversationId || !messageIds.length) return { url:'', filename:candidate.filename, errors:['Sandbox resolver missing conversation/message identity.'] };
    for (const sandboxPath of [...new Set(candidate.sandboxPaths || [])]) {
      const safePath = normalizeSandboxPath(sandboxPath);
      if (!safePath || cancelled || Date.now() >= deadline) continue;
      for (const messageId of messageIds) {
        if (cancelled || Date.now() >= deadline) break;
        const params = new URLSearchParams({ message_id:String(messageId), sandbox_path:safePath });
        const url = `${location.origin}/backend-api/conversation/${encodeURIComponent(conversationId)}/interpreter/download?${params.toString()}`;
        try {
        const remaining = Math.max(300, deadline - Date.now());
        const response = await authenticatedFetch(url, { headers:{ accept:'application/json' }, timeoutMs:Math.min(REQUEST_TIMEOUT_MS, remaining) });
        if (!response.ok) { errors.push(`Sandbox HTTP ${response.status}`); continue; }
        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        if (!contentType.includes('application/json')) {
          const blob = await response.blob();
          const name = sanitizeFilename(safePath.split('/').pop() || candidate.filename, candidate.filename || 'attachment.bin');
          if (await blobLooksValid(blob, name)) return { blob, url:response.url || url, filename:name, errors };
          errors.push('Sandbox endpoint returned non-file bytes.');
          continue;
        }
        const data = await response.json();
        const signedUrl = extractDescriptorUrl(data);
        const returnedName = extractDescriptorFilename(data, sanitizeFilename(safePath.split('/').pop() || candidate.filename, candidate.filename || 'attachment.bin'));
        if (!signedUrl) { errors.push('Sandbox descriptor had no signed URL.'); continue; }
        return { url:signedUrl, filename:returnedName || candidate.filename, errors };
        } catch (error) { errors.push(String(error?.message || error)); }
      }
    }
    return { url:'', filename:candidate.filename, errors };
  };

  const resolveDescriptor = async (fileId, candidate, deadline) => {
    const encoded = encodeURIComponent(fileId);
    const errors = [];
    const routeUrls = [];
    const addRoute = (url, label) => {
      if (!url || routeUrls.some((item) => item.url === url)) return;
      routeUrls.push({ url, label });
    };

    // 2.13.0: file_ vs file- does NOT tell us whether a file belongs to a Project.
    // /simple metadata does. Project/library files must be allowed to resolve through
    // gizmo_id even when the identifier uses the ordinary file_ prefix.
    const gizmoId = cleanText(candidate.gizmoId || (candidate.isProject ? projectIdFromUrl : '') || projectIdFromUrl || '');
    if (gizmoId) addRoute(`${location.origin}/backend-api/files/download/${encoded}?gizmo_id=${encodeURIComponent(gizmoId)}&inline=false`, 'project');
    if (conversationId) addRoute(`${location.origin}/backend-api/files/download/${encoded}?conversation_id=${encodeURIComponent(conversationId)}&inline=false`, 'conversation');
    addRoute(`${location.origin}/backend-api/files/download/${encoded}?inline=false`, 'generic');

    for (const route of routeUrls) {
      if (cancelled || Date.now() >= deadline) break;
      try {
        const remaining = Math.max(300, deadline - Date.now());
        const response = await authenticatedFetch(route.url, { headers:{ accept:'application/json' }, timeoutMs:Math.min(REQUEST_TIMEOUT_MS, remaining) });
        if (!response.ok) { errors.push(`${route.label} HTTP ${response.status}`); continue; }
        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        if (!contentType.includes('application/json')) {
          const blob = await response.blob();
          if (await blobLooksValid(blob, candidate.filename)) return { blob, url:response.url || route.url, filename:candidate.filename, errors, route:route.label };
          errors.push(`${route.label} returned non-file bytes`);
          continue;
        }
        const data = await response.json();
        const signedUrl = extractDescriptorUrl(data);
        const returnedName = extractDescriptorFilename(data, '');
        if (!signedUrl) {
          const status = cleanText(data?.status || data?.detail || data?.message || data?.error || '').slice(0, 120);
          errors.push(`${route.label} descriptor${status ? `: ${status}` : ' had no signed URL'}`);
          continue;
        }
        return { url:signedUrl, filename:returnedName || candidate.filename, errors, route:route.label };
      } catch (error) { errors.push(`${route.label}: ${String(error?.message || error)}`); }
    }

    // Final non-interactive fallback. Current ChatGPT Estuary accepts authenticated
    // file streams for some attachments even when /files/download refuses to mint a
    // descriptor. This does not click the UI and therefore cannot produce ChatGPT toasts.
    if (!cancelled && Date.now() < deadline) {
      const bareEstuary = `${location.origin}/backend-api/estuary/content?id=${encoded}`;
      const direct = await fetchBinary(bareEstuary, candidate.filename, deadline);
      if (direct.blob) return { blob:direct.blob, url:direct.url || bareEstuary, filename:candidate.filename, errors, route:'authenticated-estuary' };
      if (direct.error) errors.push(`estuary: ${direct.error}`);
    }

    return { url:'', filename:candidate.filename, errors };
  };

  pipelineDiagnostics.candidatesBeforeDownload = candidates.length;
  const rawDownloadCandidates = candidates.slice(0, MAX_ASSETS);
  const deduped = new Map();
  for (const candidate of rawDownloadCandidates) {
    const primaryId = candidate.fileIds?.[0] || '';
    const stable = candidate.type === 'image'
      ? `image:${normalizeUrl(candidate.sourceUrl) || candidate.messageIndex + ':' + normalizeName(candidate.filename)}`
      : primaryId ? `attachment:id:${primaryId}` : `attachment:${candidate.messageIndex}:${normalizeName(candidate.filename)}`;
    const current = deduped.get(stable);
    if (!current) deduped.set(stable, { ...candidate, fileIds:[...new Set(candidate.fileIds || [])], urls:[...new Set(candidate.urls || [])], sandboxPaths:[...new Set((candidate.sandboxPaths || []).map(normalizeSandboxPath).filter(Boolean))], sandboxMessageIds:[...new Set((candidate.sandboxMessageIds || []).map(cleanText).filter(Boolean))] });
    else {
      current.fileIds = [...new Set([...(current.fileIds || []), ...(candidate.fileIds || [])])];
      current.urls = [...new Set([...(current.urls || []), ...(candidate.urls || [])])];
      current.sandboxPaths = [...new Set([...(current.sandboxPaths || []), ...(candidate.sandboxPaths || [])].map(normalizeSandboxPath).filter(Boolean))];
      current.sandboxMessageIds = [...new Set([...(current.sandboxMessageIds || []), ...(candidate.sandboxMessageIds || [])].map(cleanText).filter(Boolean))];
      if (/^attachment-[a-z0-9_-]+\.bin$/i.test(current.filename) && !/^attachment-[a-z0-9_-]+\.bin$/i.test(candidate.filename)) current.filename = candidate.filename;
    }
  }
  const downloadCandidates = [...deduped.values()];
  pipelineDiagnostics.downloadCandidates = downloadCandidates.length;
  const assets = [];
  let includedCount = 0, skippedCount = 0;
  const completedIndices = new Set();
  reportProgress({ stage:'files', percent:25, current:0, total:downloadCandidates.length, included:0, skipped:0 });

  const processCandidate = async (candidate) => {
    if (cancelled) return { cancelled:true, candidate };
    let filename = sanitizeFilename(candidate.filename || candidate.label, candidate.type === 'image' ? 'image.png' : 'attachment.bin');
    const isVideoCandidate = /^(?:mp4|mov|webm|avi|mkv|m4v)$/i.test(String(filename || '').split('.').pop().toLowerCase());
    const deadline = Date.now() + (isVideoCandidate ? VIDEO_FILE_BUDGET_MS : FILE_BUDGET_MS);

    if (candidate.type === 'image') {
      const direct = await fetchBinary(candidate.sourceUrl, filename, deadline);
      let blob = direct.blob;
      if (!blob && candidate.element) blob = await canvasFallback(candidate.element);
      if (!blob) return { asset:{ messageIndex:candidate.messageIndex,type:'image',label:candidate.label,filename,sourceUrl:candidate.sourceUrl,included:false,reason:direct.error || 'Image bytes unavailable.',detectedBy:'message-bound-image' } };
      if (totalBytes + blob.size > MAX_TOTAL_BYTES) return { asset:{ messageIndex:candidate.messageIndex,type:'image',label:candidate.label,filename,sourceUrl:candidate.sourceUrl,included:false,reason:'Archive asset budget reached.',detectedBy:'message-bound-image' } };
      if (!/\.[a-z0-9]{1,8}$/i.test(filename)) filename += `.${extensionForMime(blob.type)}`;
      totalBytes += blob.size;
      return { asset:{ messageIndex:candidate.messageIndex,type:'image',label:candidate.label,filename,sourceUrl:direct.url || candidate.sourceUrl,mimeType:blob.type,size:blob.size,dataUrl:await blobToDataUrl(blob),included:true,detectedBy:'message-bound-image' } };
    }

    const errors = [];
    // First reuse exact signed/file URLs already attached to this message/file_id.
    for (const url of [...new Set(candidate.urls || [])]) {
      if (Date.now() >= deadline || cancelled) break;
      if (!isAssetUrl(url)) continue;
      const direct = await fetchBinary(url, filename, deadline);
      if (direct.blob) {
        totalBytes += direct.blob.size;
        return { asset:{ messageIndex:candidate.messageIndex,type:'attachment',label:candidate.label || filename,filename,sourceUrl:direct.url || url,mimeType:direct.blob.type || 'application/octet-stream',size:direct.blob.size,dataUrl:await blobToDataUrl(direct.blob),included:true,detectedBy:'message-bound-url' } };
      }
      if (direct.error) errors.push(direct.error);
    }

    if ((candidate.sandboxPaths || []).length && candidate.messageId) {
      const sandbox = await resolveSandboxDescriptor(candidate, deadline);
      errors.push(...(sandbox.errors || []));
      if (sandbox.blob) {
        const blob = sandbox.blob;
        totalBytes += blob.size;
        return { asset:{ messageIndex:candidate.messageIndex,type:'attachment',label:candidate.label || filename,filename:sandbox.filename || filename,sourceUrl:sandbox.url || '',mimeType:blob.type || 'application/octet-stream',size:blob.size,dataUrl:await blobToDataUrl(blob),included:true,detectedBy:'message-bound-sandbox' } };
      }
      if (sandbox.url) {
        if (sandbox.filename) filename = sanitizeFilename(sandbox.filename, filename);
        const direct = await fetchBinary(sandbox.url, filename, deadline);
        if (direct.blob) {
          totalBytes += direct.blob.size;
          return { asset:{ messageIndex:candidate.messageIndex,type:'attachment',label:candidate.label || filename,filename,mimeType:direct.blob.type || 'application/octet-stream',size:direct.blob.size,sourceUrl:direct.url || sandbox.url,dataUrl:await blobToDataUrl(direct.blob),included:true,detectedBy:'message-bound-sandbox' } };
        }
        if (direct.error) errors.push(direct.error);
      }
    }

    for (const fileId of [...new Set(candidate.fileIds || [])]) {
      if (Date.now() >= deadline || cancelled) break;
      const descriptor = await resolveDescriptor(fileId, candidate, deadline);
      errors.push(...(descriptor.errors || []));
      if (descriptor.blob) {
        const blob = descriptor.blob;
        totalBytes += blob.size;
        return { asset:{ messageIndex:candidate.messageIndex,type:'attachment',label:candidate.label || filename,filename:descriptor.filename || filename,sourceUrl:descriptor.url || '',mimeType:blob.type || 'application/octet-stream',size:blob.size,dataUrl:await blobToDataUrl(blob),included:true,detectedBy:'message-bound-file-id' } };
      }
      if (!descriptor.url) continue;
      if (descriptor.filename && /^attachment-[a-z0-9_-]+\.bin$/i.test(filename)) filename = sanitizeFilename(descriptor.filename);
      const direct = await fetchBinary(descriptor.url, filename, deadline);
      if (direct.blob) {
        totalBytes += direct.blob.size;
        return { asset:{ messageIndex:candidate.messageIndex,type:'attachment',label:candidate.label || filename,filename,mimeType:direct.blob.type || 'application/octet-stream',size:direct.blob.size,sourceUrl:direct.url || descriptor.url,dataUrl:await blobToDataUrl(direct.blob),included:true,detectedBy:'message-bound-file-id' } };
      }
      if (direct.error) errors.push(direct.error);
    }

    if (Date.now() >= deadline) errors.push(`File time budget ${Math.round((isVideoCandidate ? VIDEO_FILE_BUDGET_MS : FILE_BUDGET_MS) / 1000)}s exceeded.`);
    const hasIdentity = (candidate.fileIds || []).length || (candidate.sandboxPaths || []).length;
    return { asset:{ messageIndex:candidate.messageIndex,type:'attachment',label:candidate.label || filename,filename,sourceUrl:'',included:false,reason:hasIdentity ? `Message-bound file could not be downloaded: ${[...new Set(errors)].slice(0,6).join('; ') || 'download route unavailable'}` : 'A real file card was found in this message, but no file_id or sandbox path was exposed.',detectedBy:'message-bound-resolver' } };
  };

  await runPool(downloadCandidates, processCandidate, MAX_CONCURRENCY, (done, total, index, result) => {
    completedIndices.add(index);
    if (result?.error && !result?.asset) {
      const candidate = downloadCandidates[index] || {};
      const filename = sanitizeFilename(candidate.filename || candidate.label, candidate.type === 'image' ? 'image.png' : 'attachment.bin');
      result.asset = { messageIndex:Number.isInteger(candidate.messageIndex) ? candidate.messageIndex : -1, type:candidate.type || 'attachment', label:candidate.label || filename, filename, sourceUrl:candidate.sourceUrl || '', included:false, reason:`Candidate worker error: ${String(result.error).slice(0, 500)}`, detectedBy:'candidate-worker-error' };
      pipelineDiagnostics.candidateErrors += 1;
      if (pipelineDiagnostics.candidateErrorSamples.length < 5) pipelineDiagnostics.candidateErrorSamples.push(String(result.error).slice(0, 500));
    }
    if (result?.asset) {
      assets.push(result.asset);
      if (result.asset.included) includedCount += 1; else skippedCount += 1;
    }
    const percent = total ? 25 + Math.round((done / total) * 65) : 90;
    reportProgress({ stage:'files', percent, current:done, total, included:includedCount, skipped:skippedCount, filename:downloadCandidates[index]?.filename || downloadCandidates[index]?.label || '' });
  });

  if (cancelled) {
    downloadCandidates.forEach((candidate, index) => {
      if (completedIndices.has(index)) return;
      const filename = sanitizeFilename(candidate.filename || candidate.label, candidate.type === 'image' ? 'image.png' : 'attachment.bin');
      assets.push({ messageIndex:candidate.messageIndex,type:candidate.type || 'attachment',label:candidate.label || filename,filename,sourceUrl:'',included:false,reason:'Export cancelled before this file was downloaded.',detectedBy:'cancelled' });
      skippedCount += 1;
    });
    reportProgress({ stage:'cancelled', percent:92, current:completedIndices.size, total:downloadCandidates.length, included:includedCount, skipped:skippedCount });
  }

  if (candidates.length > MAX_ASSETS) assets.push({ messageIndex:-1,type:'notice',included:false,reason:`${candidates.length - MAX_ASSETS} additional assets were detected beyond the ${MAX_ASSETS}-asset safety limit.` });
  try { chrome.runtime.onMessage.removeListener(cancelListener); } catch (_) {}
  pipelineDiagnostics.status = cancelled ? 'cancelled' : 'completed';
  pipelineDiagnostics.finalAssets = assets.filter((item) => item && item.type !== 'notice').length;
  pipelineDiagnostics.included = assets.filter((item) => item?.included === true).length;
  pipelineDiagnostics.skipped = assets.filter((item) => item && item.type !== 'notice' && item.included === false).length;
  return { assets, cancelled, diagnostics:pipelineDiagnostics };
}


async function dedupeIncludedAssetsByContent(inputAssets) {
  const assets = Array.isArray(inputAssets) ? inputAssets.map((asset) => asset && typeof asset === 'object' ? { ...asset } : asset) : [];
  const diagnostics = {
    version:'2.32.0',
    sourceUrlDuplicatesRemoved:0,
    sha256DuplicatesRemoved:0,
    hashesComputed:0,
    totalDuplicatesRemoved:0,
    referencesPreserved:0
  };


  const dataUrlBytes = (value) => {
    const raw = String(value || '');
    const comma = raw.indexOf(',');
    if (comma < 0) return null;
    const meta = raw.slice(0, comma);
    const payload = raw.slice(comma + 1);
    try {
      if (/;base64/i.test(meta)) {
        const binary = atob(payload);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return bytes;
      }
      return new TextEncoder().encode(decodeURIComponent(payload));
    } catch (_) {
      return null;
    }
  };

  const hashCache = new Map();
  const hashOf = async (index) => {
    if (hashCache.has(index)) return hashCache.get(index);
    const bytes = dataUrlBytes(assets[index]?.dataUrl);
    if (!bytes?.byteLength || !globalThis.crypto?.subtle) {
      hashCache.set(index, '');
      return '';
    }
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    diagnostics.hashesComputed += 1;
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    hashCache.set(index, hash);
    return hash;
  };

  // Hash only equal-size groups, but do it across the entire selected export.
  // Exact SHA-256 equality is the final identity check, regardless of message index.
  const groups = new Map();
  for (let i = 0; i < assets.length; i += 1) {
    const asset = assets[i];
    if (!asset?.included || !asset.dataUrl || asset.type === 'notice') continue;
    const size = Number(asset.size || 0);
    if (!size) continue;
    const list = groups.get(size) || [];
    list.push(i);
    groups.set(size, list);
  }

  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const byHash = new Map();
    for (const index of list) {
      const hash = await hashOf(index);
      if (!hash) continue;
      const prior = byHash.get(hash);
      if (prior == null) {
        byHash.set(hash, index);
        assets[index].dedupeContentKey = `sha256:${hash}`;
        continue;
      }

      const keep = prior;
      const duplicate = index;

      assets[keep].dedupeContentKey = `sha256:${hash}`;
      assets[duplicate].dedupeContentKey = `sha256:${hash}`;
      assets[duplicate].deduplicated = true;
      assets[duplicate].duplicateOfFilename = String(assets[keep]?.filename || '');
      assets[duplicate].duplicateOfMessageIndex = Number.isInteger(assets[keep]?.messageIndex)
        ? assets[keep].messageIndex
        : -1;

      diagnostics.sha256DuplicatesRemoved += 1;
      diagnostics.totalDuplicatesRemoved += 1;
      diagnostics.referencesPreserved += 1;
    }
  }

  return { assets, diagnostics };
}

function normalizeAttachmentLabels(inputAssets) {
  const assets = Array.isArray(inputAssets) ? inputAssets : [];
  const supported = '(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|tar|gz|tgz|bz2|txt|csv|tsv|jsonl?|md|html?|xml|ya?ml|ini|log|har|sql|php|m?js|cjs|tsx?|jsx|css|scss|py|ipynb|java|c|cpp|h|hpp|cs|go|rs|rb|sh|ps1|bat|cmd|exe|msi|dmg|pkg|apk|deb|rpm|png|jpe?g|gif|webp|svg|mp3|wav|flac|m4a|mp4|mov|webm|avi|mkv|woff2?|ttf|otf)';
  const filenamePattern = new RegExp(`[^\\s<>:"/\\\\|?*]+\\.${supported}`, 'giu');
  const clean = (value) => String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const normalize = (value) => clean(value)
    .normalize('NFKC')
    .toLocaleLowerCase();
  const uiNoise = /(?:^|\s)(?:document|документ|open file|відкрити файл|download file|завантажити файл|download|завантажити)(?:\s|$)/iu;

  return assets.map((asset) => {
    if (!asset || asset.type !== 'attachment') return asset;

    const filename = clean(asset.filename);
    const label = clean(asset.label);
    if (!filename) return asset;
    if (!label) return { ...asset, label:filename };

    const tokens = [...label.matchAll(filenamePattern)].map((match) => clean(match[0])).filter(Boolean);
    if (!tokens.length) return asset;

    const wanted = normalize(filename);
    const matchingTokens = tokens.filter((token) => normalize(token) === wanted);
    const foreignTokens = tokens.filter((token) => normalize(token) !== wanted);
    const repeatedFilename = matchingTokens.length > 1;
    const contaminated = foreignTokens.length > 0 || repeatedFilename || uiNoise.test(label);

    if (contaminated || !matchingTokens.length) {
      return { ...asset, label:filename, labelNormalized:true };
    }

    // A label that is effectively just the exact filename remains unchanged.
    if (normalize(label) === wanted) return asset;

    // If the filename is embedded in UI/card text, keep the exported label deterministic.
    if (label.length > filename.length + 12) {
      return { ...asset, label:filename, labelNormalized:true };
    }
    return asset;
  });
}

function isServiceAttachmentName(value) {
  return /^(?:sprites?[-_.]|favicon[-_.]|icon[-_.]|attachment-(?:file-)?(?:icon|tile|radius)[-_.])|(?:^|[-_.])sprites?(?:[-_.]|$)/i.test(String(value || '').trim());
}

function suppressResolvedAttachmentFallbacks(inputAssets) {
  const assets = Array.isArray(inputAssets) ? inputAssets : [];
  const normalizeIdentity = (value) => String(value || '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/^(?:download|завантажити|скачати|отримати)(?:\s|[:—-]|$)*/iu, '')
    .replace(/\.(?:bin|zip|rar|7z|tar|gz|tgz|bz2|pdf|docx?|xlsx?|pptx?|txt|csv|tsv|jsonl?|md|html?|xml|ya?ml|ini|log|har|sql|php|m?js|cjs|tsx?|jsx|css|scss|py|ipynb|java|c|cpp|h|hpp|cs|go|rs|rb|sh|ps1|bat|cmd|exe|msi|dmg|pkg|apk|deb|rpm|png|jpe?g|gif|webp|svg|mp3|wav|flac|m4a|mp4|mov|webm|avi|mkv)$/iu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');

  const identitiesByMessage = new Map();
  for (const asset of assets) {
    if (!asset || asset.type !== 'attachment' || !asset.included) continue;
    const messageIndex = Number(asset.messageIndex);
    if (!Number.isFinite(messageIndex)) continue;
    const keys = [asset.label, asset.filename]
      .map(normalizeIdentity)
      .filter((value) => value.length >= 6);
    if (!keys.length) continue;
    const current = identitiesByMessage.get(messageIndex) || new Set();
    keys.forEach((key) => current.add(key));
    identitiesByMessage.set(messageIndex, current);
  }

  return assets.filter((asset) => {
    if (!asset || asset.type !== 'attachment' || asset.included) return true;
    if (asset.detectedBy !== 'message-bound-resolver') return true;
    const messageIndex = Number(asset.messageIndex);
    const resolvedKeys = identitiesByMessage.get(messageIndex);
    if (!resolvedKeys?.size) return true;

    const isSyntheticFallback = /\.bin$/i.test(String(asset.filename || '')) ||
      /real file card was found|no file_id or sandbox path was exposed/i.test(String(asset.reason || ''));
    if (!isSyntheticFallback) return true;

    const fallbackKeys = [asset.label, asset.filename]
      .map(normalizeIdentity)
      .filter((value) => value.length >= 6);
    if (!fallbackKeys.length) return true;

    return !fallbackKeys.some((key) => resolvedKeys.has(key));
  });
}

function mergeAssetCollections(primary, secondary) {
  const all = [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(secondary) ? secondary : [])];
  const clean = (value) => String(value || '').normalize('NFKC').replace(/^_+/, '').replace(/\s+/g,' ').trim().toLocaleLowerCase();
  const map = new Map();
  const notices = [];
  for (const asset of all) {
    if (!asset || asset.type === 'notice') { if (asset) notices.push(asset); continue; }
    const key = `${Number(asset.messageIndex)}|${asset.type || 'asset'}|${clean(asset.filename || asset.label || asset.sourceUrl)}`;
    const current = map.get(key);
    if (!current || (asset.included && !current.included) || (asset.included === current.included && Number(asset.size || 0) > Number(current.size || 0))) {
      map.set(key, asset);
    }
  }
  return [...map.values(), ...notices];
}

function mergeTranscriptAttachmentReferences(existingAssets, payload) {
  const assets = [...(Array.isArray(existingAssets) ? existingAssets : [])];
  const supported = '(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|tar|gz|tgz|bz2|txt|csv|tsv|jsonl?|md|html?|xml|ya?ml|ini|log|har|sql|php|m?js|cjs|tsx?|jsx|css|scss|py|ipynb|java|c|cpp|h|hpp|cs|go|rs|rb|sh|ps1|bat|cmd|exe|msi|dmg|pkg|apk|deb|rpm|png|jpe?g|gif|webp|svg|mp3|wav|flac|m4a|mp4|mov|webm|avi|mkv|woff2?|ttf|otf)';
  const filenamePattern = new RegExp(`[^\\/\\s<>:"|?*]+\\.${supported}`, 'iu');
  const linkPattern = /\[([^\]\n]+)\]\(([^)]+)\)/giu;
  const clean = (value) => String(value || '').trim().replace(/^_+/, '').normalize('NFKC').toLocaleLowerCase();
  const known = new Set(assets.filter((a) => a?.type === 'attachment').map((a) => `${Number(a.messageIndex)}|${clean(a.filename || a.label)}`));

  (payload?.messages || []).forEach((message, arrayIndex) => {
    const index = Number.isInteger(message?.index) ? message.index : arrayIndex;
    const text = [message?.markdown, message?.text].filter((v) => typeof v === 'string').join('\n');
    for (const match of text.matchAll(linkPattern)) {
      const rawTarget = String(match[2] || '').trim();
      // Only an actual file-style link is evidence of an attachment. A filename merely mentioned
      // in prose, code, or a standalone line never creates a download task or MISSING_FILES entry.
      if (!/^(?:sandbox:|https?:\/\/)/i.test(rawTarget)) continue;
      if (/^https?:\/\//i.test(rawTarget) && !/(?:backend-api\/estuary\/content|backend-api\/files|oaiusercontent|\/download(?:\/|\?|$))/i.test(rawTarget)) continue;
      let targetName = '';
      try {
        targetName = decodeURIComponent(rawTarget.replace(/^sandbox:/i, '').split(/[?#]/)[0].split('/').filter(Boolean).pop() || '');
      } catch (_) {}
      const labelName = String(match[1] || '').match(filenamePattern)?.[0] || '';
      const filename = String(targetName.match(filenamePattern)?.[0] || labelName || '').trim().slice(0, 180);
      const key = `${index}|${clean(filename)}`;
      if (!filename || isServiceAttachmentName(filename) || known.has(key)) continue;
      known.add(key);
      assets.push({
        messageIndex:index,
        type:'attachment',
        label:filename,
        filename,
        sourceUrl:/^https?:\/\//i.test(rawTarget) ? rawTarget : '',
        included:false,
        reason:'The selected message contains a real file link, but no message-bound file_id/bytes were resolved for it.',
        detectedBy:'transcript-file-link'
      });
    }
  });
  return assets;
}

