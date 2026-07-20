const fs = require('fs');
const path = require('path');

const reportPath = process.argv[2];

if (!reportPath) {
  console.error('Usage: node generate-issues-list.js <report.json> [outputDir] [chunkSize]');
  process.exit(2);
}

const resolvedReportPath = path.resolve(reportPath);
const outputDir = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(path.dirname(resolvedReportPath), 'issues-list');
const chunkSizeArg = Number(process.argv[4] || '100');
const chunkSize = Number.isFinite(chunkSizeArg) && chunkSizeArg > 0 ? chunkSizeArg : 100;

if (fs.existsSync(outputDir)) {
  fs.rmSync(outputDir, { recursive: true, force: true });
}
fs.mkdirSync(outputDir, { recursive: true });

const report = JSON.parse(fs.readFileSync(resolvedReportPath, 'utf8'));
const findings = report.findings;
const total = findings.length;

function escapeForMarkdown(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatSnippet(snippet) {
  if (typeof snippet !== 'string') return '';
  const normalized = snippet.replace(/\s+/g, ' ').trim();
  return escapeForMarkdown(normalized);
}

console.log(`Total findings: ${total}`);
console.log(`Generating ${Math.ceil(total / chunkSize)} files...\n`);

for (let i = 0; i < Math.ceil(total / chunkSize); i++) {
  const startIdx = i * chunkSize;
  const endIdx = Math.min((i + 1) * chunkSize, total);
  const chunk = findings.slice(startIdx, endIdx);

  let content = '';

  chunk.forEach(finding => {
    const snippet = formatSnippet(finding.htmlSnippet);
    content += `file name: ${finding.filePath || ''}\n`;
    content += `line number: ${finding.line || ''}\n`;
    content += `code snippet: ${snippet}\n`;
    content += `issue title: ${finding.title || ''}\n\n`;
  });

  const outFile = path.join(outputDir, `issues-list-part-${i + 1}.md`);
  fs.writeFileSync(outFile, content, 'utf8');
  const fileSize = (fs.statSync(outFile).size / 1024).toFixed(1);
  console.log(`✓ Created part ${i + 1}: ${chunk.length} issues (${fileSize} KB)`);
}

console.log(`\n✅ Done! Files generated in: ${outputDir}`);
