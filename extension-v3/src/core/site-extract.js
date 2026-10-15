// Page readers injected into the active tab by the Site tools panel. Ported
// unchanged from 2.x (webpage-to-chatgpt.js and the three YouTube readers), so
// their behaviour on real sites carries over. Each is self-contained because it is
// passed to chrome.scripting.executeScript.

export function readSelection(maxLength) {
  const text = String(getSelection()?.toString() || '').replace(/\u00a0/g, ' ').trim();
  return { title: document.title, url: location.href, text: text.slice(0, maxLength), truncated: text.length > maxLength };
}

export function extractReadableWebpage(maxLength) {
  const removableSelectors = [
    'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe',
    'object', 'embed', 'nav', 'aside', 'form', 'dialog', '[hidden]',
    '[aria-hidden="true"]', '[role="navigation"]', '[role="banner"]',
    '[role="contentinfo"]', '[role="complementary"]',
    '[class*="cookie" i]', '[id*="cookie" i]',
    '[class*="advert" i]', '[id*="advert" i]',
    '[class*="sidebar" i]', '[id*="sidebar" i]',
    '[class*="social" i]', '[class*="share" i]'
  ];

  // Collapsed menus and dropdowns (e.g. Wikipedia's language list) are in the DOM
  // but not on screen: mark them in the live page so the clone can drop them.
  const HIDDEN = 'data-acv-hidden';
  const marked = [];
  for (const element of document.body?.querySelectorAll('*') || []) {
    if (element.closest(`[${HIDDEN}]`)) continue;
    const visible = typeof element.checkVisibility === 'function'
      ? element.checkVisibility()
      : getComputedStyle(element).display !== 'none';
    if (!visible) {
      element.setAttribute(HIDDEN, '');
      marked.push(element);
    }
  }
  const clone = document.body?.cloneNode(true);
  for (const element of marked) element.removeAttribute(HIDDEN);
  if (!(clone instanceof HTMLElement)) {
    return { title: document.title || '', url: location.href, text: '', truncated: false };
  }
  clone.querySelectorAll(`[${HIDDEN}]`).forEach((node) => node.remove());

  for (const selector of removableSelectors) {
    try {
      clone.querySelectorAll(selector).forEach((node) => node.remove());
    } catch {
      // Ignore selectors unsupported by an older browser build.
    }
  }

  const candidates = [
    ...clone.querySelectorAll(
      'article, main, [role="main"], [itemprop="articleBody"], .mw-parser-output, .article, .post, .entry-content, .post-content, #content, .content'
    ),
    clone
  ];

  const textFor = (root) => {
    const parts = [];
    const blockTags = new Set([
      'ADDRESS', 'ARTICLE', 'BLOCKQUOTE', 'DIV', 'DL', 'FIELDSET', 'FIGCAPTION',
      'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER',
      'HR', 'LI', 'MAIN', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL'
    ]);

    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.nodeValue || '');
        return;
      }
      if (!(node instanceof Element)) return;

      if (node.tagName === 'BR') {
        parts.push('\n');
        return;
      }

      const isBlock = blockTags.has(node.tagName);
      if (isBlock) parts.push('\n');
      if (node.tagName === 'LI') parts.push('- ');
      for (const child of node.childNodes) walk(child);
      if (isBlock) parts.push('\n');
    };

    walk(root);
    return parts
      .join('')
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  };

  const scoreFor = (node, text) => {
    const linkTextLength = [...node.querySelectorAll('a')]
      .reduce((sum, link) => sum + String(link.textContent || '').trim().length, 0);
    let multiplier = 1;
    if (node.matches('article')) multiplier = 1.35;
    else if (node.matches('main, [role="main"]')) multiplier = 1.25;
    else if (node !== clone) multiplier = 1.12;
    else multiplier = 0.72;
    return (text.length - linkTextLength * 0.55) * multiplier;
  };

  let bestText = '';
  let bestScore = -Infinity;
  const seen = new Set();

  for (const candidate of candidates) {
    if (!(candidate instanceof HTMLElement) || seen.has(candidate)) continue;
    seen.add(candidate);
    const text = textFor(candidate);
    if (!text) continue;
    const score = scoreFor(candidate, text);
    if (score > bestScore) {
      bestScore = score;
      bestText = text;
    }
  }

  const normalizedLimit = Math.max(1000, Number(maxLength) || 27000);
  let text = bestText;
  let truncated = false;
  if (text.length > normalizedLimit) {
    const cut = text.slice(0, normalizedLimit);
    const boundary = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
    text = cut.slice(0, boundary > normalizedLimit * 0.8 ? boundary : normalizedLimit).trim();
    truncated = true;
  }

  const heading = document.querySelector('h1')?.textContent?.trim();
  return {
    title: String(document.title || heading || '').trim(),
    url: location.href,
    text,
    truncated
  };
}

