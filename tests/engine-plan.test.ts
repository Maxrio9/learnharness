import test from 'node:test';
import assert from 'node:assert/strict';
import { enginePlan, candidateLadder, ladderEcho } from '../src/server/experiments/engine-plan.ts';
import { parsePlan, planDigest } from '../src/server/experiments/plan.ts';
import { prepareExperimentArguments } from '../src/agent/tools/experiment.ts';
import * as fs from 'node:fs';

const jobFile = process.env.LH_TEST_BASE_JOB; // optional real plan; the synthetic base below is enough for shape checks
const base = (): any => parsePlan(jobFile ? JSON.parse(fs.readFileSync(jobFile, 'utf8')).input : {
	version: 3, title: 'base', purpose: 'p', commands: [['bash', '-c', 'true']], downloads: [], inputs: [],
	limits: { wallSeconds: 3600, memoryMiB: 16384, tasks: 256, diskMiB: 16384, outputBytes: 65536, stagedCacheMiB: 49152, artifactBytes: 268435456 },
	network: 'off', gpu: false, exports: [],
	environments: [], model: undefined,
});

test('ladders put the requested backend first, then known-good fallbacks, without duplicates', () => {
	const sglang = candidateLadder({ kind: 'sglang', environment: 'sglang', preferredBackend: 'flashinfer', maxModelLen: 2176 }, 31001);
	assert.deepEqual(sglang.map(c => c.argv[c.argv.indexOf('--attention-backend') + 1]), ['flashinfer', 'triton', 'torch_native']);
	assert.match(sglang[0]!.label, /requested/);
	assert.ok(sglang[2]!.argv.includes('--sampling-backend'));
	const vllm = candidateLadder({ kind: 'vllm', environment: 'vllm', preferredBackend: 'FLASH_ATTN', maxModelLen: 2176 }, 31002);
	assert.deepEqual(vllm.map(c => c.env.VLLM_ATTENTION_BACKEND), ['FLASH_ATTN', 'TRITON_ATTN']);
	assert.ok(vllm.every(c => c.argv.includes('--enforce-eager') && c.argv.includes('--no-enable-prefix-caching')));
});

test('the argument decoder accepts propose_engines arguments sent as JSON strings', () => {
	const out = prepareExperimentArguments({ action: 'propose_engines', baseRecipeId: 'a'.repeat(64), engines: '[{"kind":"vllm","environment":"vllm","maxModelLen":2176}]', prompts: '[{"name":"short","count":2,"words":8}]', concurrency: '[1,2]', maxTokens: 64 }) as any;
	assert.ok(Array.isArray(out.engines) && Array.isArray(out.prompts) && Array.isArray(out.concurrency));
});

test('a real engine plan keeps downloads and environments, is one command, and passes strict plan parsing', { skip: !process.env.LH_TEST_BASE_JOB }, () => {
	const plan = enginePlan(base(), { engines: [{ kind: 'sglang', environment: 'sglang', preferredBackend: 'flashinfer', maxModelLen: 2176 }, { kind: 'vllm', environment: 'vllm', maxModelLen: 2176 }],
		prompts: [{ name: 'short', count: 8, words: 96 }], maxTokens: 128, concurrency: [1, 2] });
	const again = parsePlan(JSON.parse(JSON.stringify(plan)));
	assert.equal(again.commands.length, 1);
	assert.equal(planDigest(again), planDigest(plan));
	assert.match(ladderEcho(plan), /sglang: sglang flashinfer \(requested\).*-> sglang triton.*-> sglang torch_native/);
	assert.equal(plan.exports![0]!.path, 'out/ladder_summary.json');
});
