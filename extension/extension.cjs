const vscode = require('vscode');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const crypto = require('node:crypto');
async function activate(context) {
  const {parse, operandFields} = await import(pathToFileURL(path.join(context.extensionPath,'src','parser.js')).href);
  const {compareInstructions} = await import(pathToFileURL(path.join(context.extensionPath,'src','compare.js')).href);
  let baseline, candidate, baselineName, candidateName, graphPanel, graphSelected=0, reportText='';
  const reportChanged = new vscode.EventEmitter();
  const reportUri = vscode.Uri.parse('zkir-report:/Circuit-comparison.md');
  const exampleKey = 'zkir-example:baseline';
  const exampleUri = () => vscode.Uri.joinPath(context.extensionUri,'public','examples','baseline.zkir');
  const savedBaselineUri = saved => saved === exampleKey || /\/local-zkir\.ledger-zkir-explorer-[0-9][^/]*\/public\/examples\/baseline\.zkir$/.test(saved) ? exampleUri() : vscode.Uri.parse(saved);
  const changed = new vscode.EventEmitter();
  const tree = {
    onDidChangeTreeData: changed.event,
    getTreeItem(item) { return item; },
    getChildren(item) {
      if (!baseline) return [];
      if (!item) {
        const summary = new vscode.TreeItem(`${baselineName} · ZKIR ${baseline.data.version.major}.${baseline.data.version.minor}`, vscode.TreeItemCollapsibleState.None);
        summary.description = `${baseline.data.instructions.length} instructions`;
        const instructions = new vscode.TreeItem('Instructions', vscode.TreeItemCollapsibleState.Collapsed); instructions.kind='instructions'; instructions.description=String(baseline.data.instructions.length);
        const warnings = new vscode.TreeItem('Warnings', baseline.warnings.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None); warnings.kind='warnings'; warnings.description=String(baseline.warnings.length);
        return [summary, instructions, warnings];
      }
      if (item.kind === 'warnings') return baseline.warnings.map(w=>new vscode.TreeItem(w));
      if (item.kind === 'instructions') return baseline.data.instructions.map((op,i)=>{const node=new vscode.TreeItem(`${i}: ${op.op}`,vscode.TreeItemCollapsibleState.Collapsed);node.kind='instruction';node.index=i;node.description=op.op==='impact'?'public transcript operation':'';node.tooltip='Expand for operands and dependencies, or click to open the graph.';node.command={command:'zkirExplorer.inspect',title:'Inspect',arguments:[i]};return node;});
      if (item.kind === 'instruction') {
        const index=item.index, op=baseline.data.instructions[index], result=[];
        const fields=baseline.data.version.major===3?operandFields(op.op):null;
        if(fields) for(const field of fields){const values=Array.isArray(op[field])?op[field]:[op[field]];values.forEach((value,n)=>{if(value==null)return;const name=field+(Array.isArray(op[field])?`[${n}]`:'');const line=new vscode.TreeItem(`${name}: ${String(value)}`);line.description=typeof value==='string'&&/^-?0x[0-9a-f]+$/i.test(value)?'constant':'variable';result.push(line);});}
        else for(const [key,value] of Object.entries(op)){if(key==='op')continue;const line=new vscode.TreeItem(`${key}: ${JSON.stringify(value)}`);line.description='raw field';result.push(line);}
        const ins=baseline.edges.filter(e=>e.target===String(index));const outs=baseline.edges.filter(e=>e.source===String(index));
        for(const edge of ins){const line=new vscode.TreeItem(`← ${label(edge.source)}`);line.description=edge.field||edge.label;line.tooltip=`Input ${edge.label}`;result.push(line);}
        for(const edge of outs){const line=new vscode.TreeItem(`→ ${label(edge.target)}`);line.description=edge.field||edge.label;line.tooltip=`Consumer ${edge.label}`;result.push(line);}
        if(!result.length)result.push(new vscode.TreeItem('No decoded operands or connections.'));
        return result;
      }
      return [];
    }
  };
  const view=vscode.window.createTreeView('zkirExplorerView',{treeDataProvider:tree,showCollapseAll:true});
  async function load(uri, isCandidate=false, focus=true) {
    try {
      if (!uri) { const chosen=await vscode.window.showOpenDialog({canSelectMany:false,openLabel:isCandidate?'Open candidate':'Open baseline',filters:{'ZKIR files':['zkir','json']}}); if(!chosen)return; uri=chosen[0]; }
      const bytes=await vscode.workspace.fs.readFile(uri); const parsed=parse(Buffer.from(bytes).toString('utf8'));
      if (isCandidate) { candidate=parsed; candidateName=path.basename(uri.path); } else {baseline=parsed;baselineName=path.basename(uri.path);candidate=undefined;candidateName=undefined;await context.workspaceState.update('baselineUri',uri.toString() === exampleUri().toString() ? exampleKey : uri.toString());}
      changed.fire(); if(!isCandidate && graphPanel) graphPanel.webview.postMessage({type:'load',circuit:graphData(),name:baselineName,selected:0}); if(!isCandidate && focus) await vscode.commands.executeCommand('zkirExplorerView.focus'); return true;
    } catch(e) { vscode.window.showErrorMessage(`Could not open ZKIR: ${e.message}`); return false; }
  }
  async function show(text,title) { reportText=`# ${title}\n\n${text}`;reportChanged.fire(reportUri);try {const doc=await vscode.workspace.openTextDocument(reportUri);await vscode.window.showTextDocument(doc,{preview:true});}catch(e){vscode.window.showErrorMessage(`Could not open the comparison report: ${e.message}`);} }
  function label(id) {return id.startsWith('input:')?`Input ${id.slice(6)}`:`#${id} ${baseline.data.instructions[Number(id)]?.op ?? ''}`;}
  function graphData(){return {instructions:baseline.data.instructions,edges:baseline.edges,warnings:baseline.warnings,operandFields:baseline.data.version.major===3?baseline.data.instructions.map(op=>operandFields(op.op)):null,version:`${baseline.data.version.major}.${baseline.data.version.minor}`};}
  function openGraph(i=0){
    if(!baseline){vscode.window.showInformationMessage('Open a baseline circuit first.');return;}
    if(graphPanel){graphSelected=i;graphPanel.reveal(vscode.ViewColumn.Active);graphPanel.webview.postMessage({type:'select',selected:i});return;}
    const panel=vscode.window.createWebviewPanel('zkirGraph','Circuit dependencies',vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'extension')]});
    setupGraph(panel,i);
  }
  function setupGraph(panel,i=0){
    graphPanel=panel;graphSelected=i;
    panel.webview.options={enableScripts:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,'extension')]};
    const web=graphPanel.webview, script=web.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,'extension','graph.js')), css=web.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,'extension','graph.css')), nonce=crypto.randomBytes(16).toString('base64');
    web.html=`<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${web.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"></head><body><header><h1>Circuit dependencies</h1><p id="file"></p><p>Static data flow from the artifact. Select a connected instruction to follow it.</p></header><main><aside><input id="search" placeholder="Search instructions" aria-label="Search instructions"><div id="list"></div></aside><article><h2 id="heading">Open a baseline circuit to begin</h2><p id="explanation"></p><p id="expression" class="expression" hidden></p><p id="warning" role="status"></p><div class="toolbar"><button id="previous">← Previous</button><span id="counter"></span><button id="next">Next →</button></div><div class="lanes" id="lanes"></div><section class="operand-section"><h3>Operands</h3><p class="muted">Constants are shown as encoded; variable dependencies appear above.</p><div id="operands"></div></section><details><summary>All operands and raw instruction</summary><pre id="raw"></pre></details></article></main><script nonce="${nonce}" src="${script}"></script></body></html>`;
    web.onDidReceiveMessage(message=>{if(message.type==='ready' && baseline)web.postMessage({type:'load',circuit:graphData(),name:baselineName,selected:i});},null,context.subscriptions);
    panel.onDidDispose(()=>{if(graphPanel===panel)graphPanel=undefined;},null,context.subscriptions);
  }
  context.subscriptions.push(view,changed,reportChanged,
    vscode.workspace.registerTextDocumentContentProvider('zkir-report',{onDidChange:reportChanged.event,provideTextDocumentContent:()=>reportText}),
    vscode.window.registerWebviewPanelSerializer('zkirGraph',{async deserializeWebviewPanel(panel,state){
      setupGraph(panel,Number.isInteger(state?.selected) && state.selected>=0 ? state.selected : 0);
      const saved=context.workspaceState.get('baselineUri');
      if(saved && !baseline) await load(savedBaselineUri(saved),false,false);
    }}),
    vscode.commands.registerCommand('zkirExplorer.open',()=>load()),
    vscode.commands.registerCommand('zkirExplorer.openFile',uri=>load(uri)),
    vscode.commands.registerCommand('zkirExplorer.inspect',i=>openGraph(i)),
    vscode.commands.registerCommand('zkirExplorer.graph',()=>openGraph(0)),
    vscode.commands.registerCommand('zkirExplorer.compare',async(uri)=>{if(!baseline){vscode.window.showInformationMessage('Open a baseline circuit first.');return;}candidate=undefined;candidateName=undefined;await load(uri,true);if(!candidate)return;const a=baseline.data.instructions,b=candidate.data.instructions;const count=xs=>xs.reduce((m,x)=>(m[x.op]=(m[x.op]||0)+1,m),{});const ac=count(a),bc=count(b);const ops=[...new Set([...Object.keys(ac),...Object.keys(bc)])].filter(op=>ac[op]!==bc[op]).sort();const result=compareInstructions(a,b),diffs=result.changes;const rows=ops.map(op=>`| ${op} | ${ac[op]||0} | ${bc[op]||0} | ${(bc[op]||0)-(ac[op]||0)} |`).join('\n');const detail=diffs.slice(0,100).map(({beforeIndex,afterIndex})=>{const old=beforeIndex===null?undefined:a[beforeIndex],next=afterIndex===null?undefined:b[afterIndex];return `### ${old?'Baseline #'+beforeIndex:'Added at candidate #'+afterIndex}\n\nBaseline:\n\n\`\`\`json\n${old?JSON.stringify(old,null,2):'(none)'}\n\`\`\`\n\nCandidate:\n\n\`\`\`json\n${next?JSON.stringify(next,null,2):'(none)'}\n\`\`\``}).join('\n\n');return show(`**${baselineName} → ${candidateName}**\n\n- Instructions: ${a.length} → ${b.length}\n- ZKIR: ${baseline.data.version.major}.${baseline.data.version.minor} → ${candidate.data.version.major}.${candidate.data.version.minor}\n- ${result.method === 'sequence' ? 'Added / removed instructions' : 'Positional differences (large circuit fallback)'}: ${diffs.length}\n- Decoder warnings: ${baseline.warnings.length} → ${candidate.warnings.length}\n\nInstruction counts do not measure proof cost. Instructions are matched by exact JSON, not semantics. Identifier changes can appear as removals and additions. Large circuits fall back to positional comparison.\n\n## Opcode counts\n\n| Opcode | Baseline | Candidate | Change |\n| --- | ---: | ---: | ---: |\n${rows||'| No count changes | | | |'}\n\n## Changed instructions (first 100)\n\n${detail||'No differences.'}`,'Circuit comparison');}),
    vscode.commands.registerCommand('zkirExplorer.examples',async()=>{if(await load(exampleUri()))openGraph(0);})
  );
}
module.exports={activate};
