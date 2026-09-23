const http = require('node:http');
const port = Number(process.env.PORT || 8080);
http.createServer((req, res) => {
  res.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
  res.end('<h1>Node site is running on Railway ✅</h1>');
}).listen(port, '0.0.0.0', () => console.log(`Web app listening on ${port}`));
