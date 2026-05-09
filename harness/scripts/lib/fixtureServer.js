// Tiny HTTP server that serves a single saved page.html file as the response
// to every request. Runs on a random localhost port; the harness binds the
// port at startup, swaps the navigation URL to localhost, then shuts the
// server down on teardown.

import http from 'node:http';
import fs from 'node:fs/promises';

export async function startFixtureServer(fixturePath) {
  const html = await fs.readFile(fixturePath, 'utf8');
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    stop: () => new Promise(r => server.close(r)),
  };
}
