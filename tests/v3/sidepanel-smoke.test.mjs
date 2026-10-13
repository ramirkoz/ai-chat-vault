// Loads the side panel module against a stub DOM and chrome API, so errors at
// module evaluation (bad imports, use before declaration) fail CI instead of
// leaving a blank panel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

function element(id = '') {
  const node = {
    id, textContent: '', hidden: false, disabled: false, checked: false, value: '', className: '', title: '', placeholder: '',
    dataset: {}, style: {}, children: [], files: [],
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    setAttribute(name, value) { this[`attr:${name}`] = value; },
    getAttribute(name) { return this[`attr:${name}`]; },
    replaceChildren(...items) { this.children = items; },
    append(...items) { this.children.push(...items); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    click() {}
  };
  return node;
}

test('side panel module evaluates and wires its controls', async () => {
  const html = readFileSync(fileURLToPath(new URL('../../extension-v3/sidepanel.html', import.meta.url)), 'utf8');
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
  const elements = Object.fromEntries(ids.map((id) => [id, element(id)]));
  elements['role-filter'].querySelectorAll = () => [element(), element(), element()];

  const event = () => ({ addListener() {} });
  globalThis.document = {
    getElementById: (id) => elements[id] || null,
    createElement: () => element(),
    querySelectorAll: () => []
  };
  globalThis.Option = function Option(text, value) { return { text, value }; };
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'uk-UA', clipboard: { writeText: async () => {} } }, configurable: true });
  globalThis.location = { search: '' };
  globalThis.chrome = {
    tabs: { query: async () => [], get: async () => null, onActivated: event(), onUpdated: event(), create: async () => ({}) },
    permissions: { contains: async () => false, request: async () => false, onAdded: event() },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    scripting: {},
    downloads: {},
    runtime: { getManifest: () => ({ version: 'test' }) }
  };

  await import(pathToFileURL(fileURLToPath(new URL('../../extension-v3/src/ui/sidepanel.js', import.meta.url))).href);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(elements['tab-conversation'].textContent, 'Розмова');
  assert.equal(elements['format-zip'].textContent, 'ZIP з файлами');
  assert.ok(elements['test-mode'].listeners.change?.length, 'test mode switch is wired');
  assert.ok(elements.export.listeners.click?.length, 'export button is wired');
  assert.equal(elements['panel-library'].hidden, false, 'panels start as declared in HTML');
});
