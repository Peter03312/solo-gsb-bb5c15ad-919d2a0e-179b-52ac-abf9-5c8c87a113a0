// 版本对照引擎自检（不依赖测试框架）：
// 覆盖标题边界拆分、空白规范、去标题编号、跨编号唯一内容配对（仅改号）、
// 同号内容修改、新增/删除、重复内容多候选与重复同号多候选一律待确认、
// 中文编号归一，以及 API 只读（不改文档/不动撤销历史由 index 层保证）。

import assert from 'node:assert';
import { compareVersions, normalizeWhitespace, splitClauses } from '../src/compare';

let passed = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    console.error(`  ❌ ${name}`);
    throw e;
  }
};

const by = (result: ReturnType<typeof compareVersions>, status: string) =>
  result.items.filter((i) => i.status === status);

console.log('split:');
check('按标题边界拆分并取编号/标题文字/区块', () => {
  const text = ['序言部分', '', '第一条 总则', '甲方与乙方。', '', '第二条 标的', '标的内容。'].join(
    '\n',
  );
  const cs = splitClauses(text);
  assert.equal(cs.length, 2);
  assert.equal(cs[0].number, 1);
  assert.equal(cs[0].title, '总则');
  assert.equal(cs[0].heading, '第一条 总则');
  assert.equal(cs[0].block, '总则\n甲方与乙方。');
  assert.equal(cs[0].index, 1);
  assert.equal(cs[1].number, 2);
  assert.equal(cs[1].headingLine, 6);
});

check('中文编号标题也能拆分；标点分隔符随编号一起去掉', () => {
  const cs = splitClauses('第三条：费用\n费用如下。');
  assert.equal(cs.length, 1);
  assert.equal(cs[0].number, 3);
  assert.equal(cs[0].title, '费用');
});

check('normalizeWhitespace：CRLF/全角空格/行首尾/连续空行', () => {
  const s = '　第一条　总则　\n\n\n\n\t正文\t行  \r\n\r\n 段二\r\n';
  assert.equal(normalizeWhitespace(s), '第一条 总则\n正文 行\n段二');
});

console.log('compare:');
const oldText = [
  '第一条 总则',
  '本合同依法订立。',
  '',
  '第二条 标的',
  '标的为设备一套。',
  '',
  '第三条 履行',
  '乙方应按时交付。',
].join('\n');

check('同号同内容 => same', () => {
  // 仅空白差异（全角空格 + 多余空行）不应改变内容指纹
  const next = oldText.replace('第一条 总则', '第一条　总则') + '\n\n\n';
  const r = compareVersions(oldText, next);
  assert.equal(by(r, 'same').length, 3);
  assert.equal(r.counts.same, 3);
});

check('内容一致仅编号变化 => renumbered，列出两版编号', () => {
  const next = oldText
    .replace('第三条 履行', '第四条 履行')
    .replace('乙方应按时交付。', '乙方应按时交付。');
  const r = compareVersions(oldText, next);
  const ren = by(r, 'renumbered');
  assert.equal(ren.length, 1);
  assert.equal(ren[0].old!.number, 3);
  assert.equal(ren[0].new!.number, 4);
  assert.equal(ren[0].old!.block, ren[0].new!.block);
});

check('同号内容不同 => modified；原文片段随结果返回', () => {
  const next = oldText.replace('乙方应按时交付。', '乙方应于十日内交付。');
  const r = compareVersions(oldText, next);
  const mod = by(r, 'modified');
  assert.equal(mod.length, 1);
  assert.equal(mod[0].old!.number, 3);
  assert.equal(mod[0].new!.number, 3);
  assert.ok(mod[0].old!.snippet.includes('按时'));
  assert.ok(mod[0].new!.snippet.includes('十日'));
});

