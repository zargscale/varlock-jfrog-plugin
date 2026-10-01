import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { internal } from 'varlock';

const childProcess = createRequire(import.meta.url)('node:child_process');
const realFetch = globalThis.fetch;
const root = fileURLToPath(new URL('../', import.meta.url));
const base = 'https://example.jfrog.io/prefix/';
const api = `${base}access/api/v2/authentication/jfrog_client_login/`;
const secret = 'test-access-token-never-log-this';

async function load(init, items = 'TOKEN=jfrogToken()', extra = '') {
  const graph = new internal.EnvGraph();
  await graph.setRootDataSource(new internal.DotEnvFileDataSource(`${root}.env.schema`, {
    overrideContents: `# @plugin(./)\n${init}\n# ---\n${extra}\n${items}\n`,
  }));
  await graph.finishLoad();
  if (errors(graph)) return graph;
  await graph.resolveEnvValues();
  return graph;
}

function errors(graph) {
  return [
    ...graph.plugins.flatMap((p) => p.loadingError ? [p.loadingError] : []),
    ...graph.sortedDataSources.flatMap((s) => s.errors),
    ...Object.values(graph.configSchema).flatMap((item) => item.errors),
  ].filter((error) => !error.isWarning).map((error) => error.message).join('\n');
}

