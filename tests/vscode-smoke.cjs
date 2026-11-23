// Run in a clean VS Code profile with the packaged extension installed.
const assert = require('node:assert/strict');
const vscode = require('vscode');

async function graphTab() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs)
      .find(entry => String(entry.input?.viewType).endsWith('zkirGraph'));
    if (tab) return tab;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

exports.run = async function () {
  const extension = vscode.extensions.getExtension('local-zkir.ledger-zkir-explorer');
  assert.ok(extension, 'ZKIR Explorer should be installed');
  await extension.activate();
  await vscode.commands.executeCommand('zkirExplorer.examples');
  assert.ok(await graphTab(), 'Example should open a dependency view');

  const candidate = vscode.Uri.joinPath(extension.extensionUri, 'public', 'examples', 'changed.zkir');
  await vscode.commands.executeCommand('zkirExplorer.compare', candidate);
  const document = vscode.window.activeTextEditor?.document;
  assert.ok(document, 'Comparison should open an editor');
  assert.equal(document.uri.scheme, 'zkir-report');
  assert.equal(document.isDirty, false);
  assert.match(document.getText(), /Instructions: 4 → 5/);
  assert.match(document.getText(), /\| mul \| 0 \| 1 \| 1 \|/);
  assert.match(document.getText(), /Baseline SHA-256: `[0-9a-f]{64}`/);
  assert.match(document.getText(), /longest common subsequence/);
  await vscode.commands.executeCommand('zkirExplorer.complexExample');
  await vscode.commands.executeCommand('zkirExplorer.compare', candidate);
  const expected = /Instructions: 22 → 5/;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (expected.test(vscode.window.activeTextEditor?.document.getText() ?? '')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.match(vscode.window.activeTextEditor?.document.getText() ?? '', expected);
  console.log(`Cirsie packaged smoke passed on VS Code ${vscode.version}.`);
};
