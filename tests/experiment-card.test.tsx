import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { allowances, describeCommand, ExperimentCard } from "../components/artifacts/experiment-card.tsx";
import type { JobRecord } from "../src/core/index.ts";

const plan = {
	version: 3 as const,
	title: "Section 03 serving qualification",
	purpose: "Compare two engines on one small model.",
	commands: [["/usr/bin/python3", "-I", "-c", '"""Measure the same stream on both engines."""\nprint(1)\n']],
	downloads: [
		{ name: "a-1.0.whl", url: "https://files.pythonhosted.org/a-1.0.whl", sha256: "0".repeat(64), maxBytes: 5 * 2 ** 30 },
		{ name: "b-1.0.whl", url: "https://files.pythonhosted.org/b-1.0.whl", sha256: "1".repeat(64), maxBytes: 2 ** 30 },
	],
	inputs: [],
	limits: { wallSeconds: 1800, memoryMiB: 12288, tasks: 256, diskMiB: 2048, outputBytes: 65536, stagedCacheMiB: 6144, artifactBytes: 2 ** 25 },
	exports: [{ path: "comparison.json", maxBytes: 2 ** 21 }],
	environments: [{ name: "vllm", wheels: ["a"], maxInstalledMiB: 14336 }, { name: "sglang", wheels: ["b"], maxInstalledMiB: 14336 }],
	model: { repo: "Qwen/Qwen3-1.7B", revision: "70d244cc86ccca08cf5af4e1e306ecf908b1ad5e", files: [] },
	network: "internal-loopback" as const,
	gpu: true,
};

function job(overrides: Partial<JobRecord> = {}): JobRecord {
	return {
		id: "job_x", kind: "experiment", chatId: "c", toolCallId: "t", input: plan, status: "running", activity: "awaiting approval",
		createdAt: "2026-11-07T00:00:00Z", updatedAt: "2026-11-07T00:00:00Z",
		experiment: { state: "awaiting_approval", digest: "d".repeat(64), expiresAt: Date.now() + 3_600_000 },
		...overrides,
	} as JobRecord;
}

test("allowances describe the plan in a few plain lines", () => {
	const rows = allowances(plan);
	const text = rows.map((row) => `${row.lead} ${row.rest}`).join("\n");
	assert.match(text, /Download 2 files.*6\.0 GiB.*files\.pythonhosted\.org/);
	assert.match(text, /Prepare 2 private environments.*vllm and sglang/);
	assert.match(text, /Run one command on the desktop GPU.*30 min.*12 GiB/);
	assert.match(text, /Qwen\/Qwen3-1\.7B, read-only/);
	assert.match(text, /No internet while it runs/);
	assert.match(text, /comparison\.json.*2 MiB/);
	assert.ok(rows.length <= 7);
});

test("describeCommand summarises an inline script instead of printing it", () => {
	const command = describeCommand(plan.commands[0]!);
	assert.match(command.title, /^Python script · \d+ KiB$/);
	assert.equal(command.hint, "Measure the same stream on both engines.");
	assert.ok(command.script?.includes("print(1)"));
});

test("pending card has exactly two obvious actions, no checkbox, and no raw plan JSON", () => {
	const html = renderToStaticMarkup(<ExperimentCard job={job()} />);
	assert.match(html, /Experiment · needs your approval/);
	assert.match(html, /Approving allows/);
	assert.match(html, /data-testid="experiment-approve"[^>]*>.*Approve and run/);
	assert.match(html, /data-testid="experiment-decline"/);
	assert.doesNotMatch(html, /type="checkbox"/);
	assert.doesNotMatch(html, /"commands"|"downloads"|<pre/);
	assert.ok(html.length < 15000, `card markup stays small (${html.length})`);
});

test("expired or declined proposal offers Review again and no approve button", () => {
	const html = renderToStaticMarkup(<ExperimentCard job={job({ status: "error", activity: "aborted", experiment: { state: "revoked", digest: "d".repeat(64), expiresAt: 1 } })} />);
	assert.match(html, /declined/);
	assert.match(html, /experiment-review/);
	assert.doesNotMatch(html, /experiment-approve/);
	assert.doesNotMatch(html, /Download receipt/);
});