test('JFrog plugin through the real Varlock loader', async (t) => {
  const originalCI = process.env.CI;
  t.after(() => { if (originalCI === undefined) delete process.env.CI; else process.env.CI = originalCI; });
  delete process.env.CI;
  let output = '';
  t.mock.method(process.stderr, 'write', (text) => { output += text; return true; });
  t.mock.method(globalThis, 'fetch', async () => { throw Error('Unexpected network request'); });

  await t.test('supplied token resolves dependencies, stays sensitive, and needs no network', async () => {
    const graph = await load('# @initJfrog(token=$INPUT)', undefined,
      `# @sensitive\nINPUT=${secret}`);
    assert.equal(errors(graph), '');
    assert.equal(graph.configSchema.TOKEN.resolvedValue, secret);
    assert.equal(graph.configSchema.TOKEN.isSensitive, true);
  });

  await t.test('browser login registers a UUID, retries pending, and shares concurrent requests', async () => {
    let session;
    let registrations = 0;
    let polls = 0;
    globalThis.fetch = async (url, options) => {
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      if (url === `${api}request`) {
        registrations++;
        assert.equal(options.method, 'POST');
        assert.equal(options.headers['Content-Type'], 'application/json');
        session = JSON.parse(options.body).session;
        assert.match(session, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
        return new Response('', { status: 200 });
      }
      assert.equal(url, `${api}token/${session}`);
      assert.equal(options.method, 'GET');
      if (++polls === 1) return new Response('pending', { status: 400 });
      return Response.json({ access_token: secret, refresh_token: 'unused-refresh-token', expires_in: 3600 });
    };
    output = '';
    const graph = await load(
      `# @initJfrog(url="${base}", allowWebLogin=true, openBrowser=false)`,
      'TOKEN=jfrogToken()\nSECOND=jfrogToken()',
    );
    assert.equal(errors(graph), '');
    assert.equal(graph.configSchema.TOKEN.resolvedValue, secret);
    assert.equal(graph.configSchema.SECOND.resolvedValue, secret);
    assert.equal(graph.configSchema.TOKEN.isSensitive, true);
    assert.equal(registrations, 1);
    assert.equal(polls, 2);
    const loginUrl = new URL(output.match(/https:\/\/\S+/)[0]);
    assert.equal(loginUrl.pathname, '/prefix/ui/login');
    assert.equal(loginUrl.searchParams.get('jfClientSession'), session);
    assert.equal(loginUrl.searchParams.get('jfClientCode'), '1');
    assert.equal(loginUrl.searchParams.get('jfClientName'), 'Varlock');
    assert.ok(output.includes(session.slice(-4)));
    assert.ok(!output.includes(secret));
    assert.ok(!output.includes('unused-refresh-token'));
  });

  await t.test('invalid configuration fails without contacting a server', async () => {
    globalThis.fetch = async () => assert.fail('Invalid configuration must not make requests');
    for (const [init, items, expected] of [
      ['', 'TOKEN=jfrogToken()', /initJfrog/],
      ['# @initJfrog()', 'TOKEN=jfrogToken()', /allowWebLogin/],
      ['# @initJfrog(allowWebLogin=true)', 'TOKEN=jfrogToken()', /url/],
      ['# @initJfrog(url="http://example.jfrog.io", allowWebLogin=true)', undefined, /HTTPS/],
      ['# @initJfrog(url="https://user:password@example.jfrog.io", allowWebLogin=true)', undefined, /credentials/],
      ['# @initJfrog(url="https://example.jfrog.io?token=secret", allowWebLogin=true)', undefined, /query/],
      ['# @initJfrog(url="https://example.jfrog.io?", allowWebLogin=true)', undefined, /query/],
      ['# @initJfrog(url="https://example.jfrog.io#", allowWebLogin=true)', undefined, /fragment/],
      ['# @initJfrog(allowWebLogin="true")', undefined, /boolean/],
      ['# @initJfrog(openBrowser="false")', undefined, /boolean/],
      ['# @initJfrog(timeout=0)', undefined, /timeout/],
      ['# @initJfrog(token=123)', undefined, /token/],
      ['# @initJfrog(typo=true)', undefined, /Unknown/],
      ['# @initJfrog(token=secret)\n# @initJfrog(token=other)', undefined, /already/],
      ['# @initJfrog(token=secret)', 'TOKEN=jfrogToken(missing)', /initJfrog/],
    ]) {
      const graph = await load(init, items);
      assert.match(errors(graph), expected, init);
    }
    const graph = await load('# @initJfrog()', 'UNUSED=ok');
    assert.equal(errors(graph), '', 'an unused instance must not demand authentication');
  });

  await t.test('named instances keep tokens separate', async () => {
    const graph = await load(
      '# @initJfrog(id=one, token=first-token)\n# @initJfrog(id=two, token=second-token)',
      'ONE=jfrogToken(one)\nTWO=jfrogToken(two)',
    );
    assert.equal(errors(graph), '');
    assert.equal(graph.configSchema.ONE.resolvedValue, 'first-token');
    assert.equal(graph.configSchema.TWO.resolvedValue, 'second-token');
  });

  await t.test('CI cannot launch login but can use a supplied token', async () => {
    process.env.CI = 'true';
    try {
      const graph = await load(`# @initJfrog(url="${base}", allowWebLogin=true)`);
      assert.match(errors(graph), /CI/);
      const supplied = await load(`# @initJfrog(token=${secret}, allowWebLogin=true)`);
      assert.equal(errors(supplied), '');
      assert.equal(supplied.configSchema.TOKEN.resolvedValue, secret);
    } finally {
      delete process.env.CI;
    }
  });

  await t.test('failed registration, denied login, and malformed responses are sanitized', async () => {
    for (const [registerStatus, response, expected] of [
      [404, () => new Response(secret), /registration.*404.*7\.64/],
      [200, () => new Response(secret, { status: 403 }), /token.*403/],
      [200, () => new Response(secret, { status: 500 }), /token.*500/],
      [200, () => new Response(secret, { status: 302, headers: { Location: 'https://elsewhere.example' } }), /token.*302/],
      [200, () => new Response(secret), /JSON/],
      [200, () => Response.json({ access_token: '' }), /access_token/],
      [200, () => Response.json({ access_token: 123 }), /access_token/],
      [200, () => Response.json({ access_token: 'bad\u0000token' }), /access_token/],
      [200, () => { throw Error(secret); }, /request failed/],
    ]) {
      let calls = 0;
      globalThis.fetch = async (url) => {
        calls++;
        return url === `${api}request` ? new Response(secret, { status: registerStatus }) : response();
      };
      output = '';
      const graph = await load(`# @initJfrog(url="${base}", allowWebLogin=true, openBrowser=false)`);
      assert.match(errors(graph), expected);
      assert.ok(!errors(graph).includes(secret));
      assert.ok(!output.includes(secret));
      assert.equal(calls, registerStatus === 200 ? 2 : 1);
    }
  });

  await t.test('pending login has a bounded timeout', async () => {
    globalThis.fetch = async (url) => new Response('', { status: url === `${api}request` ? 200 : 400 });
    const graph = await load(`# @initJfrog(url="${base}", allowWebLogin=true, openBrowser=false, timeout=1)`);
    assert.match(errors(graph), /timed out/);
  });

  await t.test('native HTTP redirects are refused and stalled requests time out', async () => {
    let mode = 'redirect';
    let leaked = false;
    const server = createServer((request, response) => {
      if (mode === 'stalled') return;
      if (request.url.endsWith('/request')) response.writeHead(200).end();
      else if (request.url.includes('/token/')) response.writeHead(302, { Location: '/leak' }).end();
      else { leaked = true; response.end(secret); }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    globalThis.fetch = (url, options) => realFetch(
      `http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, options,
    );
    try {
      const redirected = await load(`# @initJfrog(url="${base}", allowWebLogin=true, openBrowser=false)`);
      assert.match(errors(redirected), /token request failed/);
      assert.equal(leaked, false);
      mode = 'stalled';
      const stalled = await load(`# @initJfrog(url="${base}", allowWebLogin=true, openBrowser=false, timeout=1)`);
      assert.match(errors(stalled), /timed out/);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('a missing browser launcher falls back to the URL without stopping login', async (subtest) => {
    let launched = false;
    subtest.mock.method(childProcess, 'spawn', (command, args, options) => {
      launched = true;
      assert.ok(['open', 'xdg-open', 'rundll32.exe'].includes(command));
      assert.match(args.at(-1), /jfClientSession=/);
      assert.equal(options.shell, false);
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit('error', Error(secret)));
      return child;
    });
    globalThis.fetch = async (url) => url === `${api}request`
      ? new Response('') : Response.json({ access_token: secret });
    output = '';
    const graph = await load(`# @initJfrog(url="${base}", allowWebLogin=true)`);
    assert.equal(errors(graph), '');
    assert.equal(graph.configSchema.TOKEN.resolvedValue, secret);
    assert.equal(launched, true);
    assert.match(output, /open the login URL above manually/);
    assert.ok(!output.includes(secret));
  });

  await t.test('documented example injects the token into a real CLI child and hides its source', () => {
    const stdout = childProcess.execFileSync(process.execPath, [
      'node_modules/varlock/bin/cli.js', 'run', '--path', './examples', '--',
      process.execPath, '-e',
      `if (process.env.JFROG_ACCESS_TOKEN !== ${JSON.stringify(secret)}) process.exit(1); `
        + 'if (process.env.JFROG_TOKEN) process.exit(2); console.log("Token injected")',
    ], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
      env: { ...process.env, CI: 'true', DO_NOT_TRACK: '1', JFROG_URL: base, JFROG_TOKEN: secret },
    });
    assert.equal(stdout.trim(), 'Token injected');
    assert.ok(!stdout.includes(secret));
  });
});
