import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type SearchHit } from '../lib/api';
import { useStore } from '../lib/store';
import Icon from './Icon';

type SortMode = 'relevance' | 'name-asc' | 'name-desc' | 'path-asc';

const SORT_LABELS: Record<SortMode, string> = {
  relevance: 'Relevance',
  'name-asc': 'File name (A to Z)',
  'name-desc': 'File name (Z to A)',
  'path-asc': 'Path (A to Z)',
};

/** Strip query operators (tag:, path:, file:…) so match-case tests only free text. */
function freeTerms(q: string): string[] {
  return q
    .replace(/\b\w+:("[^"]*"|\S+)/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

export default function SearchPanel() {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [matchCase, setMatchCase] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [moreContext, setMoreContext] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [sort, setSort] = useState<SortMode>('relevance');
  const [sortOpen, setSortOpen] = useState(false);
  const openFile = useStore((s) => s.openFile);
  const searchQuery = useStore((s) => s.searchQuery);
  const timer = useRef<number>();

  // adopt a query pushed from elsewhere (e.g. clicking a tag node in the graph)
  useEffect(() => {
    if (searchQuery) setQ(searchQuery);
  }, [searchQuery]);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!q.trim()) {
      setHits([]);
      return;
    }
    timer.current = window.setTimeout(async () => {
      try {
        const r = await api.search(q, 100);
        setHits(r.hits);
      } catch {
        setHits([]);
      }
    }, 180);
    return () => window.clearTimeout(timer.current);
  }, [q]);

  // Apply client-side filters (match case) + sort.
  const shown = useMemo(() => {
    let list = hits;
    if (matchCase) {
      const terms = freeTerms(q);
      if (terms.length) {
        list = list.filter((h) => {
          const hay = `${h.title} ${h.snippet} ${h.path}`;
          return terms.every((t) => hay.includes(t));
        });
      }
    }
    const sorted = [...list];
    switch (sort) {
      case 'name-asc':
        sorted.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case 'name-desc':
        sorted.sort((a, b) => b.title.localeCompare(a.title));
        break;
      case 'path-asc':
        sorted.sort((a, b) => a.path.localeCompare(b.path));
        break;
      default:
        break; // relevance = server order
    }
    return sorted;
  }, [hits, matchCase, q, sort]);

  return (
    <div className="search-panel">
      <div className="search-head">
        <div className="search-input-wrap">
          <Icon name="search" size={15} className="search-lead" />
          <input
            className="search-input has-lead"
            placeholder="Search   (try tag:idea, path:notes)"
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button
            className={`search-icon-btn ${matchCase ? 'active' : ''}`}
            title="Match case"
            onClick={() => setMatchCase((v) => !v)}
          >
            Aa
          </button>
          {q && (
            <button className="search-icon-btn" title="Clear" onClick={() => setQ('')}>
              <Icon name="x" size={15} />
            </button>
          )}
          <button
            className={`search-icon-btn ${showOptions ? 'active' : ''}`}
            title="Search options"
            onClick={() => setShowOptions((v) => !v)}
          >
            <Icon name="sliders" size={15} />
          </button>
        </div>

        {showOptions && (
          <div className="search-options">
            <label className="search-opt">
              <span>Collapse results</span>
              <input type="checkbox" checked={collapsed} onChange={(e) => setCollapsed(e.target.checked)} />
            </label>
            <label className="search-opt">
              <span>Show more context</span>
              <input type="checkbox" checked={moreContext} onChange={(e) => setMoreContext(e.target.checked)} />
            </label>
          </div>
        )}

        {q && (
          <div className="search-meta">
            <span>
              {shown.length} result{shown.length === 1 ? '' : 's'}
            </span>
            <span className="grow" />
            <div className="search-sort">
              <button className="search-sort-btn" onClick={() => setSortOpen((v) => !v)}>
                {SORT_LABELS[sort]}
                <Icon name="chevron-down" size={13} />
              </button>
              {sortOpen && (
                <>
                  <div className="search-sort-backdrop" onClick={() => setSortOpen(false)} />
                  <div className="search-sort-menu">
                    {(Object.keys(SORT_LABELS) as SortMode[]).map((m) => (
                      <button
                        key={m}
                        className={sort === m ? 'active' : ''}
                        onClick={() => {
                          setSort(m);
                          setSortOpen(false);
                        }}
                      >
                        <Icon name="check" size={14} style={{ opacity: sort === m ? 1 : 0 }} />
                        {SORT_LABELS[m]}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="search-results">
        {shown.map((h) => (
          <div key={h.path} className="result" onClick={() => openFile(h.path)}>
            <div className="r-title">{h.title}</div>
            <div className="r-path">{h.path}</div>
            {!collapsed && h.snippet && (
              <div className={`r-snip ${moreContext ? 'expanded' : ''}`}>{h.snippet}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
