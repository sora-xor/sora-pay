#!/usr/bin/env python3
"""Exercise reviewed admission templates with an owned, temporary real nginx.

No arguments prints a plan only. --nginx must identify the executable explicitly.
All listeners, configuration, logs and process state belong to TemporaryDirectory.
The verifier never loads host nginx configuration or sends nginx -s commands.
"""
import argparse
import hashlib
import grp
import http.client
import json
import os
import re
import pwd
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = Path(__file__).resolve().parent
HTTP_TEMPLATE = 'nginx/sora-pay-pilot-http.conf.example'
SERVER_TEMPLATE = 'nginx/sora-pay-pilot-server.conf.example'
GUARD_TEMPLATE = 'nginx/sora-pay-admission-guard.conf'
OPEN_TEMPLATE = 'nginx/sora-pay-admission-open.map.conf'
PAUSED_TEMPLATE = 'nginx/sora-pay-admission-paused.map.conf'
MODE_INCLUDE = '/opt/homebrew/etc/nginx/snippets/sora-pay-admission-map.conf'
GUARD_INCLUDE = '/opt/homebrew/etc/nginx/snippets/sora-pay-admission-guard.conf'
ORDER = '11111111-1111-4111-8111-111111111111'


class CheckFailure(Exception):
    """Fixed safe diagnostic labels never include raw nginx logs or request data."""


def require(condition, label):
    if not condition:
        raise CheckFailure(label)


def quoted(path):
    value = str(path)
    require(not any(c in value for c in '\r\n\x00$'), 'unsafe_temporary_path')
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'


def render_server(template, port):
    """Change only the reviewed loopback upstream; preserve routing directives verbatim."""
    target = 'http://127.0.0.1:39848'
    require(template.count(target) == 1, 'unexpected_upstream_template')
    require(isinstance(port, int) and 0 < port <= 65535, 'invalid_ephemeral_port')
    return template.replace(target, 'http://127.0.0.1:' + str(port))


def render_include(template, original, destination):
    """Replace one mandatory include with the same artifact inside the isolated prefix."""
    directive = 'include ' + original + ';'
    require(template.count(directive) == 1, 'include_contract_changed')
    replacement = '' if destination is None else 'include ' + quoted(destination) + ';'
    return template.replace(directive, replacement)


def synthetic_node_path(raw_path):
    """Model WHATWG special-URL backslash/dot normalization for the tested ASCII paths.

    Percent-encoded backslashes remain encoded in URL.pathname; only literal
    backslashes become separators. This catches an upstream admission bypass
    that a generic echo server would otherwise mistake for a harmless forward.
    """
    path = raw_path.split('?', 1)[0].replace('\\', '/')
    parts = []
    for piece in path.split('/'):
        dots = re.sub('%2e', '.', piece, flags=re.IGNORECASE)
        if dots == '..':
            if len(parts) > 1:
                parts.pop()
        elif dots != '.':
            parts.append(piece)
    return '/'.join(parts)


def is_admission_target(method, raw_path):
    path = synthetic_node_path(raw_path)
    return method == 'POST' and (path == '/v1/orders' or re.fullmatch(r'/v1/orders/[a-f0-9-]{36}/payment-attempt', path) is not None)


def atomic_write(path, content):
    """Atomic mode swap is limited to a fresh sibling inside the owned temporary tree."""
    candidate = path.with_name(path.name + '.next')
    with candidate.open('x', encoding='utf8') as stream:
        os.chmod(candidate, 0o600)
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(candidate, path)


def signal_owned(process, pid_file, wanted):
    """Signal only the Popen child after its isolated PID file proves ownership."""
    require(process.poll() is None, 'owned_nginx_exited')
    require(pid_file.is_file() and not pid_file.is_symlink(), 'owned_pid_file_missing')
    require(pid_file.read_text(encoding='ascii').strip() == str(process.pid), 'owned_pid_mismatch')
    require(os.getpgid(process.pid) == process.pid, 'owned_process_group_mismatch')
    process.send_signal(wanted)


def group_alive(group):
    """Only ESRCH proves that the owned process group has disappeared."""
    try:
        os.killpg(group, 0)
        return True
    except ProcessLookupError:
        return False


def wait_group_absent(group, timeout):
    """Observe disappearance, preserving permission/probe errors as unknown state."""
    limit = time.monotonic() + timeout
    while group_alive(group):
        if time.monotonic() >= limit:
            return False
        time.sleep(0.05)
    return True