export async function readActiveYoutubeCaptions(preferredLanguage, maxLength) {
  const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const preferred = String(preferredLanguage || '').toLowerCase();
  const limit = Math.max(2000, Number(maxLength) || 26000);

  const currentVideoId = (() => {
    try {
      const url = new URL(location.href);
      if (url.pathname === '/watch') return String(url.searchParams.get('v') || '');
      if (url.pathname.startsWith('/shorts/')) return String(url.pathname.split('/')[2] || '');
    } catch {}
    return '';
  })();

  const pageTitle = () => normalize(
    document.querySelector('h1 yt-formatted-string')?.textContent ||
    document.querySelector('h1.ytd-watch-metadata')?.textContent ||
    document.title.replace(/\s*-\s*YouTube\s*$/i, '')
  );

  const clip = (raw) => {
    let value = String(raw || '').trim();
    let truncated = false;
    if (value.length > limit) {
      const cut = value.slice(0, limit);
      const boundary = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
      value = cut.slice(0, boundary > limit * 0.8 ? boundary : limit).trim();
      truncated = true;
    }
    return { text: value, truncated };
  };

  const scoreTrack = (track) => {
    const code = String(track?.languageCode || track?.langCode || '').toLowerCase();
    let score = track?.kind === 'asr' ? 0 : 30;
    if (code === preferred) score += 100;
    else if (preferred && code.startsWith(`${preferred}-`)) score += 80;
    if (track?.isTranslatable) score += 2;
    return score;
  };

  const trackName = (track) => normalize(
    track?.languageName ||
    track?.name?.simpleText ||
    (Array.isArray(track?.name?.runs) ? track.name.runs.map((run) => run?.text || '').join('') : '') ||
    track?.displayName ||
    track?.name || ''
  );

  const parseJson3 = (payload) => {
    const lines = [];
    for (const event of Array.isArray(payload?.events) ? payload.events : []) {
      const segments = Array.isArray(event?.segs) ? event.segs : [];
      const line = normalize(segments.map((segment) => segment?.utf8 || '').join(''));
      if (!line || line === '\n') continue;
      if (lines[lines.length - 1] !== line) lines.push(line);
    }
    return lines.join('\n').trim();
  };

  const fetchTrack = async (track) => {
    if (!track?.baseUrl) return '';
    try {
      const url = new URL(track.baseUrl, location.origin);
      url.searchParams.set('fmt', 'json3');
      const response = await fetch(url.toString(), { credentials: 'include', cache: 'no-store' });
      if (!response.ok) return '';
      return parseJson3(await response.json());
    } catch {
      return '';
    }
  };

  const player = document.getElementById('movie_player');
  const responses = [];
  try {
    const response = player?.getPlayerResponse?.();
    if (response) responses.push(response);
  } catch {}
  if (window.ytInitialPlayerResponse) responses.push(window.ytInitialPlayerResponse);
  try {
    const raw = window.ytplayer?.config?.args?.raw_player_response || window.ytplayer?.config?.args?.player_response;
    if (raw) responses.push(typeof raw === 'string' ? JSON.parse(raw) : raw);
  } catch {}

  let playerResponse = responses.find((response) => {
    const videoId = String(response?.videoDetails?.videoId || '');
    const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    return (!currentVideoId || !videoId || videoId === currentVideoId) && Array.isArray(tracks) && tracks.length;
  }) || null;

  if (!playerResponse && currentVideoId) {
    try {
      const ytcfg = window.ytcfg;
      const apiKey = String(ytcfg?.get?.('INNERTUBE_API_KEY') || '');
      const clientVersion = String(ytcfg?.get?.('INNERTUBE_CLIENT_VERSION') || '');
      const clientNameRaw = ytcfg?.get?.('INNERTUBE_CLIENT_NAME');
      const clientName = typeof clientNameRaw === 'string' && clientNameRaw ? clientNameRaw : 'WEB';
      if (apiKey && clientVersion) {
        const endpoint = new URL('/youtubei/v1/player', location.origin);
        endpoint.searchParams.set('key', apiKey);
        endpoint.searchParams.set('prettyPrint', 'false');
        const response = await fetch(endpoint.toString(), {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            context: {
              client: {
                clientName,
                clientVersion,
                hl: preferred || 'en',
                gl: String(ytcfg?.get?.('GL') || 'US')
              }
            },
            videoId: currentVideoId,
            contentCheckOk: true,
            racyCheckOk: true
          })
        });
        if (response.ok) {
          const fresh = await response.json();
          const tracks = fresh?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          if (Array.isArray(tracks) && tracks.length) playerResponse = fresh;
        }
      }
    } catch {}
  }

  let tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  let track = Array.isArray(tracks) && tracks.length
    ? [...tracks].sort((a, b) => scoreTrack(b) - scoreTrack(a))[0]
    : null;
  let transcript = await fetchTrack(track);

  if (!transcript) {
    try {
      const playerTrackList = player?.getOption?.('captions', 'tracklist');
      const playerTrack = player?.getOption?.('captions', 'track');
      const fallbackTracks = [];
      if (Array.isArray(playerTrackList)) fallbackTracks.push(...playerTrackList);
      else if (Array.isArray(playerTrackList?.captionTracks)) fallbackTracks.push(...playerTrackList.captionTracks);
      if (playerTrack && typeof playerTrack === 'object') fallbackTracks.push(playerTrack);
      const candidate = fallbackTracks.sort((a, b) => scoreTrack(b) - scoreTrack(a))[0];
      if (candidate?.baseUrl) {
        transcript = await fetchTrack(candidate);
        if (transcript) track = candidate;
      }
    } catch {}
  }

  const domTranscript = () => {
    const selectors = [
      'ytd-transcript-segment-renderer .segment-text',
      'ytd-transcript-segment-renderer [class*="segment-text"]',
      'ytd-transcript-segment-renderer yt-formatted-string',
      '[target-id="engagement-panel-searchable-transcript"] ytd-transcript-segment-renderer',
      'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"] ytd-transcript-segment-renderer'
    ];
    const lines = [];
    const seen = new Set();
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        const line = normalize(node.textContent);
        if (!line || seen.has(line)) continue;
        seen.add(line);
        lines.push(line);
      }
      if (lines.length > 2) break;
    }
    return lines.join('\n').trim();
  };

  if (!transcript) {
    transcript = domTranscript();
    if (!transcript) {
      const pattern = /(show\s+transcript|transcript|показати\s+текст\s+відео|текст\s+відео|стенограм|розшифров|расшифров)/iu;
      const controls = [...document.querySelectorAll('button, [role="button"], ytd-button-renderer, tp-yt-paper-button')];
      const target = controls.find((element) => pattern.test(normalize(`${element.textContent || ''} ${element.getAttribute?.('aria-label') || ''}`)));
      try { target?.click?.(); } catch {}
      const deadline = Date.now() + 5000;
      while (!transcript && Date.now() < deadline) {
        await wait(200);
        transcript = domTranscript();
      }
    }
  }

  if (!transcript) return { text: '' };
  const clipped = clip(transcript);
  return {
    title: normalize(playerResponse?.videoDetails?.title || pageTitle()),
    languageCode: String(track?.languageCode || track?.langCode || ''),
    languageName: trackName(track),
    automatic: track?.kind === 'asr',
    text: clipped.text,
    truncated: clipped.truncated,
    source: track?.baseUrl ? 'player-caption-track' : 'youtube-transcript-panel'
  };
}

