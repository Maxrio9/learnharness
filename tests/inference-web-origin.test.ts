import test from "node:test";
import assert from "node:assert/strict";
import * as access from "../src/server/desktop-access.ts";

test("curriculum web API rejects foreign hosts and cross-origin requests", () => {
 const fn=(access as unknown as Record<string,unknown>).curriculumWebAuthorized;
 assert.equal(typeof fn,"function","curriculum origin gate is not implemented");
 const allowed=fn as (h:Headers)=>boolean;
 const before=process.env.LH_CURRICULUM_WEB_ORIGIN;
 process.env.LH_CURRICULUM_WEB_ORIGIN="http://127.0.0.1:3933";
 try {
  assert.equal(allowed(new Headers({host:"127.0.0.1:3933"})),true);
  assert.equal(allowed(new Headers({host:"127.0.0.1:3933",origin:"http://127.0.0.1:3933"})),true);
  assert.equal(allowed(new Headers({host:"evil.example:3933"})),false);
  assert.equal(allowed(new Headers({host:"127.0.0.1:3933",origin:"https://evil.example"})),false);
  assert.equal(allowed(new Headers({host:"127.0.0.1:3933","sec-fetch-site":"cross-site"})),false);
 } finally {if(before===undefined)delete process.env.LH_CURRICULUM_WEB_ORIGIN;else process.env.LH_CURRICULUM_WEB_ORIGIN=before;}
});
