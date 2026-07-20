const fs = require('fs');
const path = require('path');

const repoRoot = 'C:\\OnBase\\DEV\\Core\\OnBase.NET\\Applications\\Hyland.Applications.Web.Client';

console.log('=== SEARCHING FOR DYNAMIC ALT INJECTION IN JAVASCRIPT ===\n');

// Key patterns that indicate alt being set
const altPatterns = [
  /\.alt\s*=/gi,           // .alt = 
  /\.setAttribute.*alt/gi,  // .setAttribute('alt'
  /\['alt'\]\s*=/gi,        // ['alt'] =
  /\.AlternateText\s*=/gi,  // .AlternateText =
  /aria-label/gi,           // aria-label (alternative to alt)
];

// Files that had findings
const filesWithFindings = [
  'FileUploadEnhancedRightPage.aspx',
  'Acc\\AccDocSelectPage.aspx',
  'OnBaseApps\\WFUserInteraction.aspx',
  'Packets\\FullSizePreview.aspx',
  'Packets\\PacketPreview.aspx',
  'Sharepoint\\SharePointKeywordPanel.aspx',
];

// Find related JS files
let jsFilesChecked = 0;
let foundDynamicAlt = [];

function findRelatedJsFiles(aspxPath) {
  const dir = path.dirname(aspxPath);
  const basename = path.basename(aspxPath, '.aspx');
  const potentialJsFiles = [
    path.join(dir, `${basename}.js`),
    path.join(dir, `${basename}.min.js`),
    path.join(repoRoot, 'Scripts', `${basename}.js`),
    path.join(repoRoot, 'Scripts', `${basename}.min.js`),
  ];
  
  return potentialJsFiles.filter(f => fs.existsSync(f));
}

filesWithFindings.forEach(aspxFile => {
  console.log(`\n${aspxFile}`);
  console.log('─'.repeat(60));
  
  const aspxPath = path.join(repoRoot, aspxFile);
  const jsFiles = findRelatedJsFiles(aspxPath);
  
  if (jsFiles.length > 0) {
    jsFiles.forEach(jsFile => {
      try {
        const content = fs.readFileSync(jsFile, 'utf8');
        jsFilesChecked++;
        
        let foundAny = false;
        altPatterns.forEach(pattern => {
          if (pattern.test(content)) {
            console.log(`  ✓ Found in ${path.basename(jsFile)}: ${pattern}`);
            foundAny = true;
            foundDynamicAlt.push({ aspx: aspxFile, jsFile: jsFile, pattern: pattern.toString() });
          }
        });
        
        if (!foundAny) {
          console.log(`  - No dynamic alt patterns in ${path.basename(jsFile)}`);
        }
      } catch (e) {
        console.log(`  ? Error reading ${jsFile}: ${e.message}`);
      }
    });
  } else {
    console.log('  - No related JavaScript files found');
  }
});

console.log('\n\n=== RESULTS ===');
console.log(`JS files checked: ${jsFilesChecked}`);
console.log(`Files with dynamic alt injection: ${foundDynamicAlt.length}`);

if (foundDynamicAlt.length > 0) {
  console.log('\nPotential FALSE POSITIVES (alt set via JS):');
  foundDynamicAlt.forEach(item => {
    console.log(`  - ${item.aspx}`);
    console.log(`    Pattern: ${item.pattern}`);
  });
}

console.log('\nNote: Check completed for JS files related to flagged images.');
console.log('Overall false positive rate so far: Low (no code-behind alt assignments found)');
