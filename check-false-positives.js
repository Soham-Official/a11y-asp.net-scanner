const fs = require('fs');
const path = require('path');

// Files to check (from the 16 findings)
const filesToCheck = [
  { aspx: 'FileUploadEnhancedRightPage.aspx', line: 72, description: 'js-imgPreview' },
  { aspx: 'Acc\\AccDocSelectPage.aspx', line: 331, description: 'imgArrow' },
  { aspx: 'BatchIndexing\\CommittedBatchQuery.aspx', line: 41, description: 'batchNumberRange_middleGap' },
  { aspx: 'Diagnostics\\logProfileController.aspx', line: 113, description: 'LogsAllProfilesWarningIcon asp:Image' },
  { aspx: 'OnBaseApps\\WFUserInteraction.aspx', line: 467, description: 'Loading_Dots' },
  { aspx: 'Packets\\FullSizePreview.aspx', line: 22, description: 'imageUrl' },
  { aspx: 'Packets\\PacketPreview.aspx', line: 61, description: 'alert_18x18.png' },
  { aspx: 'ReportingDashboards\\ReportViewer.aspx', line: 34, description: 'refreshDataButton ImageButton' },
  { aspx: 'Sharepoint\\SharePointKeywordPanel.aspx', line: 209, description: 'Loading_Dots_290x60' },
];

const repoRoot = 'C:\\OnBase\\DEV\\Core\\OnBase.NET\\Applications\\Hyland.Applications.Web.Client';

console.log('=== CHECKING FOR DYNAMIC ALT INJECTION ===\n');

let falsePositives = [];
let confirmed = [];

filesToCheck.forEach(item => {
  const aspxPath = path.join(repoRoot, item.aspx);
  const csPath = aspxPath.replace('.aspx', '.aspx.cs');
  
  console.log(`\n${item.aspx}:${item.line} (${item.description})`);
  console.log('─'.repeat(70));
  
  // Check if ASPX file exists and read it
  if (fs.existsSync(aspxPath)) {
    try {
      const aspxContent = fs.readFileSync(aspxPath, 'utf8');
      const lines = aspxContent.split('\n');
      const targetLine = lines[item.line - 1];
      
      console.log(`ASPX Line ${item.line}:`);
      console.log(`  ${targetLine.trim().substring(0, 100)}`);
      
      // Check if alt is present (even with server expressions)
      if (targetLine.includes('alt=')) {
        console.log(`  ✓ ALT ATTRIBUTE FOUND in markup`);
        falsePositives.push({ file: item.aspx, line: item.line, reason: 'alt attribute present in markup' });
      }
      
      // Check for nearby lines with alt assignment
      const context = lines.slice(Math.max(0, item.line - 3), Math.min(lines.length, item.line + 3));
      const hasNearbyAlt = context.some(l => l.includes('alt=') || l.includes('alt:'));
      if (hasNearbyAlt && !targetLine.includes('alt=')) {
        console.log(`  ? ALT might be set in nearby lines`);
      }
      
    } catch (e) {
      console.log(`  ✗ Could not read ASPX file: ${e.message}`);
    }
  } else {
    console.log(`  ✗ ASPX file not found: ${aspxPath}`);
  }
  
  // Check if CS file exists and search for alt-related assignments
  if (fs.existsSync(csPath)) {
    try {
      const csContent = fs.readFileSync(csPath, 'utf8');
      
      // Look for patterns like imgPreview.Alt = or querySelector('.js-imgPreview').alt = 
      const imageId = item.description.split(' ')[0];
      const patterns = [
        new RegExp(`${imageId}.*\\..*[Aa]lt\\s*=`, 'i'),
        new RegExp(`'${imageId}'.*\\..*[Aa]lt\\s*=`, 'i'),
        new RegExp(`"${imageId}".*\\..*[Aa]lt\\s*=`, 'i'),
        /\.alt\s*=/gi,
        /AlternateText\s*=/gi,
      ];
      
      let foundDynamicAlt = false;
      patterns.forEach(pattern => {
        if (pattern.test(csContent)) {
          foundDynamicAlt = true;
        }
      });
      
      if (foundDynamicAlt) {
        console.log(`  ✓ Code-behind likely sets alt dynamically`);
        falsePositives.push({ file: item.aspx, line: item.line, reason: 'alt set in code-behind' });
      } else {
        console.log(`  ✗ No dynamic alt assignment found in code-behind`);
        confirmed.push({ file: item.aspx, line: item.line });
      }
      
    } catch (e) {
      console.log(`  ? Could not fully analyze code-behind`);
    }
  } else {
    console.log(`  ? Code-behind file not found: ${csPath}`);
  }
});

console.log('\n\n=== SUMMARY ===');
console.log(`Potential FALSE POSITIVES: ${falsePositives.length}`);
falsePositives.forEach(f => console.log(`  - ${f.file}:${f.line} (${f.reason})`));

console.log(`\nCONFIRMED VIOLATIONS: ${confirmed.length}`);
confirmed.forEach(f => console.log(`  - ${f.file}:${f.line}`));

console.log(`\nTotal analyzed: ${filesToCheck.length}`);
console.log(`False positive rate: ${((falsePositives.length / filesToCheck.length) * 100).toFixed(1)}%`);
