#!/usr/bin/env node
/** Explicit local tool only. It loads no environment file, credentials, or wallet API. */
import { parseRehearsalProxyArguments, startRehearsalProxy } from '../dist/relay/rehearsal-proxy.js';

if (process.argv.length === 2 || process.argv.slice(2).includes('--help')) {
  console.log('Usage: node deploy/rehearsal-proxy.mjs --listen-port 39849 --upstream http://127.0.0.1:39850 --frontend-origin http://127.0.0.1:41829');
} else {
  try {
    const options = parseRehearsalProxyArguments(process.argv.slice(2));
    const server = await startRehearsalProxy(options);
    console.log(`Local customer rehearsal proxy listening on http://127.0.0.1:${options.listenPort}`);
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      server.close();
      const deadline = setTimeout(() => server.closeAllConnections(), 5_000);
      deadline.unref(); server.once('close', () => clearTimeout(deadline));
    };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } catch {
    console.error('Rehearsal proxy could not start. Check the explicit loopback flags and port availability.');
    process.exitCode = 1;
  }
}
