const http = require('http');

function makeRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            data: JSON.parse(data),
          });
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

async function test() {
  console.log('=== File Hash API Tests ===\n');

  console.log('1. Test GET /');
  const root = await makeRequest({ hostname: 'localhost', port: 3000, path: '/', method: 'GET' });
  console.log(`   Status:`, root.status);
  console.log(`   Data:`, JSON.stringify(root.data, null, 2).split('\n').map(l => '   ' + l).join('\n'));
  console.log();

  console.log('2. Test GET /api/algorithms');
  const algos = await makeRequest({ hostname: 'localhost', port: 3000, path: '/api/algorithms', method: 'GET' });
  console.log(`   Status:`, algos.status);
  console.log(`   Data:`, JSON.stringify(algos.data, null, 2).split('\n').map(l => '   ' + l).join('\n'));
  console.log();

  console.log('3. Test GET /api/files');
  const files = await makeRequest({ hostname: 'localhost', port: 3000, path: '/api/files', method: 'GET' });
  console.log(`   Status:`, files.status);
  console.log(`   Data:`, JSON.stringify(files.data, null, 2).split('\n').map(l => '   ' + l).join('\n'));
  console.log();

  console.log('4. Test GET /api/hash?file=example.txt (SHA256)');
  const hash1 = await makeRequest({ hostname: 'localhost', port: 3000, path: '/api/hash?file=example.txt', method: 'GET' });
  console.log(`   Status:`, hash1.status);
  console.log(`   Data:`, JSON.stringify(hash1.data, null, 2).split('\n').map(l => '   ' + l).join('\n'));
  console.log();

  console.log('5. Test GET /api/hash?file=example.txt&algorithm=md5');
  const hash2 = await makeRequest({ hostname: 'localhost', port: 3000, path: '/api/hash?file=example.txt&algorithm=md5', method: 'GET' });
  console.log(`   Status:`, hash2.status);
  console.log(`   Data:`, JSON.stringify(hash2.data, null, 2).split('\n').map(l => '   ' + l).join('\n'));
  console.log();

  console.log('6. Test GET /api/hash?file=example.txt&algorithm=sha512');
  const hash3 = await makeRequest({ hostname: 'localhost', port: 3000, path: '/api/hash?file=example.txt&algorithm=sha512', method: 'GET' });
  console.log(`   Status:`, hash3.status);
  console.log(`   Data:`, JSON.stringify(hash3.data, null, 2).split('\n').map(l => '   ' + l).join('\n'));
  console.log();

  console.log('7. Test GET /api/hash?file=data.json');
  const hash4 = await makeRequest({ hostname: 'localhost', port: 3000, path: '/api/hash?file=data.json', method: 'GET' });
  console.log(`   Status:`, hash4.status);
  console.log(`   Data:`, JSON.stringify(hash4.data, null, 2).split('\n').map(l => '   ' + l).join('\n'));
  console.log();

  console.log('8. Test POST /api/hash/batch');
  const batchBody = JSON.stringify({
    files: ['example.txt', 'data.json', 'document.md', 'nonexistent.txt'],
    algorithm: 'sha256'
  });
  const batch = await makeRequest({
    hostname: 'localhost',
    port: 3000,
    path: '/api/hash/batch',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(batchBody) }
  }, batchBody);
  console.log(`   Status:`, batch.status);
  console.log(`   Data:`, JSON.stringify(batch.data, null, 2).split('\n').map(l => '   ' + l).join('\n'));
  console.log();

  console.log('9. Test GET /api/hash?file=../package.json (Path Traversal Attempt)');
  const traversal = await makeRequest({ hostname: 'localhost', port: 3000, path: '/api/hash?file=../package.json', method: 'GET' });
  console.log(`   Status:`, traversal.status);
  console.log(`   Data:`, JSON.stringify(traversal.data, null, 2).split('\n').map(l => '   ' + l).join('\n'));
  console.log();

  console.log('10. Test GET /api/hash?file=nonexistent.txt');
  const notfound = await makeRequest({ hostname: 'localhost', port: 3000, path: '/api/hash?file=nonexistent.txt', method: 'GET' });
  console.log(`   Status:`, notfound.status);
  console.log(`   Data:`, JSON.stringify(notfound.data, null, 2).split('\n').map(l => '   ' + l).join('\n'));
  console.log();

  console.log('=== All Tests Completed ===');
}

test().catch(console.error);