def stop_owned(process, group_proven):
    """Stop the owned master and any surviving workers in its previously proven group."""
    require(group_proven, 'owned_process_group_unproven')
    if process.poll() is None:
        require(os.getpgid(process.pid) == process.pid, 'owned_process_group_mismatch')
        process.send_signal(signal.SIGQUIT)
        try:
            process.wait(timeout=4)
        except subprocess.TimeoutExpired:
            pass
    for escalation in (signal.SIGTERM, signal.SIGKILL):
        if wait_group_absent(process.pid, 2):
            return
        # The initial start_new_session proof also covers workers after master exit.
        # If the master remains alive, independently recheck it before escalation.
        if process.poll() is None:
            require(os.getpgid(process.pid) == process.pid, 'owned_process_group_mismatch')
        try:
            os.killpg(process.pid, escalation)
        except ProcessLookupError:
            pass
        if process.poll() is None:
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
    require(wait_group_absent(process.pid, 2), 'owned_worker_group_remains')


class SyntheticUpstream(BaseHTTPRequestHandler):
    """Echo only synthetic routing/header evidence, with no access logging."""
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_args):
        pass

    def reply(self):
        length = int(self.headers.get('Content-Length', '0'))
        require(0 <= length <= 16384, 'synthetic_body_limit')
        self.rfile.read(length)
        result = {'path': self.path, 'method': self.command,
                  'headers': {key.lower(): value for key, value in self.headers.items()},
                  'nodePathname': synthetic_node_path(self.path),
                  'admissionTarget': is_admission_target(self.command, self.path)}
        body = json.dumps(result, separators=(',', ':')).encode()
        code = 204 if self.command == 'OPTIONS' else 200
        self.send_response(code)
        self.send_header('X-Synthetic-Upstream', '1')
        self.send_header('X-Synthetic-Path', self.path)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', 'https://polkaswap.io')
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(0 if code == 204 else len(body)))
        self.end_headers()
        if code != 204:
            self.wfile.write(body)

    do_GET = do_POST = do_OPTIONS = do_PUT = do_PATCH = do_DELETE = reply


def response_headers(pairs):
    """Preserve duplicate response headers so a later no-store cannot hide public caching."""
    headers = {}
    for key, value in pairs:
        lower = key.lower()
        headers[lower] = headers[lower] + ', ' + value if lower in headers else value
    return headers


def assert_store_headers(headers):
    """Store responses must shadow every contaminating parent cache/CSP/header value."""
    require('location' not in headers, 'unexpected_redirect')
    require(headers.get('cache-control') == 'no-store', 'cache_control_not_exact_no_store')
    require('x-synthetic-parent' not in headers, 'parent_header_leaked')
    require('content-security-policy' not in headers, 'parent_csp_leaked')


