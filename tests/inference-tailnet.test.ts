import test from "node:test";
import assert from "node:assert/strict";
import * as access from "../src/server/desktop-access.ts";
import { subscriptionRequestOrigin } from "../src/server/web-subscription-http.ts";

test("tailnet access keeps localhost and requires the configured Serve identity remotely", () => {
 const before={...process.env};
 process.env.LH_CURRICULUM_WEB_ORIGIN="http://127.0.0.1:3933";
 process.env.LH_CURRICULUM_TAILNET_ORIGIN="https://desktop.example.ts.net";
 process.env.LH_CURRICULUM_TAILNET_LOGIN="learner@example.test";
 try {
  const f=(access as unknown as Record<string,unknown>).curriculumTailnetAuthorized;
  assert.equal(typeof f,"function","tailnet identity gate is missing");
  const allowed=f as (headers:Headers)=>boolean;
  assert.equal(allowed(new Headers({host:"127.0.0.1:3933"})),true);
  assert.equal(allowed(new Headers({host:"desktop.example.ts.net"})),false);
  assert.equal(allowed(new Headers({host:"desktop.example.ts.net","tailscale-user-login":"other@example.test"})),false);
  const h=new Headers({host:"desktop.example.ts.net","tailscale-user-login":"learner@example.test",origin:"https://desktop.example.ts.net"});
  assert.equal(allowed(h),true);
  assert.equal(access.curriculumWebAuthorized(h),true);
  h.set("origin","https://evil.example");assert.equal(access.curriculumWebAuthorized(h),false);
  h.set("origin","https://desktop.example.ts.net");h.set("sec-fetch-site","cross-site");assert.equal(access.curriculumWebAuthorized(h),false);
  h.set("host","evil.example");assert.equal(allowed(h),false);
  h.set("host","127.0.0.1:3933");assert.equal(access.curriculumWebAuthorized(h),false,"remote Origin is not allowed on localhost Host");
  const request=new Request("http://desktop.example.ts.net/api/subscriptions",{headers:{host:"desktop.example.ts.net",origin:"https://desktop.example.ts.net"}});
  assert.equal(subscriptionRequestOrigin(request),"https://desktop.example.ts.net","TLS termination uses configured origin, not untrusted forwarded headers");
 } finally {
  for(const k of ["LH_CURRICULUM_WEB_ORIGIN","LH_CURRICULUM_TAILNET_ORIGIN","LH_CURRICULUM_TAILNET_LOGIN"]) {if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];}
 }
});
