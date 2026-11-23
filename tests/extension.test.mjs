import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {createRequire} from 'node:module';
import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

test('extension opens, compares, exports and restores artifacts', async () => {
  const commands = new Map(), documents = [], posted = [], state = new Map(), exported = new Map();
  let receive, tree, serializer, provider, exportTarget, shownError, clipboard;
  class EventEmitter {
    event = () => {};
    fire() {}
    dispose() {}
  }
  class TreeItem {
    constructor(label, state) {
      this.label = label;
      this.collapsibleState = state;
    }
  }
  const uri = file => ({path: file, fsPath: file, toString: () => file});
  const disposable = () => ({dispose() {}});
  const panel = () => ({
    webview: {asWebviewUri: uri => uri, onDidReceiveMessage: cb => {receive = cb;},
      postMessage: message => posted.push(message), cspSource: 'test:'},
    reveal() {},
    onDidDispose() {},
  });
  const mock = {
    env: {clipboard: {writeText: async text => {clipboard = text;}}},
    EventEmitter, TreeItem, TreeItemCollapsibleState: {None: 0, Collapsed: 1},
    ProgressLocation: {Notification: 1}, ViewColumn: {Active: 1},
    Uri: {joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)), parse: uri},
    workspace: {
      getConfiguration: () => ({get: () => 4 * 1024 * 1024}),
      fs: {
        stat: async file => stat(file.fsPath),
        readFile: async file => readFile(file.fsPath),
        writeFile: async (file, bytes) => exported.set(file.path, bytes.toString('utf8')),
      },
      registerTextDocumentContentProvider: (_, value) => {provider = value; return disposable();},
      openTextDocument: async uri => {
        documents.push({uri, content: provider.provideTextDocumentContent(uri)});
        return uri;
      },
    },
    window: {
      withProgress: async (_, run) => run({}, {onCancellationRequested: disposable}),
      registerWebviewPanelSerializer: (_, value) => {serializer = value; return disposable();},
      createTreeView: (_, options) => {tree = options.treeDataProvider; return disposable();},
      showSaveDialog: async () => exportTarget,
      showTextDocument: async () => {},
      showInformationMessage: () => {},
      showErrorMessage: message => {shownError = message;},
      createWebviewPanel: panel,
    },
    commands: {
      registerCommand: (name, command) => {commands.set(name, command); return disposable();},
      executeCommand: async (name, ...args) => commands.get(name)?.(...args),
    },
  };

  const original = Module._load;
  Module._load = function (id, ...args) {
    if (id === 'vscode') return mock;
    return original.call(this, id, ...args);
  };

  try {
    const extension = require('../extension/extension.cjs');
    const activate = () => extension.activate({
      extensionUri: uri(process.cwd()),
      workspaceState: {get: key => state.get(key), update: async (key, value) => state.set(key, value)},
      subscriptions: [],
    });
    const execute = mock.commands.executeCommand;
    const candidate = uri(path.join(process.cwd(), 'public/examples/changed.zkir'));
    await activate();
    await execute('zkirExplorer.examples');
    assert.equal(shownError, undefined);
    const operations = tree.getChildren()[1];
    assert.equal(operations.description, '4');
    const details = tree.getChildren(tree.getChildren(operations)[0]);
    assert.ok(details.some(row => row.label === 'b: 0x01' && row.description === 'constant'));
    assert.ok(details.some(row => row.label === '→ #2 impact'));
    receive({type: 'ready'});
    assert.equal(posted[0].circuit.instructions.length, 4);
    assert.deepEqual(posted[0].circuit.instructions[0].operands.map(operand => operand.field), ['a', 'b']);

    await execute('zkirExplorer.compare', candidate);
    assert.match(documents[0].content, /Circuit comparison/);
    assert.match(documents[0].uri.path, /zkir-report:/);
    exportTarget = uri('/export/cirsie.json');
    await execute('zkirExplorer.exportJson');
    assert.equal(JSON.parse(exported.get(exportTarget.path)).comparison.counts.added, 3);
    exportTarget = uri('/export/cirsie.md');
    await execute('zkirExplorer.exportMarkdown');
    assert.equal(exported.get(exportTarget.path), documents[0].content);
    exportTarget = candidate;
    await execute('zkirExplorer.exportMarkdown');
    assert.match(shownError, /other than an imported artifact/);
    assert.equal(exported.has(candidate.path), false);

    mock.window.showTextDocument = async () => {throw Error('editor unavailable');};
    await execute('zkirExplorer.compare', candidate);
    assert.match(shownError, /Could not open the comparison report: editor unavailable/);
    assert.equal(state.get('baselineUri'), 'zkir-example:baseline');

    state.set('baselineUri', 'file:///home/user/.vscode-server/extensions/local-zkir.ledger-zkir-explorer-0.3.6/public/examples/baseline.zkir');
    posted.length = 0;
    await activate();
    await serializer.deserializeWebviewPanel(panel(), {selected: 2});
    receive({type: 'ready'});
    assert.equal(posted.at(-1).selected, 2);
    assert.equal(posted.at(-1).circuit.instructions.length, 4);
    receive({type: 'selected', index: 3});
    receive({type: 'ready'});
    assert.equal(posted.at(-1).selected, 3);
    await receive({type: 'copyRaw', index: 3});
    assert.equal(JSON.parse(clipboard).op, 'impact');
    assert.deepEqual(posted.at(-1), {type: 'copyResult', index: 3, ok: true});

    await execute('zkirExplorer.openFile', candidate);
    assert.equal(state.get('baselineUri'), candidate.toString());
    assert.equal(posted.at(-1).selected, 0);
    await execute('zkirExplorer.complexExample');
    const complex = posted.findLast(message => message.type === 'load');
    assert.equal(complex.selected, 3);
    assert.equal(complex.circuit.instructions.length, 22);
    assert.equal(complex.circuit.warningCount, 0);
    assert.equal(state.get('baselineUri'), 'zkir-example:branching');
    await activate();
    await serializer.deserializeWebviewPanel(panel(), {selected: 6});
    receive({type: 'ready'});
    assert.equal(posted.at(-1).name, 'branching.zkir');
    assert.equal(posted.at(-1).selected, 6);
    mock.workspace.fs.stat = async () => ({size: 5 * 1024 * 1024});
    mock.workspace.fs.readFile = async () => assert.fail('file size must be checked before reading');
    await execute('zkirExplorer.openFile', uri('/oversize.zkir'));
    assert.match(shownError, /configured limit/);
    assert.equal(tree.getChildren()[1].description, '22');
  } finally {
    Module._load = original;
  }
});
