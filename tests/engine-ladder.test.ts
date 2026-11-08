import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ladder = path.resolve('scripts/experiments/engine_ladder.py');
const stub = path.resolve('tests/fixtures/stub-engine.py');

function run(engines: unknown[], extra: Record<string, unknown> = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-'));
	const spec = { model: 'stub', out: path.join(dir, 'out'), ready_seconds: 4, max_tokens: 6, concurrency: [1, 2], warmup: 1, prompts: { short: { count: 3, words: 8 } }, engines, ...extra };
	fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(spec));
	const started = Date.now();
	const result = spawnSync('/usr/bin/python3', ['-I', ladder, path.join(dir, 'spec.json')], { encoding: 'utf8', timeout: 90000 });
	const summary = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'ladder_summary.json'), 'utf8'));
	return { result, summary, seconds: (Date.now() - started) / 1000 };
}
const cand = (label: string, mode: string, port: number) => ({ label, argv: ['/usr/bin/python3', stub, mode, String(port)] });

test('falls back past a crashing candidate fast and records why', () => {
	const { result, summary, seconds } = run([{ name: 'a', port: 38101, candidates: [cand('needs nvcc', 'crash', 38101), cand('plain', 'ok', 38101)] }]);
	assert.equal(result.status, 0, result.stderr);
	const engine = summary.engines.a;
	assert.equal(engine.status, 'ok');
	assert.equal(engine.rung, 'plain');
	assert.equal(engine.attempts[0].outcome, 'failed');
	assert.match(engine.attempts[0].reason, /exited with status 1/);
	assert.match(engine.attempts[0].log_tail, /nvcc/);
	assert.equal(engine.attempts[1].port_released, true);
	assert.equal(engine.runs.length, 2);
	assert.equal(engine.runs[0].success, 3);
	assert.ok(seconds < 30, `crash must not wait out the ready bound (took ${seconds}s)`);
	assert.match(result.stdout, /1 earlier candidate\(s\) failed/);
});

test('a hung candidate is abandoned at the ready bound and a request-failing one falls through', () => {
	const { summary } = run([{ name: 'b', port: 38102, candidates: [cand('hangs', 'hang', 38102), cand('bad requests', 'badreq', 38102), cand('good', 'ok', 38102)] }]);
	const engine = summary.engines.b;
	assert.deepEqual(engine.attempts.map((a: { outcome: string }) => a.outcome), ['failed', 'failed', 'ok']);
	assert.match(engine.attempts[0].reason, /not ready within 4 s/);
	assert.match(engine.attempts[1].reason, /first request failed/);
	assert.equal(engine.rung, 'good');
});

test('an engine with no working candidate is reported, and the other engine is still measured', () => {
	const { result, summary } = run([
		{ name: 'dead', port: 38103, candidates: [cand('only', 'crash', 38103)] },
		{ name: 'live', port: 38104, candidates: [cand('only', 'ok', 38104)] },
	]);
	assert.equal(result.status, 0);
	assert.equal(summary.engines.dead.status, 'failed');
	assert.equal(summary.engines.dead.rung, null);
	assert.equal(summary.engines.live.status, 'ok');
});