class Probe:
    """New connections observe reloads; pacing preserves the real per-client rate limit."""
    def __init__(self, port, deadline):
        self.port = port
        self.deadline = deadline
        self.previous = 0.0
        self.count = 0

    def request(self, method, path):
        delay = max(0.0, self.previous + 0.52 - time.monotonic())
        require(time.monotonic() + delay + 2 < self.deadline, 'verification_deadline')
        if delay:
            time.sleep(delay)
        self.previous = time.monotonic()
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=2)
        try:
            connection.request(method, path, body=b'{}' if method in ('POST', 'PUT', 'PATCH') else None,
                headers={'Content-Type': 'application/json', 'Origin': 'https://polkaswap.io',
                         'X-Sora-Pay-Client-IP': '203.0.113.8', 'X-Forwarded-For': '203.0.113.9',
                         'Forwarded': 'for=203.0.113.10', 'X-Real-IP': '203.0.113.11',
                         'Connection': 'close'})
            response = connection.getresponse()
            data = response.read(32769)
            require(len(data) <= 32768, 'unexpected_response_size')
            headers = response_headers(response.getheaders())
            self.count += 1
            return response.status, headers, data
        finally:
            connection.close()

    def check(self, method, path, expected, upstream_path=None):
        try:
            self.check_response(method, path, expected, upstream_path)
        except CheckFailure as error:
            raise CheckFailure(str(error) + ': ' + method + ' ' + path) from None

    def check_response(self, method, path, expected, upstream_path):
        status, headers, body = self.request(method, path)
        require(status == expected, 'route_status_mismatch')
        assert_store_headers(headers)
        if upstream_path is None:
            require('x-synthetic-upstream' not in headers, 'blocked_request_reached_upstream')
        else:
            require(headers.get('x-synthetic-upstream') == '1', 'upstream_not_reached')
            require(headers.get('x-synthetic-path') == upstream_path, 'upstream_path_mismatch')
            require(headers.get('access-control-allow-origin') == 'https://polkaswap.io', 'cors_header_mismatch')
            if method != 'OPTIONS':
                echoed = json.loads(body)
                forwarded = echoed['headers']
                require(echoed['method'] == method, 'upstream_method_mismatch')
                require(forwarded.get('x-sora-pay-client-ip') == '127.0.0.1', 'client_ip_not_overwritten')
                require(not any(key in forwarded for key in ('x-forwarded-for', 'forwarded', 'x-real-ip')), 'spoofed_forwarded_header_preserved')

    def await_mode(self, process, expected):
        limit = min(self.deadline, time.monotonic() + 7)
        while time.monotonic() < limit:
            require(process.poll() is None, 'owned_nginx_exited')
            try:
                status, headers, _body = self.request('POST', '/sora-pay/v1/orders')
                if status == expected and (headers.get('x-synthetic-upstream') == '1') == (expected == 200):
                    try:
                        assert_store_headers(headers)
                    except CheckFailure as error:
                        raise CheckFailure(str(error) + ': observing POST /sora-pay/v1/orders') from None
                    return
            except (ConnectionError, OSError, http.client.HTTPException):
                continue
        raise CheckFailure('reload_mode_not_observed')


def configuration(root, port, with_map):
    """Explicit paths isolate every nginx runtime artifact from the installed service."""
    http_file = 'admission-http.conf' if with_map else 'admission-http-missing-map.conf'
    http_include = 'include ' + quoted(root / http_file) + ';'
    user = ''
    if os.getuid() == 0:
        username = pwd.getpwuid(os.getuid()).pw_name
        groupname = grp.getgrgid(os.getgid()).gr_name
        require(re.fullmatch(r'[A-Za-z_][A-Za-z0-9_-]*', username) and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_-]*', groupname), 'unsupported_local_account_name')
        user = 'user ' + username + ' ' + groupname + ';\n'
    return f'''{user}daemon off;
master_process on;
worker_processes 1;
pid {quoted(root / 'nginx.pid')};
error_log {quoted(root / 'error.log')} crit;
worker_shutdown_timeout 2s;
events {{ worker_connections 64; }}
http {{
  access_log off;
  client_body_temp_path {quoted(root / 'body')};
  proxy_temp_path {quoted(root / 'proxy')};
  fastcgi_temp_path {quoted(root / 'fastcgi')};
  uwsgi_temp_path {quoted(root / 'uwsgi')};
  scgi_temp_path {quoted(root / 'scgi')};
  {http_include}
  server {{
    listen 127.0.0.1:{port};
    server_name localhost;
    add_header_inherit merge;
    add_header X-Synthetic-Parent leaked always;
    add_header Cache-Control "public, max-age=3600" always;
    add_header Content-Security-Policy "default-src 'none'" always;
    include {quoted(root / 'admission-server.conf')};
    location / {{ add_header Cache-Control no-store always; return 418; }}
  }}
}}
'''


def syntax_reason(stderr):
    """Classify synthetic config errors without printing raw logs or filesystem paths."""
    if re.search(br'unknown "sora_pay_admission[^"\n]*" variable', stderr):
        return 'missing_admission_map'
    for pattern, label in ((b'getgrnam', 'configured_group_unavailable'), (b'getpwnam', 'configured_user_unavailable'),
                           (b'zero size shared memory zone', 'missing_rate_zone'), (b'unknown directive', 'unsupported_nginx_directive'),
                           (b'pcre2_compile', 'invalid_template_regex'), (b'pcre_compile', 'invalid_template_regex'),
                           (b'Permission denied', 'isolated_path_permission_denied'), (b'No such file', 'isolated_file_missing')):
        if pattern in stderr:
            return label
    return 'unclassified_synthetic_config_error'


