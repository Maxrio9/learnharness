import type { ExperimentPlan } from './plan.ts';

/** Build a complete, reviewable serving-comparison plan from a few parameters instead of letting an agent write a
 *  launch script. The commands only write a small JSON spec and hand it to the trusted /tools/engine_ladder.py, which
 *  owns starting, waiting (with liveness checks), smoke testing, measuring, tearing down and falling back.
 *
 *  Candidate backends are tried in order: the requested preferred backend first (if any), then backends known to start
 *  in the sandbox. Known here means observed: the sandbox has no CUDA toolkit (no nvcc), so JIT-compiled kernel paths
 *  such as SGLang's flashinfer backend cannot start, while triton and torch_native can. The approval card shows the
 *  whole ladder and the receipt records which rung actually produced the numbers. */

export type EngineRequest = { kind: 'vllm' | 'sglang'; environment: string; preferredBackend?: string; maxModelLen: number; memoryFraction?: number };
export type EngineComparisonInput = {
	title?: string; purpose?: string; limits?: Record<string, number>;
	engines: EngineRequest[];
	prompts: { name: string; count: number; words: number }[];
	maxTokens: number; concurrency: number[]; warmup?: number; readySeconds?: number;
};

const FALLBACKS: Record<EngineRequest['kind'], string[]> = { vllm: ['FLASH_ATTN', 'TRITON_ATTN'], sglang: ['triton', 'torch_native'] };
const BASE_PORT = 31001;
const SERVED_NAME = 'model';

export function candidateLadder(request: EngineRequest, port: number): { label: string; argv: string[]; env: Record<string, string> }[] {
	const backends = [...new Set([...(request.preferredBackend ? [request.preferredBackend] : []), ...FALLBACKS[request.kind]])];
	const python = `/environments/${request.environment}/python`;
	const fraction = String(request.memoryFraction ?? 0.35);
	return backends.map((backend, index) => {
		const preferred = index === 0 && Boolean(request.preferredBackend);
		const label = `${request.kind} ${backend}${preferred ? ' (requested)' : index === 0 ? '' : ' (fallback)'}, eager, no prefix caching`;
		if (request.kind === 'vllm') {
			return { label, env: { VLLM_ATTENTION_BACKEND: backend }, argv: [python, '-m', 'vllm.entrypoints.openai.api_server', '--model', '/model', '--served-model-name', SERVED_NAME,
				'--host', '127.0.0.1', '--port', String(port), '--dtype', 'bfloat16', '--enforce-eager', '--no-enable-prefix-caching',
				'--max-model-len', String(request.maxModelLen), '--gpu-memory-utilization', fraction] };
		}
		return { label, env: { SGLANG_ENABLE_JIT_DEEPGEMM: '0', SGLANG_FORCE_FUSED_OP_BACKEND: 'torch' }, argv: [python, '-m', 'sglang.launch_server', '--model-path', '/model', '--served-model-name', SERVED_NAME,
			'--host', '127.0.0.1', '--port', String(port), '--dtype', 'bfloat16', '--attention-backend', backend, '--disable-radix-cache', '--disable-cuda-graph',
			'--context-length', String(request.maxModelLen), '--mem-fraction-static', fraction, '--stream-interval', '1',
			...(backend === 'torch_native' ? ['--sampling-backend', 'pytorch'] : [])] };
	});
}

export function enginePlan(base: ExperimentPlan, input: EngineComparisonInput): ExperimentPlan {
	if (base.version !== 3 || !base.environments?.length || !base.model) throw new Error('propose_engines needs a base plan with pinned environments and a model (use a serving recipe or an earlier proposal of this lesson as the base)');
	const known = new Set(base.environments.map(e => e.name));
	const names = new Set<string>();
	for (const engine of input.engines) {
		if (!known.has(engine.environment)) throw new Error(`engine environment ${engine.environment} is not in the base plan (it has: ${[...known].join(', ')})`);
		if (names.has(engine.environment + engine.kind)) throw new Error('each engine may appear once');
		names.add(engine.environment + engine.kind);
	}
	const spec = {
		model: SERVED_NAME, out: 'out', seed: 20260717, ready_seconds: input.readySeconds ?? 300,
		max_tokens: input.maxTokens, concurrency: input.concurrency, warmup: input.warmup ?? 2, request_timeout: 240,
		prompts: Object.fromEntries(input.prompts.map(p => [p.name, { count: p.count, words: p.words }])),
		engines: input.engines.map((engine, index) => ({ name: engine.kind, port: BASE_PORT + index, candidates: candidateLadder(engine, BASE_PORT + index) })),
	};
	const runner = `/environments/${input.engines[0]!.environment}/python`;
	const script = [
		'mkdir -p out',
		`/usr/bin/nvidia-smi --query-gpu=name,compute_cap,driver_version,memory.total --format=csv,noheader || true`,
		`cat > out/ladder_spec.json <<'LADDER_SPEC'\n${JSON.stringify(spec)}\nLADDER_SPEC`,
		`exec ${runner} /tools/engine_ladder.py out/ladder_spec.json`,
	].join('\n');
	const plan = structuredClone(base) as ExperimentPlan;
	plan.commands = [['bash', '-c', script]];
	plan.gpu = true;
	plan.network = 'internal-loopback';
	plan.exports = [{ path: 'out/ladder_summary.json', maxBytes: 1048576 }, { path: 'out/ladder_spec.json', maxBytes: 65536 }];
	if (input.title) plan.title = input.title;
	if (input.purpose) plan.purpose = input.purpose;
	if (input.limits) Object.assign(plan.limits, input.limits);
	return plan;
}

export function ladderEcho(plan: ExperimentPlan): string {
	try {
		const script = plan.commands[0]?.[2] ?? '';
		const spec = JSON.parse(script.split("<<'LADDER_SPEC'\n")[1]!.split('\nLADDER_SPEC')[0]!);
		return spec.engines.map((e: { name: string; candidates: { label: string }[] }) => `${e.name}: ${e.candidates.map(c => c.label).join(' -> ')}`).join('; ');
	} catch { return ''; }
}
