// End-to-end test inside the REAL Obsidian app (the part the browser harness cannot cover:
// vault events, Vault.process writes, native menu/modal, settings, rename, plugin reload).
//
//   npm run build && npm run test:obsidian
//   OBSIDIAN=/path/to/obsidian   override the binary (default: `obsidian` / /snap/bin/obsidian)
//   SHOTS=./shots                also save screenshots
//
// Safety: it creates a throwaway vault and a throwaway Obsidian profile (--user-data-dir) in a temp
// folder and talks to that instance over the Chrome DevTools Protocol. Your own Obsidian, profile
// and vaults are never opened or modified; on exit only processes of that temp profile are killed.
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(repo, 'packages/cli/dist/oprojects.cjs');
const DIST = path.join(repo, 'packages/plugin/dist');
for (const f of [CLI, path.join(DIST, 'main.js')]) if (!existsSync(f)) (console.error(`Missing ${f}. Run \`npm run build\` first.`), process.exit(2));
const obsidian = process.env.OBSIDIAN ?? ['/snap/bin/obsidian', '/usr/bin/obsidian', '/usr/local/bin/obsidian'].find(existsSync);
if (!obsidian) (console.error('Obsidian not found. Set OBSIDIAN=/path/to/obsidian.'), process.exit(2));
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const work = mkdtempSync(path.join(tmpdir(), 'oprojects-e2e-'));
const VAULT = path.join(work, 'vault');
const PROFILE = path.join(work, 'profile');
const PORT = 9300 + Math.floor(Math.random() * 500);
mkdirSync(PROFILE, { recursive: true });

// --- throwaway vault: demo cards + the built plugin, enabled ---
execFileSync('npx', ['tsx', path.join(repo, 'scripts/seed.ts'), VAULT], { cwd: repo, stdio: 'ignore' });
const pluginDir = path.join(VAULT, '.obsidian/plugins/obsidian-projects');
for (const f of ['main.js', 'manifest.json', 'styles.css']) cpSync(path.join(DIST, f), path.join(pluginDir, f));
writeFileSync(path.join(VAULT, '.obsidian/community-plugins.json'), '["obsidian-projects"]\n');
writeFileSync(path.join(PROFILE, 'obsidian.json'), JSON.stringify({ vaults: { e2e0000000000001: { path: VAULT, ts: Date.now(), open: true } } }));

const cli = (...a) => execFileSync('node', [CLI, '--vault', VAULT, ...a], { encoding: 'utf8' });
const cliJson = (...a) => JSON.parse(cli(...a, '--json'));
const cliIn = (input, ...a) => execFileSync('node', [CLI, '--vault', VAULT, ...a, '--json'], { encoding: 'utf8', input });
const note = (rel) => readFileSync(path.join(VAULT, rel), 'utf8');
const dataJson = () => JSON.parse(note('.obsidian/plugins/obsidian-projects/data.json'));

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   ' + extra}`); };
let browser;
const killProfile = () => { try { execFileSync('pkill', ['-f', PROFILE]); } catch {} };

