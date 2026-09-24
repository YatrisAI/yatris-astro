// A stand-in for the Yatris Delivery API, for e2e builds only. It serves the
// items in a JSON fixture file (re-read on every request, so a test can change
// it between builds) with the same URLs, bearer-key check and Laravel-style
// pagination as the real API. A fixture of { "malformed": true } answers with
// a broken envelope.
//
//   node scripts/fake-delivery.mjs <port> <fixture.json> <api-key>
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [port, fixture, key] = process.argv.slice(2);

createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== `Bearer ${key}`) return send(401, { message: 'API key required.' });

  const url = new URL(req.url, 'http://localhost');
  const match = /^\/api\/v1\/delivery\/7\/items(?:\/([^/]+))?$/.exec(url.pathname);
  if (!match) return send(404, {});

  const data = JSON.parse(readFileSync(fixture, 'utf8'));
  if (data.malformed) return send(200, { items: 'not an envelope' });

  if (match[1]) {
    const found = data.items.find((i) => i.canonical_id === decodeURIComponent(match[1]));
    return found ? send(200, { data: found }) : send(404, {});
  }
  const ofType = data.items.filter((i) => i.type === url.searchParams.get('type'));
  if (ofType.length === 0) return send(200, { data: [], meta: { total: 0 } });
  const perPage = Math.min(Number(url.searchParams.get('per_page') ?? 25), 100);
  const page = Number(url.searchParams.get('page') ?? 1);
  send(200, {
    data: ofType.slice((page - 1) * perPage, page * perPage),
    meta: { total: ofType.length, per_page: perPage, current_page: page, last_page: Math.ceil(ofType.length / perPage) },
  });
}).listen(Number(port), '127.0.0.1', () => console.log(`fake delivery on ${port}`));
