// Browser UI regression suite: drives the real BoardUI (harness) in Chrome with real mouse/keyboard events.
//   npm run build && npm run test:ui
//   SHOTS=./shots npm run test:ui     also save screenshots of each state
//   CHROME=/path/to/chrome            override the browser binary
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packages/plugin');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(root) || !existsSync(file)) return void res.writeHead(404).end();
  res
    .writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
    .end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const chrome =
  process.env.CHROME ??
  ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(
    existsSync,
  );
if (!chrome) {
  console.error('No Chrome/Chromium found. Set CHROME=/path/to/chrome.');
  process.exit(2);
}
if (!existsSync(path.join(root, 'dev/harness.js'))) {
  console.error('dev/harness.js missing. Run `npm run build` first.');
  process.exit(2);
}
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const S = SHOTS ?? '';

const browser = await chromium.launch({ executablePath: chrome, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(5000);
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
let pass = 0,
  fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
};
const ev = (fn, arg) => page.evaluate(fn, arg);
const card = (key) =>
  ev((k) => {
    const c = window.__op.store.get(k);
    return (
      c && {
        status: c.status,
        rank: c.rank,
        title: c.title,
        priority: c.priority,
        labels: c.labels,
        assignee: c.assignee,
        due: c.due,
      }
    );
  }, key);
const order = (col) => page.$$eval(`.op-col[data-col="${col}"] .op-card`, (els) => els.map((e) => e.dataset.key));
const settle = () => page.waitForTimeout(250);

await page.goto(`${base}/dev/harness.html?theme=light&lang=en`);
await page.waitForSelector('.op-card');

// 1. Drag OP-4 (To do) into In review, before OP-16
check(
  'review order before',
  JSON.stringify(await order('review')) === '["OP-15","OP-16"]',
  JSON.stringify(await order('review')),
);
await page.dragAndDrop('[data-key="OP-4"]', '[data-key="OP-16"]', { targetPosition: { x: 100, y: 6 } });
await settle();
check('drag: OP-4 moved to review', (await card('OP-4')).status === 'review', JSON.stringify(await card('OP-4')));
check(
  'drag: lands between OP-15 and OP-16',
  JSON.stringify(await order('review')) === '["OP-15","OP-4","OP-16"]',
  JSON.stringify(await order('review')),
);
check('drag: removed from To do', !(await order('todo')).includes('OP-4'));
check(
  'drag: written to the note (service)',
  await ev(async () => (await window.__op.storage.read('Cards/OP-4.md')).includes('status: review')),
);
check(
  'review column WIP now 3/3 (not over)',
  (await page.textContent('.op-col[data-col="review"] .op-col-count')) === '3/3',
);

// 2. Reorder inside a column (drop OP-13 above OP-10 in In progress)
await page.dragAndDrop('[data-key="OP-13"]', '[data-key="OP-10"]', { targetPosition: { x: 100, y: 6 } });
await settle();
check('reorder inside column', (await order('doing'))[0] === 'OP-13', JSON.stringify(await order('doing')));

// 3. Drop in the same place is a no-op (no write)
const before = await ev(() => window.__op.storage.files.get('Cards/OP-12.md'));
await page.dragAndDrop('[data-key="OP-12"]', '[data-key="OP-14"]', { targetPosition: { x: 100, y: 6 } }); // OP-12 already sits right before OP-14
await settle();
check(
  'same-place drop does not rewrite the note',
  before === (await ev(() => window.__op.storage.files.get('Cards/OP-12.md'))),
);

// 4. Open the drawer, edit fields
await page.click('[data-key="OP-10"] .op-card-title');
await settle();
check('drawer opens', await page.isVisible('.op-drawer'));
check('drawer shows title', (await page.inputValue('.op-title-input')) === 'Fix redirect after login');
check(
  'the description opens in Preview mode by default',
  (await page.isVisible('.op-preview')) &&
    !(await page.isVisible('.op-desc')) &&
    (await page.locator('.op-tab.is-on').textContent()) === 'Preview',
);
check(
  'the rendered description is shown (not the raw Markdown)',
  (await page.locator('.op-preview input[type=checkbox]').count()) === 3,
);
check('card marked selected', (await page.locator('[data-key="OP-10"].op-selected').count()) === 1);
if (SHOTS) await page.screenshot({ path: `${S}/drawer-light.png` });
await page.selectOption('.op-drawer .op-fields select >> nth=1', 'low'); // priority
await settle();
check('drawer: priority change saved', (await card('OP-10')).priority === 'low', JSON.stringify(await card('OP-10')));
await page.fill('.op-title-input', 'Title edited in the panel');
await page.press('.op-title-input', 'Enter');
await settle();
check('drawer: title saved on Enter', (await card('OP-10')).title === 'Title edited in the panel');
await page.fill('.op-label-field', 'urgente');
await page.press('.op-label-field', 'Enter');
await settle();
check('drawer: label added', (await card('OP-10')).labels.includes('urgente'));
await page.click('.op-preview', { position: { x: 8, y: 8 } });
check(
  'clicking the text enters edit mode with the editor focused',
  (await page.isVisible('.op-desc')) &&
    !(await page.isVisible('.op-preview')) &&
    (await ev(() => document.activeElement?.classList.contains('op-desc'))),
);
await page.keyboard.press('Escape');
check(
  'Esc leaves the editor and keeps the drawer open',
  (await page.isVisible('.op-preview')) && (await page.isVisible('.op-drawer')),
);
await page.click('.op-tab >> nth=0');
check(
  'the Write tab opens the editor with focus',
  (await page.isVisible('.op-desc')) && (await ev(() => document.activeElement?.classList.contains('op-desc'))),
);
await page.fill('.op-desc', 'New description\n\n- [x] one\n- [ ] two');
await page.click('.op-title-input'); // blur description -> flush
await settle();
check(
  'drawer: description saved on blur + checklist chip updated',
  (await page.textContent('[data-key="OP-10"] .op-chip-check')).trim() === '1/2',
);
await page.click('.op-tab >> nth=1');
await settle();
check('drawer: preview renders markdown', await page.isVisible('.op-preview input[type=checkbox]'));
check(
  'leaving the editor returned to Preview with the saved text',
  (await page.isVisible('.op-preview')) && (await page.locator('.op-preview').innerText()).includes('New description'),
);
await ev(() => {
  const { store } = window.__op;
  for (let i = 0; i < 6; i++) store.apply({ ...store.get('OP-10'), estimate: 20 + i });
}); // a burst of unrelated updates
await settle();
check(
  'repeated updates do not re-render or duplicate the description',
  (await page.locator('.op-preview .op-preview-content').count()) === 1 &&
    (await page.locator('.op-preview').innerText()).split('New description').length === 2,
);
const chip = () => page.textContent('[data-key="OP-10"] .op-chip-check').then((t) => t.trim());
await page.locator('.op-preview input[type=checkbox]').nth(1).click();
await settle();
check(
  'clicking a rendered checkbox writes the change to the note',
  await ev(async () => (await window.__op.storage.read('Cards/OP-10.md')).includes('- [x] two')),
);
check(
  '…the card progress follows (2/2) and the box stays checked',
  (await chip()) === '2/2' && (await page.locator('.op-preview input[type=checkbox]').nth(1).isChecked()),
);
await page.locator('.op-preview input[type=checkbox]').nth(1).click();
await settle();
check(
  '…and unchecking works too (1/2)',
  (await chip()) === '1/2' &&
    (await ev(async () => (await window.__op.storage.read('Cards/OP-10.md')).includes('- [ ] two'))),
);
check(
  'clicking a checkbox does not switch to edit mode',
  (await page.isVisible('.op-preview')) && !(await page.isVisible('.op-desc')),
);
check(
  'wide rendered content cannot widen the panel (tables scroll inside, media scales)',
  await ev(() => {
    const body = document.querySelector('.op-drawer-body');
    const box = document.querySelector('.op-preview');
    const keep = box.innerHTML;
    const cells = Array.from({ length: 12 }, (_, i) => `<td>celula-${i}-${'x'.repeat(40)}</td>`).join('');
    box.innerHTML = `<div><table><tbody><tr>${cells}</tr></tbody></table><pre><code>${'y'.repeat(300)}</code></pre><p>${'z'.repeat(400)}</p><img width="1600" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></div>`;
    const table = box.querySelector('table');
    const ok =
      body.scrollWidth <= body.clientWidth + 1 &&
      table.scrollWidth > table.clientWidth &&
      box.querySelector('img').getBoundingClientRect().right <= box.getBoundingClientRect().right + 1;
    box.innerHTML = keep;
    return ok;
  }),
);
if (SHOTS) await page.screenshot({ path: `${S}/drawer-preview-light.png` });
// ---- comments ----
const lastAuthor = () => page.$$eval('.op-comment .op-comment-author', (e) => e.at(-1)?.textContent);
const count = () => page.locator('.op-comment').count();
check(
  'card face shows the comment count',
  (await page.textContent('[data-key="OP-10"] .op-chip-comments')).trim() === '2',
);
check(
  'drawer lists existing comments in order',
  JSON.stringify(await page.$$eval('.op-comment .op-comment-author', (e) => e.map((x) => x.textContent))) ===
    '["Carla","Ana"]',
);
check(
  'comment markdown is rendered (2 checklist items in the 2nd comment)',
  (await page.locator('.op-comment-body input[type=checkbox]').count()) === 2,
);
await page.locator('.op-comment-body input[type=checkbox]').nth(1).click();
await settle();
check(
  'a checkbox inside a comment is saved too',
  await ev(async () => (await window.__op.storage.read('Cards/OP-10.md')).includes('> - [x] fix in the gateway')),
);
await page.locator('.op-comment-body input[type=checkbox]').nth(1).click();
await settle();
check(
  '…and can be unchecked again',
  await ev(async () => (await window.__op.storage.read('Cards/OP-10.md')).includes('> - [ ] fix in the gateway')),
);
if (SHOTS) await page.screenshot({ path: `${S}/comments-light.png` });
check('post button is disabled while the box is empty', await page.isDisabled('.op-comment-new .op-btn-primary'));
await page.fill('.op-comment-new .op-comment-input', 'First **new** comment\n\nwith two lines');
check('post button enables once there is text', !(await page.isDisabled('.op-comment-new .op-btn-primary')));
await page.press('.op-comment-new .op-comment-input', 'Control+Enter');
await settle();
check('Ctrl+Enter posts a comment', (await count()) === 3);
check('…signed with the board user', (await lastAuthor()) === 'Ana');
check(
  '…written to the note as a callout',
  await ev(async () => (await window.__op.storage.read('Cards/OP-10.md')).includes('> [!comment|')),
);
check('…the card chip goes to 3', (await page.textContent('[data-key="OP-10"] .op-chip-comments')).trim() === '3');
check('…and the box is cleared', (await page.inputValue('.op-comment-new .op-comment-input')) === '');

const editBtn = (n) => page.locator('.op-comment').nth(n).locator('.op-comment-act').nth(0);
const delBtn = (n) => page.locator('.op-comment').nth(n).locator('.op-comment-act').nth(1);
await editBtn(2).click({ force: true });
await page.fill('.op-comment-edit', 'mid-edit text');
await ev(() => {
  const c = window.__op.store.get('OP-10');
  window.__op.store.apply({ ...c, estimate: 7 });
}); // unrelated update arrives
await settle();
check(
  'an update arriving mid-edit does not wipe the editor',
  (await page.inputValue('.op-comment-edit')) === 'mid-edit text',
);
await page.fill('.op-comment-edit', 'Edited text');
await page.press('.op-comment-edit', 'Control+Enter');
await settle();
check(
  'editing a comment saves it (screen and note)',
  (await page.textContent('.op-comment:last-child .op-comment-body')).includes('Edited text') &&
    (await ev(async () => (await window.__op.storage.read('Cards/OP-10.md')).includes('Edited text'))),
);
await editBtn(2).click({ force: true });
await page.press('.op-comment-edit', 'Escape');
check(
  'Esc cancels an edit without saving',
  (await page.locator('.op-comment-edit').count()) === 0 && (await page.isVisible('.op-drawer')),
);

await delBtn(2).click({ force: true });
await page.click('.hx-modal button >> nth=1');
await settle();
check(
  'deleting a comment removes it and updates the chip',
  (await count()) === 2 && (await page.textContent('[data-key="OP-10"] .op-chip-comments')).trim() === '2',
);

await page.fill('.op-comment-new .op-comment-input', 'unsent draft');
await page.click('[data-key="OP-11"] .op-card-title');
await settle();
check(
  'an unsent draft belongs to its card (empty on another card)',
  (await page.inputValue('.op-comment-new .op-comment-input')) === '' &&
    (await page.locator('.op-comments-empty').count()) === 1,
);
await page.click('[data-key="OP-10"] .op-card-title');
await settle();
check(
  '…and is restored when you come back',
  (await page.inputValue('.op-comment-new .op-comment-input')) === 'unsent draft',
);
await page.fill('.op-comment-new .op-comment-input', '');

// ---- empty description ----
await page.click('[data-key="OP-7"] .op-card-title');
await settle();
check('an empty description invites you to write one', await page.locator('.op-preview-empty').isVisible());
await page.click('.op-preview-empty');
check(
  '…and clicking it opens the editor',
  (await page.isVisible('.op-desc')) && (await ev(() => document.activeElement?.classList.contains('op-desc'))),
);
await page.keyboard.press('Escape');
await page.click('[data-key="OP-10"] .op-card-title');
await settle();

// ---- resizing the details panel ----
const panelWidth = async () => (await page.locator('.op-drawer').boundingBox()).width;
const handle = page.locator('.op-drawer-resizer');
const savedWidth = () => ev(() => window.__op.ui.getState().drawerWidth);
const dragHandle = async (dx) => {
  const b = await handle.boundingBox();
  const x = b.x + b.width / 2,
    y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 8 });
  await page.mouse.up();
  await settle();
};
const w0 = await panelWidth();
check('panel default width is roomy (>= 400px)', w0 >= 400, `w0=${w0}`);
check('the resize handle is exposed to assistive tech', (await handle.getAttribute('role')) === 'separator');
await dragHandle(-150);
const w1 = await panelWidth();
check(
  'dragging the handle left widens the panel by the dragged amount',
  Math.abs(w1 - (w0 + 150)) <= 2,
  `w0=${w0} w1=${w1}`,
);
check(
  '…and the width is saved in the view state',
  (await savedWidth()) === Math.round(w1),
  `saved=${await savedWidth()}`,
);
if (SHOTS) await page.screenshot({ path: `${S}/drawer-resized.png` });
await dragHandle(900);
check(
  'dragging far right stops at the minimum (300px)',
  Math.abs((await panelWidth()) - 300) <= 1,
  `w=${await panelWidth()}`,
);
await dragHandle(-2000);
const paneW = (await page.locator('.op-main').boundingBox()).width;
const wMax = await panelWidth();
check('dragging far left leaves room for the board (>= 260px)', paneW - wMax >= 259, `pane=${paneW} panel=${wMax}`);
await dragHandle(900);
await handle.focus();
await page.keyboard.press('ArrowLeft');
await settle();
check('ArrowLeft on the handle widens by 16px', Math.abs((await panelWidth()) - 316) <= 1, `w=${await panelWidth()}`);
await page.keyboard.press('Shift+ArrowLeft');
await settle();
check('Shift+ArrowLeft widens by 48px', Math.abs((await panelWidth()) - 364) <= 1, `w=${await panelWidth()}`);
await page.keyboard.press('ArrowRight');
await settle();
check(
  'ArrowRight narrows by 16px and the drawer stays open',
  Math.abs((await panelWidth()) - 348) <= 1 && (await page.isVisible('.op-drawer')),
);
await handle.dblclick();
await settle();
check(
  'double-click restores the default width',
  Math.abs((await panelWidth()) - w0) <= 1 && (await savedWidth()) === null,
  `w=${await panelWidth()} saved=${await savedWidth()}`,
);
await dragHandle(-100);
check(
  'a user-chosen width survives clearing filters',
  await (async () => {
    await page.fill('.op-search-input', 'zzz');
    await page.click('.op-link-btn');
    await settle();
    return (await savedWidth()) !== null;
  })(),
);

