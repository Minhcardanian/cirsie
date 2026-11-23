import {useMemo, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ReactFlow, Background, Controls, type Node, type Edge} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {version} from '../package.json';
import {analysisJson, analyzeArtifact, compareArtifacts, comparisonMarkdown} from './analysis.js';
import {checkArtifactSize} from './parser.js';
import './style.css';

type Analysis = Awaited<ReturnType<typeof analyzeArtifact>>;
type Comparison = ReturnType<typeof compareArtifacts>;
const pageSize = 200;
const graphLimit = 40;

function download(filename: string, body: string, type: string) {
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(new Blob([body], {type}));
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
}

function Compare({baseline, candidate, result, onClose}: {
  baseline: Analysis; candidate: Analysis; result: Comparison; onClose: () => void;
}) {
  const {counts, fallback, changes, histogramDelta, coverage} = result;
  return <section className="comparison">
    <div className="comparetitle">
      <div><h3>Build comparison</h3><p>{baseline.artifact.name} → {candidate.artifact.name}</p></div>
      <div className="header-actions">
        <button onClick={() => download('Circuit-comparison.md', comparisonMarkdown(baseline, candidate, result), 'text/markdown')}>
          Export Markdown
        </button>
        <button onClick={onClose}>Close comparison</button>
      </div>
    </div>
    <p>{fallback ? 'Positional fallback. Insertions can shift later instructions.' : 'Longest common subsequence of parsed JSON instructions.'}
      {' '}Decoder coverage {coverage.baseline} → {coverage.candidate}.</p>
    <div className="metrics">
      <div><small>INSTRUCTIONS</small><b>{baseline.summary.instructions} → {candidate.summary.instructions}</b></div>
      <div><small>ZKIR VERSION</small><b>{baseline.artifact.zkirVersion} → {candidate.artifact.zkirVersion}</b></div>
      <div><small>MATCHED</small><b>{counts.matched}</b></div>
      <div><small>ADDED / REMOVED</small><b>{counts.added} / {counts.removed}</b></div>
      {fallback && <div><small>POSITIONAL DIFFERENCES</small><b>{counts.positionalDifferences}</b></div>}
    </div>
    <h4>Opcode count changes</h4>
    {histogramDelta.length ? <div className="opcounts">{histogramDelta.slice(0, 100).map(({opcode, before, after, delta}) =>
      <div key={opcode}><code>{opcode}</code><span>{before} → {after}</span><b>{delta > 0 ? '+' : ''}{delta}</b></div>
    )}</div> : <p>No opcode count changes.</p>}
    {histogramDelta.length > 100 && <p>Showing the first 100 opcode changes.</p>}
    <details>
      <summary>Inspect changes ({changes.length})</summary>
      {changes.slice(0, 100).map(({beforeIndex, afterIndex}) => {
        const before = beforeIndex === null ? undefined : baseline.instructions[beforeIndex].raw;
        const after = afterIndex === null ? undefined : candidate.instructions[afterIndex].raw;
        return <div className="diff" key={`${beforeIndex}:${afterIndex}`}>
          <b>{beforeIndex === null ? 'Added' : `Baseline #${beforeIndex}`}
            {afterIndex === null ? ' · Removed' : ` · Candidate #${afterIndex}`}</b>
          <pre>{before ? JSON.stringify(before, null, 2) : '—'}</pre>
          <pre>{after ? JSON.stringify(after, null, 2) : '—'}</pre>
        </div>;
      })}
      {changes.length > 100 && <p>Showing the first 100 instruction differences.</p>}
    </details>
  </section>;
}

async function readFile(file: File) {
  checkArtifactSize(file.size);
  return analyzeArtifact(new Uint8Array(await file.arrayBuffer()), file.name, version);
}

async function readExample(name: string) {
  const response = await fetch(`${import.meta.env.BASE_URL}examples/${name}`);
  if (!response.ok) throw Error(`Could not load ${name}.`);
  return analyzeArtifact(new Uint8Array(await response.arrayBuffer()), name, version);
}

