const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const ALLOWED_ALGORITHMS = ['md5', 'sha1', 'sha256', 'sha512'];
const DEFAULT_ALGORITHM = 'sha256';
const CHUNK_SIZE = 64 * 1024;
const MAX_FILE_SIZE = 500 * 1024 * 1024;
const CONCURRENT_LIMIT = 5;
let activeStreams = 0;

function sanitizePath(filePath) {
  if (!filePath) return null;
  const normalized = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const resolved = path.join(PUBLIC_DIR, normalized);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    return null;
  }
  return resolved;
}

function generateHash(filePath, algorithm = DEFAULT_ALGORITHM) {
  return new Promise((resolve, reject) => {
    if (!ALLOWED_ALGORITHMS.includes(algorithm)) {
      return reject(new Error(`Unsupported algorithm. Allowed: ${ALLOWED_ALGORITHMS.join(', ')}`));
    }

    let stats;
    try {
      stats = fs.statSync(filePath);
    } catch (err) {
      return reject(err);
    }

    if (stats.size > MAX_FILE_SIZE) {
      return reject(new Error(`File too large. Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`));
    }

    if (activeStreams >= CONCURRENT_LIMIT) {
      return reject(new Error('Too many concurrent requests. Please try again later.'));
    }

    activeStreams++;

    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath, {
      highWaterMark: CHUNK_SIZE,
      autoClose: true,
    });

    let bytesProcessed = 0;
    let isDestroyed = false;

    const cleanup = () => {
      if (!isDestroyed) {
        isDestroyed = true;
        activeStreams = Math.max(0, activeStreams - 1);
        stream.destroy();
      }
    };

    stream.on('error', (err) => {
      cleanup();
      reject(err);
    });

    stream.on('data', (chunk) => {
      bytesProcessed += chunk.length;
      hash.update(chunk);

      if (bytesProcessed % (CHUNK_SIZE * 16) === 0) {
        stream.pause();
        setImmediate(() => {
          if (!isDestroyed) stream.resume();
        });
      }
    });

    stream.on('end', () => {
      cleanup();
      resolve({
        hash: hash.digest('hex'),
        bytesProcessed,
        fileSize: stats.size,
      });
    });

    stream.on('close', () => {
      cleanup();
    });
  });
}

