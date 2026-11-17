const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const sass = require('sass');
const ts = require('typescript');

const source = fs.readFileSync('src/content-style.ts', 'utf8');
const initialize = source.slice(source.indexOf('function initializeDarkMode()'), source.indexOf('\ninitializeDarkMode();'));
const js = ts.transpile(initialize, { target: ts.ScriptTarget.ES2018 });
function harness(hasHead = true, pathname = '/std/cmn/frame/Frame.do') {
  let resolveSettings, change, observer, domReady;
  const elements = [];
  const attributes = new Set();
  const parent = {
    append(el) { el.isConnected = true; },
    toggleAttribute(name, enabled) { if (enabled) attributes.add(name); else attributes.delete(name); },
  };
  const document = {
    head: hasHead ? parent : null,
    documentElement: parent,
    createElement(tag) {
      const el = { tag, isConnected: false, remove() { this.isConnected = false; } };
      elements.push(el);
      return el;
    },
    addEventListener(name, fn) { if (name === 'DOMContentLoaded') domReady = fn; },
  };
  const browser = {
    runtime: { getURL: (file) => `extension://${file}` },
    storage: {
      sync: { get: () => new Promise((resolve) => { resolveSettings = resolve; }) },
      onChanged: { addListener(fn) { change = fn; } },
    },
  };
  vm.runInNewContext(`${js}\ninitializeDarkMode();`, {
    browser,
    document,
    location: { pathname },
    console,
    MutationObserver: class { constructor(fn) { observer = fn; } observe() {} disconnect() {} },
  });
  return {
    elements,
    attributes,
    document,
    async resolve(value) { resolveSettings(value); await Promise.resolve(); },
    change(value, area = 'sync') { change(value, area); },
    headReady() { document.head = parent; observer(); domReady(); },
    active() { return elements.filter((el) => el.isConnected); },
  };
}
test('initial CSS applies before head; stylesheet attaches once and OFF removes both', async () => {
  const h = harness(false);
  await h.resolve({ useDark: 'ON' });
  assert.equal(h.active().length, 1);
  assert.match(h.active()[0].textContent, /color-scheme: dark/);
  h.headReady();
  assert.equal(h.active().length, 2);
  h.change({ useDark: { newValue: 'ON' } });
  assert.equal(h.elements.length, 2);
  h.change({ useDark: { newValue: 'OFF' } });
  assert.equal(h.active().length, 0);
  h.change({ useDark: { newValue: 'ON' } });
  assert.equal(h.active().length, 2);
  h.change({ currentState: { newValue: 'OFF' } });
  assert.equal(h.active().length, 0);
  h.change({ currentState: { newValue: 'ON' } });
  assert.equal(h.active().length, 2);
});
test('tuition emphasis is scoped to its route and removed when dark mode is disabled', async () => {
  for (const pathname of ['/std/hak/erollmnt/TutionNtPage.do', '/std/lis/evltn/TaskViewStdPage.do']) {
    const h = harness(true, pathname);
    await h.resolve({ useDark: 'ON' });
    assert.equal(h.attributes.has('data-kh-tuition-dark'), pathname.includes('TutionNtPage'));
    h.change({ useDark: { newValue: 'OFF' } });
    assert.equal(h.attributes.size, 0);
    h.change({ useDark: { newValue: 'ON' }, currentState: { newValue: 'OFF' } });
    assert.equal(h.attributes.size, 0);
  }
});
test('pending storage read cannot overwrite a newer toggle; other storage areas ignored', async () => {
  const h = harness();
  h.change({ useDark: { newValue: 'OFF' } });
  await h.resolve({ useDark: 'ON' });
  assert.equal(h.active().length, 0);
  h.change({ useDark: { newValue: 'ON' } }, 'local');
  assert.equal(h.active().length, 0);
});
test('unset preference and disabled extension never apply dark CSS', async () => {
  for (const settings of [{}, { currentState: 'OFF', useDark: 'ON' }]) {
    const h = harness(); await h.resolve(settings); assert.equal(h.active().length, 0);
  }
});
const css = sass.compile('src/styles/dark.scss').css;
const token = (name) => css.match(new RegExp(`--kh-${name}: (#[0-9a-f]{6})`))[1];
function luminance(hex) {
  const c = hex.slice(1).match(/../g).map((x) => parseInt(x, 16) / 255).map((x) => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
  return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
}
function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
test('text and control tokens meet contrast on every neutral surface', () => {
  for (const bg of ['bg', 'surface', 'raised', 'hover']) {
    for (const fg of ['text', 'secondary', 'muted', 'link', 'success', 'warning', 'danger', 'accent']) {
      assert.ok(contrast(token(fg), token(bg)) >= (fg === 'text' ? 7 : 4.5), `${fg} on ${bg}`);
    }
    assert.ok(contrast(token('control-border'), token(bg)) >= 3, `control on ${bg}`);
  }
});
test('all 15 timetable colors meet normal text contrast', () => {
  const colors = [...css.matchAll(/\.namecol\d+\s*\{\s*background-color: (#[0-9a-f]{6})/g)];
  assert.equal(colors.length, 15);
  for (const [, bg] of colors) assert.ok(contrast(token('text'), bg) >= 4.5, bg);
});

test('initial canvas and loading background match the final dark palette', async () => {
  const h = harness(false);
  await h.resolve({ useDark: 'ON' });
  const initial = h.active()[0].textContent;
  const canvas = initial.match(/html, body\s*\{([^}]+)\}/)[1];
  const overlay = initial.match(/\.vld-overlay \.vld-background\s*\{([^}]+)\}/)[1];
  assert.equal(canvas.match(/background-color:\s*(#[0-9a-f]{6})/)[1], token('bg'));
  assert.equal(canvas.match(/(?:^|;)\s*color:\s*(#[0-9a-f]{6})/)[1], token('text'));
  assert.equal(overlay.match(/background:\s*(#[0-9a-f]{6})/)[1], token('bg'));
});

test('colored shortcuts keep readable normal and hover colors without repainting all buttons', () => {
  for (const name of ['lightgreen', 'lightpurple', 'lightbrown', 'lightblue']) {
    const rules = [...css.matchAll(new RegExp(`\\.btn-${name}[^{}]*\\{([^}]+)\\}`, 'g'))];
    assert.equal(rules.length, 2, `${name} normal and hover`);
    for (const [, declarations] of rules) {
      const bg = declarations.match(/background-color:\s*(#[0-9a-f]{6})/)[1];
      assert.ok(contrast(token('text'), bg) >= 4.5, `${name} on ${bg}`);
    }
  }
  for (const [, selectors, declarations] of css.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
    if (!/background(?:-color)?:/.test(declarations)) continue;
    assert.ok(!selectors.split(',').some((selector) =>
      /^(?:\.btn2?|\.subjectlist \.right button)(?::.*)?$/.test(selector.trim())), selectors);
  }
});