def check_syntax(nginx, root, config, expected):
    result = subprocess.run([nginx, '-p', str(root) + '/', '-c', str(config), '-e', str(root / 'bootstrap.log'), '-t'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=4, check=False)
    require((result.returncode == 0) == expected, 'nginx_syntax_expectation_failed:' + syntax_reason(result.stderr))
    if not expected:
        require(syntax_reason(result.stderr) == 'missing_admission_map', 'missing_map_did_not_fail_closed:' + syntax_reason(result.stderr))


def run(nginx):
    """Test open/paused/open in one owned nginx instance, always cleaning up its children."""
    binary = Path(nginx)
    require(binary.is_absolute() and binary.is_file() and os.access(binary, os.X_OK), 'explicit_nginx_executable_required')
    source_http = (HERE / HTTP_TEMPLATE).read_text(encoding='utf8')
    source_server = (HERE / SERVER_TEMPLATE).read_text(encoding='utf8')
    source_guard = (HERE / GUARD_TEMPLATE).read_text(encoding='utf8')
    open_mode = (HERE / OPEN_TEMPLATE).read_text(encoding='utf8')
    paused_mode = (HERE / PAUSED_TEMPLATE).read_text(encoding='utf8')
    deadline = time.monotonic() + 50
    result = None
    with tempfile.TemporaryDirectory(prefix='sora-pay-admission-') as directory:
        root = Path(directory)
        upstream = ThreadingHTTPServer(('127.0.0.1', 0), SyntheticUpstream)
        upstream.daemon_threads = True
        thread = threading.Thread(target=upstream.serve_forever, kwargs={'poll_interval': 0.05}, daemon=True)
        process = None
        group_proven = False
        try:
            thread.start()
            with socket.socket() as reserve:
                reserve.bind(('127.0.0.1', 0))
                port = reserve.getsockname()[1]
            for name in ('body', 'proxy', 'fastcgi', 'uwsgi', 'scgi'):
                (root / name).mkdir(mode=0o700)
            (root / 'admission-http.conf').write_text(render_include(source_http, MODE_INCLUDE, root / 'mode.conf'), encoding='utf8')
            (root / 'admission-http-missing-map.conf').write_text(render_include(source_http, MODE_INCLUDE, None), encoding='utf8')
            (root / 'admission-server.conf').write_text(render_include(render_server(source_server, upstream.server_address[1]), GUARD_INCLUDE, root / 'guard.conf'), encoding='utf8')
            (root / 'guard.conf').write_text(source_guard, encoding='utf8')
            atomic_write(root / 'mode.conf', open_mode)
            config = root / 'nginx.conf'
            missing = root / 'missing-map.conf'
            config.write_text(configuration(root, port, True), encoding='utf8')
            missing.write_text(configuration(root, port, False), encoding='utf8')
            check_syntax(str(binary), root, missing, False)
            check_syntax(str(binary), root, config, True)
            process = subprocess.Popen([str(binary), '-p', str(root) + '/', '-c', str(config), '-e', str(root / 'bootstrap.log')],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            require(os.getpgid(process.pid) == process.pid, 'owned_process_group_mismatch')
            group_proven = True
            probe = Probe(port, deadline)
            probe.await_mode(process, 200)
            probe.check('POST', '/sora-pay/v1/orders', 200, '/v1/orders')
            probe.check('POST', f'/sora-pay/v1/orders/{ORDER}/payment-attempt', 200, f'/v1/orders/{ORDER}/payment-attempt')
            check_backslashes(probe)
            for mode, expected in ((paused_mode, 503), (open_mode, 200)):
                atomic_write(root / 'mode.conf', mode)
                check_syntax(str(binary), root, config, True)
                signal_owned(process, root / 'nginx.pid', signal.SIGHUP)
                probe.await_mode(process, expected)
                if expected == 503:
                    paused_matrix(probe)
                    check_backslashes(probe)
                else:
                    probe.check('POST', '/sora-pay/v1/orders', 200, '/v1/orders')
                    probe.check('POST', f'/sora-pay/v1/orders/{ORDER}/payment-attempt', 200, f'/v1/orders/{ORDER}/payment-attempt')
            result = {'ok': True, 'realNginx': True, 'modes': ['open', 'paused', 'open'], 'requests': probe.count,
                      'missingMapRejected': True, 'normalizationVerified': True, 'recoveryPreserved': True, 'parentHeadersIsolated': True,
                      'forwardedClientIpHeadersStripped': True, 'operatorBlocked': True, 'backslashRejectedInBothModes': True,
                      'templateSha256': {'http': hashlib.sha256(source_http.encode()).hexdigest(), 'server': hashlib.sha256(source_server.encode()).hexdigest(), 'guard': hashlib.sha256(source_guard.encode()).hexdigest(), 'open': hashlib.sha256(open_mode.encode()).hexdigest(), 'paused': hashlib.sha256(paused_mode.encode()).hexdigest()}}
        finally:
            # Finish bounded child cleanup even if the operator presses Ctrl-C again.
            previous_interrupt = signal.signal(signal.SIGINT, signal.SIG_IGN)
            try:
                try:
                    if process is not None:
                        stop_owned(process, group_proven)
                finally:
                    if thread.is_alive():
                        upstream.shutdown()
                    upstream.server_close()
                    thread.join(timeout=2)
                    require(not thread.is_alive(), 'synthetic_upstream_not_stopped')
            finally:
                signal.signal(signal.SIGINT, previous_interrupt)
    result['ownedProcessesStopped'] = True
    result['temporaryDirectoryRemoved'] = True
    return result


def check_backslashes(probe):
    """Reject nginx/WHATWG separator disagreement in both admission modes."""
    for suffix in ('orders' + chr(92) + ORDER + chr(92) + 'payment-attempt', 'orders/' + ORDER + chr(92) + 'payment-attempt', 'orders/' + ORDER + '%5Cpayment-attempt', 'x' + chr(92) + '..' + chr(92) + 'orders', 'x%5C..%5Corders', 'operator' + chr(92) + 'orders', 'operator%5Corders'):
        probe.check('POST', '/sora-pay/v1/' + suffix, 400)


def paused_matrix(probe):
    """Verify nginx-normalized URI and request-method admission, preserving existing orders."""
    for path in ('/sora-pay/v1/orders', '/sora-pay//v1/orders', '/sora-pay/v1/%6frders', '/sora-pay/v1/x/../orders'):
        probe.check('POST', path, 503)
    for path in (f'/sora-pay/v1/orders/{ORDER}/payment-attempt', f'/sora-pay/v1/orders/{ORDER}//payment-attempt', f'/sora-pay/v1/orders/{ORDER}/payment%2dattempt'):
        probe.check('POST', path, 503)
    for method, path in (
        ('GET', '/sora-pay/v1/catalog'), ('GET', f'/sora-pay/v1/orders/{ORDER}'),
        ('POST', '/sora-pay/v1/orders/recover-create'), ('POST', f'/sora-pay/v1/orders/{ORDER}/transaction'),
        ('POST', f'/sora-pay/v1/orders/{ORDER}/payment-attempt/cancel'),
        ('OPTIONS', '/sora-pay/v1/orders'), ('OPTIONS', f'/sora-pay/v1/orders/{ORDER}/payment-attempt'),
        ('GET', '/sora-pay/v1/orders'), ('PUT', '/sora-pay/v1/orders'),
        ('POST', '/sora-pay/v1/orders/'), ('POST', f'/sora-pay/v1/orders/{ORDER}/payment-attempt/'),
    ):
        probe.check(method, path, 204 if method == 'OPTIONS' else 200, path.replace('/sora-pay', '', 1))
    for path in ('/sora-pay/v1/operator', '/sora-pay/v1/operator/', '/sora-pay/v1/operator/orders', '/sora-pay/v1/%6fperator/orders', '/sora-pay//v1/operator/orders'):
        probe.check('POST', path, 403)
    for path in ('/sora-pay', '/sora-pay/', '/sora-pay/v1', '/sora-pay/not-an-api'):
        probe.check('GET', path, 404)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--nginx', metavar='ABSOLUTE_PATH', help='explicit opt-in to isolated real-nginx verification')
    args = parser.parse_args(argv)
    if args.nginx is None:
        print(json.dumps({'mode': 'plan', 'executed': False, 'usage': 'python3 deploy/check-admission-ingress.py --nginx /absolute/path/to/nginx', 'scope': 'temporary loopback nginx and synthetic upstream only'}, separators=(',', ':')))
        return 0
    try:
        result = run(args.nginx)
    except CheckFailure as error:
        result = {'ok': False, 'error': str(error)}
    except BaseException as error:
        result = {'ok': False, 'error': 'verification_failed', 'errorType': type(error).__name__}
    print(json.dumps(result, separators=(',', ':')))
    return 0 if result.get('ok') else 1


if __name__ == '__main__':
    raise SystemExit(main())
