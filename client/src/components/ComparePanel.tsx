import { useMemo, useState } from 'react';
import { api } from '../api';
import type { CompareClause, CompareItem, CompareResult, CompareStatus } from '../types';

// 版本对照面板（只读）：
//   - 旧稿 = 已保存的工作台文档内容，新稿在下方文本框粘贴（不入库、不改文档）；
//   - 后端按标题边界拆分、去编号规范空白后先按唯一内容跨编号配对，再配同号；
//   - 结果状态：未变 / 仅改号 / 内容修改 / 新增 / 删除 / 待确认；
//   - 重复内容或重复同号产生多候选时列为“待确认”，系统不擅自归类。

export interface ComparePanelProps {
  docId: number;
  loading: boolean;
  setLoading: (v: boolean) => void;
  onError: (message: string) => void;
}

const STATUS_META: {
  key: CompareStatus | 'all';
  label: string;
  badge: string;
}[] = [
  { key: 'all', label: '全部', badge: '' },
  { key: 'added', label: '新增', badge: 'cmp-added' },
  { key: 'deleted', label: '删除', badge: 'cmp-deleted' },
  { key: 'modified', label: '内容修改', badge: 'cmp-modified' },
  { key: 'renumbered', label: '仅改号', badge: 'cmp-renumbered' },
  { key: 'same', label: '未变', badge: 'cmp-same' },
  { key: 'ambiguous', label: '待确认', badge: 'cmp-ambiguous' },
];

const STATUS_LABEL: Record<CompareStatus, string> = {
  same: '未变',
  renumbered: '仅改号',
  modified: '内容修改',
  added: '新增',
  deleted: '删除',
  ambiguous: '待确认',
};

function ClauseView({ c, side }: { c: CompareClause; side: 'old' | 'new' }) {
  return (
    <div className={`cmp-side cmp-${side}`}>
      <div className="cmp-side-head">
        <span className="num">第{c.number}条</span>
        <span className="muted small">第 {c.headingLine} 行</span>
      </div>
      <div className="cmp-title">{c.title || <span className="muted">（无标题文字）</span>}</div>
      <details>
        <summary>原文片段</summary>
        <pre className="cmp-block">{c.block}</pre>
      </details>
    </div>
  );
}

function CandidateList({ list, side }: { list: CompareClause[]; side: 'old' | 'new' }) {
  return (
    <div className={`cmp-side cmp-${side}`}>
      <div className="cmp-side-head muted small">
        {side === 'old' ? '旧稿' : '新稿'}候选（{list.length}）
      </div>
      <ul className="cmp-cand-list">
        {list.map((c) => (
          <li key={`${side}-${c.index}`}>
            <span className="num">第{c.number}条</span>
            <span className="muted small">第 {c.headingLine} 行</span>
            <span className="ellipsis inline">{c.title || '（无标题文字）'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function ComparePanel({ docId, loading, setLoading, onError }: ComparePanelProps) {
  const [newDraft, setNewDraft] = useState('');
  const [result, setResult] = useState<CompareResult | null>(null);
  const [filter, setFilter] = useState<CompareStatus | 'all'>('all');

  const runCompare = async () => {
    if (!newDraft.trim()) {
      onError('请先粘贴新稿文本。');
      return;
    }
    setLoading(true);
    try {
      const { comparison } = await api.compare(docId, newDraft);
      setResult(comparison);
      setFilter('all');
    } catch (e) {
      onError((e as { message: string }).message);
    } finally {
      setLoading(false);
    }
  };

  const filtered = useMemo(
    () => (result && filter === 'all' ? result.items : result?.items.filter((i) => i.status === filter) ?? []),
    [result, filter],
  );

  return (
    <section className="card">
      <h3>版本对照：旧稿（当前已保存文本）↔ 新稿（粘贴）</h3>
      <p className="muted small">
        按现有“第X条”标题边界拆分条款，先去掉标题编号并规范空白，以<strong>内容唯一</strong>匹配跨编号条款，
        再对剩余的唯一同号条款配对；重复内容形成多候选时列为<strong>待确认</strong>，不擅自归类。
        对照全程<strong>只读</strong>：不修改文档、不产生或撤销任何历史记录，新稿仅用于本次对照。
      </p>

      <textarea
        className="contract-input"
        value={newDraft}
        onChange={(e) => setNewDraft(e.target.value)}
        placeholder={'在此粘贴新稿合同文本……\n不会保存，仅用于与已保存的旧稿逐条对照。'}
        rows={10}
      />
      <div className="row-actions">
        <button type="button" className="btn btn-primary" onClick={runCompare} disabled={loading}>
          {loading ? '对照中…' : '生成版本对照'}
        </button>
        {result && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setResult(null);
              setNewDraft('');
            }}
          >
            清空新稿与结果
          </button>
        )}
        {result && (
          <span className="muted small">
            旧稿 {result.oldClauseCount} 条 · 新稿 {result.newClauseCount} 条
          </span>
        )}
      </div>

      {result && (
        <>
          {result.warnings.length > 0 && (
            <div className="issue issue-missing cmp-warn">
              {result.warnings.map((w, i) => (
                <div key={i}>⚠️ {w}</div>
              ))}
            </div>
          )}

          <div className="cmp-filters">
            {STATUS_META.map((m) => {
              const n = m.key === 'all' ? result.items.length : result.counts[m.key];
              return (
                <button
                  key={m.key}
                  type="button"
                  className={`btn cmp-filter ${filter === m.key ? 'cmp-filter-on' : ''}`}
                  onClick={() => setFilter(m.key)}
                >
                  {m.label}
                  <span className="cmp-count">{n}</span>
                </button>
              );
            })}
          </div>

          {filtered.length === 0 ? (
            <p className="muted small">当前筛选下没有条款。</p>
          ) : (
            <ul className="cmp-list">
              {filtered.map((item, i) => (
                <CompareRow key={i} item={item} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function CompareRow({ item }: { item: CompareItem }) {
  if (item.status === 'ambiguous') {
    return (
      <li className="cmp-row cmp-row-ambiguous">
        <div className="cmp-row-top">
          <span className={`kind cmp-badge cmp-ambiguous`}>{STATUS_LABEL.ambiguous}</span>
          <span className="muted small">{item.reasonMessage}</span>
        </div>
        <div className="cmp-pair">
          <CandidateList list={item.oldCandidates ?? []} side="old" />
          <CandidateList list={item.newCandidates ?? []} side="new" />
        </div>
      </li>
    );
  }

  const oldNum = item.old ? `第${item.old.number}条` : '—';
  const newNum = item.new ? `第${item.new.number}条` : '—';

  return (
    <li className={`cmp-row cmp-row-${item.status}`}>
      <div className="cmp-row-top">
        <span className={`kind cmp-badge cmp-${item.status}`}>{STATUS_LABEL[item.status]}</span>
        <span className="cmp-nums">
          <span className="num">旧 {oldNum}</span>
          {item.status === 'renumbered' && <span className="arrow">→</span>}
          <span className="num">新 {newNum}</span>
        </span>
        {item.status === 'renumbered' && (
          <span className="muted small">两版内容一致，仅编号不同</span>
        )}
      </div>
      <div className="cmp-pair">
        {item.old ? <ClauseView c={item.old} side="old" /> : <div className="cmp-side cmp-empty">旧稿无此条款</div>}
        {item.new ? <ClauseView c={item.new} side="new" /> : <div className="cmp-side cmp-empty">新稿已无此条款</div>}
      </div>
    </li>
  );
}
