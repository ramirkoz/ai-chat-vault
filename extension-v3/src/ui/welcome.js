import { t, uiLanguage } from './strings.js';

const $ = (id) => document.getElementById(id);

document.documentElement.lang = uiLanguage();
$('title').textContent = t('welcomeTitle');
$('lead').textContent = t('welcomeLead');
$('step1').textContent = t('welcomeStep1');
$('step2').textContent = t('welcomeStep2');
$('step3').textContent = t('welcomeStep3');
$('step4').textContent = t('welcomeStep4', { export: t('exportLabel') });
$('open').textContent = t('welcomeOpen');

// sidePanel.open must run inside the click, so the window id is read beforehand.
const { id: windowId } = await chrome.windows.getCurrent();
$('open').addEventListener('click', () => {
  chrome.sidePanel.open({ windowId }).catch(() => {});
});