function App() {
  const [baseline, setBaseline] = useState<Analysis>();
  const [candidate, setCandidate] = useState<Analysis>();
  const [error, setError] = useState('');
  const [compareError, setCompareError] = useState('');
  const [selected, setSelected] = useState(0);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);
  const baselineRequest = useRef(0), candidateRequest = useRef(0);

  const result = useMemo(() => baseline && candidate ? compareArtifacts(baseline, candidate) : undefined,
    [baseline, candidate]);
  const searchIndex = useMemo(() => baseline?.instructions.map(row => ({
    ...row, searchText: `${row.index} ${JSON.stringify(row.raw)}`.toLowerCase(),
  })) ?? [], [baseline]);
  const filtered = useMemo(() => {
    const query = search.toLowerCase();
    return searchIndex.filter(row => (!filter || row.opcode === filter) && row.searchText.includes(query));
  }, [searchIndex, filter, search]);

  const graph = useMemo(() => {
    const nodes: Node[] = [], edges: Edge[] = [];
    if (!baseline?.instructions[selected]) return {nodes, edges, omitted: 0};
    const id = String(selected);
    const incoming = baseline.edges.filter(edge => edge.target === id);
    const outgoing = baseline.edges.filter(edge => edge.source === id);
    const relevant = [...incoming.slice(0, graphLimit), ...outgoing.slice(0, graphLimit)];
    const producers = new Set(incoming.map(edge => edge.source));
    const ids = new Set([id, ...relevant.flatMap(edge => [edge.source, edge.target])]);
    let left = 0, right = 0;
    for (const nodeId of ids) {
      const isSelected = nodeId === id;
      const isProducer = producers.has(nodeId);
      const input = nodeId.startsWith('input:');
      nodes.push({
        id: nodeId,
        position: {x: isSelected ? 340 : isProducer ? 0 : 680, y: isSelected ? 0 : 70 * (isProducer ? left++ : right++)},
        data: {label: input ? `Input ${nodeId.slice(6)}` : `#${nodeId} ${baseline.instructions[Number(nodeId)].opcode}`},
      });
    }
    relevant.forEach((edge, index) => edges.push({...edge, id: String(index)}));
    return {nodes, edges, omitted: incoming.length + outgoing.length - edges.length};
  }, [baseline, selected]);

  async function open(file?: File, examples = false) {
    if (!file && !examples) return;
    const request = ++baselineRequest.current;
    setError('');
    try {
      const [next, reference] = file ? [await readFile(file), undefined]
        : await Promise.all([readExample('baseline.zkir'), readExample('changed.zkir')]);
      if (request !== baselineRequest.current) return;
      candidateRequest.current++;
      setBaseline(next);
      setCandidate(reference);
      setSelected(0);
      setSearch('');
      setFilter('');
      setPage(0);
      setCompareError('');
    } catch (failure) {
      if (request === baselineRequest.current) setError((failure as Error).message);
    }
  }

  async function compare(file?: File) {
    if (!file) return;
    const request = ++candidateRequest.current;
    setCompareError('');
    try {
      const next = await readFile(file);
      if (request === candidateRequest.current) setCandidate(next);
    } catch (failure) {
      if (request === candidateRequest.current) setCompareError((failure as Error).message);
    }
  }

  const current = baseline?.instructions[selected];
  return <>
    <header><div><b>Cirsie</b><small>ZKIR EXPLORER · WEB PREVIEW</small></div>
      <div className="header-actions">
        <button className="sample" onClick={() => open(undefined, true)}>Load example comparison</button>
        <label className="upload">Open baseline .zkir <input type="file" accept=".zkir,application/json"
          onChange={event => {void open(event.target.files?.[0]); event.target.value = '';}}/></label>
      </div>
    </header>
    {error && <div className="error" role="alert">{error}</div>}
    {!baseline ? <main className="empty">
      <h1>Inspect a ZKIR circuit</h1>
      <p>Open a local ZKIR 2.0, 3.0 or 3.1 artifact to inspect its instructions and trace dependencies.</p>
    </main> : <>
      <div className="comparebar">
        <strong>{baseline.artifact.name}</strong>
        <div className="header-actions">
          <button onClick={() => download('Cirsie-analysis.json', analysisJson(baseline, candidate, result), 'application/json')}>
            Export JSON
          </button>
          <label className="compareupload">{candidate ? 'Replace candidate' : 'Open candidate .zkir'}
            <input type="file" accept=".zkir,application/json"
              onChange={event => {void compare(event.target.files?.[0]); event.target.value = '';}}/>
          </label>
        </div>
      </div>
      {compareError && <div className="error" role="alert">{compareError}</div>}
      {candidate && result && <Compare baseline={baseline} candidate={candidate} result={result} onClose={() => {
        candidateRequest.current++;
        setCandidate(undefined);
      }}/>}
      <div className="meta">
        <span>ZKIR <b>{baseline.artifact.zkirVersion}</b></span>
        <span><b>{baseline.summary.instructions}</b> instructions</span>
        <span><b>{baseline.summary.inputs.length}</b> inputs</span>
        <span>Commitment {baseline.summary.communicationsCommitment ? 'enabled' : 'disabled'}</span>
        <span>Structural decode {baseline.decoder.status}</span>
      </div>
      {baseline.warnings.length > 0 && <details className="warning" open>
        <summary>{baseline.warnings.length} diagnostics · partial structural decode</summary>
        <ul>{baseline.warnings.slice(0, 50).map((warning, index) => <li key={index}>{warning}</li>)}</ul>
        {baseline.warnings.length > 50 && <p>Showing the first 50 diagnostics. Export JSON for the complete list.</p>}
      </details>}
      <div className="layout">
        <aside>
          <h3>Instructions <small>{filtered.length}</small></h3>
          <input aria-label="Search instructions" placeholder="Search instructions…" value={search}
            onChange={event => {setSearch(event.target.value); setPage(0);}}/>
          <select aria-label="Filter opcode" value={filter}
            onChange={event => {setFilter(event.target.value); setPage(0);}}>
            <option value="">All opcodes</option>
            {baseline.summary.opcodes.slice(0, 500).map(({opcode}) => <option key={opcode}>{opcode}</option>)}
          </select>
          {baseline.summary.opcodes.length > 500 && <p>Showing the first 500 opcodes. Search for others by name.</p>}
          {filtered.length > pageSize && <div className="comparetitle">
            <button disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
            <span>{page * pageSize + 1}–{Math.min((page + 1) * pageSize, filtered.length)}</span>
            <button disabled={(page + 1) * pageSize >= filtered.length} onClick={() => setPage(page + 1)}>Next</button>
          </div>}
          <div className="list">{filtered.slice(page * pageSize, (page + 1) * pageSize).map(({opcode, index}) =>
            <button aria-current={selected === index ? 'true' : undefined} className={selected === index ? 'active' : ''}
              key={index} onClick={() => setSelected(index)}><span>{index}</span>{opcode}</button>)}</div>
        </aside>
        <section className="graph">
          <div className="graphhead"><h3>Dependency graph</h3><small>
            {graph.omitted ? `${graph.omitted} connections omitted from this view` : 'Inputs → selected instruction → consumers'}
          </small></div>
          <ReactFlow key={`${baseline.artifact.sha256}:${selected}`} nodes={graph.nodes} edges={graph.edges}
            fitView nodesDraggable={false} onNodeClick={(_, node) => {
              if (!node.id.startsWith('input:')) setSelected(Number(node.id));
            }}><Background/><Controls/></ReactFlow>
        </section>
        <aside className="detail">
          <h3>Instruction details</h3>
          {current ? <><b>#{selected} · {current.opcode}</b><pre>{JSON.stringify(current.raw, null, 2)}</pre></>
            : <p>No instructions in this circuit.</p>}
          <details><summary>Artifact details</summary>
            <pre>{JSON.stringify({...baseline.artifact, decoder: baseline.decoder.revision}, null, 2)}</pre>
            <p>{baseline.summary.inputs.length} inputs. {baseline.summary.outputs?.length ?? 'Unknown number of'} output types.</p>
            <pre>{JSON.stringify({inputs: baseline.summary.inputs.slice(0, 20),
              outputs: baseline.summary.outputs?.slice(0, 20) ?? null}, null, 2)}</pre>
            {(baseline.summary.inputs.length > 20 || (baseline.summary.outputs?.length ?? 0) > 20) &&
              <p>Showing up to 20 items per signature. Export JSON for the full signature.</p>}
          </details>
        </aside>
      </div>
    </>}
  </>;
}

createRoot(document.getElementById('root')!).render(<App/>);
