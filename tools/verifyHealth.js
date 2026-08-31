const store = require('../lib/store');
const runner = require('../lib/runner');
const healthcheck = require('../lib/healthcheck');

async function main() {
  const projectId = process.argv[2];
  if (!projectId) {
    console.error(JSON.stringify({ error: 'Missing project ID argument' }));
    process.exit(1);
  }

  try {
    const projects = await store.getProjects();
    const project = projects.find(p => p.id === projectId);
    if (!project) {
      console.error(JSON.stringify({ error: `Project not found with ID: ${projectId}` }));
      process.exit(1);
    }

    // Start project
    await runner.start(project);

    // Wait 6 seconds
    await new Promise(resolve => setTimeout(resolve, 6000));

    // Check health
    const result = await healthcheck.checkProject(project, runner);

    // Print result as JSON before exit
    console.log(JSON.stringify(result, null, 2));

    // Exit based on healthy status
    process.exit(result.healthy ? 0 : 1);
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
