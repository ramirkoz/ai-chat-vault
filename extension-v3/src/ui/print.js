import { t } from './strings.js';

// Print view for "PDF": the panel stores the export HTML in session storage under
// a one-time token; this page renders it and opens the print dialog, where the
// user picks "Save as PDF" (ported from 2.x print.html).
const token = new URLSearchParams(location.search).get('token') || '';
const key = `print:${token}`;

const { [key]: job } = await chrome.storage.session.get(key);
await chrome.storage.session.remove(key);

if (!job?.html) {
  document.getElementById('loading').textContent = t('printMissing');
} else {
  const parsed = new DOMParser().parseFromString(job.html, 'text/html');
  document.title = job.title || parsed.title || 'PDF';
  document.documentElement.lang = parsed.documentElement.lang || 'und';
  for (const style of parsed.head.querySelectorAll('style')) document.head.append(document.importNode(style, true));

  const guide = document.createElement('aside');
  guide.className = 'print-guide';
  const heading = document.createElement('h1');
  heading.textContent = t('printHeading');
  const hint = document.createElement('div');
  hint.textContent = t('printHint');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = t('printButton');
  button.addEventListener('click', () => window.print());
  guide.append(heading, hint, button);

  document.body.replaceChildren(guide, ...[...parsed.body.childNodes].map((node) => document.importNode(node, true)));
  await Promise.all([...document.images].map((image) => (image.complete ? null : new Promise((resolve) => { image.onload = image.onerror = resolve; setTimeout(resolve, 2500); }))));
  setTimeout(() => window.print(), 300);
}
