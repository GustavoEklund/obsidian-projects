import { describe, expect, it } from 'vitest';
import {
  BUDGETS,
  creditProblems,
  fakeObsidian,
  isNodeBuiltin,
  loadPlugin,
  packagesInMetafile,
  pluginRequireProblems,
  requiredModules,
  sizeProblems,
} from '../quality/bundle';

describe('sizeProblems', () => {
  const budgets = { 'a.js': 100, 'b.css': 50 };

  it('passes when every file is within its budget, boundaries included', () => {
    expect(sizeProblems({ 'a.js': 100, 'b.css': 1 }, budgets)).toEqual([]);
  });

  it('flags a file over budget with both numbers', () => {
    expect(sizeProblems({ 'a.js': 101, 'b.css': 1 }, budgets)).toEqual([
      'a.js: 101 bytes is over its budget of 100 bytes',
    ]);
  });

  it('flags a missing file and says how to fix it', () => {
    expect(sizeProblems({ 'a.js': 1 }, budgets)).toEqual(['b.css: missing (run `npm run build` first)']);
  });

  it('has a budget for each shipped file', () => {
    expect(Object.keys(BUDGETS).sort()).toEqual([
      'packages/cli/dist/oprojects.cjs',
      'packages/plugin/dist/main.js',
      'packages/plugin/dist/styles.css',
    ]);
  });
});

describe('requiredModules / pluginRequireProblems', () => {
  it('lists each required module once, with either quote style', () => {
    expect(requiredModules(`var a=require("obsidian");var b=require('yaml');var c = require( "obsidian" );`)).toEqual([
      'obsidian',
      'yaml',
    ]);
  });

  it('ignores identifiers that merely end in "require"', () => {
    expect(requiredModules('prerequire("fs"); myrequire("fs"); const requireX = 1;')).toEqual([]);
  });

  it('counts a member call such as module.require("x") too, to be on the safe side', () => {
    expect(requiredModules('module.require("x")')).toEqual(['x']);
  });

  it('accepts a plugin that only requires obsidian', () => {
    expect(pluginRequireProblems('var o=require("obsidian");')).toEqual([]);
  });

  it('rejects Node modules, which do not exist on mobile', () => {
    for (const name of ['fs', 'node:path', 'child_process', 'fs/promises', 'os']) {
      const [problem] = pluginRequireProblems(`require("${name}")`);
      expect(problem, name).toContain('a Node module, which does not exist on mobile');
    }
  });

  it('rejects any other module the app does not provide', () => {
    expect(pluginRequireProblems('require("left-pad")')).toEqual([
      'main.js requires "left-pad", which the app does not provide',
    ]);
  });
});

describe('isNodeBuiltin', () => {
  it('recognises Node modules with and without the node: prefix and subpaths', () => {
    for (const name of ['fs', 'node:fs', 'fs/promises', 'path', 'node:test', 'child_process'])
      expect(isNodeBuiltin(name), name).toBe(true);
  });

  it('does not mistake packages for Node modules', () => {
    for (const name of ['obsidian', 'yaml', '@codemirror/view', 'fs-extra'])
      expect(isNodeBuiltin(name), name).toBe(false);
  });
});

describe('packagesInMetafile', () => {
  it('names the packages under node_modules, scoped ones included, once each', () => {
    const inputs = {
      'packages/core/src/index.ts': {},
      'node_modules/yaml/dist/index.js': {},
      'node_modules/yaml/dist/parse.js': {},
      'node_modules/@scope/pkg/lib/a.js': {},
      'node_modules/a/node_modules/b/index.js': {},
    };
    expect(packagesInMetafile(inputs)).toEqual(['@scope/pkg', 'a', 'yaml']);
  });

  it('is empty when nothing third-party was bundled', () => {
    expect(packagesInMetafile({ 'packages/core/src/index.ts': {} })).toEqual([]);
  });
});

describe('creditProblems', () => {
  const pkg = { name: 'yaml', version: '2.9.1', license: 'ISC' };
  const banner =
    '/*!\n * Obsidian Projects\n * This bundle includes yaml 2.9.1 (ISC):\n */\nvar x = 1; // yaml 2.9.1 (ISC)';

  it('passes when the banner credits the package with its version and license', () => {
    expect(creditProblems('main.js', banner, [pkg])).toEqual([]);
  });

  it('flags a package that is bundled but not credited, or credited at another version', () => {
    expect(creditProblems('main.js', banner, [{ name: 'left-pad', version: '1.0.0', license: 'MIT' }])[0]).toContain(
      'bundles left-pad 1.0.0 (MIT)',
    );
    expect(creditProblems('main.js', banner, [{ ...pkg, version: '2.0.0' }])).toHaveLength(1);
  });

  it('only looks at the banner, not at the code below it', () => {
    expect(creditProblems('main.js', '/*! nothing */\nvar yaml = "yaml 2.9.1 (ISC)";', [pkg])).toHaveLength(1);
  });
});

describe('loadPlugin / fakeObsidian', () => {
  it('lets a bundle extend the classes of the obsidian module and returns its exports', () => {
    const source = `"use strict"; var o = require("obsidian"); class P extends o.Plugin {} class V extends o.ItemView {} module.exports = { default: P, V };`;
    const exports = loadPlugin(source);
    expect(typeof exports.default).toBe('function');
  });

  it('gives the same class for the same name, and a different one for another name', () => {
    const o = fakeObsidian();
    expect(o.Plugin).toBe(o.Plugin);
    expect(o.Plugin).not.toBe(o.Modal);
    expect(o.__esModule).toBeUndefined();
  });

  it('rejects a bundle that requires anything else', () => {
    expect(() => loadPlugin('require("fs")')).toThrow('unexpected require("fs")');
  });

  it('surfaces errors thrown while the bundle loads', () => {
    expect(() => loadPlugin('throw new Error("boom")')).toThrow('boom');
  });
});
