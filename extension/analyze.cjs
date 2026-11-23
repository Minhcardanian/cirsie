const {parentPort, workerData} = require('node:worker_threads');
const {webcrypto} = require('node:crypto');
const {version} = require('../package.json');

async function run() {
  try {
    const {analysisJson, analyzeArtifact, compareArtifacts, comparisonMarkdown} = await import('../src/analysis.js');
    const {format, bytes, name, maxBytes, baseline, candidate} = workerData;
    if (format === 'json') {
      parentPort.postMessage({content: analysisJson(baseline, candidate, workerData.comparison)});
      return;
    }

    const analysis = await analyzeArtifact(bytes, name, version, maxBytes, webcrypto);
    const comparison = baseline ? compareArtifacts(baseline, analysis) : undefined;
    const markdown = comparison ? comparisonMarkdown(baseline, analysis, comparison) : undefined;
    parentPort.postMessage({analysis, comparison, markdown});
  } catch (error) {
    parentPort.postMessage({error: error.message});
  }
}
run();
