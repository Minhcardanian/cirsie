(function () {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  let circuit, selected = 0;
  let searchIndex = [];
  const incoming = new Map(), outgoing = new Map();
  const visibleLimit = 40;

  function label(id) {
    if (id.startsWith('input:')) return 'Circuit input ' + id.slice(6);
    return '#' + id + '  ' + circuit.instructions[Number(id)]?.raw.op;
  }

  function add(parent, tag, text, className) {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    parent.appendChild(node);
    return node;
  }

  function select(index, focus = false) {
    selected = Math.max(0, Math.min(index, circuit.instructions.length - 1));
    draw();
    if (focus) $('heading').focus();
  }

  function renderOperands(row) {
    const panel = $('operands');
    panel.replaceChildren();
    if (row.operands.length) {
      const table = add(panel, 'table', '', 'operand-table');
      const headings = table.createTHead().insertRow();
      for (const label of ['Field', 'Value', 'Kind']) add(headings, 'th', label).scope = 'col';
      const body = table.createTBody();
      for (const {field, element, value, kind, issue} of row.operands.slice(0, visibleLimit)) {
        const line = body.insertRow();
        add(line, 'td', element === undefined ? field : field + '[' + element + ']', 'operand-name');
        add(line.insertCell(), 'code', typeof value === 'string' ? value : JSON.stringify(value));
        const classification = add(line, 'td', (issue ?? kind).replaceAll('_', ' '), 'operand-kind');
        if (issue) classification.dataset.issue = 'true';
      }
      if (row.operands.length > visibleLimit) {
        add(panel, 'p', `Showing ${visibleLimit} of ${row.operands.length} operands. See Raw JSON for every field.`, 'muted');
      }
    } else {
      add(panel, 'p', row.decoded ? 'No decoded operands.' : 'Operands unavailable. See Raw JSON.', 'muted');
    }
    const definitions = $('definitions');
    definitions.replaceChildren();
    definitions.hidden = !row.definitions?.length;
    if (!definitions.hidden) {
      add(definitions, 'h3', 'Defines');
      for (const value of row.definitions.slice(0, visibleLimit)) add(definitions, 'code', String(value));
      if (row.definitions.length > visibleLimit) {
        add(definitions, 'p', `Showing ${visibleLimit} of ${row.definitions.length} definitions.`, 'muted');
      }
    }
  }

  function showRaw(raw) {
    $('operand-view').hidden = raw;
    $('raw-view').hidden = !raw;
    $('show-operands').setAttribute('aria-pressed', String(!raw));
    $('show-raw').setAttribute('aria-pressed', String(raw));
  }

  function draw() {
    vscode.setState({selected});
    vscode.postMessage({type: 'selected', index: selected});
    const heading = $('heading'), lanes = $('lanes'), expression = $('expression');
    const row = circuit.instructions[selected], op = row?.raw;
    const total = circuit.instructions.length;
    $('counter').textContent = total ? (selected + 1) + ' / ' + total : '0 / 0';
    $('previous').disabled = selected <= 0;
    $('next').disabled = selected >= total - 1;
    $('warning').textContent = circuit.status === 'partial'
      ? `${row?.partial ? 'Selected instruction has incomplete decoding. ' : ''}Partial structural decode. ${circuit.warningCount} diagnostics in the sidebar.`
      : '';
    $('warning').hidden = !$('warning').textContent;
    $('raw').textContent = op ? JSON.stringify(op, null, 2) : '';
    $('copy-status').textContent = '';
    $('copy-raw').hidden = !op;
    $('trace-board').hidden = !op;
    $('inspector').hidden = !op;
    $('explanation').textContent = '';
    $('explanation').hidden = true;
    expression.hidden = true;
    expression.textContent = '';
    lanes.replaceChildren();
    repaint = () => {};
    if (!op) {
      heading.textContent = 'No instructions in this circuit';
      $('operands').replaceChildren();
      return;
    }
    heading.textContent = label(String(selected));
    if (row.decoded && op.op === 'impact') {
      $('explanation').hidden = false;
      $('explanation').textContent = 'Declares a group of public input values guarded by a condition.';
    }
    if (row.decoded && !row.partial && ['add', 'mul'].includes(op.op) &&
        [op.output, op.a, op.b].every(value => typeof value === 'string')) {
      expression.hidden = false;
      expression.textContent = `${op.output} = ${op.a} ${op.op === 'add' ? '+' : '×'} ${op.b}`;
    }
    renderOperands(row);
    for (const button of $('list').querySelectorAll('button')) {
      if (Number(button.dataset.index) === selected) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    }

    const connections = [];
    function lane(title, edges, side) {
      const neighbors = new Map();
      for (const edge of edges) {
        const id = side === 'in' ? edge.source : edge.target;
        if (!neighbors.has(id)) neighbors.set(id, []);
        neighbors.get(id).push(edge);
      }

      const column = add(lanes, 'div', '', 'lane');
      const heading = add(column, 'h3', title, 'lane-heading');
      add(heading, 'span', String(neighbors.size), 'lane-count');
      if (!neighbors.size) add(column, 'p', side === 'in' ? 'No producers' : 'No consumers', 'muted lane-empty');
      let shown = 0;
      for (const [id, links] of neighbors) {
        if (shown++ === visibleLimit) break;
        const isInput = id.startsWith('input:');
        const node = add(column, isInput ? 'div' : 'button', label(id), 'node');
        for (const edge of links.slice(0, visibleLimit)) {
          const field = edge.element === undefined ? edge.field : `${edge.field}[${edge.element}]`;
          add(node, 'small', field ? `${field} · ${edge.label}` : edge.label);
        }
        if (links.length > visibleLimit) add(node, 'small', `${links.length - visibleLimit} more operands`);
        connections.push({button: node, side});
        if (!isInput) node.onclick = () => select(Number(id), true);
      }
      if (neighbors.size > visibleLimit) {
        add(column, 'p', `Showing ${visibleLimit} of ${neighbors.size} connected instructions.`, 'muted');
      }
    }

    lane('Inputs', incoming.get(String(selected)) ?? [], 'in');
    const center = add(lanes, 'div', '', 'lane center');
    add(center, 'h3', 'Selected', 'lane-heading');
    const selectedNode = add(center, 'div', label(String(selected)), 'selected');
    lane('Consumers', outgoing.get(String(selected)) ?? [], 'out');
    scheduleConnectors(lanes, selectedNode, connections);
  }

  let repaint = () => {};

  function scheduleConnectors(lanes, center, connections) {
    const svgNamespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNamespace, 'svg');
    const defs = document.createElementNS(svgNamespace, 'defs');
    const arrow = document.createElementNS(svgNamespace, 'marker');
    for (const [key, value] of Object.entries({id: 'edge-end', viewBox: '0 0 8 8', refX: '7', refY: '4',
      markerWidth: '5', markerHeight: '5', orient: 'auto'})) arrow.setAttribute(key, value);
    const tip = document.createElementNS(svgNamespace, 'path');
    tip.setAttribute('d', 'M 0 0 L 8 4 L 0 8 z');
    tip.setAttribute('class', 'edge-tip');
    arrow.appendChild(tip);
    defs.appendChild(arrow);
    svg.appendChild(defs);
    svg.setAttribute('class', 'connection-lines');
    svg.setAttribute('aria-hidden', 'true');
    lanes.prepend(svg);
    repaint = () => {
      if (!svg.isConnected) return;
      svg.replaceChildren(defs);
      const box = lanes.getBoundingClientRect();
      const middle = center.getBoundingClientRect();
      const vertical = window.innerWidth <= 450;
      for (const {button, side} of connections) {
        const linked = button.getBoundingClientRect();
        const [from, to] = side === 'in' ? [linked, middle] : [middle, linked];
        const x1 = (vertical ? from.left + from.width / 2 : from.right) - box.left;
        const y1 = (vertical ? from.bottom : from.top + from.height / 2) - box.top;
        const x2 = (vertical ? to.left + to.width / 2 : to.left) - box.left;
        const y2 = (vertical ? to.top : to.top + to.height / 2) - box.top;
        const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
        const control = vertical ? `${x1} ${midY} ${x2} ${midY}` : `${midX} ${y1} ${midX} ${y2}`;
        const connector = document.createElementNS(svgNamespace, 'path');
        connector.setAttribute('class', 'connection');
        connector.setAttribute('marker-end', 'url(#edge-end)');
        connector.setAttribute('d', `M ${x1} ${y1} C ${control} ${x2} ${y2}`);
        svg.appendChild(connector);
      }
    };
    window.requestAnimationFrame(repaint);
  }

  window.addEventListener('resize', () => repaint());
  $('previous').onclick = () => select(selected - 1);
  $('next').onclick = () => select(selected + 1);
  $('search').addEventListener('input', renderList);
  $('show-operands').onclick = () => showRaw(false);
  $('show-raw').onclick = () => showRaw(true);
  $('copy-raw').onclick = () => vscode.postMessage({type: 'copyRaw', index: selected});

  function renderList() {
    const list = $('list');
    list.replaceChildren();
    const query = $('search').value.toLowerCase();
    let count = 0;
    for (const [index, text] of searchIndex.entries()) {
      if (!text.includes(query)) continue;
      if (count++ >= 200) continue;
      const row = circuit.instructions[index];
      const button = add(list, 'button', '', 'listitem');
      button.setAttribute('aria-label', `${label(String(index))}${row.partial ? ', partial decode' : ''}`);
      button.dataset.index = String(index);
      add(button, 'span', String(index), 'list-index');
      add(button, 'span', row.raw.op);
      if (row.partial) add(button, 'span', '!', 'list-warning').setAttribute('aria-hidden', 'true');
      if (index === selected) button.setAttribute('aria-current', 'true');
      button.onclick = () => select(index);
    }
    $('list-count').textContent = query ? `${count} / ${searchIndex.length}` : String(count);
    if (count > 200) add(list, 'p', `Showing 200 of ${count}. Search to narrow the list.`, 'muted');
    if (!count && query) add(list, 'p', 'No matching instructions.', 'muted');
  }

  window.addEventListener('message', ({data: message}) => {
    if (message.type === 'load') {
      circuit = message.circuit;
      searchIndex = circuit.instructions.map(({raw}, index) => `${index} ${raw.op} ${JSON.stringify(raw)}`.toLowerCase());
      incoming.clear();
      outgoing.clear();
      for (const edge of circuit.edges) {
        for (const [connections, id] of [[incoming, edge.target], [outgoing, edge.source]]) {
          if (!connections.has(id)) connections.set(id, []);
          connections.get(id).push(edge);
        }
      }
      $('search').disabled = false;
      $('search').value = '';
      $('file').textContent = message.name;
      $('file').hidden = false;
      $('artifact-meta').hidden = false;
      $('version').textContent = `ZKIR ${circuit.version}`;
      const status = $('decode-status');
      status.textContent = circuit.status === 'partial' ? 'Partial decode' : 'Structural decode complete';
      status.dataset.status = circuit.status;
      renderList();
      select(message.selected ?? 0);
    } else if (message.type === 'select' && circuit) select(message.selected);
    else if (message.type === 'copyResult' && message.index === selected) {
      $('copy-status').textContent = message.ok ? 'Copied' : 'Could not copy. Select the JSON to copy it manually.';
    }
  });
  vscode.postMessage({type: 'ready'});
})();