export async function readYoutubeTranscriptPanel(maxLength) {
  const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const normalize = (value) => String(value || '').replace(/[ \t\f\v]+/g, ' ').trim();
  const timePattern = /^\s*\d{1,2}:\d{2}(?::\d{2})?\s*$/;
  const timePrefixPattern = /^\s*\d{1,2}:\d{2}(?::\d{2})?\s+/;
  const limit = Math.max(2000, Number(maxLength) || 26000);

  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };

  const cleanLines = (raw) => {
    const output = [];
    for (const rawLine of String(raw || '').split(/\r?\n/)) {
      let line = normalize(rawLine);
      if (!line || timePattern.test(line)) continue;
      line = line.replace(timePrefixPattern, '').trim();
      if (!line) continue;
      if (/^(transcript|транскрипт|текст відео|розшифровка|расшифровка)$/iu.test(line)) continue;
      if (/^(search in video|пошук у відео|show transcript|показати текст відео)$/iu.test(line)) continue;
      if (output[output.length - 1] !== line) output.push(line);
    }
    return output;
  };

  // 2026 transcript panel: <transcript-segment-view-model> with a timestamp, its
  // spoken label ("1 секунда") and the text in an attributed string.
  const readViewModelSegments = () => {
    const lines = [];
    for (const node of document.querySelectorAll('transcript-segment-view-model')) {
      const textNode = node.querySelector('.ytAttributedStringHost, [class*="AttributedString"], .yt-core-attributed-string');
      const raw = textNode ? textNode.textContent : [...node.querySelectorAll('*')]
        .filter((item) => !item.children.length && !/timestamp/i.test(String(item.className)))
        .map((item) => item.textContent).join(' ');
      const line = normalize(String(raw || '').replace(/\s*\n\s*/g, ' '));
      if (line && lines[lines.length - 1] !== line) lines.push(line);
    }
    return lines;
  };

  const readSegmentNodes = () => {
    const modern = readViewModelSegments();
    if (modern.length) return modern;
    const selectors = [
      'ytd-transcript-segment-renderer',
      'ytd-transcript-segment-view-model',
      'yt-transcript-segment-view-model',
      '[class*="transcript-segment"]',
      '[class*="segment-text"]'
    ];
    const nodes = [];
    const seenNodes = new Set();
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (!seenNodes.has(node) && visible(node)) {
          seenNodes.add(node);
          nodes.push(node);
        }
      }
    }

    const lines = [];
    for (const node of nodes) {
      for (const line of cleanLines(node.innerText || node.textContent || '')) {
        if (!lines.includes(line)) lines.push(line);
      }
    }
    return lines;
  };

  const readPanelText = () => {
    const selectors = [
      'ytd-engagement-panel-section-list-renderer[target-id*="transcript"]',
      '[target-id*="transcript"]',
      'ytd-transcript-renderer',
      '[id*="transcript"]'
    ];
    for (const selector of selectors) {
      for (const panel of document.querySelectorAll(selector)) {
        if (!visible(panel)) continue;
        const raw = String(panel.innerText || panel.textContent || '');
        const timestamps = raw.match(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g) || [];
        const lines = cleanLines(raw);
        if (timestamps.length >= 2 && lines.length >= 2) return lines;
      }
    }
    return [];
  };

  const readNow = () => {
    const segmentLines = readSegmentNodes();
    if (segmentLines.length >= 1 && document.querySelector('transcript-segment-view-model')) return segmentLines;
    if (segmentLines.length >= 2) return segmentLines;
    return readPanelText();
  };

  let lines = readNow();
  if (lines.length < 2) {
    const transcriptPattern = /(show\s+transcript|transcript|показати\s+текст\s+відео|текст\s+відео|стенограм|розшифров|расшифров)/iu;
    const controls = [...document.querySelectorAll('button, [role="button"], ytd-button-renderer, tp-yt-paper-button')];
    const target = controls.find((element) => visible(element) && transcriptPattern.test(normalize(`${element.textContent || ''} ${element.getAttribute?.('aria-label') || ''}`)));
    try { target?.click?.(); } catch {}

    const deadline = Date.now() + 6000;
    while (lines.length < 2 && Date.now() < deadline) {
      await wait(200);
      lines = readNow();
    }
  }

  if (lines.length < 2) return { text: '' };

  let text = lines.join('\n').trim();
  let truncated = false;
  if (text.length > limit) {
    const cut = text.slice(0, limit);
    const boundary = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
    text = cut.slice(0, boundary > limit * 0.8 ? boundary : limit).trim();
    truncated = true;
  }

  const title = normalize(
    document.querySelector('h1 yt-formatted-string')?.textContent ||
    document.querySelector('h1.ytd-watch-metadata')?.textContent ||
    document.title.replace(/\s*-\s*YouTube\s*$/i, '')
  );

  return { title, text, truncated, source: 'open-transcript-panel' };
}

