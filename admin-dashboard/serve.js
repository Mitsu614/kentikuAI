const http = require('http');
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'index.html');
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(file));
}).listen(8080, () => {
  console.log('管理ダッシュボード: http://localhost:8080');
  require('child_process').exec('start http://localhost:8080');
});