await page.keyboard.press('Escape');
await page.click('.op-col-head >> nth=0'); // move focus out of fields
await page.keyboard.press('Escape');
await settle();
check('Esc closes drawer', !(await page.isVisible('.op-drawer')));

// 5. Filters
await page.fill('.op-search-input', 'checkout');
await settle();
const visible = (await page.$$('.op-card')).length;
check('search filters cards', visible > 0 && visible < 20, `visible=${visible}`);
await page.fill('.op-search-input', 'zzzz-nada');
await settle();
check(
  'empty state text when nothing matches',
  (await page.textContent('.op-col-empty >> nth=0')).includes('No cards match'),
);
await page.click('.op-link-btn');
await settle();
check('clear restores all cards', (await page.$$('.op-card')).length === 20);
await page.click('.op-pill >> nth=0'); // Assignee
await page.click('.op-pop-item >> text=Carla');
await settle();
const carlaCards = await page.$$eval('.op-card .op-avatar', (els) => els.map((e) => e.title));
check(
  'assignee filter only shows Carla',
  carlaCards.length > 0 && carlaCards.every((t) => t === 'Carla'),
  JSON.stringify(carlaCards),
);
if (SHOTS) await page.screenshot({ path: `${S}/popover-light.png` });
await page.keyboard.press('Escape');
await page.click('.op-link-btn');
await settle();

