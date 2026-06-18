const http = require('http');
const fs = require('fs');
const path = require('path');

function makeRequest(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path,
      method: 'GET',
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            contentType: res.headers['content-type'],
            data: res.headers['content-type'].includes('application/json') ? JSON.parse(data) : data,
          });
        } catch (e) {
          resolve({ status: res.statusCode, contentType: res.headers['content-type'], data });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function test() {
  console.log('=== Resource Manifest API Tests ===\n');

  console.log('1. Test GET /api/manifest (JSON format, all files)');
  const jsonAll = await makeRequest('/api/manifest');
  console.log(`   Status: ${jsonAll.status}`);
  console.log(`   Content-Type: ${jsonAll.contentType}`);
  if (jsonAll.data && jsonAll.data.success !== false) {
    const manifest = typeof jsonAll.data === 'string' ? JSON.parse(jsonAll.data) : jsonAll.data;
    console.log(`   Version: ${manifest.version}`);
    console.log(`   Generated: ${manifest.generatedAt}`);
    console.log(`   Algorithm: ${manifest.algorithm}`);
    console.log(`   Duration: ${manifest.duration}`);
    console.log(`   Files: ${manifest.processedFiles}/${manifest.totalFiles}`);
    console.log(`   Failed: ${manifest.failedFiles}`);
    console.log(`   File list:`);
    manifest.files.forEach(f => {
      console.log(`     • ${f.path}`);
      console.log(`       hash: ${f.hash}`);
      console.log(`       size: ${(f.size / 1024).toFixed(2)} KB`);
    });
  }
  console.log();

  console.log('2. Test GET /api/manifest?ext=js&ext=css (Filter by extensions)');
  const filtered = await makeRequest('/api/manifest?ext=js&ext=css');
  console.log(`   Status: ${filtered.status}`);
  if (filtered.data && filtered.data.success !== false) {
    const manifest = typeof filtered.data === 'string' ? JSON.parse(filtered.data) : filtered.data;
    console.log(`   Files: ${manifest.processedFiles}/${manifest.totalFiles}`);
    console.log(`   File list:`);
    manifest.files.forEach(f => {
      console.log(`     • ${f.path} - ${f.hash}`);
    });
  }
  console.log();

  console.log('3. Test GET /api/manifest?ext=json (Single extension filter)');
  const jsonFilter = await makeRequest('/api/manifest?ext=json');
  console.log(`   Status: ${jsonFilter.status}`);
  if (jsonFilter.data && jsonFilter.data.success !== false) {
    const manifest = typeof jsonFilter.data === 'string' ? JSON.parse(jsonFilter.data) : jsonFilter.data;
    console.log(`   Files: ${manifest.processedFiles}/${manifest.totalFiles}`);
    manifest.files.forEach(f => {
      console.log(`     • ${f.path} - ${f.hash}`);
    });
  }
  console.log();

  console.log('4. Test GET /api/manifest?algorithm=md5 (MD5 algorithm)');
  const md5 = await makeRequest('/api/manifest?algorithm=md5');
  console.log(`   Status: ${md5.status}`);
  if (md5.data && md5.data.success !== false) {
    const manifest = typeof md5.data === 'string' ? JSON.parse(md5.data) : md5.data;
    console.log(`   Algorithm: ${manifest.algorithm}`);
    console.log(`   Sample hash: ${manifest.files[0].hash}`);
  }
  console.log();

  console.log('5. Test GET /api/manifest?format=text (Plain text format)');
  const text = await makeRequest('/api/manifest?format=text');
  console.log(`   Status: ${text.status}`);
  console.log(`   Content-Type: ${text.contentType}`);
  const lines = text.data.split('\n').slice(0, 10);
  console.log(`   Preview (first 10 lines):`);
  lines.forEach(l => console.log(`     ${l}`));
  console.log();

  console.log('6. Test GET /api/manifest?format=html&ext=js&ext=css (HTML format)');
  const html = await makeRequest('/api/manifest?format=html&ext=js&ext=css');
  console.log(`   Status: ${html.status}`);
  console.log(`   Content-Type: ${html.contentType}`);
  console.log(`   Content length: ${html.data.length} characters`);
  console.log(`   Contains table: ${html.data.includes('<table>') ? '✓' : '✗'}`);
  console.log(`   Contains gradient: ${html.data.includes('linear-gradient') ? '✓' : '✗'}`);

  const htmlPath = path.join(__dirname, 'manifest-preview.html');
  fs.writeFileSync(htmlPath, html.data);
  console.log(`   Saved preview to: ${htmlPath}`);
  console.log();

  console.log('7. Test GET /api/manifest?prefix=https://cdn.example.com/ (URL prefix)');
  const prefix = await makeRequest('/api/manifest?prefix=https://cdn.example.com/');
  console.log(`   Status: ${prefix.status}`);
  if (prefix.data && prefix.data.success !== false) {
    const manifest = typeof prefix.data === 'string' ? JSON.parse(prefix.data) : prefix.data;
    console.log(`   Sample path: ${manifest.files[0].path}`);
    console.log(`   Has prefix: ${manifest.files[0].path.startsWith('https://cdn.example.com/') ? '✓' : '✗'}`);
  }
  console.log();

  console.log('8. Test GET /api/manifest?ext=md&format=text (MD files, text format)');
  const mdText = await makeRequest('/api/manifest?ext=md&format=text');
  console.log(`   Status: ${mdText.status}`);
  console.log(`   Content preview:`);
  console.log(mdText.data);
  console.log();

  console.log('9. Test GET /api/manifest?ext=txt&ext=md&ext=json (Multiple extensions)');
  const multiExt = await makeRequest('/api/manifest?ext=txt&ext=md&ext=json');
  console.log(`   Status: ${multiExt.status}`);
  if (multiExt.data && multiExt.data.success !== false) {
    const manifest = typeof multiExt.data === 'string' ? JSON.parse(multiExt.data) : multiExt.data;
    console.log(`   Files: ${manifest.processedFiles}`);
    manifest.files.forEach(f => {
      const ext = path.extname(f.path).slice(1);
      console.log(`     • ${f.path} (${ext})`);
    });
  }
  console.log();

  console.log('10. Test GET /api/manifest?ext=.JS (Case insensitive extension)');
  const caseInsensitive = await makeRequest('/api/manifest?ext=.JS');
  console.log(`   Status: ${caseInsensitive.status}`);
  if (caseInsensitive.data && caseInsensitive.data.success !== false) {
    const manifest = typeof caseInsensitive.data === 'string' ? JSON.parse(caseInsensitive.data) : caseInsensitive.data;
    console.log(`   Files: ${manifest.processedFiles}`);
    manifest.files.forEach(f => {
      console.log(`     • ${f.path}`);
    });
  }
  console.log();

  console.log('=== Generate Hash Lookup Table ===');
  const allFiles = await makeRequest('/api/manifest');
  if (allFiles.data && allFiles.data.success !== false) {
    const manifest = typeof allFiles.data === 'string' ? JSON.parse(allFiles.data) : allFiles.data;
    const hashTable = {};
    manifest.files.forEach(f => {
      hashTable[f.path] = f.hash;
    });
    console.log('\nPath to Hash Lookup Table:');
    console.log(JSON.stringify(hashTable, null, 2));

    const lookupPath = path.join(__dirname, 'hash-lookup.json');
    fs.writeFileSync(lookupPath, JSON.stringify(hashTable, null, 2));
    console.log(`\n✓ Saved hash lookup table to: ${lookupPath}`);
  }

  console.log('\n=== All Tests Completed ===');
  console.log('\nKey features:');
  console.log('  • Recursive directory scanning');
  console.log('  • Multiple output formats (JSON, Text, HTML)');
  console.log('  • Extension filtering (case insensitive)');
  console.log('  • Multiple algorithm support');
  console.log('  • URL prefix support for CDN');
  console.log('  • Hash lookup table generation');
  console.log('  • Memory-efficient streaming processing');
}

test().catch(console.error);
