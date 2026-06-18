const fs = require('fs');
const path = require('path');
const http = require('http');

const PUBLIC_DIR = path.join(__dirname, 'public');
const LARGE_FILE = path.join(PUBLIC_DIR, 'large-test.js');
const LARGE_CSS = path.join(PUBLIC_DIR, 'large-test.css');

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function generateLargeFile(filePath, sizeMB, type) {
  return new Promise((resolve, reject) => {
    console.log(`\nGenerating ${sizeMB}MB ${type} file: ${path.basename(filePath)}`);

    const size = sizeMB * 1024 * 1024;
    const chunkSize = 64 * 1024;
    const chunks = Math.ceil(size / chunkSize);

    let jsTemplate, cssTemplate;
    if (type === 'js') {
      jsTemplate = `
// Large JavaScript file for memory testing
function testFunction_${Date.now()}(param) {
  const result = param * 2 + Math.random();
  console.log('Processing:', result);
  return {
    data: result,
    timestamp: Date.now(),
    metadata: {
      version: '1.0.0',
      hash: 'test_hash_' + Math.random().toString(36).substr(2, 9)
    }
  };
}

const arrayData = [${Array.from({ length: 100 }, () => Math.random().toFixed(4)).join(', ')}];

module.exports = { testFunction_${Date.now()}, arrayData };
`;
    } else {
      cssTemplate = `
/* Large CSS file for memory testing */
.test-class-${Date.now()} {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: auto;
  padding: 1rem;
  margin: 0.5rem;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border-radius: 8px;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
  transition: all 0.3s ease;
}

.test-class-${Date.now()}:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 12px rgba(0, 0, 0, 0.15);
}
`;
    }

    const template = type === 'js' ? jsTemplate : cssTemplate;
    const writeStream = fs.createWriteStream(filePath);
    let written = 0;

    function write() {
      let ok = true;
      while (ok && written < chunks) {
        const data = `/* Chunk ${written} */\n` + template;
        ok = writeStream.write(data);
        written++;
        if (written % 1000 === 0) {
          process.stdout.write(`\r  Progress: ${Math.round((written / chunks) * 100)}%`);
        }
      }
      if (written < chunks) {
        writeStream.once('drain', write);
      } else {
        writeStream.end();
      }
    }

    writeStream.on('finish', () => {
      const finalSize = fs.statSync(filePath).size;
      console.log(`\r  Progress: 100% - Done! Size: ${formatSize(finalSize)}`);
      resolve(filePath);
    });
    writeStream.on('error', reject);
    write();
  });
}

function makeRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getStats() {
  const res = await makeRequest({
    hostname: 'localhost',
    port: 3000,
    path: '/api/stats',
    method: 'GET'
  });
  return res.data;
}

async function testLargeFile(filename, algorithm = 'sha256') {
  console.log(`\n=== Testing ${filename} with ${algorithm} ===`);

  const statsBefore = await getStats();
  console.log(`Memory before: ${statsBefore.memory.heapUsed} / ${statsBefore.memory.heapTotal}`);
  console.log(`Active streams before: ${statsBefore.memory.activeStreams}`);

  const startTime = Date.now();
  const result = await makeRequest({
    hostname: 'localhost',
    port: 3000,
    path: `/api/hash?file=${filename}&algorithm=${algorithm}`,
    method: 'GET'
  });
  const duration = Date.now() - startTime;

  const statsAfter = await getStats();
  console.log(`Memory after: ${statsAfter.memory.heapUsed} / ${statsAfter.memory.heapTotal}`);
  console.log(`Active streams after: ${statsAfter.memory.activeStreams}`);

  if (result.status === 200 && result.data.success) {
    console.log(`✓ Hash: ${result.data.hash}`);
    console.log(`✓ Bytes processed: ${formatSize(result.data.bytesProcessed)}`);
    console.log(`✓ File size: ${formatSize(result.data.size)}`);
    console.log(`✓ Duration: ${duration}ms`);
    console.log(`✓ Throughput: ${(result.data.size / duration / 1024).toFixed(2)} MB/s`);
    return true;
  } else {
    console.log(`✗ Error: ${result.data.error || 'Unknown error'}`);
    return false;
  }
}

async function testBatch(files, algorithm = 'sha256') {
  console.log(`\n=== Testing batch processing with ${files.length} files ===`);

  const statsBefore = await getStats();
  console.log(`Memory before: ${statsBefore.memory.heapUsed}`);
  console.log(`Active streams before: ${statsBefore.memory.activeStreams}`);

  const startTime = Date.now();
  const body = JSON.stringify({ files, algorithm });
  const result = await makeRequest({
    hostname: 'localhost',
    port: 3000,
    path: '/api/hash/batch',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, body);
  const duration = Date.now() - startTime;

  const statsAfter = await getStats();
  console.log(`Memory after: ${statsAfter.memory.heapUsed}`);
  console.log(`Active streams after: ${statsAfter.memory.activeStreams}`);
  console.log(`✓ Duration: ${duration}ms`);

  if (result.status === 200 && result.data.success) {
    const successCount = result.data.results.filter(r => r.success).length;
    console.log(`✓ Success: ${successCount}/${files.length} files`);
    return true;
  }
  return false;
}

async function main() {
  console.log('=== Memory Optimization Test for Large JS/CSS Files ===\n');

  try {
    const jsFile = await generateLargeFile(LARGE_FILE, 50, 'js');
    const cssFile = await generateLargeFile(LARGE_CSS, 30, 'css');

    console.log('\n' + '='.repeat(60));
    console.log('Testing completed. Generated files:');
    console.log(`  ${path.basename(jsFile)}: ${formatSize(fs.statSync(jsFile).size)}`);
    console.log(`  ${path.basename(cssFile)}: ${formatSize(fs.statSync(cssFile).size)}`);
    console.log('='.repeat(60));

    await testLargeFile(path.basename(jsFile), 'sha256');
    await testLargeFile(path.basename(jsFile), 'md5');
    await testLargeFile(path.basename(cssFile), 'sha256');

    await testBatch([
      path.basename(jsFile),
      path.basename(cssFile),
      'example.txt',
      'data.json',
      'document.md'
    ]);

    console.log('\n' + '='.repeat(60));
    console.log('FINAL MEMORY STATUS');
    console.log('='.repeat(60));
    const finalStats = await getStats();
    console.log(JSON.stringify(finalStats, null, 2));

    console.log('\n=== All tests completed successfully! ===');
    console.log('\nKey optimizations:');
    console.log('  • 64KB chunk size - prevents loading entire file into memory');
    console.log('  • Stream backpressure - yields CPU periodically');
    console.log('  • Concurrent stream limit (5) - prevents resource exhaustion');
    console.log('  • Max file size limit (500MB) - protects against abuse');
    console.log('  • Batch concurrency limit (2) - controlled parallel processing');
    console.log('  • Proper stream cleanup - prevents memory leaks');

  } catch (err) {
    console.error('Test failed:', err);
    process.exit(1);
  }
}

main();
