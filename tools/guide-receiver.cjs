// Local helper for recording the guide GIFs: the page POSTs a finished file, this writes it into guide-out/.
// (Not straight into public/: the dev server reloads the page when a file there changes, which would cut a
// recording short. Copy the finished GIFs to public/guide/ afterwards.)
//   node tools/guide-receiver.cjs [folder] [port]
// Listens on localhost only; file names are restricted to plain names ending in .gif or .png.
const http = require('http'), fs = require('fs'), path = require('path');
const dir = process.argv[2] || path.join(__dirname, "..", "guide-out");
fs.mkdirSync(dir, { recursive: true });
http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5183');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') { res.end(); return; }
  const name = new URL(req.url, 'http://x').searchParams.get('name') || '';
  if (req.method !== 'POST' || !/^[a-z0-9-]+\.(gif|png)$/.test(name)) { res.statusCode = 400; res.end('bad'); return; }
  const chunks = [];
  req.on('data', (c) => chunks.push(c)).on('end', () => {
    const buf = Buffer.concat(chunks);
    fs.writeFileSync(path.join(dir, name), buf);
    res.end(String(buf.length));
  });
}).listen(Number(process.argv[3]) || 5199, '127.0.0.1', function () { console.log('receiver on', this.address().port, '->', dir); });
