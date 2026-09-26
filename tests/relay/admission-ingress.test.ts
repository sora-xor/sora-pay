import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const directory = new URL('../../deploy/nginx/', import.meta.url);
const filenames = [
  'sora-pay-admission-open.map.conf', 'sora-pay-admission-paused.map.conf',
  'sora-pay-admission-guard.conf', 'sora-pay-pilot-http.conf.example',
  'sora-pay-pilot-server.conf.example',
];
const read = (name: string): string => readFileSync(new URL(name, directory), 'utf8');
const uncomment = (source: string): string => source.replace(/^\s*#.*$/gm, '').trim();
const variable = '$sora_pay_admission_blocked';
const mapPath = '/opt/homebrew/etc/nginx/snippets/sora-pay-admission-map.conf';
const guardPath = '/opt/homebrew/etc/nginx/snippets/sora-pay-admission-guard.conf';
const id = '12345678-abcd-4abc-8abc-123456789abc';
const orders = '/sora-pay/v1/orders';

/** Test only this deliberately small map grammar; nginx parsing/routing is checked separately. */
function mapRules(source: string): RegExp[] {
  const match = /^map "\$request_method:\$uri" \$sora_pay_admission_blocked \{\s*default 0;([\s\S]*?)\s*\}$/.exec(uncomment(source));
  assert.ok(match, 'admission must use normalized $uri and default to forwarding other routes');
  return match[1]!.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const rule = /^"~(\^.*\$)" 1;$/.exec(line);
    assert.ok(rule, 'only quoted, anchored, case-sensitive regex entries are allowed');
    assert.ok(!rule[1]!.startsWith('^*'));
    return new RegExp(rule[1]!);
  });
}

/** Evaluate supplied normalized path fixtures, not a reimplementation of nginx normalization. */
function blocked(rules: RegExp[], method: string, normalizedUri: string): boolean {
  return rules.some((rule) => rule.test(`${method}:${normalizedUri}`));
}

/** Extract the six flat location blocks without executing nginx or contacting an upstream. */
function locations(): Map<string, string> {
  const source = uncomment(read('sora-pay-pilot-server.conf.example'));
  const result = new Map<string, string>();
  const remaining = source.replace(/^location ([^\n]+) \{\n([\s\S]*?)^\}/gm, (_all, selector: string, body: string) => {
    assert.ok(!result.has(selector), 'no duplicate location');
    result.set(selector, body);
    return '';
  });
  assert.equal(remaining.trim(), '', 'template cannot add server-level directives or unrelated routes');
  return result;
}

test('admission maps contain exactly the two intended POST gates with case-sensitive keys', () => {
  assert.deepEqual(mapRules(read(filenames[0]!)), []);
  assert.deepEqual(mapRules(read(filenames[1]!)).map((rule) => rule.source), [
    '^POST:\\/sora-pay\\/v1\\/orders$',
    '^POST:\\/sora-pay\\/v1\\/orders\\/[a-f0-9-]{36}\\/payment-attempt$',
  ]);
  for (const bad of [
    uncomment(read(filenames[1]!)).replace('$uri', '$request_uri'),
    uncomment(read(filenames[1]!)).replace('"~^POST:', '"~*^POST:'),
    uncomment(read(filenames[1]!)).replace('"~^POST:/sora-pay/v1/orders$"', '"POST:/sora-pay/v1/orders"'),
  ]) assert.throws(() => mapRules(bad));
});

test('paused map blocks canonical normalized creation and every relay-shaped signing lease ID', () => {
  const rules = mapRules(read(filenames[1]!));
  assert.equal(blocked(rules, 'POST', orders), true);
  for (const orderId of [id, 'a'.repeat(36), '-'.repeat(36), '0123456789abcdef-'.repeat(2) + 'ab']) {
    assert.equal(blocked(rules, 'POST', `${orders}/${orderId}/payment-attempt`), true);
  }
  // nginx supplies these same normalized paths after supported escaping/dot-segment
  // normalization. Actual raw-URI behavior is exercised by check-admission-ingress.py.
  assert.equal(blocked(rules, 'POST', `${orders}/${id}/payment-attempt`), true);
  assert.equal(blocked(rules, 'post', orders), false);
  assert.equal(blocked(rules, 'POST', orders.toUpperCase()), false);
});

test('paused map preserves receipt recovery, transaction hints, cancellation, catalog and preflights', () => {
  const rules = mapRules(read(filenames[1]!));
  for (const [method, path] of [
    ['GET', '/sora-pay/v1/catalog'], ['GET', `${orders}/${id}`],
    ['POST', `${orders}/recover-create`], ['POST', `${orders}/${id}/transaction`],
    ['POST', `${orders}/${id}/payment-attempt/cancel`],
    ['OPTIONS', orders], ['OPTIONS', `${orders}/${id}/payment-attempt`],
    ['GET', orders], ['GET', `${orders}/${id}/payment-attempt`],
    ['HEAD', orders], ['PUT', orders],
  ]) assert.equal(blocked(rules, method!, path!), false, `${method} ${path}`);
});

test('gate does not widen to path prefixes, invalid IDs, operator or unrelated services', () => {
  const rules = mapRules(read(filenames[1]!));
  for (const path of [
    `${orders}/`, `${orders}-extra`, `${orders}/${id}/payment-attempt/`,
    `${orders}/${id}/payment-attempt-extra`, `${orders}/${id}/payment-attempt/cancel/extra`,
    `${orders}/${'a'.repeat(35)}/payment-attempt`, `${orders}/${'a'.repeat(37)}/payment-attempt`,
    `${orders}/${id.toUpperCase()}/payment-attempt`, `${orders}/${'g'.repeat(36)}/payment-attempt`,
    '/sora-pay/v1/operator/orders', '/ipfs/example', '/healthz', '/v1/orders', '/',
  ]) assert.equal(blocked(rules, 'POST', path), false, path);
  // These routes retain their existing downstream validation; forwarding is not acceptance.
});