// 6. Epic toggle
await page.click('.op-toggle >> nth=1'); // Epics
await settle();
check('epics toggle shows epic cards', (await page.$$('.op-type-epic')).length >= 3);
await page.click('.op-toggle >> nth=1');
await settle();

// 7. Composer
await page.click('.op-col[data-col="todo"] .op-add');
await page.fill('.op-composer-input', 'Card created by the composer');
if (SHOTS) await page.screenshot({ path: `${S}/composer-light.png` });
await page.press('.op-composer-input', 'Enter');
await settle();
const created = await ev(() => window.__op.store.all().find((c) => c.title === 'Card created by the composer'));
check('composer creates a card', !!created && created.status === 'todo', JSON.stringify(created));
check('composer stays open for the next card', await page.isVisible('.op-composer-input'));
check('new card is last in column', (await order('todo')).at(-1) === created?.key);
await page.fill('.op-composer-input', 'Title line 1\nCard body');
await page.keyboard.press('Shift+Enter').catch(() => {});
await page.press('.op-composer-input', 'Escape');
check('Esc closes composer', !(await page.isVisible('.op-composer-input')));

// 8. Context menu + keyboard move
await page.click('[data-key="OP-6"]', { button: 'right' });
if (SHOTS) await page.screenshot({ path: `${S}/menu-light.png` });
await page.click('.hx-menu button >> text=Priority: Highest');
await settle();
check('context menu: priority', (await card('OP-6')).priority === 'highest');
await page.focus('[data-key="OP-7"]');
await page.keyboard.press('Alt+ArrowRight');
await settle();
check('Alt+→ moves card to next column', (await card('OP-7')).status === 'doing', JSON.stringify(await card('OP-7')));
check('focus follows the moved card', (await ev(() => document.activeElement?.dataset?.key)) === 'OP-7');
// keyboard: reorder within a column + global shortcuts
const doing = await order('doing');
await page.focus(`[data-key="${doing[1]}"]`);
await page.keyboard.press('Alt+ArrowUp');
await settle();
check(
  'Alt+↑ moves the card up one position',
  (await order('doing'))[0] === doing[1],
  JSON.stringify(await order('doing')),
);
await page.keyboard.press('Alt+ArrowDown');
await settle();
check(
  'Alt+↓ moves it back down',
  JSON.stringify(await order('doing')) === JSON.stringify(doing),
  JSON.stringify(await order('doing')),
);
await page.click('.op-col-head >> nth=0');
await page.keyboard.press('/');
check('"/" focuses the search box', await ev(() => document.activeElement?.classList.contains('op-search-input')));
await page.click('.op-col-head >> nth=0');
await page.keyboard.press('c');
check(
  '"c" opens the composer in the first column',
  await page.isVisible('.op-col[data-col="todo"] .op-composer-input'),
);
await page.press('.op-composer-input', 'Escape');