async function main() {
  spawn(obsidian, [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--ozone-platform=headless', '--no-sandbox', '--disable-gpu'], { stdio: 'ignore', detached: true }).unref();
  for (let i = 0; i < 60; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.ok).catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const mainPage = () => browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('app://obsidian.md/index.html'));
  // The headless window is 1x1: give it a real viewport.
  const viewport = async (p, w, h) => { const c = await p.context().newCDPSession(p); await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }); };
  const logs = [];
  const watched = new WeakSet();
  const watch = (p) => {
    if (watched.has(p)) return;
    watched.add(p);
    p.setDefaultTimeout(8000);
    p.on('console', (m) => { if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
    p.on('pageerror', (e) => logs.push('[pageerror] ' + e.message.slice(0, 300)));
  };
  let page;

  // Boot. Accepting the trust prompt reloads the app window, so any step can be interrupted by a
  // reload ("execution context destroyed" / "promise was garbage collected"): re-find the page and retry.
  let booted = false;
  for (let attempt = 1; attempt <= 5 && !booted; attempt++) {
    try {
      for (let i = 0; i < 80 && !(page = mainPage()); i++) await new Promise((r) => setTimeout(r, 250));
      watch(page);
      await viewport(page, 1500, 920);
      await page.waitForFunction(() => !!window.app?.workspace, null, { timeout: 30000 });
      // The modal renders a moment after the workspace exists, so wait for it (it never shows if already trusted).
      const trust = page.locator('.modal-container button', { hasText: /trust author/i }).first();
      if (await trust.waitFor({ timeout: 6000 }).then(() => true, () => false)) await trust.click();
      await page.waitForFunction(() => !!window.app.plugins?.plugins?.['obsidian-projects'], null, { timeout: 30000 });
      await page.evaluate(() => window.app.commands.executeCommandById('obsidian-projects:open-board'));
      await page.waitForSelector('.op-card');
      booted = true;
    } catch (e) {
      if (attempt === 5) throw e;
      await new Promise((r) => setTimeout(r, 2000)); // let the reload finish, then try again on the fresh page
    }
  }
  // Obsidian opens modals in its "active window"; under CDP that is not always the one we clicked in
  // (a real user clicks where the modal should appear), so look in every window.
  const clickInAnyWindow = async (selector) => {
    for (let i = 0; i < 40; i++) {
      for (const p of browser.contexts().flatMap((c) => c.pages())) {
        const target = p.locator(selector).first();
        // DOM click: the other windows of this headless app are 1x1 px, so a pointer click would never be "actionable".
        if (await target.count().catch(() => 0)) return void (await target.evaluate((el) => el.click()));
      }
      await page.waitForTimeout(150);
    }
    throw new Error(`${selector} not found in any window`);
  };
  const shot = async (p, name) => SHOTS && p.screenshot({ path: path.join(SHOTS, name) });
  const until = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn().catch(() => false)) return true; await page.waitForTimeout(100); } return false; };
  const colOf = (key) => page.evaluate((k) => document.querySelector(`[data-key="${k}"]`)?.closest('.op-col')?.dataset.col ?? null, key);
  const inCol = (key, col) => until(async () => (await colOf(key)) === col);

  check('plugin loads in Obsidian and the board reads all cards from the vault (20 visible of 24)', (await page.locator('.op-card').count()) === 20);
  await shot(page, 'board.png');
  if (SHOTS) {
    // A clean picture of the details panel, taken before the tests below edit anything.
    await page.click('[data-key="OP-10"] .op-card-title');
    await page.waitForSelector('.op-comment-body');
    await page.waitForTimeout(600);
    await shot(page, 'comments-clean.png');
    await page.locator('.op-drawer-close, .op-drawer [aria-label="Close"]').first().click();
    await page.waitForTimeout(300);
  }

  // ---------- CLI -> Obsidian ----------
  const created = cliJson('add', 'Created by the CLI', '-s', 'review', '-p', 'high', '-a', 'Ana');
  check('CLI-created card appears live (vault create event)', await inCol(created.key, 'review'));
  cli('move', created.key, 'doing');
  check('CLI move shows live (modify event)', await inCol(created.key, 'doing'));
  cli('edit', created.key, '--title', 'Title edited by the CLI');
  check('CLI edit shows live', await until(async () => (await page.textContent(`[data-key="${created.key}"] .op-card-title`)) === 'Title edited by the CLI'));
  cli('rm', created.key);
  check('CLI rm removes it live (delete event)', await until(async () => (await colOf(created.key)) === null));

  // ---------- Obsidian -> disk ----------
  await page.click('[data-key="OP-10"] .op-card-title');
  await page.waitForSelector('.op-drawer:not([hidden])');
  const before10 = note('Cards/OP-10.md');
  await page.selectOption('.op-drawer .op-fields select >> nth=1', 'low');
  check('drawer edit is written to the note', await until(async () => note('Cards/OP-10.md').includes('priority: low')));
  const after10 = note('Cards/OP-10.md');
  check('…keeping description and other fields', after10.includes('Preserve `returnTo`') && after10.includes('assignee: Ana') && after10.includes('parent: OP-1'));
  check('…changing only the priority line (+ updated)', before10.split('\n').filter((l, i) => l !== after10.split('\n')[i]).length <= 2);
  await page.fill('.op-title-input', 'Redirect (edited in Obsidian)');
  await page.press('.op-title-input', 'Enter');
  check('title edit is written', await until(async () => note('Cards/OP-10.md').includes('title: Redirect (edited in Obsidian)')));
  // ---------- comments ----------
  const nComments = () => page.locator('.op-comment').count();
  check('drawer shows the 2 seeded comments', (await nComments()) === 2);
  cli('comment', 'OP-10', 'Comment from the CLI', '--author', 'Bruno');
  check('a comment added by the CLI appears live in the open drawer', await until(async () => (await nComments()) === 3));
  await page.fill('.op-comment-new .op-comment-input', 'Comment from Obsidian\n\n- item **bold**');
  await page.press('.op-comment-new .op-comment-input', 'Control+Enter');
  check('posting from the drawer writes a callout into the note', await until(async () => note('Cards/OP-10.md').includes('Comment from Obsidian')));
  const withComments = cliJson('show', 'OP-10');
  check('…the CLI reads it back (author = board user), description intact', withComments.comments.length === 4 && withComments.comments.at(-1).author === 'Ana' && withComments.body.includes('Preserve `returnTo`'));
  check('…Obsidian renders its Markdown in the thread', await until(async () => (await page.locator('.op-comment-body strong').count()) >= 1));
  await page.locator('.op-preview input[type=checkbox]').nth(1).click(); // "Preserve returnTo"
  check('clicking a task checkbox in the description saves it to the note', await until(async () => note('Cards/OP-10.md').includes('- [x] Preserve `returnTo`')));
  check('…and the card shows the new progress (2/3)', await until(async () => (await page.textContent('[data-key="OP-10"] .op-chip-check')).trim() === '2/3'));
  await page.locator('.op-comment-body input[type=checkbox]').nth(1).click(); // "fix in the gateway" in Ana's comment
  check('a checkbox inside a comment is saved too', await until(async () => note('Cards/OP-10.md').includes('> - [x] fix in the gateway')));
  await shot(page, 'comments.png');
  await page.locator('.op-comment').last().hover();
  await page.locator('.op-comment').last().locator('.op-comment-act').first().click();
  await page.fill('.op-comment-edit', 'Edited in Obsidian');
  await page.press('.op-comment-edit', 'Control+Enter');
  check('editing a comment rewrites only that block', (await until(async () => note('Cards/OP-10.md').includes('Edited in Obsidian'))) && !note('Cards/OP-10.md').includes('Comment from Obsidian'));
  await page.click('.op-tab >> nth=0'); // the description opens in Preview; switch to the editor
  await page.fill('.op-desc', 'Description rewritten in Obsidian');
  await page.click('.op-title-input'); // blur flushes the description
  check('editing the description keeps every comment', await until(async () => note('Cards/OP-10.md').includes('Description rewritten in Obsidian') && cliJson('show', 'OP-10').comments.length === 4));
  await page.locator('.op-comment').last().locator('.op-comment-act').nth(1).click();
  await clickInAnyWindow('.modal button.mod-warning');
  check('deleting a comment (native confirm) removes only that one', await until(async () => cliJson('show', 'OP-10').comments.length === 3));
  check('…and the note still has its "## Comments" section and description', note('Cards/OP-10.md').includes('## Comments') && note('Cards/OP-10.md').includes('Description rewritten in Obsidian'));

  // ---------- resizable details panel ----------
  const panelW = async () => (await page.locator('.op-drawer').boundingBox()).width;
  const w0 = await panelW();
  const hb = await page.locator('.op-drawer-resizer').boundingBox();
  const hx = hb.x + hb.width / 2, hy = hb.y + hb.height / 2;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx - 120, hy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const w1 = await panelW();
  check('the details panel can be resized by dragging its edge', Math.abs(w1 - (w0 + 120)) <= 2, `w0=${w0} w1=${w1}`);
  check('…and the width is saved in the workspace layout', await until(async () => page.evaluate((w) => Math.abs(window.app.workspace.getLeavesOfType('obsidian-projects-board')[0].view.getState().ui?.drawerWidth - w) <= 2, w1)));
  await shot(page, 'drawer-resized.png');
  await page.locator('.op-drawer-resizer').dblclick();
  await page.waitForTimeout(200);
  check('…and double-click restores the default', Math.abs((await panelW()) - w0) <= 1);

  // ---------- rendered Markdown must stay inside the panel ----------
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='1400' height='80'><rect width='1400' height='80' fill='#e5484d'/></svg>`;
  const WIDE = [
    '## Hard content',
    '',
    '| Column A | Column B | Column C | Column D | Column E | Column F | Column G | Column H |',
    '|---|---|---|---|---|---|---|---|',
    '| a very long value to force the table width | another equally long value here | x | y | z | w | k | j |',
    '',
    '```js',
    'const aVeryLongLineOfCodeThatNeverBreaksAndNeedsHorizontalScrollInsideTheBlockAndNotTheWholePanel = 1;',
    '```',
    '',
    'URL without spaces: https://example.com/a/very/long/path/that/has/no/spaces/to/break/the/line/and/keeps/going/even/further/until/it/overflows?query=param&other=value',
    '',
    `![wide image](data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')})`,
    '',
    '> [!note] Callout\n> with `inline_code_that_is_very_long_with_no_spaces_to_break_the_line_anywhere`',
  ].join('\n');
  const wide = JSON.parse(cliIn(WIDE, 'add', 'Wide content in the preview', '--body', '-'));
  cliIn(WIDE, 'comment', wide.key, '-', '--author', 'Bruno');
  await page.click(`[data-key="${wide.key}"] .op-card-title`);
  await page.waitForSelector('.op-comment-body');
  check('the description opens in Preview mode by default', (await page.isVisible('.op-preview')) && !(await page.isVisible('.op-desc')));
  if (!(await page.isVisible('.op-preview'))) await page.click('.op-tab >> nth=1'); // (so the overflow checks below run either way)
  await page.waitForSelector('.op-preview table');
  await page.waitForTimeout(600);
  const geometry = () => page.evaluate(() => {
    const body = document.querySelector('.op-drawer-body');
    const scrolls = (el) => !!el && ['auto', 'scroll'].includes(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth;
    const within = (sel, root) => [...document.querySelectorAll(`${root} ${sel}`)];
    const limit = (root) => document.querySelector(root).getBoundingClientRect().right + 1;
    const out = { sideways: body.scrollWidth - body.clientWidth };
    for (const root of ['.op-preview', '.op-comment-body']) {
      const table = within('table', root)[0], pre = within('pre', root)[0], img = within('img', root)[0];
      out[root] = {
        table: table ? { scrollsInside: scrolls(table) || scrolls(table.parentElement), overflowsRoot: table.getBoundingClientRect().right > limit(root) && !(scrolls(table) || scrolls(table.parentElement)) } : null,
        pre: pre ? { scrollsInside: scrolls(pre), overflowsRoot: pre.getBoundingClientRect().right > limit(root) } : null,
        img: img ? { overflowsRoot: img.getBoundingClientRect().right > limit(root) } : null,
        overflowing: [...document.querySelectorAll(`${root} *`)].filter((e) => e.getBoundingClientRect().right > limit(root) && ![...(function* () { for (let p = e; p && p.matches && !p.matches(root); p = p.parentElement) yield p; })()].some((a) => scrolls(a))).map((e) => e.tagName.toLowerCase()).slice(0, 6),
      };
    }
    return out;
  });
  const g = await geometry();
  await shot(page, 'preview-wide.png');
  console.log('  geometry:', JSON.stringify(g));
  check('wide content does not make the panel scroll sideways', g.sideways <= 1, `scrollWidth - clientWidth = ${g.sideways}`);
  for (const root of ['.op-preview', '.op-comment-body']) {
    const label = root === '.op-preview' ? 'description' : 'comment';
    check(`${label}: a wide table scrolls inside itself`, !!g[root].table && g[root].table.scrollsInside, JSON.stringify(g[root].table));
    check(`${label}: a long code line stays inside the panel`, !!g[root].pre && !g[root].pre.overflowsRoot, JSON.stringify(g[root].pre));
    check(`${label}: nothing else sticks out of the panel (images, URLs, inline code)`, g[root].overflowing.length === 0 && !(g[root].img?.overflowsRoot), JSON.stringify(g[root].overflowing));
  }

  await page.keyboard.press('Escape');

  const mtime16 = statSync(path.join(VAULT, 'Cards/OP-16.md')).mtimeMs;
  await page.dragAndDrop('[data-key="OP-4"]', '[data-key="OP-16"]', { targetPosition: { x: 100, y: 6 } });
  check('drag & drop moves the card', await inCol('OP-4', 'review'));
  check('…persisted as a single note change', await until(async () => /status: review/.test(note('Cards/OP-4.md'))) && statSync(path.join(VAULT, 'Cards/OP-16.md')).mtimeMs === mtime16);
  const order = await page.$$eval('.op-col[data-col="review"] .op-card', (els) => els.map((e) => e.dataset.key));
  check('…board and CLI agree on the column order', order.join() === 'OP-15,OP-4,OP-16' && cliJson('ls', '-s', 'review').map((c) => c.key).join() === order.join(), order.join());

  await page.click('.op-col[data-col="todo"] .op-add');
  await page.fill('.op-composer-input', 'Card created in the Obsidian composer');
  await page.press('.op-composer-input', 'Enter');
  await page.waitForTimeout(600);
  const mine = cliJson('ls', '--all').find((c) => c.title === 'Card created in the Obsidian composer');
  check('composer creates a valid card note via the real vault', !!mine && mine.status === 'todo' && note(`Cards/${mine.key}.md`).startsWith('---\nkey: '));
  await page.press('.op-composer-input', 'Escape');

  await page.click(`[data-key="${mine.key}"]`, { button: 'right' });
  await page.waitForSelector('.menu .menu-item');
  await page.locator('.menu .menu-item', { hasText: /Delete/ }).click();
  await clickInAnyWindow('.modal button.mod-warning');
  check('delete through the native menu + modal removes the card and its note', await until(async () => (await colOf(mine.key)) === null) && (await until(async () => !existsSync(path.join(VAULT, `Cards/${mine.key}.md`)))));

  // ---------- rename / open note / saved state ----------
  await page.evaluate(async () => {
    const { app } = window;
    await app.vault.createFolder('Cards/Arquivo').catch(() => {});
    await app.fileManager.renameFile(app.vault.getAbstractFileByPath('Cards/OP-7.md'), 'Cards/Arquivo/OP-7.md');
  });
  await page.waitForTimeout(500);
  check('renaming/moving a note keeps the card on the board', (await colOf('OP-7')) !== null);
  await page.click('[data-key="OP-7"]', { button: 'right' });
  await page.locator('.menu .menu-item', { hasText: /Priority: Highest/ }).click();
  check('…and later edits go to the moved note', await until(async () => note('Cards/Arquivo/OP-7.md').includes('priority: highest')));

  await page.dblclick('[data-key="OP-5"] .op-card-title');
  check('double-click opens the note beside the board, not over it', (await until(async () => page.evaluate(() => window.app.workspace.getLeavesOfType('markdown').some((l) => l.view.file?.path === 'Cards/OP-5.md')))) && (await page.locator('.op-root').count()) === 1);
  check('the note itself shows the comment as a callout in Obsidian', await until(async () => page.evaluate(() => !!document.querySelector('.workspace-leaf-content[data-type="markdown"] .callout[data-callout="comment"]'))));
  await page.fill('.op-search-input', 'login');
  check('filters are saved with the workspace layout', await until(async () => page.evaluate(() => window.app.workspace.getLeavesOfType('obsidian-projects-board')[0].view.getState().ui?.text === 'login')));
  await page.fill('.op-search-input', '');

  // ---------- commands ----------
  await page.evaluate(() => window.app.commands.executeCommandById('obsidian-projects:new-card'));
  check('"Create card" command opens the composer', await until(async () => page.isVisible('.op-composer-input')));
  await page.press('.op-composer-input', 'Escape');
  await page.evaluate(() => window.app.commands.executeCommandById('obsidian-projects:go-to-card'));
  await page.waitForSelector('.prompt-input');
  await page.fill('.prompt-input', 'OP-9');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  check('"Go to card…" finds a card by key and opens its note', await until(async () => page.evaluate(() => window.app.workspace.getLeavesOfType('markdown').some((l) => l.view.file?.path === 'Cards/OP-9.md'))));

  // ---------- plugin reload ----------
  await page.evaluate(async () => { await window.app.plugins.disablePlugin('obsidian-projects'); await window.app.plugins.enablePlugin('obsidian-projects'); });
  await page.evaluate(() => window.app.commands.executeCommandById('obsidian-projects:open-board'));
  check('disable → enable reloads cleanly (one board, cards back)', (await until(async () => (await page.locator('.op-card').count()) >= 20)) && (await page.evaluate(() => window.app.workspace.getLeavesOfType('obsidian-projects-board').length)) === 1);

  // ---------- settings (opens in its own window in this build) ----------
  await page.evaluate(() => { window.app.setting.open(); window.app.setting.openTabById('obsidian-projects'); });
  await page.waitForTimeout(1200);
  const popout = browser.contexts().flatMap((c) => c.pages()).find((p) => p !== page && p.url() === 'about:blank');
  const settings = popout ?? page;
  if (popout) await viewport(popout, 900, 900);
  await settings.waitForSelector('.op-setting-column');
  await shot(settings, 'settings.png');
  check('settings lists one row per column', (await settings.locator('.op-setting-column').count()) === 4);
  await settings.locator('button', { hasText: /Add column/ }).click();
  check('adding a column is saved to data.json and seen by the CLI', (await until(async () => dataJson().board.columns.length === 5)) && cliJson('config').columns.length === 5);
  check('…and the open board re-renders with 5 columns', await until(async () => (await page.locator('.op-col').count()) === 5));
  await settings.locator('.op-setting-column').last().locator('.extra-setting-button').last().click();
  check('removing it restores 4 columns', await until(async () => dataJson().board.columns.length === 4 && (await page.locator('.op-col').count()) === 4));
  const prefix = settings.locator('.setting-item', { hasText: /Project key/ }).locator('input');
  await prefix.fill('x'); await prefix.blur();
  await page.waitForTimeout(400);
  check('an invalid project key is rejected', dataJson().board.prefix === 'OP');
  await prefix.fill('web'); await prefix.blur();
  check('a valid key is upper-cased, saved, and used by the CLI', (await until(async () => dataJson().board.prefix === 'WEB')) && cliJson('add', 'Prefix test').key.startsWith('WEB-'));
  await page.evaluate(() => window.app.setting.close());

  // ---------- real light theme ----------
  await page.evaluate(() => window.app.changeTheme('moonstone'));
  await page.waitForTimeout(800);
  await page.click('[data-key="OP-11"] .op-card-title');
  await page.waitForTimeout(400);
  await shot(page, 'light-drawer.png');

  const errors = [...new Set(logs)];
  check('no console errors or warnings from the plugin', errors.length === 0, errors.join(' | '));
}

// If something goes wrong before/while the app boots, show what the app was displaying.
async function diagnose() {
  for (const p of browser?.contexts().flatMap((c) => c.pages()) ?? []) {
    const info = await p.evaluate(() => ({ title: document.title, app: typeof window.app, plugin: !!window.app?.plugins?.plugins?.['obsidian-projects'], modals: [...document.querySelectorAll('.modal-container')].map((m) => m.innerText.slice(0, 160)) })).catch(() => null);
    if (info) console.log('  window:', JSON.stringify(info));
  }
}

try {
  await main();
} catch (e) {
  fail++;
  console.log('FAIL  test run crashed:', String(e).split('\n')[0]);
  await diagnose();
} finally {
  await browser?.close().catch(() => {});
  killProfile();
  await new Promise((r) => setTimeout(r, 1500)); // let the app release its profile files
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
