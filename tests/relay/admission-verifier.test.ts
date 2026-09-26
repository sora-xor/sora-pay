import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const script = new URL('../../deploy/check-admission-ingress.py', import.meta.url).pathname;
const load = `import importlib.util, pathlib, json, io, contextlib, tempfile, signal, subprocess, os\nfrom unittest.mock import patch, Mock\nspec=importlib.util.spec_from_file_location('ingress_verifier',${JSON.stringify(script)})\nv=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)\n`;
function python(source: string): void { execFileSync('/usr/bin/python3', ['-B', '-c', load + source], { stdio: 'pipe', timeout: 10_000 }); }

test('default verifier performs no config reads, temporary writes, process creation or network requests', () => {
  python(`with patch.object(v.Path,'read_text',side_effect=AssertionError('read')), patch.object(v.tempfile,'TemporaryDirectory',side_effect=AssertionError('write')), patch.object(v.subprocess,'Popen',side_effect=AssertionError('process')), patch.object(v.subprocess,'run',side_effect=AssertionError('process')), patch.object(v,'ThreadingHTTPServer',side_effect=AssertionError('network')):
    output=io.StringIO()
    with contextlib.redirect_stdout(output): assert v.main([])==0
    assert json.loads(output.getvalue())['executed'] is False
`);
});

test('verifier rewrites only exact loopback target and mandatory includes; missing/duplicate contracts fail', () => {
  python(`original='proxy_pass http://127.0.0.1:39848/v1/;'
assert v.render_server(original,12345)=='proxy_pass http://127.0.0.1:12345/v1/;'
for value in ('',original+original):
    try: v.render_server(value,12345); raise AssertionError('accepted')
    except v.CheckFailure: pass
assert v.render_include('include /old;', '/old', pathlib.Path('/tmp/owned'))=='include "/tmp/owned";'
assert v.render_include('include /old; limit_req_zone zone=kept;', '/old', None)==' limit_req_zone zone=kept;'
assert 'admission-http-missing-map.conf' in v.configuration(pathlib.Path('/tmp/owned'),12345,False)
for value in ('include /different;', 'include /old;include /old;'):
    try: v.render_include(value,'/old',pathlib.Path('/tmp/owned')); raise AssertionError('accepted')
    except v.CheckFailure: pass
with tempfile.TemporaryDirectory() as temporary:
    path=pathlib.Path(temporary)/'mode.conf';v.atomic_write(path,'open');v.atomic_write(path,'paused')
    assert path.read_text()=='paused' and path.stat().st_mode & 0o777 == 0o600
    (path.parent/'mode.conf.next').write_text('unrelated')
    try: v.atomic_write(path,'open');raise AssertionError('overwrote')
    except FileExistsError: pass
    assert path.read_text()=='paused' and (path.parent/'mode.conf.next').read_text()=='unrelated'
`);
});

test('root nginx configuration names the actual Darwin primary group and syntax diagnostics stay scrubbed', () => {
  python(`with patch.object(v.os,'getuid',return_value=0), patch.object(v.os,'getgid',return_value=0), patch.object(v.pwd,'getpwuid',return_value=Mock(pw_name='root')), patch.object(v.grp,'getgrgid',return_value=Mock(gr_name='wheel')):
    assert v.configuration(pathlib.Path('/tmp/owned'),12345,True).startswith('user root wheel;')
assert v.syntax_reason(b'getgrnam("root") failed in /tmp/path')=='configured_group_unavailable'
assert v.syntax_reason(b'unknown "sora_pay_admission_blocked" variable')=='missing_admission_map'
assert v.syntax_reason(b'zero size shared memory zone "x"')=='missing_rate_zone'
assert v.syntax_reason(b'unexpected sensitive-looking text')=='unclassified_synthetic_config_error'
`);
});

test('parent-header fixture and all response statuses enforce exact no-store without hidden duplicates', () => {
  python(`config=v.configuration(pathlib.Path('/tmp/owned'),12345,True)
for marker in ('add_header_inherit merge;', 'X-Synthetic-Parent leaked always;', 'Cache-Control "public, max-age=3600" always;', 'Content-Security-Policy "default-src'):
    assert marker in config
headers=v.response_headers([('Cache-Control','public, max-age=3600'),('cache-control','no-store')])
assert headers['cache-control']=='public, max-age=3600, no-store'
probe=v.Probe(12345,v.time.monotonic()+60)
for status in (200,400,403,503):
    with patch.object(probe,'request',return_value=(status,{'cache-control':'no-store'},b'{}')):
        probe.check('POST','/sora-pay/v1/orders',status)
    for bad in (headers,{'cache-control':'no-store','x-synthetic-parent':'leaked'},{'cache-control':'no-store','content-security-policy':'parent'}):
        with patch.object(probe,'request',return_value=(status,bad,b'{}')):
            try:probe.check('POST','/sora-pay/v1/orders',status);raise AssertionError('parent leak accepted')
            except v.CheckFailure as error:assert 'POST /sora-pay/v1/orders' in str(error)
`);
});