test('open map does not block new or saved-order routes', () => {
  const rules = mapRules(read(filenames[0]!));
  for (const method of ['GET', 'POST', 'OPTIONS']) {
    for (const path of [orders, `${orders}/${id}/payment-attempt`, `${orders}/${id}/transaction`, '/sora-pay/v1/catalog']) {
      assert.equal(blocked(rules, method, path), false);
    }
  }
});

test('guard requires the exact http map include, with no fallback variable or non-return if action', () => {
  const guardLines = uncomment(read(filenames[2]!)).split('\n');
  assert.equal(guardLines[0], 'if ($uri ~ "' + '\\'.repeat(4) + '") {');
  assert.deepEqual(guardLines.slice(1, 4), ['    return 400;', '}', '']);
  assert.equal(guardLines.slice(4).join('\n'), `if (${variable}) {\n    return 503;\n}`);
  assert.equal(uncomment(read(filenames[3]!)), `include ${mapPath};\nlimit_req_zone $binary_remote_addr zone=sora_pay_public:10m rate=2r/s;`);
  assert.doesNotMatch(filenames.map(read).map(uncomment).join('\n'), /\bset\s|\bmap\s+[^\n]*\$request_uri|include\s+[^;]*[*?]/);
  assert.equal((locations().get('^~ /sora-pay/v1/')!.match(/include /g) ?? []).length, 1);
  assert.ok(locations().get('^~ /sora-pay/v1/')!.includes(`include ${guardPath};`));
  // No synthetic assertion claims nginx -t success: the real verifier removes
  // the map and checks that nginx rejects the now-unknown guard variable.
});

test('pilot template reserves its namespace and denies public operator paths without touching other services', () => {
  const blocks = locations();
  assert.deepEqual([...blocks.keys()], [
    '= /sora-pay', '= /sora-pay/v1', '= /sora-pay/v1/operator',
    '^~ /sora-pay/v1/operator/', '^~ /sora-pay/v1/', '^~ /sora-pay/',
  ]);
  for (const [selector, body] of blocks) {
    for (const directive of ['access_log off;', 'error_log /dev/null crit;', 'expires off;', 'add_header Cache-Control "no-store" always;']) {
      assert.ok(body.includes(directive), `${selector}: ${directive}`);
    }
    const customerProxy = selector === '^~ /sora-pay/v1/';
    assert.ok(body.includes(`add_header_inherit ${customerProxy ? 'on' : 'off'};`), `${selector}: nested return responses retain no-store`);
    assert.ok(!body.includes(`add_header_inherit ${customerProxy ? 'off' : 'on'};`), `${selector}: exact header inheritance mode`);
    if (selector.includes('operator')) {
      assert.match(body, /return 403;/);
      assert.doesNotMatch(body, /proxy_pass|include/);
    } else if (selector !== '^~ /sora-pay/v1/') {
      assert.match(body, /return 404;/);
      assert.doesNotMatch(body, /proxy_pass|include/);
    }
  }
});

test('customer proxy preserves endpoint suffixes and existing privacy, timeout and trusted-IP controls', () => {
  const body = locations().get('^~ /sora-pay/v1/')!;
  assert.equal((body.match(/proxy_pass /g) ?? []).length, 1);
  assert.match(body, /proxy_pass http:\/\/127\.0\.0\.1:39848\/v1\/;/);
  for (const directive of [
    'proxy_hide_header Cache-Control;', 'limit_req zone=sora_pay_public burst=20 nodelay;', 'limit_req_status 429;',
    'client_max_body_size 16k;', 'client_body_buffer_size 16k;', 'client_body_timeout 25s;',
    'proxy_http_version 1.1;', 'proxy_connect_timeout 25s;', 'proxy_send_timeout 25s;', 'proxy_read_timeout 25s;', 'send_timeout 25s;',
    'proxy_request_buffering off;', 'proxy_buffering off;', 'proxy_cache off;', 'proxy_store off;',
    'proxy_intercept_errors off;', 'proxy_next_upstream off;', 'proxy_redirect off;',
    'proxy_set_header Host $host;', 'proxy_set_header Connection "";', 'proxy_set_header X-Forwarded-For "";',
    'proxy_set_header X-Real-IP "";', 'proxy_set_header Forwarded "";', 'proxy_set_header X-Sora-Pay-Client-IP $remote_addr;',
  ]) assert.ok(body.includes(directive), directive);
  assert.doesNotMatch(body, /add_header\s+Access-Control|\$http_x_sora_pay_client_ip|\$request_uri|rewrite\s|return\s+30[1278]/);
});

test('public package allows only the named ingress assets and verifier, not adjacent private files', () => {
  const script = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location('checker', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
for name in sys.argv[2:]:
    assert module.public_path('deploy/nginx/' + name)
assert module.public_path('deploy/check-admission-ingress.py')
for unsafe in ['deploy/nginx/relay.env', 'deploy/nginx/private.conf', 'deploy/nginx/.env', 'deploy/nginx/output/receipt.json']:
    assert not module.public_path(unsafe)
`;
  execFileSync('python3', ['-B', '-c', script, new URL('../../deploy/check-package.py', import.meta.url).pathname, ...filenames], { stdio: 'pipe' });
});