// 9. Delete flow (custom confirm in harness)
await page.click('[data-key="OP-9"]', { button: 'right' });
await page.click('.hx-menu button.danger');
await page.click('.hx-modal button >> nth=1');
await settle();
check('delete removes the card', !(await ev(() => !!window.__op.store.get('OP-9'))));

// ---- panel width survives re-opening the view (like an Obsidian restart) ----
const chosen = await savedWidth();
await page.selectOption('#hx-lang', 'en'); // remounts the BoardUI with its saved state
await settle();
await page.click('[data-key="OP-11"] .op-card-title');
await settle();
check(
  'the chosen panel width is restored when the view is recreated',
  chosen !== null && Math.abs((await panelWidth()) - chosen) <= 1,
  `chosen=${chosen} now=${await panelWidth()}`,
);
await settle();
await page.keyboard.press('Escape');

// ---- the interface can switch language (checked without hardcoding any translation) ----
const englishHint = await page.getAttribute('.op-search-input', 'placeholder');
await page.selectOption('#hx-lang', 'pt');
await settle();
const translatedHint = await page.getAttribute('.op-search-input', 'placeholder');
check(
  'the interface can switch to Portuguese (pt-BR)',
  !!translatedHint && translatedHint !== englishHint,
  `en=${englishHint} pt=${translatedHint}`,
);
await page.selectOption('#hx-lang', 'en');
await settle();
check('…and back to English', (await page.getAttribute('.op-search-input', 'placeholder')) === englishHint);

