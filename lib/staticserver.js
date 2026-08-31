const http = require('http');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(process.argv[2] || '.');
const port = parseInt(process.argv[3] || '5500', 10);

const contentTypeMap = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
};

// Array of active SSE connections for live reloading
const sseClients = [];

function notifyClients() {
  for (const client of sseClients) {
    try {
      client.write('data: reload\n\n');
    } catch (err) {
      // Ignore write errors (closed connections)
    }
  }
}

// Watch directory for changes and trigger reload
let debounceTimeout = null;
try {
  fs.watch(rootDir, { recursive: true }, (eventType, filename) => {
    clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(() => {
      notifyClients();
    }, 150);
  });
} catch (err) {
  console.warn('Warning: fs.watch recursive failed. Live reload disabled. Reason:', err.message);
}

const server = http.createServer((req, res) => {
  // 1. SSE Live reload endpoint
  if (req.url === '/__livereload') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write('data: connected\n\n');
    sseClients.push(res);
    req.on('close', () => {
      const idx = sseClients.indexOf(res);
      if (idx !== -1) {
        sseClients.splice(idx, 1);
      }
    });
    return;
  }

  // 2. Resolve requested filepath safely
  const urlPath = req.url.split('?')[0].split('#')[0];
  let targetPath = path.join(rootDir, urlPath === '/' ? 'index.html' : urlPath);

  // Prevent directory traversal attacks
  if (!targetPath.startsWith(rootDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  // Handle directories by defaulting to index.html inside them
  try {
    const stats = fs.statSync(targetPath);
    if (stats.isDirectory()) {
      targetPath = path.join(targetPath, 'index.html');
    }
  } catch (err) {
    // Stat failure implies file does not exist, handled by fs.readFile below
  }

  fs.readFile(targetPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('الملف غير موجود (404)');
      return;
    }

    const ext = path.extname(targetPath).toLowerCase();
    const contentType = contentTypeMap[ext] || 'application/octet-stream';

    // 3. Inject live reload client script into HTML files
    if (ext === '.html') {
      const htmlContent = data.toString('utf8');
      const scriptTag = `
<script>
  (function() {
    var sse = new EventSource('/__livereload');
    sse.onmessage = function(e) {
      if (e.data === 'reload') {
        console.log('[Live Reload] Reloading page...');
        location.reload();
      }
    };
  })();
</script>
</body>`;
      
      const injected = htmlContent.includes('</body>') 
        ? htmlContent.replace('</body>', scriptTag) 
        : htmlContent + scriptTag;

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(injected, 'utf8');
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    }
  });
});

// Loopback only: these are the user's own project folders being served, and
// they have no business being reachable from the local network.
server.listen(port, '127.0.0.1', () => {
  // Print exact expected startup string so runner's regex matches the port
  console.log(`Server listening on port ${port}`);
});
