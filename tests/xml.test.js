/**
 * XML 解析器测试。
 *
 * 覆盖真实 TTML 会遇到的输入形态，而非理想化 XML。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, decodeEntities } from '../src/core/xml.js';

test('decodeEntities：预定义实体与数字字符引用', () => {
  assert.equal(decodeEntities('a &amp; b'), 'a & b');
  assert.equal(decodeEntities('&lt;tag&gt;'), '<tag>');
  assert.equal(decodeEntities('&quot;q&quot; &apos;a&apos;'), '"q" \'a\'');
  assert.equal(decodeEntities('&#65;&#x42;&#x4e2d;'), 'AB中');
  assert.equal(decodeEntities('&nbsp;'), '\u00A0');
});

test('decodeEntities：非法与未知实体原样保留', () => {
  // 非法码位、代理区、未知实体名都不应被吞掉或产出替换字符
  assert.equal(decodeEntities('&#xD800;'), '&#xD800;');
  assert.equal(decodeEntities('&#999999999;'), '&#999999999;');
  assert.equal(decodeEntities('&unknownentity;'), '&unknownentity;');
  assert.equal(decodeEntities('plain & text'), 'plain & text');
});

test('parseXml：基本结构与属性', () => {
  const doc = parseXml('<tt xml:lang="ja"><body><p begin="1s">hi</p></body></tt>');
  const root = doc.documentElement;
  assert.equal(root.localName, 'tt');
  assert.equal(root.getAttribute('xml:lang'), 'ja');
  assert.equal(root.getElementsByTagName('p').length, 1);
  assert.equal(root.getElementsByTagName('p')[0].textContent, 'hi');
  assert.equal(doc.recovered, false);
});

test('parseXml：属性前缀兼容（带前缀与裸写互认）', () => {
  const doc = parseXml('<tt><p ttm:agent="v1" ttm:role="x-bg"/><p role="x-translation"/></tt>');
  const [a, b] = doc.getElementsByTagName('p');
  // 原名命中
  assert.equal(a.getAttribute('ttm:agent'), 'v1');
  // 去前缀命中
  assert.equal(a.getAttribute('agent'), 'v1');
  // 反向：裸写属性用带前缀名读取
  assert.equal(b.getAttribute('ttm:role'), 'x-translation');
  assert.equal(b.getAttribute('role'), 'x-translation');
  assert.equal(b.hasAttribute('ttm:role'), true);
  assert.equal(b.hasAttribute('nonexistent'), false);
});

test('parseXml：XML 声明、注释、DOCTYPE 不进文本内容', () => {
  const src = '<?xml version="1.0"?><!DOCTYPE tt [<!ENTITY x "y">]><!-- c --><tt><p>text</p></tt>';
  const doc = parseXml(src);
  assert.equal(doc.documentElement.textContent, 'text');
  assert.equal(doc.documentElement.getElementsByTagName('p')[0].textContent, 'text');
});

test('parseXml：CDATA 内容原样保留且不破坏标签扫描', () => {
  const src = '<tt><p><![CDATA[a <b> & "c"]]></p><p>after</p></tt>';
  const doc = parseXml(src);
  const [p1, p2] = doc.getElementsByTagName('p');
  assert.equal(p1.textContent, 'a <b> & "c"');
  // 关键：CDATA 内的 '<b>' 不能被当成元素
  assert.equal(p1.childElements().length, 0);
  assert.equal(p2.textContent, 'after');
});

test('parseXml：CDATA 未闭合时容错', () => {
  const doc = parseXml('<tt><p><![CDATA[unclosed');
  assert.equal(doc.documentElement.getElementsByTagName('p')[0].textContent, 'unclosed');
  assert.ok(doc.warnings.some((w) => w.includes('CDATA')));
});

test('parseXml：未闭合标签自动补全', () => {
  const doc = parseXml('<tt><body><p><span>a</span>');
  assert.equal(doc.recovered, true);
  assert.ok(doc.warnings.some((w) => w.includes('未闭合')));
  assert.equal(doc.getElementsByTagName('span')[0].textContent, 'a');
});

test('parseXml：游离闭合标签被忽略而非抛错', () => {
  const doc = parseXml('<tt><body></p><p>ok</p></div></body></tt>');
  assert.equal(doc.getElementsByTagName('p')[0].textContent, 'ok');
});

test('parseXml：自闭合标签', () => {
  const doc = parseXml('<tt><head><ttm:agent xml:id="v1"/></head><body/></tt>');
  const agents = doc.getElementsByTagName('agent');
  assert.equal(agents.length, 1);
  assert.equal(agents[0].getAttribute('xml:id'), 'v1');
  assert.equal(agents[0].localName, 'agent');
  assert.equal(agents[0].prefix, 'ttm');
});

test('parseXml：无值属性容错', () => {
  const doc = parseXml('<tt><p ttm:role>x</p></tt>');
  const p = doc.getElementsByTagName('p')[0];
  assert.equal(p.textContent, 'x');
  assert.equal(p.hasAttribute('ttm:role'), true);
  assert.equal(p.getAttribute('ttm:role'), '');
});

test('parseXml：single-quoted 属性', () => {
  const doc = parseXml("<tt><p begin='1.5s' end='2.5s'>q</p></tt>");
  const p = doc.getElementsByTagName('p')[0];
  assert.equal(p.getAttribute('begin'), '1.5s');
  assert.equal(p.getAttribute('end'), '2.5s');
});

test('parseXml：directText 只取直系文本，不含子元素文本', () => {
  const doc = parseXml('<tt><p>outer<span>inner</span>tail</p></tt>');
  const p = doc.getElementsByTagName('p')[0];
  assert.equal(p.directText, 'outertail');
  assert.equal(p.textContent, 'outerinnertail');
});

test('parseXml：parent 指针可上溯且不可枚举（不破坏 JSON 序列化）', () => {
  const doc = parseXml('<tt><body><div itunes:song-part="Verse"><p>x</p></div></body></tt>');
  const p = doc.getElementsByTagName('p')[0];
  assert.equal(p.parent.localName, 'div');
  assert.equal(p.parent.parent.localName, 'body');
  assert.equal(p.parent.parent.parent, doc.documentElement);
  assert.equal(doc.documentElement.parent, null);
  // parent 不可枚举 → 无循环引用
  assert.doesNotThrow(() => JSON.stringify(p));
  assert.equal(Object.keys(p).includes('parent'), false);
});

test('parseXml：空输入与纯垃圾输入不抛异常', () => {
  assert.doesNotThrow(() => parseXml(''));
  assert.doesNotThrow(() => parseXml(null));
  assert.doesNotThrow(() => parseXml(undefined));
  assert.doesNotThrow(() => parseXml('not xml at all'));
  assert.doesNotThrow(() => parseXml('<<<>>>'));
  assert.doesNotThrow(() => parseXml('<tt><p>未闭合'));

  const empty = parseXml('');
  assert.equal(empty.recovered, true);
  assert.equal(empty.documentElement.localName, 'tt');

  // 无标签的纯文本：不应崩溃，且不产生元素
  const noise = parseXml('just text');
  assert.equal(noise.getElementsByTagName('p').length, 0);
});

test('parseXml：getElementsByTagName 支持带前缀查询名', () => {
  const doc = parseXml('<tt><head><ttm:agent xml:id="v1"/></head><body><p>x</p></body></tt>');
  // 传 'ttm:agent' 也应命中 localName === 'agent' 的元素
  assert.equal(doc.getElementsByTagName('ttm:agent').length, 1);
  assert.equal(doc.getElementsByTagName('agent').length, 1);
  assert.equal(doc.getElementsByTagName('ttm:agent')[0].getAttribute('xml:id'), 'v1');
});

test('parseXml：深层嵌套与文档序', () => {
  const doc = parseXml('<tt><a><b><c>1</c></b><b><c>2</c></b></a></tt>');
  const cs = doc.getElementsByTagName('c');
  assert.deepEqual(cs.map((c) => c.textContent), ['1', '2']);
});

test('parseXml：UTF-8 中文与 emoji 内容', () => {
  const doc = parseXml('<tt><p>夜色渐浓 🌙</p></tt>');
  assert.equal(doc.getElementsByTagName('p')[0].textContent, '夜色渐浓 🌙');
});