test('backslash tests distinguish Node pathname normalization from percent-encoded separators', () => {
  python(`identifier='11111111-1111-4111-8111-111111111111'
assert v.is_admission_target('POST','/v1/orders/'+identifier+chr(92)+'payment-attempt')
assert v.is_admission_target('POST','/v1/x'+chr(92)+'..'+chr(92)+'orders')
assert not v.is_admission_target('POST','/v1/orders/'+identifier+'%5Cpayment-attempt')
assert not v.is_admission_target('POST','/v1/orders/')
assert not v.is_admission_target('GET','/v1/orders')
`);
});

test('reload never signals a mismatched PID or non-owned process group', () => {
  python(`process=Mock();process.pid=12345;process.poll.return_value=None
with tempfile.TemporaryDirectory() as temporary:
    path=pathlib.Path(temporary)/'nginx.pid';path.write_text('999')
    try: v.signal_owned(process,path,signal.SIGHUP);raise AssertionError('signalled')
    except v.CheckFailure: pass
    process.send_signal.assert_not_called()
    path.write_text('12345')
    with patch.object(v.os,'getpgid',return_value=999):
        try: v.signal_owned(process,path,signal.SIGHUP);raise AssertionError('signalled')
        except v.CheckFailure: pass
    process.send_signal.assert_not_called()
    with patch.object(v.os,'getpgid',return_value=12345):v.signal_owned(process,path,signal.SIGHUP)
    process.send_signal.assert_called_once_with(signal.SIGHUP)
`);
});

test('cleanup escalates only the proven group, including surviving workers after master exit', () => {
  python(`process=Mock();process.pid=12345;process.poll.return_value=None
process.wait.side_effect=[subprocess.TimeoutExpired('owned nginx',4),None]
with patch.object(v.os,'getpgid',return_value=12345), patch.object(v.os,'killpg') as killpg, patch.object(v,'wait_group_absent',side_effect=[False,True]):
    v.stop_owned(process,True)
    process.send_signal.assert_called_once_with(signal.SIGQUIT)
    killpg.assert_called_once_with(12345,signal.SIGTERM)
process.reset_mock();process.poll.return_value=0
with patch.object(v.os,'getpgid') as getpgid, patch.object(v.os,'killpg') as killpg, patch.object(v,'wait_group_absent',side_effect=[False,False,True]):
    v.stop_owned(process,True)
    assert killpg.call_args_list==[((12345,signal.SIGTERM),),((12345,signal.SIGKILL),)]
    process.send_signal.assert_not_called();getpgid.assert_not_called()
with patch.object(v.os,'killpg') as killpg, patch.object(v,'wait_group_absent',side_effect=PermissionError):
    try:v.stop_owned(process,True);raise AssertionError('unknown group accepted')
    except PermissionError:pass
    killpg.assert_not_called()
with patch.object(v.os,'killpg'), patch.object(v,'wait_group_absent',return_value=False):
    try:v.stop_owned(process,True);raise AssertionError('live group accepted')
    except v.CheckFailure as error:assert str(error)=='owned_worker_group_remains'
try:v.stop_owned(process,False);raise AssertionError('unowned accepted')
except v.CheckFailure:pass
process.send_signal.assert_not_called()
with patch.object(v.os,'killpg',side_effect=PermissionError):
    try:v.group_alive(12345);raise AssertionError('unknown absence accepted')
    except PermissionError:pass
with patch.object(v.os,'killpg',side_effect=ProcessLookupError):assert v.group_alive(12345) is False
with patch.object(v,'group_alive',side_effect=[True,False]), patch.object(v.time,'sleep') as sleep:
    assert v.wait_group_absent(12345,2);sleep.assert_called_once_with(0.05)
`);
});

test('real verifier is isolated, has bounded deadlines, and does not use installed nginx control commands', () => {
  const source = readFileSync(script, 'utf8');
  assert.match(source, /start_new_session=True/);
  assert.match(source, /TemporaryDirectory\(prefix='sora-pay-admission-'/);
  assert.match(source, /signal_owned\(process, root \/ 'nginx.pid', signal.SIGHUP\)/);
  assert.match(source, /time.monotonic\(\) \+ 50/);
  assert.match(source, /signal.signal\(signal.SIGINT, signal.SIG_IGN\)/);
  assert.doesNotMatch(source, /\['-s'|pkill|killall|\/private\/relay.env|launchctl/);
});