export async function extractYoutubeTranscript(preferredLanguage, maxLength) {
  const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const preferred = String(preferredLanguage || '').toLowerCase();
  const limit = Math.max(2000, Number(maxLength) || 26000);

  const currentVideoId = (() => {
    try {
      const url = new URL(location.href);
      if (url.pathname === '/watch') return String(url.searchParams.get('v') || '');
      if (url.pathname.startsWith('/shorts/')) return String(url.pathname.split('/')[2] || '');
    } catch {
      return '';
    }
    return '';
  })();

  const clipTranscript = (rawText) => {
    let transcript = String(rawText || '').trim();
    let truncated = false;
    if (transcript.length > limit) {
      const cut = transcript.slice(0, limit);
      const boundary = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
      transcript = cut.slice(0, boundary > limit * 0.8 ? boundary : limit).trim();
      truncated = true;
    }
    return { transcript, truncated };
  };

  const pageTitle = () => normalize(
    document.querySelector('h1 yt-formatted-string')?.textContent ||
    document.querySelector('h1.ytd-watch-metadata')?.textContent ||
    document.title.replace(/\s*-\s*YouTube\s*$/i, '')
  );

  const transcriptFromDom = () => {
    const selectors = [
      'ytd-transcript-segment-renderer .segment-text',
      'ytd-transcript-segment-renderer yt-formatted-string.segment-text',
      '[target-id="engagement-panel-searchable-transcript"] .segment-text',
      'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"] .segment-text',
      'yt-formatted-string.segment-text'
    ];
    const nodes = [];
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (!nodes.includes(node)) nodes.push(node);
      }
    }
    const lines = [];
    for (const node of nodes) {
      const line = normalize(node.textContent);
      if (!line) continue;
      if (lines[lines.length - 1] !== line) lines.push(line);
    }
    return lines.join('\n').trim();
  };

  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };

  const clickTranscriptUi = async () => {
    const existing = transcriptFromDom();
    if (existing) return existing;

    const expandSelectors = [
      '#description-inline-expander #expand',
      'ytd-text-inline-expander #expand',
      'tp-yt-paper-button#expand',
      'button[aria-label*="more" i]'
    ];
    for (const selector of expandSelectors) {
      const expand = [...document.querySelectorAll(selector)].find(visible);
      if (expand) {
        try {
          expand.click();
          await wait(250);
        } catch {
          // Continue to transcript controls.
        }
        break;
      }
    }

    const transcriptPattern = /(show\s+transcript|transcript|показати\s+текст\s+відео|текст\s+відео|стенограм|розшифров|показать\s+расшифровку)/iu;
    const candidates = [
      ...document.querySelectorAll('button, [role="button"], yt-button-shape button, tp-yt-paper-button')
    ].filter((element) => {
      if (!visible(element)) return false;
      const label = normalize(`${element.textContent || ''} ${element.getAttribute('aria-label') || ''}`);
      return transcriptPattern.test(label);
    });

    if (candidates[0]) {
      try {
        candidates[0].click();
      } catch {
        return '';
      }
    }

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const transcript = transcriptFromDom();
      if (transcript) return transcript;
      await wait(200);
    }
    return '';
  };

  const isCurrentPlayerResponse = (response) => {
    if (!response || typeof response !== 'object') return false;
    const responseVideoId = String(response?.videoDetails?.videoId || '');
    return !currentVideoId || !responseVideoId || responseVideoId === currentVideoId;
  };

  const findBalancedJson = (source, marker) => {
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) return null;
    const start = source.indexOf('{', markerIndex + marker.length);
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(start, index + 1);
      }
    }
    return null;
  };

  const parsePlayerResponseFromHtml = (html) => {
    const markers = [
      'ytInitialPlayerResponse =',
      'var ytInitialPlayerResponse =',
      'window["ytInitialPlayerResponse"] =',
      'window.ytInitialPlayerResponse ='
    ];
    for (const marker of markers) {
      try {
        const json = findBalancedJson(html, marker);
        if (!json) continue;
        const parsed = JSON.parse(json);
        if (isCurrentPlayerResponse(parsed)) return parsed;
      } catch {
        // Try the next representation.
      }
    }
    return null;
  };

  const getPlayerResponse = async () => {
    const directCandidates = [];
    if (window.ytInitialPlayerResponse) directCandidates.push(window.ytInitialPlayerResponse);
    try {
      const raw = window.ytplayer?.config?.args?.raw_player_response ||
        window.ytplayer?.config?.args?.player_response;
      if (raw) directCandidates.push(typeof raw === 'string' ? JSON.parse(raw) : raw);
    } catch {
      // Continue with fresh watch-page extraction.
    }

    for (const candidate of directCandidates) {
      const tracks = candidate?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (isCurrentPlayerResponse(candidate) && Array.isArray(tracks) && tracks.length) return candidate;
    }

    try {
      const freshResponse = await fetch(location.href, { credentials: 'include', cache: 'no-store' });
      if (freshResponse.ok) {
        const parsed = parsePlayerResponseFromHtml(await freshResponse.text());
        if (parsed) return parsed;
      }
    } catch {
      // DOM and timed-text fallbacks remain available.
    }
    return directCandidates.find(isCurrentPlayerResponse) || null;
  };

  const scoreTrack = (track) => {
    const code = String(track?.languageCode || track?.langCode || '').toLowerCase();
    let score = track?.kind === 'asr' ? 0 : 30;
    if (code === preferred) score += 100;
    else if (preferred && code.startsWith(`${preferred}-`)) score += 80;
    if (track?.isTranslatable) score += 2;
    return score;
  };

  const parseJson3 = (payload) => {
    const lines = [];
    for (const event of Array.isArray(payload?.events) ? payload.events : []) {
      const segments = Array.isArray(event?.segs) ? event.segs : [];
      const line = normalize(segments.map((segment) => segment?.utf8 || '').join(''));
      if (!line || line === '\n') continue;
      if (lines[lines.length - 1] !== line) lines.push(line);
    }
    return lines.join('\n').trim();
  };

  const fetchTrackJson3 = async (track) => {
    if (!track?.baseUrl) return '';
    try {
      const captionUrl = new URL(track.baseUrl, location.origin);
      captionUrl.searchParams.set('fmt', 'json3');
      const response = await fetch(captionUrl.toString(), { credentials: 'include', cache: 'no-store' });
      if (!response.ok) return '';
      return parseJson3(await response.json());
    } catch {
      return '';
    }
  };

  const playerResponse = await getPlayerResponse();
  let tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  let track = Array.isArray(tracks) && tracks.length
    ? [...tracks].sort((a, b) => scoreTrack(b) - scoreTrack(a))[0]
    : null;
  let transcript = await fetchTrackJson3(track);

  if (!transcript && currentVideoId) {
    try {
      const listUrl = new URL('/api/timedtext', location.origin);
      listUrl.searchParams.set('type', 'list');
      listUrl.searchParams.set('v', currentVideoId);
      const listResponse = await fetch(listUrl.toString(), { credentials: 'include', cache: 'no-store' });
      if (listResponse.ok) {
        const xml = await listResponse.text();
        const documentXml = new DOMParser().parseFromString(xml, 'text/xml');
        const listedTracks = [...documentXml.querySelectorAll('track')].map((node) => ({
          languageCode: node.getAttribute('lang_code') || '',
          languageName: node.getAttribute('lang_translated') || node.getAttribute('name') || '',
          name: node.getAttribute('name') || '',
          kind: node.getAttribute('kind') || '',
          isTranslatable: true
        }));
        const fallbackTrack = listedTracks.sort((a, b) => scoreTrack(b) - scoreTrack(a))[0];
        if (fallbackTrack?.languageCode) {
          const captionUrl = new URL('/api/timedtext', location.origin);
          captionUrl.searchParams.set('v', currentVideoId);
          captionUrl.searchParams.set('lang', fallbackTrack.languageCode);
          captionUrl.searchParams.set('fmt', 'json3');
          if (fallbackTrack.name) captionUrl.searchParams.set('name', fallbackTrack.name);
          if (fallbackTrack.kind) captionUrl.searchParams.set('kind', fallbackTrack.kind);
          const captionResponse = await fetch(captionUrl.toString(), { credentials: 'include', cache: 'no-store' });
          if (captionResponse.ok) {
            transcript = parseJson3(await captionResponse.json());
            track = fallbackTrack;
          }
        }
      }
    } catch {
      // DOM fallback below remains available.
    }
  }

  if (!transcript) {
    transcript = transcriptFromDom() || await clickTranscriptUi();
    if (transcript) {
      const clipped = clipTranscript(transcript);
      return {
        title: pageTitle(),
        languageCode: '',
        languageName: '',
        automatic: false,
        text: clipped.transcript,
        truncated: clipped.truncated,
        source: 'youtube-transcript-panel'
      };
    }
  }

  if (!transcript) return { text: '' };

  const clipped = clipTranscript(transcript);
  const trackName = track?.languageName || track?.name?.simpleText ||
    (Array.isArray(track?.name?.runs) ? track.name.runs.map((run) => run?.text || '').join('') : '') ||
    track?.name || '';

  return {
    title: normalize(playerResponse?.videoDetails?.title || pageTitle()),
    languageCode: String(track?.languageCode || track?.langCode || ''),
    languageName: normalize(trackName),
    automatic: track?.kind === 'asr',
    text: clipped.transcript,
    truncated: clipped.truncated,
    source: 'youtube-caption-track'
  };
}
