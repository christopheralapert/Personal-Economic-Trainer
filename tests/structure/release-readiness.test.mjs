import {test} from 'node:test';
import assert from 'node:assert/strict';
import {releaseReadiness} from '../../scripts/release_readiness.mjs';

test('default readiness check does not call providers or claim real service/device verification',async()=>{
 const report=await releaseReadiness({env:{},network:()=>{throw new Error('No external request allowed');}});
 assert.equal(report.configurationOnly,true);assert.equal(report.liveInferencePerformed,false);
 assert.ok(report.results.every(result=>result.status!=='passed'));
 assert.deepEqual(report.results.find(result=>result.feature==='Gemini').missing,['GEMINI_API_KEY']);
 assert.equal(report.results.find(result=>result.feature==='Physical microphone, playback and PWA installation').status,'manual_verification_required');
});
test('keys and configured endpoint values never enter readiness output',async()=>{
 const env={GEMINI_API_KEY:'private-synthetic-gemini',VERDA_INFERENCE_KEY:'private-synthetic-verda',MONEYLENS_OIDC_ISSUER:'https://private-tenant.auth0.com/',MONEYLENS_OIDC_CLIENT_ID:'private-client',MONEYLENS_OIDC_CLIENT_SECRET:'private-secret',MONEYLENS_OIDC_AUTHORIZATION_URL:'https://private-tenant.auth0.com/authorize',MONEYLENS_OIDC_TOKEN_URL:'https://private-tenant.auth0.com/oauth/token',MONEYLENS_OIDC_JWKS_URL:'https://private-tenant.auth0.com/.well-known/jwks.json'};
 const report=await releaseReadiness({env});assert.equal(report.results.find(result=>result.feature==='Real Auth0').status,'configured_not_verified');
 for(const value of Object.values(env))assert.equal(JSON.stringify(report).includes(value),false);
});
test('explicit reachability probes contain no credentials or payload and do not count as live inference',async()=>{
 const calls=[];
 const report=await releaseReadiness({env:{GEMINI_API_KEY:'must-not-leave'},probe:true,network:async(url,init)=>{calls.push([url,init]);return new Response(null,{status:404});}});
 assert.equal(calls.length,2);assert.equal(report.liveInferencePerformed,false);
 for(const [,init] of calls){assert.equal(init.method,'HEAD');assert.equal(init.headers,undefined);assert.equal(init.body,undefined);}
 assert.ok(report.results.filter(result=>result.status==='network_reachable').every(result=>result.httpStatus===404));
});
test('network failures are sanitized instead of printing private provider diagnostics',async()=>{
 const report=await releaseReadiness({env:{},probe:true,network:async()=>{throw new TypeError('secret URL or key',{cause:Object.assign(new Error('private request details'),{code:'EACCES'})});}});
 assert.equal(report.results.filter(result=>result.code==='EACCES').length,2);
 assert.doesNotMatch(JSON.stringify(report),/secret URL|private request/);
});
test('placeholder OIDC issuers and invalid admission limits remain blocked',async()=>{
 const report=await releaseReadiness({env:{MONEYLENS_OIDC_ISSUER:'https://identity.example',MONEY_COACH_PUBLIC_AI_BUDGET_PATH:'relative.json',MONEY_COACH_PUBLIC_AI_MAX_REQUESTS:'unlimited'}});
 assert.deepEqual(report.results.find(result=>result.feature==='Real Auth0').invalid,['MONEYLENS_OIDC_ISSUER']);
 assert.deepEqual(report.results.find(result=>result.feature==='Local AI admission controls').invalid,['MONEY_COACH_PUBLIC_AI_BUDGET_PATH','MONEY_COACH_PUBLIC_AI_MAX_REQUESTS']);
});
