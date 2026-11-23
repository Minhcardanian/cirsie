// Run with VS Code's --extensionDevelopmentPath and --extensionTestsPath.
// The extension under test must include public/examples/{baseline,changed}.zkir.
const assert = require('node:assert/strict');
const vscode = require('vscode');

exports.run = async function () {
  const extension = vscode.extensions.getExtension('local-zkir.ledger-zkir-explorer');
  assert.ok(extension, 'ZKIR Explorer should be available');
  await extension.activate();
  await vscode.commands.executeCommand('zkirExplorer.examples');
  let graph;
  for (let i = 0; i < 30 && !graph; i++) {
    graph = vscode.window.tabGroups.all.flatMap(group => group.tabs)
      .find(tab => String(tab.input?.viewType).endsWith('zkirGraph'));
    if (!graph) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(graph, 'Example should open a dependency view');
  const candidate = vscode.Uri.joinPath(extension.extensionUri, 'public', 'examples', 'changed.zkir');
  await vscode.commands.executeCommand('zkirExplorer.compare', candidate);
  const doc = vscode.window.activeTextEditor?.document;
  assert.ok(doc, 'Comparison should open an editor');
  assert.equal(doc.uri.scheme, 'zkir-report');
  assert.equal(doc.isDirty, false);
  assert.match(doc.getText(), /Instructions: 4 → 5/);
  assert.match(doc.getText(), /\| mul \| 0 \| 1 \| 1 \|/);
};
