import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileSha256, verifyRuntimeArchive, inventory, verifyManifest, assertNoSecretFields } from '../../deploy/staging-utils.mjs';
import { stageRelay, stagingOptions } from '../../deploy/stage-relay.mjs';
import { validateConfig, type MerchantConfig } from '../../dist/relay/index.js';

function temporary() { const directory=mkdtempSync(join(tmpdir(),'sora-pay-deploy-test-'));return {directory,cleanup:()=>rmSync(directory,{recursive:true,force:true})}; }

test('Polkaswap binds its approved archive without replacing primary RPC or enabling checkout', () => {
 const config = JSON.parse(readFileSync(new URL('../../deploy/merchant.polkaswap.json.example', import.meta.url), 'utf8')) as MerchantConfig;
 assert.equal(config.enabled, false);
 assert.equal(config.chain.rpcUrl, 'wss://ws.mof.sora.org');
 assert.equal(config.chain.archiveRpcUrl, 'wss://mof2.sora.org');
 assert.equal(config.chain.genesisHash, '0x7e4e32d0feafd4f9c9414b0be86373f9a1efa904809b683453a9af6856d38ad5');
 assert.equal(config.chain.recipient, 'cnWUWKLZmNjQXGzYAF7YuRSiW1pKTRTzu4fmcYmWQX6UMGQUZ');
 assert.equal(config.product.priceXor, '1.759225');
 const enabledCopy = { ...structuredClone(config), enabled: true };
 assert.doesNotThrow(() => validateConfig(enabledCopy));
 enabledCopy.chain.archiveRpcUrl = 'http://unapproved.example.test';
 assert.throws(() => validateConfig(enabledCopy), /TLS archive RPC/);
 const generic = JSON.parse(readFileSync(new URL('../../deploy/merchant.disabled.json.example', import.meta.url), 'utf8')) as MerchantConfig;
 assert.equal(generic.enabled, false);
 assert.equal(generic.chain.archiveRpcUrl, undefined);
});

test('staging checksums reject changed runtime bytes before creating an output tree',async()=>{
 const t=temporary();try {
  const archive=join(t.directory,'node.tar.xz');writeFileSync(archive,'corrupt archive');
  const digest=await fileSha256(archive);await verifyRuntimeArchive(archive,digest);
  await assert.rejects(()=>verifyRuntimeArchive(archive,'0'.repeat(64)),/runtime_checksum_mismatch/);
  const output=join(t.directory,'output');await assert.rejects(()=>stageRelay({output,runtimeArchive:archive,installationRoot:'/Users/administrator/apps/sora-pay'}),/runtime_checksum_mismatch/);assert.equal(existsSync(output),false);
 }finally{t.cleanup();}
});

test('deterministic staging inventory verifies bytes and refuses escaping symlinks',async()=>{
 const t=temporary();try {
  mkdirSync(join(t.directory,'bin'));writeFileSync(join(t.directory,'bin/node'),'test runtime',{mode:0o755});symlinkSync('node',join(t.directory,'bin/node-link'));
  const files=await inventory(t.directory);assert.deepEqual(await inventory(t.directory),files);
  const manifest={version:1,merchantEnabled:false,runtime:{version:'26.9.0'},files};writeFileSync(join(t.directory,'staging-manifest.json'),JSON.stringify(manifest));
  const digest=await fileSha256(join(t.directory,'staging-manifest.json'));assert.equal((await verifyManifest(t.directory,digest)).digest,digest);
  writeFileSync(join(t.directory,'bin/node'),'modified runtime');await assert.rejects(()=>verifyManifest(t.directory,digest),/staging_manifest_file_mismatch/);
  symlinkSync('../../outside',join(t.directory,'bin/escape'));await assert.rejects(()=>inventory(t.directory),/staging_symlink_escape/);
 }finally{t.cleanup();}
});