// 10. Dark + responsive screenshots
await page.selectOption('#hx-theme', 'dark');
await settle();
if (SHOTS) await page.screenshot({ path: `${S}/board-dark.png` });
await page.click('[data-key="OP-11"] .op-card-title');
await settle();
if (SHOTS) await page.screenshot({ path: `${S}/drawer-dark.png` });
await page.keyboard.press('Escape');
await page.selectOption('#hx-theme', 'light');
for (const w of ['720px', '520px', '400px']) {
  await page.selectOption('#hx-width', w);
  await settle();
  if (SHOTS) await page.screenshot({ path: `${S}/board-${w}.png` });
}
await page.click('[data-key="OP-11"] .op-card-title');
await settle();
if (SHOTS) await page.locator('#pane').screenshot({ path: `${S}/drawer-400.png` });
const drawerBox = await page.locator('.op-drawer').boundingBox();
check('phone width: no resize handle (panel is full width)', !(await page.locator('.op-drawer-resizer').isVisible()));
check('phone width: drawer covers the pane', drawerBox && drawerBox.width >= 395, JSON.stringify(drawerBox));

console.log(`\n${pass} passed, ${fail} failed`);
console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.join('\n') : 'no console errors');
await browser.close();
server.close();
process.exit(fail ? 1 : 0);
