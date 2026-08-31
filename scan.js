const path = require('path');
const config = require('./config.json');
const { scanProjects } = require('./lib/scanner');
const { extractMetadata } = require('./lib/metadata');
const { findDuplicates } = require('./lib/duplicates');
const { saveProjects } = require('./lib/store');
const { classifyProject } = require('./lib/classifier');
const { groupBackups } = require('./lib/backups');

async function main() {
  console.log('=== Maktaba CLI Test Scan ===');
  
  // Override config for this test run
  const testConfig = {
    ...config,
    roots: ['C:\\projects'],
    maxDepth: 4
  };

  console.log(`Roots to scan: ${JSON.stringify(testConfig.roots)}`);
  console.log(`Max depth: ${testConfig.maxDepth}`);
  console.log(`Directories to skip: ${testConfig.skipDirs.length} configured`);

  try {
    console.log('\n1. Scanning directories...');
    const rawProjects = await scanProjects(testConfig);
    console.log(`   Found ${rawProjects.length} candidate project directories.`);

    console.log('\n2. Extracting project metadata...');
    const projects = [];
    for (const rawProj of rawProjects) {
      try {
        const metadata = await extractMetadata(rawProj.path, rawProj.markers);
        projects.push({
          path: rawProj.path,
          ...metadata
        });
      } catch (err) {
        console.error(`   [Error] Failed to extract metadata for ${rawProj.path}:`, err.message);
      }
    }

    console.log('\n3. Detecting duplicate projects...');
    const duplicateMap = await findDuplicates(projects);
    for (const proj of projects) {
      proj.duplicates = duplicateMap[proj.path] || [];
    }

    console.log('\n3.5 Classifying projects...');
    for (const proj of projects) {
      try {
        const result = await classifyProject(proj);
        proj.confidence = result.confidence;
        proj.classification = result.classification;
        proj.signals = result.signals;
      } catch (err) {
        console.error(`   [Error] Failed to classify ${proj.path}:`, err.message);
      }
    }

    console.log('\n3.8 Grouping backup-like duplicates...');
    groupBackups(projects);

    console.log('\n4. Saving results to store...');
    await saveProjects(projects);

    console.log('\n=== Scan Results ===');
    const tableData = projects.map(p => ({
      Name: p.name,
      Type: p.type,
      Port: p.port !== null ? p.port : 'N/A',
      EntryFile: p.entryFile !== null ? p.entryFile : 'N/A',
      DuplicatesCount: p.duplicates.length
    }));

    if (tableData.length > 0) {
      console.table(tableData);
    } else {
      console.log('No projects detected in the target directories.');
    }

    console.log(`\nScan finished. Total projects processed and stored: ${projects.length}`);

  } catch (err) {
    console.error('\n[Fatal Error] Scan process encountered an error:', err);
  }
}

main();
