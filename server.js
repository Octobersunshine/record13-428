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

function sendResponse(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data, null, 2));
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
  console.log('  GET  http://localhost:' + PORT + '/api/hash?file=example.txt&algorithm=sha256');
  console.log('  POST http://localhost:' + PORT + '/api/hash/batch');
});
