const fs = require('fs');
const path = require('path');

const json = JSON.parse(fs.readFileSync(
  'C:\\a11y-scanner-main\\packages\\a11y-scout\\a11y-reports\\Hyland-Applications-Web-Client-2026-07-15T13-02-00\\report.json',
  'utf8'
));

const altFindings = json.findings.filter(f => f.ruleId === 'aspnet/alt-text');

console.log('=== ALT-TEXT FINDINGS ANALYSIS ===\n');
console.log(`Total alt-text findings: ${altFindings.length}\n`);

// Group by file
const byFile = {};
altFindings.forEach(f => {
  if (!byFile[f.filePath]) byFile[f.filePath] = [];
  byFile[f.filePath].push(f);
});

console.log(`Files with alt-text violations: ${Object.keys(byFile).length}\n`);

// Show some examples
console.log('First 15 findings:');
altFindings.slice(0, 15).forEach((f, i) => {
  console.log(`${i + 1}. ${f.filePath}:${f.line}`);
  console.log(`   HTML: ${f.htmlSnippet.substring(0, 80)}`);
});

// Export file list for checking code-behind
console.log('\n\n=== FILES TO CHECK FOR DYNAMIC ALT INJECTION ===');
const filesToCheck = [...new Set(altFindings.map(f => {
  const dir = path.dirname(f.filePath);
  const name = path.basename(f.filePath, '.aspx');
  return { aspx: f.filePath, codeBehind: dir ? `${dir}/${name}.aspx.cs` : `${name}.aspx.cs` };
}))];

filesToCheck.slice(0, 10).forEach(f => {
  console.log(`\nASPX: ${f.aspx}`);
  console.log(`C#:   ${f.codeBehind}`);
});
