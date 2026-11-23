const vscode = require('vscode');
const path = require('node:path');
const crypto = require('node:crypto');
const {Worker} = require('node:worker_threads');
const byteSetting = require('../package.json').contributes.configuration.properties['zkirExplorer.maxArtifactBytes'];

const pageSize = 200;
const examples = {
  baseline: {file: 'baseline.zkir', selection: 0},
  branching: {file: 'branching.zkir', selection: 3},
};
const examplePrefix = 'zkir-example:';

function runWorker(input, token) {
  if (token?.isCancellationRequested) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'analyze.cjs'), {workerData: input});
    const cancellation = token?.onCancellationRequested(() => {
      resolve(undefined);
      void worker.terminate();
    });
    worker.once('message', result => {
      if (result.error) reject(Error(result.error));
      else resolve(result);
    });
    worker.once('error', reject);
    worker.once('exit', code => {
      cancellation?.dispose();
      if (code !== 0) reject(Error(`Analysis worker exited with code ${code}.`));
    });
  });
}

async function activate(context) {
  const changed = new vscode.EventEmitter();
  const reportChanged = new vscode.EventEmitter();
  const reportUri = vscode.Uri.parse('zkir-report:/Circuit-comparison.md');
  let baseline, candidateResult, graph;
  let baselineRequest = 0, comparisonRequest = 0;

  const exampleUri = example => vscode.Uri.joinPath(context.extensionUri, 'public', 'examples', example.file);

  function savedBaselineUri(saved) {
    const id = saved.startsWith(examplePrefix) ? saved.slice(examplePrefix.length) : '';
    if (Object.hasOwn(examples, id)) return exampleUri(examples[id]);
    const legacyBaseline = /\/local-zkir\.ledger-zkir-explorer-[0-9][^/]*\/public\/examples\/baseline\.zkir$/;
    return legacyBaseline.test(saved) ? exampleUri(examples.baseline) : vscode.Uri.parse(saved);
  }

  function item(label, description = '', kind, index) {
    const node = new vscode.TreeItem(label, kind ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None);
    node.description = description;
    node.kind = kind;
    node.index = index;
    return node;
  }

  function inspectLink(node, index) {
    node.command = {command: 'zkirExplorer.inspect', title: 'Inspect instruction', arguments: [Number(index)]};
    return node;
  }

  function pages(entries, kind, render, offset) {
    if (offset === undefined && entries.length > pageSize) {
      return Array.from({length: Math.ceil(entries.length / pageSize)}, (_, page) => {
        const start = page * pageSize;
        return item(`${start + 1}–${Math.min(start + pageSize, entries.length)}`, '', kind, start);
      });
    }
    return entries.slice(offset ?? 0, (offset ?? 0) + pageSize)
      .map((entry, index) => render(entry, (offset ?? 0) + index));
  }

  function edgeItem(edge, incoming) {
    const id = incoming ? edge.source : edge.target;
    const input = id.startsWith('input:');
    const target = input ? `Input ${id.slice(6)}` : `#${id} ${baseline.data.instructions[Number(id)].op}`;
    const node = item(`${incoming ? '←' : '→'} ${target}`, edge.field);
    return input ? node : inspectLink(node, id);
  }

  function instructionDetails(index) {
    const row = baseline.instructions[index];
    if (!row) return [];
    const incoming = baseline.connections.incoming.get(String(index)) ?? [];
    const outgoing = baseline.connections.outgoing.get(String(index)) ?? [];
    const rows = row.operands.slice(0, 40).map(({field, element, value, kind, issue}) =>
      item(`${field}${element === undefined ? '' : `[${element}]`}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
        issue ? issue.replaceAll('_', ' ') : kind.replaceAll('_', ' ')));
    if (row.operands.length > 40) rows.push(item(`Showing 40 of ${row.operands.length} operands. Open the graph for the raw instruction.`));
    rows.push(...incoming.slice(0, 40).map(edge => edgeItem(edge, true)),
      ...outgoing.slice(0, 40).map(edge => edgeItem(edge, false)));
    if (incoming.length > 40 || outgoing.length > 40) {
      rows.push(item(`Showing up to 40 links per direction (${incoming.length} producers, ${outgoing.length} consumers).`));
    }
    return [...rows, inspectLink(item('Inspect raw instruction'), index)];
  }

  const tree = {
    onDidChangeTreeData: changed.event,
    getTreeItem(node) { return node; },
    getChildren(node) {
      if (!baseline) return [];
      const {artifact, decoder, summary, instructions, warnings} = baseline;
      if (!node) return [
        item(`${artifact.name} · ZKIR ${artifact.zkirVersion}`, `${summary.instructions} instructions`),
        item('Instructions', String(instructions.length), instructions.length ? 'instructions' : undefined),
        item('Diagnostics', `${warnings.length} · ${decoder.status}`, warnings.length ? 'diagnostics' : undefined),
        item('Artifact details', '', 'artifact'),
      ];
      switch (node.kind) {
        case 'artifact':
          return [
            item('SHA-256', artifact.sha256),
            item('Size', `${artifact.bytes} bytes`),
            item('Compiler version', artifact.compilerVersion ?? 'Unknown'),
            item('Decoder schema revision', decoder.revision),
            item('Decoded instructions', `${decoder.decodedInstructions} of ${decoder.totalInstructions}`),
            item('Communications commitment', summary.communicationsCommitment ? 'Enabled' : 'Disabled'),
            item('Inputs', String(summary.inputs.length), summary.inputs.length ? 'inputs' : undefined),
            item('Output types', summary.outputs ? String(summary.outputs.length) : 'Unavailable in this version',
              summary.outputs?.length ? 'outputs' : undefined),
            item('Opcode counts', String(summary.opcodes.length), summary.opcodes.length ? 'opcodes' : undefined),
          ];
        case 'inputs':
          return pages(summary.inputs, 'inputs', (entry, index) =>
            item(`#${index} ${entry?.name ?? '(invalid)'}`, entry?.type ?? ''), node.index);
        case 'outputs':
          return pages(summary.outputs, 'outputs', (entry, index) => item(`#${index}`, String(entry)), node.index);
        case 'opcodes':
          return pages(summary.opcodes, 'opcodes', entry => item(entry.opcode, String(entry.count)), node.index);
        case 'diagnostics':
          return pages(warnings, 'diagnostics', (warning, index) => {
            const position = baseline.diagnostics[index].instructionIndex;
            return position === undefined ? item(warning) : inspectLink(item(warning), position);
          }, node.index);
        case 'instructions':
          return pages(instructions, 'instructions', row => inspectLink(
            item(`${row.index}: ${row.opcode}`, baseline.partialInstructions.has(row.index) || !row.decoded ? 'Partial decode' : '',
              'instruction', row.index), row.index), node.index);
        case 'instruction':
          return instructionDetails(node.index);
        default:
          return [];
      }
    },
  };

  async function readArtifact(uri, isCandidate, token, reference) {
    const configured = vscode.workspace.getConfiguration('zkirExplorer').get('maxArtifactBytes');
    const maxBytes = Number.isInteger(configured)
      ? Math.max(byteSetting.minimum, Math.min(configured, byteSetting.maximum)) : byteSetting.default;
    const checkSize = bytes => {
      if (bytes > maxBytes) throw Error(`File is ${bytes} bytes. The configured limit is ${maxBytes} bytes.`);
    };
    const stat = await vscode.workspace.fs.stat(uri);
    checkSize(stat.size);
    if (token.isCancellationRequested) return;
    const bytes = await vscode.workspace.fs.readFile(uri);
    checkSize(bytes.byteLength);
    const input = {bytes, name: path.posix.basename(uri.path), maxBytes};
    if (isCandidate) {
      input.baseline = {
        data: {instructions: reference.data.instructions},
        artifact: reference.artifact,
        summary: reference.summary,
        decoder: reference.decoder,
        diagnostics: reference.diagnostics,
      };
    }
    return runWorker(input, token);
  }

  async function load(uri, {isCandidate = false, restore = false, selection = 0} = {}) {
    const reference = baseline;
    const request = isCandidate ? ++comparisonRequest : ++baselineRequest;
    const current = () => isCandidate ? request === comparisonRequest && reference === baseline
      : request === baselineRequest;
    try {
      if (!uri) {
        const chosen = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: isCandidate ? 'Open candidate' : 'Open baseline',
          filters: {'ZKIR files': ['zkir', 'json']},
        });
        if (!chosen || !current()) return false;
        [uri] = chosen;
      }
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: 'Analyzing ZKIR artifact', cancellable: true,
      }, async (_, token) => {
        const analysis = await readArtifact(uri, isCandidate, token, reference);
        return token.isCancellationRequested ? undefined : analysis;
      });
      if (!result || !current()) return false;
      if (isCandidate) {
        candidateResult = {...result, uri};
        reportChanged.fire(reportUri);
        return true;
      }

      const {analysis} = result;
      const incoming = new Map(), outgoing = new Map();
      for (const edge of analysis.edges) {
        for (const [connections, id] of [[incoming, edge.target], [outgoing, edge.source]]) {
          if (!connections.has(id)) connections.set(id, []);
          connections.get(id).push(edge);
        }
      }
      baseline = {...analysis, uri, connections: {incoming, outgoing},
        partialInstructions: new Set(analysis.diagnostics
          .map(diagnostic => diagnostic.instructionIndex).filter(Number.isInteger))};
      candidateResult = undefined;
      reportChanged.fire(reportUri);
      changed.fire();
      if (graph) {
        if (!restore) graph.selected = selection;
        publishGraph();
      }
      if (!restore) {
        const saved = uri.toString();
        const example = Object.entries(examples).find(([, fixture]) => exampleUri(fixture).toString() === saved);
        await context.workspaceState.update('baselineUri', example ? examplePrefix + example[0] : saved);
        if (current()) await vscode.commands.executeCommand('zkirExplorerView.focus');
      }
      return current();
    } catch (error) {
      if (current()) vscode.window.showErrorMessage(`Could not open ZKIR${restore ? ' saved baseline' : ''}: ${error.message}`);
      return false;
    }
  }

  function publishGraph() {
    if (!graph?.ready || !baseline) return;
    const {artifact, decoder, instructions, edges} = baseline;
    graph.panel.webview.postMessage({type: 'load', name: artifact.name, selected: graph.selected, circuit: {
      version: artifact.zkirVersion, status: decoder.status, warningCount: baseline.diagnostics.length,
      instructions: instructions.map(row => ({raw: row.raw, operands: row.operands, definitions: row.definitions, decoded: row.decoded,
        partial: baseline.partialInstructions.has(row.index) || !row.decoded})),
      edges,
    }});
  }

  const resourceRoot = vscode.Uri.joinPath(context.extensionUri, 'extension');
  const webOptions = {enableScripts: true, localResourceRoots: [resourceRoot]};

  function setupGraph(panel, selected) {
    const view = {panel, selected, ready: false};
    graph = view;
    const web = panel.webview;
    web.options = webOptions;
    const script = web.asWebviewUri(vscode.Uri.joinPath(resourceRoot, 'graph.js'));
    const css = web.asWebviewUri(vscode.Uri.joinPath(resourceRoot, 'graph.css'));
    const nonce = crypto.randomBytes(16).toString('base64');
    const listener = web.onDidReceiveMessage(async message => {
      if (graph !== view) return;
      if (message?.type === 'ready') {
        view.ready = true;
        publishGraph();
      } else if (message?.type === 'selected' && Number.isInteger(message.index) &&
                 message.index >= 0 && message.index < (baseline?.instructions.length ?? 0)) {
        view.selected = message.index;
      } else if (message?.type === 'copyRaw' && Number.isInteger(message.index) && message.index === view.selected) {
        const instruction = baseline?.instructions[message.index];
        if (!instruction) return;
        let ok = false;
        try {
          await vscode.env.clipboard.writeText(JSON.stringify(instruction.raw, null, 2));
          ok = true;
        } catch {
          // The inspector offers manual selection when clipboard access fails.
        } finally {
          if (graph === view) web.postMessage({type: 'copyResult', index: message.index, ok});
        }
      }
    });
    panel.onDidDispose(() => {
      listener?.dispose();
      if (graph === view) graph = undefined;
    });
    web.html = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${web.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body>
<header class="artifact-bar">
  <div>
    <h1>Circuit dependencies</h1>
    <p id="file" class="artifact-name" hidden></p>
  </div>
  <div class="artifact-meta" id="artifact-meta" hidden>
    <span id="version"></span><span id="decode-status" class="decode-status"></span>
  </div>
</header>
<main class="workbench">
  <aside class="instruction-pane" aria-labelledby="instructions-title">
    <div class="pane-header">
      <h2 id="instructions-title">Instructions</h2>
      <span id="list-count" aria-live="polite"></span>
    </div>
    <div class="search-wrap"><input type="search" id="search" placeholder="Search instructions" aria-label="Search instructions" disabled></div>
    <div id="list" class="instruction-list"></div>
  </aside>
  <section class="trace-pane" aria-labelledby="heading">
    <div class="instruction-bar">
      <h2 id="heading" tabindex="-1">Open a baseline circuit to begin</h2>
      <div class="toolbar" aria-label="Instruction navigation">
        <button id="previous" aria-label="Previous instruction" title="Previous instruction" disabled>←</button>
        <span id="counter" aria-live="polite"></span>
        <button id="next" aria-label="Next instruction" title="Next instruction" disabled>→</button>
      </div>
    </div>
    <p id="explanation" class="instruction-description" hidden></p>
    <p id="expression" class="expression" hidden></p>
    <p id="warning" class="warning" role="status" hidden></p>
    <div class="trace-board" id="trace-board" hidden><div class="lanes" id="lanes"></div></div>
  </section>
  <aside id="inspector" class="inspector" aria-label="Instruction details" hidden>
    <div class="pane-header"><h2>Instruction details</h2></div>
    <div class="inspector-switch" role="group" aria-label="Detail view">
      <button id="show-operands" aria-pressed="true" aria-controls="operand-view">Operands</button>
      <button id="show-raw" aria-pressed="false" aria-controls="raw-view">Raw JSON</button>
    </div>
    <section id="operand-view" aria-label="Operands">
      <div id="operands"></div>
      <div id="definitions" class="definitions" hidden></div>
    </section>
    <section id="raw-view" aria-label="Raw JSON" hidden>
      <div class="raw-toolbar"><button id="copy-raw" type="button" hidden>Copy JSON</button><span id="copy-status" role="status"></span></div>
      <pre id="raw" tabindex="0" aria-label="Raw instruction JSON"></pre>
    </section>
  </aside>
</main><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }

  function openGraph(index = 0) {
    if (!baseline) return vscode.window.showInformationMessage('Open a baseline circuit first.');
    if (graph) {
      graph.selected = index;
      graph.panel.reveal(vscode.ViewColumn.Active);
      if (graph.ready) graph.panel.webview.postMessage({type: 'select', selected: index});
      return;
    }
    setupGraph(vscode.window.createWebviewPanel('zkirGraph', 'Circuit dependencies',
      vscode.ViewColumn.Active, webOptions), index);
  }

  function report() {
    return candidateResult?.markdown ?? '# Circuit comparison\n\nOpen a candidate for the current baseline.\n';
  }

  async function compare(uri) {
    if (!baseline) return vscode.window.showInformationMessage('Open a baseline circuit first.');
    if (!await load(uri, {isCandidate: true})) return;
    try {
      const document = await vscode.workspace.openTextDocument(reportUri);
      await vscode.window.showTextDocument(document, {preview: true});
    } catch (error) {
      vscode.window.showErrorMessage(`Could not open the comparison report: ${error.message}`);
    }
  }

  async function exportReport(format) {
    if (!baseline || (format === 'md' && !candidateResult)) {
      return vscode.window.showInformationMessage(format === 'md'
        ? 'Compare a baseline and candidate first.' : 'Open a baseline circuit first.');
    }
    const selectedBaseline = baseline, selectedCandidate = candidateResult;
    const markdown = format === 'md';
    const filename = markdown ? 'Circuit-comparison.md' : 'Cirsie-analysis.json';
    const filters = markdown ? {Markdown: ['md']} : {JSON: ['json']};
    try {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const target = await vscode.window.showSaveDialog({
        defaultUri: folder ? vscode.Uri.joinPath(folder, filename) : undefined,
        filters, saveLabel: `Export ${filename}`,
      });
      if (!target) return;
      if ([selectedBaseline.uri, selectedCandidate?.uri].some(uri => uri?.toString() === target.toString())) {
        throw Error('Choose a file other than an imported artifact.');
      }
      const {uri: _, connections, partialInstructions, ...analysis} = selectedBaseline;
      const content = markdown ? selectedCandidate.markdown : (await runWorker({
        format: 'json', baseline: analysis, candidate: selectedCandidate?.analysis,
        comparison: selectedCandidate?.comparison,
      })).content;
      await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
      vscode.window.showInformationMessage(`Exported ${path.posix.basename(target.path)}.`);
    } catch (error) {
      vscode.window.showErrorMessage(`Could not export the report: ${error.message}`);
    }
  }

  async function loadExample(example) {
    if (await load(exampleUri(example), {selection: example.selection})) openGraph(example.selection);
  }

  context.subscriptions.push(
    vscode.window.createTreeView('zkirExplorerView', {treeDataProvider: tree, showCollapseAll: true}),
    changed, reportChanged,
    vscode.workspace.registerTextDocumentContentProvider('zkir-report', {
      onDidChange: reportChanged.event, provideTextDocumentContent: report,
    }),
    vscode.window.registerWebviewPanelSerializer('zkirGraph', {
      async deserializeWebviewPanel(panel, state) {
        setupGraph(panel, Number.isInteger(state?.selected) && state.selected >= 0 ? state.selected : 0);
      },
    }),
    vscode.commands.registerCommand('zkirExplorer.open', () => load()),
    vscode.commands.registerCommand('zkirExplorer.openFile', uri => load(uri)),
    vscode.commands.registerCommand('zkirExplorer.inspect', index => openGraph(index)),
    vscode.commands.registerCommand('zkirExplorer.graph', () => openGraph()),
    vscode.commands.registerCommand('zkirExplorer.compare', compare),
    vscode.commands.registerCommand('zkirExplorer.exportJson', () => exportReport('json')),
    vscode.commands.registerCommand('zkirExplorer.exportMarkdown', () => exportReport('md')),
    vscode.commands.registerCommand('zkirExplorer.examples', () => loadExample(examples.baseline)),
    vscode.commands.registerCommand('zkirExplorer.complexExample', () => loadExample(examples.branching)),
  );

  const saved = context.workspaceState.get('baselineUri');
  if (saved) await load(savedBaselineUri(saved), {restore: true});
}

module.exports = {activate};
