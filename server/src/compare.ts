// 版本对照引擎（只读）。
//
// 以已保存合同为“旧稿”、粘贴文本为“新稿”，复用 parser 的标题识别能力按标题边界
// 拆分条款，随后：
//   1) 去掉标题编号（“第X条”及其后分隔标点）并规范空白，得到条款内容指纹；
//   2) 内容指纹在两稿中均【唯一】出现时跨编号配对（编号不同 => 仅改号）；
//   3) 剩余条款按同号配对（内容不同 => 内容修改）；
//   4) 重复内容/重复同号产生多候选时一律列为“待确认”，绝不擅自归类；
//   5) 仍未配对的旧稿条款 => 删除，新稿条款 => 新增。
//
// 本模块纯计算、不落库；首个标题之前的“序言”不参与对照。

import { analyzeText, type ClauseOccurrence, type TextPos } from './parser';

// ---------- 文本规范化 ----------

/**
 * 规范空白：CRLF 归一 -> 连续空格/制表/全角空格压缩为一个 ->
 * 去掉每行首尾空白 -> 连续空行收敛为一个换行 -> 整体 trim。
 * 不改动任何标点与文字。
 */
export function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t　]+/g, ' ')
    .replace(/^[ \t　]+|[ \t　]+$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** 去掉标题行开头的“第X条”编号及其后分隔标点/空白，保留标题文字。 */
function stripHeadingNumber(heading: string, occ: ClauseOccurrence): string {
  let rest = heading.startsWith(occ.text) ? heading.slice(occ.text.length) : heading;
  rest = rest.replace(/^[\s:：.。、，,；;（(【[）\-—_]+/, '');
  return rest;
}

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

function makeSnippet(block: string): string {
  const oneLine = block.replace(/\n+/g, ' ');
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}…` : oneLine;
}

// ---------- 条款拆分 ----------

export interface CompareClause {
  /** 标题编号（解析出的数值，阿拉伯/中文均已归一） */
  number: number;
  /** 在本稿中的文档顺序序号（1-based） */
  index: number;
  /** 标题行号 */
  headingLine: number;
  /** 标题行原文（去前导空白，仅规范空白） */
  heading: string;
  /** 去掉编号与分隔符、规范空白后的标题文字 */
  title: string;
  /** 规范空白后的完整区块文本（标题去编号 + 正文），即内容指纹 */
  block: string;
  /** 单行原文片段，用于列表展示 */
  snippet: string;
  /** 标题 token 位置 */
  pos: TextPos;
}

interface RawClause extends CompareClause {
  key: string;
}

/**
 * 按现有标题边界（行首“第X条”）拆分条款。
 * 与 removal.buildGraph 的区别：保留重复编号的每一处标题，不做去重。
 */
export function splitClauses(text: string): RawClause[] {
  const { occurrences } = analyzeText(text);
  const lineStarts = lineStartsOf(text);
  const heads = occurrences
    .filter((o) => o.kind === 'definition')
    .sort((a, b) => a.start - b.start);

  return heads.map((occ, i) => {
    const lineStart = lineStarts[occ.pos.line - 1];
    const nl = text.indexOf('\n', occ.start);
    const lineEnd = nl === -1 ? text.length : nl;
    const blockEnd =
      i + 1 < heads.length ? lineStarts[heads[i + 1].pos.line - 1] : text.length;

    const headingRaw = text
      .slice(lineStart, lineEnd)
      .replace(/^[ \t　]+/, '');
    const heading = normalizeWhitespace(headingRaw);
    const title = normalizeWhitespace(stripHeadingNumber(headingRaw, occ));
    const body = text.slice(lineEnd + 1, blockEnd);
    const block = normalizeWhitespace(body.trim() ? `${title}\n${body}` : title);

    return {
      number: occ.number,
      index: i + 1,
      headingLine: occ.pos.line,
      heading,
      title,
      block,
      key: block,
      snippet: makeSnippet(block),
      pos: occ.pos,
    };
  });
}

// ---------- 对照结果 ----------

export type CompareStatus =
  | 'same' // 编号与内容均未变
  | 'renumbered' // 内容一致，仅编号变化
  | 'modified' // 编号相同，内容变化
  | 'added' // 新稿新增
  | 'deleted' // 旧稿删除
  | 'ambiguous'; // 多候选，待人工确认

export type AmbiguousReason = 'duplicate-content' | 'duplicate-number';

export interface CompareItemDTO {
  status: CompareStatus;
  /** 配对/新增/删除时的旧稿条款（新增为 null） */
  old: CompareClause | null;
  /** 配对/新增/删除时的新稿条款（删除为 null） */
  new: CompareClause | null;
  /** 待确认：旧稿全部候选 */
  oldCandidates?: CompareClause[];
  /** 待确认：新稿全部候选 */
  newCandidates?: CompareClause[];
  /** 待确认原因 */
  reason?: AmbiguousReason;
  reasonMessage?: string;
}

export interface CompareResult {
  oldClauseCount: number;
  newClauseCount: number;
  counts: Record<CompareStatus, number>;
  items: CompareItemDTO[];
  /** 不阻止对照的提示（如某侧无标题、存在重复编号） */
  warnings: string[];
}

function bucketBy<T>(list: T[], keyOf: (x: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of list) {
    const k = keyOf(item);
    const arr = map.get(k);
    if (arr) arr.push(item);
    else map.set(k, [item]);
  }
  return map;
}

/**
 * 两稿条款对照。纯函数、无副作用。
 */
export function compareVersions(oldText: string, newText: string): CompareResult {
  const oldAll = splitClauses(oldText);
  const newAll = splitClauses(newText);
  const warnings: string[] = [];

  if (oldAll.length === 0) warnings.push('旧稿未识别到任何“第X条”标题，无法拆出条款。');
  if (newAll.length === 0) warnings.push('新稿未识别到任何“第X条”标题，无法拆出条款。');

  const dupWarn = (label: string, clauses: RawClause[]) => {
    const byNum = bucketBy(clauses, (c) => String(c.number));
    for (const [num, list] of byNum) {
      if (list.length > 1) {
        warnings.push(
          `${label}中第${num}条出现 ${list.length} 次标题定义（第 ${list
            .map((c) => c.headingLine)
            .join('、')} 行），同号条款无法唯一配对时将列为待确认。`,
        );
      }
    }
  };
  dupWarn('旧稿', oldAll);
  dupWarn('新稿', newAll);

  const items: (CompareItemDTO & { order: number })[] = [];
  const usedOld = new Set<number>(); // index 集合
  const usedNew = new Set<number>();

  const orderOf = (o: RawClause[] | null, n: RawClause[] | null) => {
    const a = o && o.length ? Math.min(...o.map((c) => c.index)) * 2 : Infinity;
    const b = n && n.length ? Math.min(...n.map((c) => c.index)) * 2 + 1 : Infinity;
    return Math.min(a, b);
  };

  // ---- 第一步：内容指纹唯一匹配（跨编号） ----
  const oldByKey = bucketBy(oldAll.filter((c) => c.key !== ''), (c) => c.key);
  const newByKey = bucketBy(newAll.filter((c) => c.key !== ''), (c) => c.key);

  for (const [key, oldGroup] of oldByKey) {
    const newGroup = newByKey.get(key);
    if (!newGroup) continue;
    for (const c of oldGroup) usedOld.add(c.index);
    for (const c of newGroup) usedNew.add(c.index);
    if (oldGroup.length === 1 && newGroup.length === 1) {
      const o = oldGroup[0];
      const n = newGroup[0];
      items.push({
        status: o.number === n.number ? 'same' : 'renumbered',
        old: o,
        new: n,
        order: orderOf([o], [n]),
      });
    } else {
      items.push({
        status: 'ambiguous',
        old: null,
        new: null,
        oldCandidates: oldGroup,
        newCandidates: newGroup,
        reason: 'duplicate-content',
        reasonMessage: `相同内容在旧稿出现 ${oldGroup.length} 处、新稿出现 ${newGroup.length} 处，存在多个候选，无法唯一配对，请人工确认。`,
        order: orderOf(oldGroup, newGroup),
      });
    }
  }

  // ---- 第二步：剩余条款按同号配对 ----
  const leftOld = oldAll.filter((c) => !usedOld.has(c.index));
  const leftNew = newAll.filter((c) => !usedNew.has(c.index));
  const oldByNum = bucketBy(leftOld, (c) => String(c.number));
  const newByNum = bucketBy(leftNew, (c) => String(c.number));
  const allNumbers = new Set([...oldByNum.keys(), ...newByNum.keys()]);

  for (const numStr of allNumbers) {
    const og = oldByNum.get(numStr) ?? [];
    const ng = newByNum.get(numStr) ?? [];
    if (og.length === 1 && ng.length === 1) {
      // 能走到这里且内容指纹不同（或为空），即“同号内容修改”
      const o = og[0];
      const n = ng[0];
      usedOld.add(o.index);
      usedNew.add(n.index);
      items.push({ status: 'modified', old: o, new: n, order: orderOf([o], [n]) });
    } else if (og.length > 0 && ng.length > 0 && (og.length > 1 || ng.length > 1)) {
      for (const c of og) usedOld.add(c.index);
      for (const c of ng) usedNew.add(c.index);
      items.push({
        status: 'ambiguous',
        old: null,
        new: null,
        oldCandidates: og,
        newCandidates: ng,
        reason: 'duplicate-number',
        reasonMessage: `第${numStr}条在剩余条款中于旧稿有 ${og.length} 处、新稿有 ${ng.length} 处候选，无法确定同号配对关系，请人工确认。`,
        order: orderOf(og, ng),
      });
    }
  }

  // ---- 第三步：仍未配对 => 删除 / 新增 ----
  for (const o of oldAll) {
    if (usedOld.has(o.index)) continue;
    usedOld.add(o.index);
    items.push({ status: 'deleted', old: o, new: null, order: orderOf([o], null) });
  }
  for (const n of newAll) {
    if (usedNew.has(n.index)) continue;
    usedNew.add(n.index);
    items.push({ status: 'added', old: null, new: n, order: orderOf(null, [n]) });
  }

  items.sort((a, b) => a.order - b.order);

  const counts: Record<CompareStatus, number> = {
    same: 0,
    renumbered: 0,
    modified: 0,
    added: 0,
    deleted: 0,
    ambiguous: 0,
  };
  for (const it of items) counts[it.status]++;

  return {
    oldClauseCount: oldAll.length,
    newClauseCount: newAll.length,
    counts,
    items,
    warnings,
  };
}