test('staging accepts only documented explicit flags and rejects secret template fields',()=>{
 assert.deepEqual(stagingOptions(['--output','/tmp/stage','--runtime-archive','/tmp/node.tar.xz','--installation-root','/Users/operator/apps/sora-pay']),{output:'/tmp/stage',runtimeArchive:'/tmp/node.tar.xz',installationRoot:'/Users/operator/apps/sora-pay'});
 assert.throws(()=>stagingOptions(['--enable','yes']));assert.throws(()=>stagingOptions(['--output','/tmp/a','--output','/tmp/b']));
 assert.doesNotThrow(()=>assertNoSecretFields({merchant:{supportEmail:'test@example.test'}}));assert.throws(()=>assertNoSecretFields({privateKey:'do-not-copy'}));assert.throws(()=>assertNoSecretFields({transport:{password:'do-not-copy'}}));
 const runner=readFileSync(new URL('../../deploy/run-relay.sh',import.meta.url),'utf8');assert.match(runner,/runtime\/node-v26\.9\.0-darwin-arm64\/bin\/node/);assert.doesNotMatch(runner,/\/opt\/homebrew\/bin\/node/);
 const plist=readFileSync(new URL('../../deploy/org.sora.sora-pay-relay.plist.example',import.meta.url),'utf8');assert.match(plist,/<key>Disabled<\/key><true\/>/);assert.match(plist,/<key>RunAtLoad<\/key><false\/>/);assert.match(plist,/<key>KeepAlive<\/key><false\/>/);
});

test('staging archive is byte reproducible and refuses extra private runtime files',async()=>{
 const t=temporary();try {
  const root=join(t.directory,'stage');mkdirSync(join(root,'private'),{recursive:true,mode:0o700});writeFileSync(join(root,'private/merchant.json'),JSON.stringify({enabled:false}),{mode:0o600});writeFileSync(join(root,'payload'),'test');
  const files=await inventory(root);writeFileSync(join(root,'staging-manifest.json'),JSON.stringify({version:1,merchantEnabled:false,runtime:{},files}));
  const script=new URL('../../deploy/archive-stage.py',import.meta.url).pathname;const first=join(t.directory,'first.tgz');const second=join(t.directory,'second.tgz');
  execFileSync('python3',[script,root,first]);execFileSync('python3',[script,root,second]);assert.equal(await fileSha256(first),await fileSha256(second));
  writeFileSync(join(root,'private/relay.env'),'SORA_PAY_OPERATOR_TOKEN=secret');assert.throws(()=>execFileSync('python3',[script,root,join(t.directory,'unsafe.tgz')],{stdio:'pipe'}));assert.equal(existsSync(join(t.directory,'unsafe.tgz')),false);
 }finally{t.cleanup();}
});

import { checkReadiness } from '../../deploy/check-readiness.mjs';
test('readiness reports credential booleans without exposing values or creating a database',async()=>{
 const t=temporary();try {
  mkdirSync(join(t.directory,'private'),{mode:0o700});writeFileSync(join(t.directory,'private/merchant.json'),JSON.stringify({enabled:false,chain:{}}),{mode:0o600});
  const files=await inventory(t.directory);writeFileSync(join(t.directory,'staging-manifest.json'),JSON.stringify({version:1,merchantEnabled:false,runtime:{version:'26.9.0',platform:'test-other-platform',arch:'test-other-arch',directory:'node-runtime'},files}));
  const sensitive='a'.repeat(64);writeFileSync(join(t.directory,'private/relay.env'),`SORA_PAY_ENCRYPTION_KEY=${sensitive}\nSORA_PAY_OPERATOR_TOKEN=${sensitive}\n`,{mode:0o600});
  const report=await checkReadiness(t.directory);assert.equal(report.stagingReady,false);assert.equal(report.liveReadinessVerified,false);assert.equal(report.runtime.hostMatches,false);assert.equal(report.credentials.databaseEncryptionKey,true);assert.equal(report.credentials.operatorToken,true);assert.equal(report.credentials.notification,false);assert.equal(JSON.stringify(report).includes(sensitive),false);assert.equal(existsSync(join(t.directory,'private/orders.sqlite')),false);
 }finally{t.cleanup();}
});
