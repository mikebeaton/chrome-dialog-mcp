import http from 'node:http';
import { readFile } from 'node:fs/promises';

const authorise = process.argv.includes('--authorise');
const route = authorise ? '/authorise' : '/dialog';
const html = await readFile(new URL(authorise ? '../assets/start.html' : '../test/fixtures/computer-use.html', import.meta.url));
const server = http.createServer((request, response) => {
  if (request.url !== route && request.url !== '/') {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(html);
});
server.listen(0, '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${server.address().port}${route}`);
});