check('新稿追加条款 => added；旧稿删除条款 => deleted', () => {
  const added = `${oldText}\n\n第四条 验收\n甲方组织验收。`;
  let r = compareVersions(oldText, added);
  assert.equal(by(r, 'added').length, 1);
  assert.equal(by(r, 'added')[0].new!.number, 4);
  assert.equal(by(r, 'deleted').length, 0);

  const removed = oldText.split('\n').slice(0, 5).join('\n'); // 去掉第三条区块
  r = compareVersions(oldText, removed);
  assert.equal(by(r, 'deleted').length, 1);
  assert.equal(by(r, 'deleted')[0].old!.number, 3);
  assert.equal(by(r, 'added').length, 0);
});

check('跨编号插入导致整体顺移：旧1->新2 等按内容唯一配对为仅改号', () => {
  // 新稿在开头插入一条全新条款，旧三条编号各 +1（标题文字与正文不变）
  const next = [
    '第一条 鉴于',
    '双方合作背景如下。',
    '',
    '第二条 总则',
    '本合同依法订立。',
    '',
    '第三条 标的',
    '标的为设备一套。',
    '',
    '第四条 履行',
    '乙方应按时交付。',
  ].join('\n');
  const r = compareVersions(oldText, next);
  const ren = by(r, 'renumbered');
  assert.equal(ren.length, 3);
  const m = new Map(ren.map((i) => [i.old!.number, i.new!.number]));
  assert.deepEqual(m.get(1), 2);
  assert.deepEqual(m.get(2), 3);
  assert.deepEqual(m.get(3), 4);
  assert.equal(by(r, 'added').length, 1);
  assert.equal(by(r, 'added')[0].new!.title, '鉴于');
});

check('重复内容多候选 => ambiguous(duplicate-content)，不擅自归类', () => {
  // 新稿把旧稿第1条（去编号后内容完全一致）复制成两条
  const dup = [
    '第一条 总则',
    '本合同依法订立。',
    '',
    '第二条 总则',
    '本合同依法订立。',
  ].join('\n');
  const r = compareVersions(oldText, dup);
  const amb = by(r, 'ambiguous');
  assert.ok(amb.length >= 1);
  const contentAmb = amb.find((i) => i.reason === 'duplicate-content');
  assert.ok(contentAmb, '应存在重复内容待确认项');
  assert.equal(contentAmb!.oldCandidates!.length, 1);
  assert.equal(contentAmb!.newCandidates!.length, 2);
  // 候选条款不能再出现在 added/deleted 中
  const newNums = by(r, 'added').map((i) => i.new!.number);
  assert.ok(!newNums.includes(1));
  assert.ok(!newNums.includes(2));
});

check('重复同号多候选 => ambiguous(duplicate-number)，并有告警', () => {
  const o = [
    '第一条 甲',
    '内容甲。',
    '',
    '第二条 乙',
    '内容乙。',
  ].join('\n');
  const n = [
    '第一条 甲改',
    '内容甲变了。',
    '',
    '第一条 甲又一处',
    '内容甲另一个版本。',
    '',
    '第二条 乙',
    '内容乙。',
  ].join('\n');
  const r = compareVersions(o, n);
  const amb = by(r, 'ambiguous').find((i) => i.reason === 'duplicate-number');
  assert.ok(amb, '同号 1 对 2 应待确认');
  assert.equal(amb!.oldCandidates!.length, 1);
  assert.equal(amb!.newCandidates!.length, 2);
  assert.ok(r.warnings.some((w) => w.includes('新稿中第1条出现 2 次')));
});

check('旧稿无标题时给出告警且全部新稿为 added', () => {
  const r = compareVersions('没有任何条款标题的文本。', oldText);
  assert.ok(r.warnings.some((w) => w.includes('旧稿未识别到')));
  assert.equal(by(r, 'added').length, 3);
  assert.equal(by(r, 'deleted').length, 0);
});

check('结果按文档顺序稳定排列', () => {
  const next = oldText.replace('第三条 履行', '第四条 履行');
  const r = compareVersions(oldText, next);
  const orders = r.items.map((i) =>
    Math.min(
      i.old ? i.old.index * 2 : Infinity,
      i.new ? i.new.index * 2 + 1 : Infinity,
    ),
  );
  const sorted = [...orders].sort((a, b) => a - b);
  assert.deepEqual(orders, sorted);
});

console.log(`\ncompare tests passed: ${passed}`);
