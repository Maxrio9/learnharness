import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { PATHS } from '../../../config.ts';
import { boundedText } from './evidence.ts';

/** What the TUTOR needs to keep teaching after an experiment: the run facts and a bounded structural
 *  digest of the exported JSON measurements. The receipt's console summary alone is often two lines
 *  ("vllm served all streaming requests"), so without this the tutor cannot compare anything.
 *
 *  Safety shape (artifact content is untrusted, agent-authored data):
 *  - only JSON artifacts within a size bound are previewed, and only through a hash- and ownership-checked read;
 *  - numbers, booleans and short printable-ASCII strings pass; every longer string (model completions,
 *    logs, prose) is replaced by an "omitted" marker, so free text can never reach the model context;
 *  - keys are restricted, arrays/objects/depth are capped and the whole digest has a hard byte budget;
 *  - the caller labels the section UNTRUSTED data. */

const MAX_PREVIEW_BYTES = 262144;
const SHORT_STRING = 60;
const DIGEST_BUDGET = 9000;
const printable = /^[\x20-\x7E]*$/;

export function slimJson(value: unknown, depth = 0): unknown {
	if (value === null || typeof value === 'boolean') return value;
	if (typeof value === 'number') return Number.isFinite(value) ? Number(value.toPrecision(5)) : null;
	if (typeof value === 'string') return value.length <= SHORT_STRING && printable.test(value) ? value : `<omitted ${value.length} chars>`;
	if (depth >= 8) return '<omitted depth>';
	if (Array.isArray(value)) {
		const simple = value.every((item) => item === null || ['number', 'boolean', 'string'].includes(typeof item));
		const limit = simple ? 40 : 3;
		const out = value.slice(0, limit).map((item) => slimJson(item, depth + 1));
		if (value.length > limit) out.push(`<${value.length - limit} more of ${value.length}>`);
		return out;
	}
	if (typeof value === 'object') {
		const out: Record<string, unknown> = {};
		let kept = 0;
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			if (kept >= 40) { out._more_keys = Object.keys(value as object).length - kept; break; }
			out[/^[A-Za-z0-9_. -]{1,48}$/.test(key) ? key : `_key${kept}`] = slimJson(item, depth + 1);
			kept++;
		}
		return out;
	}
	return '<omitted>';
}

function readArtifactText(id: string, sha256: string, bytes: number): string | undefined {
	if (bytes > MAX_PREVIEW_BYTES || !/^[a-f0-9]{64}$/.test(sha256)) return undefined;
	const dir = path.join(PATHS.data, 'admin', 'experiments', 'artifacts', id);
	try {
		const dirStat = fs.lstatSync(dir);
		if (dirStat.isSymbolicLink() || !dirStat.isDirectory() || dirStat.uid !== process.getuid?.() || (dirStat.mode & 0o077) !== 0) return undefined;
		const fd = fs.openSync(path.join(dir, sha256), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
		try {
			const stat = fs.fstatSync(fd);
			if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size !== bytes) return undefined;
			const data = fs.readFileSync(fd);
			return createHash('sha256').update(data).digest('hex') === sha256 ? data.toString('utf8') : undefined;
		} finally { fs.closeSync(fd); }
	} catch { return undefined; }
}

export function artifactDigest(id: string, artifacts: { name: string; sha256: string; bytes: number }[] | undefined): string {
	if (!artifacts?.length) return '';
	const lines: string[] = [];
	for (const artifact of artifacts) {
		const head = `- ${artifact.name} (${artifact.bytes.toLocaleString('en-US')} bytes, sha256 ${artifact.sha256.slice(0, 12)})`;
		if (!artifact.name.endsWith('.json')) { lines.push(`${head}: not previewed (not JSON)`); continue; }
		const text = readArtifactText(id, artifact.sha256, artifact.bytes);
		if (text === undefined) { lines.push(`${head}: not previewed (unreadable or too large)`); continue; }
		try {
			lines.push(`${head}: ${JSON.stringify(slimJson(JSON.parse(text)))}`);
		} catch { lines.push(`${head}: not previewed (invalid JSON)`); }
	}
	return boundedText(lines.join('\n'), DIGEST_BUDGET);
}

/** Facts from the native receipt, so a later status line can never contradict what actually happened. */
export function runFacts(receipt: Record<string, unknown>): string {
	const auth = (receipt.authorization ?? {}) as { approvedAt?: unknown };
	const start = typeof receipt.start === 'string' ? Date.parse(receipt.start) : NaN;
	const end = typeof receipt.end === 'string' ? Date.parse(receipt.end) : NaN;
	const parts = [
		typeof auth.approvedAt === 'number' ? `approved by the learner at ${new Date(auth.approvedAt).toISOString()}` : 'approval time not recorded',
		Number.isFinite(start) && Number.isFinite(end) ? `ran ${new Date(start).toISOString()} to ${new Date(end).toISOString()} (${Math.round((end - start) / 1000)} s)` : 'run time not recorded',
		`exit code ${typeof receipt.exitCode === 'number' ? receipt.exitCode : 'unknown'}`,
		`outcome ${String(receipt.outcome)}`,
		receipt.gpuReleasedAfterCleanup === true ? 'cleanup confirmed and GPU released' : 'cleanup confirmed',
	];
	return `Execution facts from the native receipt: ${parts.join('; ')}. This receipt supersedes any earlier "awaiting approval" or "nothing has executed" status for this job.`;
}
