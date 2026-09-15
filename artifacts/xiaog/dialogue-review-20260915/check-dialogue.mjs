import fs from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const review = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(review, '../design-delivery-20260915');
const require = createRequire(path.resolve(review, '../../../web/package.json'));
const {JSDOM} = require('jsdom');
const base = 'http://127.0.0.1:18405';
const route = '/prototype.html?static=1#/analysis?projectId=18cb3488-119b-4d8d-958f-e20a0a70d0ae&layerId=76375d7a-74cf-4c2b-b0e0-d724afaec1d9';
const dom = new JSDOM(await fs.readFile(path.join(root, 'prototype.html'), 'utf8'), {url:base+route,runScripts:'outside-only',pretendToBeVisual:true});
const w = dom.window;
w.fetch = (url, options) => fetch(new URL(url, w.location.href), options);
w.matchMedia = () => ({matches:true,addEventListener(){},removeEventListener(){}});
w.scrollTo = () => {};
w.Element.prototype.animate = () => ({cancel(){}});
const context = dom.getInternalVMContext();
const modules = new Map();
async function load(file) {
  if (modules.has(file)) return modules.get(file);
  const m = new vm.SourceTextModule(await fs.readFile(file, 'utf8'), {context,identifier:file});
  modules.set(file,m);
  await m.link((specifier,parent) => load(path.resolve(path.dirname(parent.identifier),specifier)));
  return m;
}
await (await load(path.join(root,'app.mjs'))).evaluate();
const text = () => w.document.querySelector('#dialogue-text').textContent;
const click = selector => {
  const el = w.document.querySelector(selector);
  assert(el, selector);
  el.click();
};
const checks = [];
const methods = [
  ['buffer', /缓冲距离.*米/],
  ['clip', /输入图层.*掩膜图层/],
  ['intersection', /两层数据.*重叠/],
  ['dissolve', /字段.*融合全部/],
  ['spatial-join', /目标图层.*关联图层.*匹配属性/],
  ['validate-repair', /修复无效几何/],
  ['point-in-polygon', /点图层.*多边形图层.*每个面/],
];
const originalLayer = w.document.querySelector('#analysis-layer').value;
for (const [id, pattern] of methods) {
  click(`[data-tool="${id}"]`);
  assert.match(text(), pattern);
  assert.equal(w.document.querySelector(`[data-tool="${id}"]`).getAttribute('aria-pressed'),'true');
  assert.equal(w.document.querySelector('#analysis-layer').value, originalLayer);
  if (id !== 'buffer') assert(!text().includes('缓冲距离'));
  checks.push({name:id,pass:true,dialogue:text()});
}
const last = text();
click('#return-home');
assert.match(text(), /你好/);
click('[data-feature="analysis"]');
assert.equal(text(), last);
assert.equal(w.D01.state.mode, 'preview');
click('#expand');
assert.equal(text(), last);
assert.equal(w.D01.state.mode, 'work');
checks.push({name:'return-preview-expand-keeps-current-method',pass:true});
click('[data-feature="tasks"]');
assert.match(text(), /任务走到哪一步/);
click('[data-feature="analysis"]');
assert.equal(text(),last);
checks.push({name:'other-feature-dialogue-and-return',pass:true});
const report={version:'D01-R1.1',method:'jsdom DOM integration using actual app.mjs and map.mjs; static/reduced-motion path; not a real browser or WebGL test',passed:checks.length,failed:0,checks,createdAt:new Date().toISOString()};
await fs.writeFile(path.join(review,'dialogue-verification.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
w.close();