function getFileInfo(filePath) {
  return new Promise((resolve, reject) => {
    fs.stat(filePath, (err, stats) => {
      if (err) return reject(err);
      resolve({
        filename: path.basename(filePath),
        size: stats.size,
        modified: stats.mtime.toISOString(),
        created: stats.birthtime.toISOString(),
      });
    });
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
      if (body.length > 1e6) {
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function limitConcurrency(items, limit, processor) {
  const results = [];
  const executing = [];

  for (const item of items) {
    const p = Promise.resolve().then(() => processor(item));
    results.push(p);

    if (limit <= items.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }
  }

  return Promise.all(results);
}

function getMemoryStats() {
  const mem = process.memoryUsage();
  return {
    rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
    heapTotal: `${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
    heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
    external: `${Math.round(mem.external / 1024 / 1024)}MB`,
    activeStreams,
    maxConcurrentStreams: CONCURRENT_LIMIT,
    maxFileSize: `${MAX_FILE_SIZE / 1024 / 1024}MB`,
    chunkSize: `${CHUNK_SIZE / 1024}KB`,
  };
}

function scanDirectory(dir, baseDir = dir, extensions = null) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      results.push(...scanDirectory(fullPath, baseDir, extensions));
    } else if (entry.isFile()) {
      if (entry.name.startsWith('.')) continue;
      if (extensions && extensions.length > 0) {
        const ext = path.extname(entry.name).toLowerCase().slice(1);
        if (!extensions.includes(ext)) continue;
      }
      results.push({
        path: relativePath,
        fullPath,
        name: entry.name,
      });
    }
  }

  return results;
}

async function generateManifest(options = {}) {
  const {
    algorithm = DEFAULT_ALGORITHM,
    extensions = null,
    format = 'json',
    prefix = '',
  } = options;

  const files = scanDirectory(PUBLIC_DIR, PUBLIC_DIR, extensions);
  const startTime = Date.now();

  const results = await limitConcurrency(files, 2, async (file) => {
    try {
      const hashResult = await generateHash(file.fullPath, algorithm);
      const stats = fs.statSync(file.fullPath);
      return {
        path: prefix + file.path,
        hash: hashResult.hash,
        size: stats.size,
        modified: stats.mtime.toISOString(),
      };
    } catch (err) {
      return {
        path: prefix + file.path,
        error: err.message,
      };
    }
  });

  const duration = Date.now() - startTime;
  const validResults = results.filter(r => !r.error);
  const manifest = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    algorithm,
    duration: `${duration}ms`,
    totalFiles: files.length,
    processedFiles: validResults.length,
    failedFiles: results.length - validResults.length,
    files: validResults,
  };

  if (format === 'json') {
    return { contentType: 'application/json', content: JSON.stringify(manifest, null, 2) };
  } else if (format === 'text') {
    const lines = [
      `# Resource Manifest`,
      `# Generated: ${manifest.generatedAt}`,
      `# Algorithm: ${algorithm}`,
      `# Duration: ${duration}ms`,
      `# Files: ${validResults.length}/${files.length}`,
      ``,
      `# Path\tHash\tSize\tModified`,
      ...validResults.map(f => `${f.path}\t${f.hash}\t${f.size}\t${f.modified}`),
    ];
    return { contentType: 'text/plain; charset=utf-8', content: lines.join('\n') };
  } else if (format === 'html') {
    const rows = validResults.map(f => `
      <tr>
        <td style="padding: 8px 12px; border-bottom: 1px solid #eee; font-family: monospace;">${f.path}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #eee; font-family: monospace; color: #667eea;">${f.hash}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #eee; text-align: right;">${(f.size / 1024).toFixed(2)} KB</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #eee; color: #666;">${f.modified}</td>
      </tr>
    `).join('');

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Resource Manifest</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f7fa; }
    .container { max-width: 1200px; margin: 0 auto; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); overflow: hidden; }
    .header { padding: 24px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }
    .header h1 { margin: 0 0 8px 0; font-size: 24px; }
    .header .stats { display: flex; gap: 24px; margin-top: 16px; flex-wrap: wrap; }
    .header .stat { background: rgba(255,255,255,0.2); padding: 8px 16px; border-radius: 4px; }
    .header .stat .label { font-size: 12px; opacity: 0.8; }
    .header .stat .value { font-size: 18px; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #f8f9fa; padding: 12px; text-align: left; font-weight: 600; color: #333; border-bottom: 2px solid #e9ecef; }
    tr:hover { background: #f8f9fa; }
    .hash { font-family: 'Courier New', monospace; color: #667eea; }
    .path { font-family: 'Courier New', monospace; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📦 Resource Manifest</h1>
      <p style="margin: 0; opacity: 0.9;">Generated at ${manifest.generatedAt}</p>
      <div class="stats">
        <div class="stat"><div class="label">Algorithm</div><div class="value">${algorithm.toUpperCase()}</div></div>
        <div class="stat"><div class="label">Files</div><div class="value">${validResults.length}</div></div>
        <div class="stat"><div class="label">Duration</div><div class="value">${duration}ms</div></div>
        <div class="stat"><div class="label">Total Size</div><div class="value">${(validResults.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(2)} MB</div></div>
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th>Path</th>
          <th>Hash</th>
          <th>Size</th>
          <th>Modified</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>
</body>
</html>`;
    return { contentType: 'text/html; charset=utf-8', content: html };
  }

  return { contentType: 'application/json', content: JSON.stringify(manifest, null, 2) };
}

function sendResponse(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data, null, 2));
}

function sendContent(res, statusCode, contentType, content) {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(content);
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  try {
    if (pathname === '/api/hash' && method === 'GET') {
      const { file, algorithm } = parsedUrl.query;
      const sanitizedPath = sanitizePath(file);

      if (!sanitizedPath) {
        return sendResponse(res, 400, { error: 'Invalid or missing file path' });
      }

      if (!fs.existsSync(sanitizedPath)) {
        return sendResponse(res, 404, { error: 'File not found' });
      }

      const [hashResult, fileInfo] = await Promise.all([
        generateHash(sanitizedPath, algorithm),
        getFileInfo(sanitizedPath),
      ]);

      sendResponse(res, 200, {
        success: true,
        algorithm: algorithm || DEFAULT_ALGORITHM,
        hash: hashResult.hash,
        bytesProcessed: hashResult.bytesProcessed,
        ...fileInfo,
      });
    } else if (pathname === '/api/hash/batch' && method === 'POST') {
      const body = await parseBody(req);
      const { files, algorithm } = body;

      if (!Array.isArray(files) || files.length === 0) {
        return sendResponse(res, 400, { error: 'Invalid or empty files array' });
      }

      const results = await limitConcurrency(files, 2, async (file) => {
        const sanitizedPath = sanitizePath(file);
        if (!sanitizedPath || !fs.existsSync(sanitizedPath)) {
          return { file, error: 'File not found or invalid path' };
        }
        try {
          const [hashResult, fileInfo] = await Promise.all([
            generateHash(sanitizedPath, algorithm),
            getFileInfo(sanitizedPath),
          ]);
          return {
            file,
            success: true,
            algorithm: algorithm || DEFAULT_ALGORITHM,
            hash: hashResult.hash,
            bytesProcessed: hashResult.bytesProcessed,
            ...fileInfo,
          };
        } catch (err) {
          return { file, error: err.message };
        }
      });

      sendResponse(res, 200, { success: true, results });
    } else if (pathname === '/api/algorithms' && method === 'GET') {
      sendResponse(res, 200, {
        success: true,
        algorithms: ALLOWED_ALGORITHMS,
        default: DEFAULT_ALGORITHM,
      });
    } else if (pathname === '/api/files' && method === 'GET') {
      fs.readdir(PUBLIC_DIR, { withFileTypes: true }, (err, entries) => {
        if (err) {
          return sendResponse(res, 500, { error: 'Failed to read directory' });
        }
        const files = entries
          .filter((e) => e.isFile())
          .map((e) => e.name);
        sendResponse(res, 200, { success: true, files });
      });
    } else if (pathname === '/api/manifest' && method === 'GET') {
      const { algorithm, ext, format, prefix } = parsedUrl.query;

      let extensions = null;
      if (ext) {
        extensions = Array.isArray(ext) ? ext : [ext];
        extensions = extensions.map(e => e.toLowerCase().replace(/^\./, ''));
      }

      try {
        const result = await generateManifest({
          algorithm,
          extensions,
          format: format || 'json',
          prefix: prefix || '',
        });
        sendContent(res, 200, result.contentType, result.content);
      } catch (err) {
        sendResponse(res, 500, { error: err.message });
      }
    } else if (pathname === '/api/stats' && method === 'GET') {
      sendResponse(res, 200, {
        success: true,
        memory: getMemoryStats(),
        uptime: `${Math.floor(process.uptime())}s`,
      });
    } else if (pathname === '/' || pathname === '/health') {
      sendResponse(res, 200, {
        success: true,
        status: 'running',
        memory: getMemoryStats(),
        uptime: `${Math.floor(process.uptime())}s`,
        endpoints: {
          'GET /api/algorithms': 'List supported hash algorithms',
          'GET /api/files': 'List available files in public directory',
          'GET /api/stats': 'Show memory and performance stats',
          'GET /api/manifest': 'Generate resource manifest with file hashes',
          'GET /api/hash?file=:filename&algorithm=:algo': 'Get hash for a single file',
          'POST /api/hash/batch': 'Get hashes for multiple files (body: { files: [], algorithm: string })',
        },
      });
    } else {
      sendResponse(res, 404, { error: 'Endpoint not found' });
    }
  } catch (err) {
    sendResponse(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`File Hash API Server running on http://localhost:${PORT}`);
  console.log(`Public directory: ${PUBLIC_DIR}`);
  console.log('');
  console.log('Memory Optimization Settings:');
  console.log(`  Chunk size: ${CHUNK_SIZE / 1024}KB`);
  console.log(`  Max file size: ${MAX_FILE_SIZE / 1024 / 1024}MB`);
  console.log(`  Concurrent streams limit: ${CONCURRENT_LIMIT}`);
  console.log('');
  console.log('Available endpoints:');
  console.log('  GET  http://localhost:' + PORT + '/api/algorithms');
  console.log('  GET  http://localhost:' + PORT + '/api/files');
  console.log('  GET  http://localhost:' + PORT + '/api/stats');
  console.log('  GET  http://localhost:' + PORT + '/api/manifest?format=json');
  console.log('  GET  http://localhost:' + PORT + '/api/manifest?format=html&ext=js&ext=css');
  console.log('  GET  http://localhost:' + PORT + '/api/hash?file=example.txt&algorithm=sha256');
  console.log('  POST http://localhost:' + PORT + '/api/hash/batch');
});
