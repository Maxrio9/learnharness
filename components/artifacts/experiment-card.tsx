"use client";
import { useContext, useEffect, useState, type ReactNode } from "react";
import { Boxes, ChevronDown, Clock3, Cpu, Database, Download, FileDown, FlaskConical, Play, RotateCcw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrailleSpinner } from "@/components/braille-spinner";
import { DispatchCard } from "@/components/artifacts/dispatch-card";
import { JobsContext } from "@/components/jobs-context";
import type { ArtifactPartProps, JobRecord } from "@/src/core";
import type { ExperimentResult } from "@/src/core/contracts/experiment";
import type { ExperimentPlan } from "@/src/server/experiments/plan";

/** The experiment approval card. It answers one question for the learner: "what exactly am I letting
 *  this agent do?" in a handful of plain lines. Everything technical (the script, the package list, the
 *  limits, the plan fingerprint) lives behind one "Technical details" toggle and is never dumped raw. */

function sizeLabel(bytes: number): string {
	if (bytes >= 2 ** 30) return `${(bytes / 2 ** 30).toFixed(1)} GiB`;
	if (bytes >= 2 ** 20) return `${Math.round(bytes / 2 ** 20)} MiB`;
	return `${Math.max(1, Math.ceil(bytes / 2 ** 10))} KiB`;
}

function memoryLabel(mib: number): string {
	return mib >= 1024 ? `${+(mib / 1024).toFixed(1)} GiB` : `${mib} MiB`;
}

function durationLabel(seconds: number): string {
	if (seconds >= 3600) return `${+(seconds / 3600).toFixed(1)} h`;
	if (seconds >= 120) return `${Math.round(seconds / 60)} min`;
	return `${seconds} s`;
}

function remainingLabel(ms: number): string {
	const minutes = Math.max(1, Math.ceil(ms / 60_000));
	return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

/** One command, described for a human: what runs, not its argv. */
export function describeCommand(argv: string[]): { title: string; hint?: string; script?: string } {
	const program = (argv[0] ?? "").split("/").pop() ?? "";
	const flag = argv.indexOf("-c");
	if (flag > 0 && argv[flag + 1] !== undefined) {
		const script = argv[flag + 1]!;
		const first = script.split("\n").map((line) => line.replace(/^\s*(#|"""|''')\s*/, "").replace(/("""|''')\s*$/, "").trim()).find(Boolean);
		return {
			title: `${program.startsWith("python") ? "Python script" : `${program} script`} · ${sizeLabel(new TextEncoder().encode(script).length)}`,
			...(first ? { hint: first.slice(0, 140) } : {}),
			script,
		};
	}
	const line = argv.join(" ");
	return { title: line.length > 90 ? `${line.slice(0, 89)}…` : line };
}

function hostsOf(downloads: ExperimentPlan["downloads"]): string[] {
	const hosts = new Set<string>();
	for (const download of downloads) {
		try { hosts.add(new URL(download.url).hostname); } catch { /* an unparsable URL is shown in the details */ }
	}
	return [...hosts];
}

type Allowance = { icon: typeof Download; lead: string; rest: string };

/** The "Approving allows" lines, derived only from the plan the digest covers. */
export function allowances(plan: ExperimentPlan): Allowance[] {
	const rows: Allowance[] = [];
	const environments = plan.environments ?? [];
	const downloadBytes = plan.downloads.reduce((total, download) => total + download.maxBytes, 0);
	if (plan.downloads.length) {
		const hosts = hostsOf(plan.downloads);
		rows.push({
			icon: Download,
			lead: `Download ${plan.downloads.length} file${plan.downloads.length === 1 ? "" : "s"}`,
			rest: `up to ${sizeLabel(downloadBytes)}${hosts.length ? ` from ${hosts.slice(0, 2).join(", ")}${hosts.length > 2 ? ` +${hosts.length - 2}` : ""}` : ""}, each checked against a pinned hash`,
		});
	}
	if (environments.length) {
		rows.push({
			icon: Boxes,
			lead: `Prepare ${environments.length === 1 ? "a private environment" : `${environments.length} private environments`}`,
			rest: `${environments.map((environment) => environment.name).join(" and ")}, reused later if already built. Nothing is installed on your system`,
		});
	}
	const commands = plan.commands.length;
	rows.push({
		icon: plan.gpu ? Cpu : Play,
		lead: `Run ${commands === 1 ? "one command" : `${commands} commands`}${plan.gpu ? " on the desktop GPU" : ""}`,
		rest: `in a sandbox, up to ${durationLabel(plan.limits.wallSeconds)} and ${memoryLabel(plan.limits.memoryMiB)} of RAM`,
	});
	if (plan.model) {
		rows.push({ icon: Database, lead: "Read a cached model", rest: `${plan.model.repo}, read-only` });
	}
	rows.push({
		icon: WifiOff,
		lead: plan.network === "internal-loopback" ? "No internet while it runs" : "No network at all",
		rest: plan.network === "internal-loopback" ? "only a private loopback between its own processes" : "the sandbox is fully offline",
	});
	const exported = plan.exports ?? [];
	if (exported.length) {
		rows.push({
			icon: FileDown,
			lead: `Save ${exported.map((entry) => entry.path).join(", ")} to this lesson`,
			rest: `up to ${sizeLabel(exported.reduce((total, entry) => total + entry.maxBytes, 0))}`,
		});
	}
	return rows;
}

export function ExperimentToolCard({ part }: ArtifactPartProps) {
	const jobs = useContext(JobsContext);
	const job = jobs.find((j) => j.toolCallId === part.toolCallId);
	if (!job) return <div>Experiment specialist dispatched</div>;
	if (job.kind !== "experiment") return <DispatchCard toolCallId={part.toolCallId} kind="research" />;
	return <ExperimentCard key={`${job.id}:${job.experiment?.digest}`} job={job} />;
}

export function ExperimentCard({ job }: { job: JobRecord }) {
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const [showDetails, setShowDetails] = useState(false);
	const [now, setNow] = useState(0);
	useEffect(() => {
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const plan = job.input as ExperimentPlan;
	const pending = job.status === "running" && job.experiment?.state === "awaiting_approval";
	const expired = !!job.experiment && now > 0 && now >= job.experiment.expiresAt;
	const awaiting = pending && !expired;
	const canReview = (pending && expired) || (job.status === "error" && job.experiment?.state === "revoked" && !job.result);
	const running = job.status === "running" && !pending;

	async function act(action: "approve" | "decline" | "review" | "cancel") {
		if (busy || (action === "approve" && !awaiting) || (action === "review" && !canReview)) return;
		setBusy(true);
		try {
			const id = encodeURIComponent(job.id);
			const url = action === "approve" ? `/api/experiments/${id}/approve` : action === "review" ? `/api/experiments/${id}/review-again` : "/api/activity/abort";
			const body = action === "approve" ? { digest: job.experiment?.digest } : action === "review" ? {} : { kind: "job", id: job.id };
			const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
			setMessage(
				response.ok
					? action === "approve" ? "Approved for one run. Preparing the experiment."
					: action === "review" ? "A fresh proposal is ready for your review."
					: action === "decline" ? "Declined. Nothing was run."
					: "Cancellation requested."
					: "Unable to complete that action. Please refresh and try again.",
			);
		} catch {
			setMessage("Could not reach the application. Please try again.");
		} finally {
			setBusy(false);
		}
	}

	if (!plan || !job.experiment) return null;
	const rows = allowances(plan);
	const state = awaiting ? "needs your approval" : pending ? "approval expired" : job.experiment.state === "revoked" ? (job.result ? "cancelled" : job.status === "running" ? "cancelling" : "declined") : running ? "running" : "finished";

	return (
		<section className="rounded-xl border bg-card text-card-foreground" data-testid="experiment-card">
			<div className="flex items-center justify-between gap-3 px-4 pt-3.5">
				<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					{running ? <BrailleSpinner label="Experiment running" /> : <FlaskConical className="size-3.5" aria-hidden />}
					Experiment · {state}
				</div>
				{awaiting && now > 0 && (
					<span className="flex items-center gap-1.5 text-xs text-muted-foreground" title={new Date(job.experiment.expiresAt).toLocaleString()}>
						<Clock3 className="size-3.5" aria-hidden />
						expires in {remainingLabel(job.experiment.expiresAt - now)}
					</span>
				)}
			</div>

			<div className="px-4 pb-3 pt-2">
				<h3 className="text-base font-semibold leading-snug">{plan.title}</h3>
				{(awaiting || canReview) && <Purpose text={plan.purpose} />}
				{running && job.activity && <p className="mt-1.5 truncate text-sm text-muted-foreground">{job.activity}</p>}
			</div>

			{awaiting && (
				<div className="border-t border-border/60 px-4 py-3">
					<div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Approving allows</div>
					<ul className="mt-2.5 space-y-2.5" data-testid="experiment-allowances">
						{rows.map((row) => (
							<li key={row.lead} className="flex items-start gap-3 text-sm leading-snug">
								<row.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
								<span>
									<span className="font-medium">{row.lead}</span>
									<span className="text-muted-foreground"> · {row.rest}</span>
								</span>
							</li>
						))}
					</ul>
					<p className="mt-3 text-xs leading-relaxed text-muted-foreground">
						It cannot see your files or credentials, and nothing else runs. The approval covers this exact plan, once.
					</p>
				</div>
			)}

			{(awaiting || canReview) && (
				<div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-b-xl border-t border-border/60 bg-card px-3 py-2.5">
					<DetailsToggle open={showDetails} onClick={() => setShowDetails((open) => !open)} />
					<div className="flex items-center gap-2">
						{awaiting && (
							<>
								<Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => act("decline")} data-testid="experiment-decline">
									Decline
								</Button>
								<Button type="button" size="sm" disabled={busy} onClick={() => act("approve")} data-testid="experiment-approve">
									{plan.environments?.length ? "Approve and run" : "Approve and run once"}
								</Button>
							</>
						)}
						{canReview && (
							<Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => act("review")} data-testid="experiment-review">
								<RotateCcw /> Review again
							</Button>
						)}
					</div>
				</div>
			)}

			{running && (
				<div className="flex items-center justify-end rounded-b-xl border-t border-border/60 px-3 py-2.5">
					<Button type="button" variant="outline" size="sm" disabled={busy || job.experiment.state === "revoked"} onClick={() => act("cancel")}>
						Cancel experiment
					</Button>
				</div>
			)}

			{message && (
				<p className="border-t border-border/60 px-4 py-2.5 text-sm text-muted-foreground" role="status">
					{message}
				</p>
			)}

			{showDetails && (awaiting || canReview) && <TechnicalDetails plan={plan} digest={job.experiment.digest} />}
			{job.status !== "running" && !!job.result && <ExperimentReceiptLinks id={job.id} artifacts={(job.result as ExperimentResult | undefined)?.artifacts} />}
		</section>
	);
}

function Purpose({ text }: { text: string }) {
	const [open, setOpen] = useState(false);
	const long = text.length > 220;
	return (
		<p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
			{open || !long ? text : `${text.slice(0, 220).trimEnd()}…`}
			{long && (
				<button type="button" className="ml-1.5 text-foreground underline underline-offset-4" onClick={() => setOpen((value) => !value)}>
					{open ? "less" : "more"}
				</button>
			)}
		</p>
	);
}

function DetailsToggle({ open, onClick }: { open: boolean; onClick: () => void }) {
	return (
		<button
			type="button"
			aria-expanded={open}
			onClick={onClick}
			className="flex items-center gap-1.5 rounded-sm px-1 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
		>
			<ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
			Technical details
		</button>
	);
}

/** Structured, bounded detail: nothing here grows the card without a scroll cap. */
function TechnicalDetails({ plan, digest }: { plan: ExperimentPlan; digest: string }) {
	const hosts = hostsOf(plan.downloads);
	const downloadBytes = plan.downloads.reduce((total, download) => total + download.maxBytes, 0);
	const limits: [string, string][] = [
		["Time", durationLabel(plan.limits.wallSeconds)],
		["Memory", memoryLabel(plan.limits.memoryMiB)],
		["Workspace disk", memoryLabel(plan.limits.diskMiB)],
		["Processes", String(plan.limits.tasks)],
		["Console output", sizeLabel(plan.limits.outputBytes)],
		...(plan.limits.stagedCacheMiB ? ([["Download cache", memoryLabel(plan.limits.stagedCacheMiB)]] as [string, string][]) : []),
	];
	return (
		<div className="space-y-4 border-t border-border/60 px-4 py-3 text-sm" data-testid="experiment-details">
			<DetailSection label="Limits">
				<dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
					{limits.map(([name, value]) => (
						<div key={name} className="flex justify-between gap-2 border-b border-border/40 py-1">
							<dt className="text-muted-foreground">{name}</dt>
							<dd className="font-medium tabular-nums">{value}</dd>
						</div>
					))}
				</dl>
			</DetailSection>
			<DetailSection label={`Commands (${plan.commands.length})`}>
				<ol className="space-y-2">
					{plan.commands.map((argv, index) => <CommandRow key={index} argv={argv} />)}
				</ol>
			</DetailSection>
			{plan.downloads.length > 0 && (
				<DetailSection label={`Downloads (${plan.downloads.length}, up to ${sizeLabel(downloadBytes)})`}>
					<p className="text-xs text-muted-foreground">From {hosts.join(", ") || "unknown host"}. Each file must match its pinned SHA-256 or it is discarded.</p>
					<FileList names={plan.downloads.map((download) => download.name)} />
				</DetailSection>
			)}
			{!!plan.environments?.length && (
				<DetailSection label="Environments">
					<ul className="space-y-1 text-xs">
						{plan.environments.map((environment) => (
							<li key={environment.name}>
								<span className="font-medium">{environment.name}</span>
								<span className="text-muted-foreground"> · {environment.wheels.length} pinned packages · up to {environment.maxInstalledMiB.toLocaleString()} MiB installed</span>
							</li>
						))}
					</ul>
				</DetailSection>
			)}
			{plan.model && (
				<DetailSection label="Model">
					<p className="break-words text-xs">{plan.model.repo} <span className="text-muted-foreground">· revision {plan.model.revision.slice(0, 12)} · {plan.model.files.length} files</span></p>
				</DetailSection>
			)}
			<p className="break-all text-xs text-muted-foreground">Plan fingerprint (SHA-256): <span className="font-mono">{digest}</span></p>
		</div>
	);
}

function DetailSection({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div>
			<div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
			{children}
		</div>
	);
}

function CommandRow({ argv }: { argv: string[] }) {
	const [open, setOpen] = useState(false);
	const command = describeCommand(argv);
	return (
		<li className="rounded-lg border border-border/60 bg-background/50 px-3 py-2">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="break-words text-xs font-medium">{command.title}</div>
					{command.hint && <div className="mt-0.5 break-words text-xs text-muted-foreground">{command.hint}</div>}
				</div>
				{command.script && (
					<button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="shrink-0 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">
						{open ? "Hide script" : "View script"}
					</button>
				)}
			</div>
			{open && command.script && (
				<pre className="mt-2 max-h-56 overflow-auto whitespace-pre rounded-md bg-muted/60 p-2.5 text-xs leading-relaxed">{command.script}</pre>
			)}
		</li>
	);
}

function FileList({ names }: { names: string[] }) {
	const [all, setAll] = useState(false);
	const shown = all ? names : names.slice(0, 6);
	return (
		<div className="mt-1.5">
			<ul className={`space-y-0.5 text-xs text-muted-foreground ${all ? "max-h-48 overflow-auto" : ""}`}>
				{shown.map((name) => <li key={name} className="break-all">{name}</li>)}
			</ul>
			{names.length > 6 && (
				<button type="button" className="mt-1.5 text-xs text-foreground underline underline-offset-4" onClick={() => setAll((value) => !value)}>
					{all ? "Show fewer" : `Show all ${names.length}`}
				</button>
			)}
		</div>
	);
}

function ExperimentReceiptLinks({ id, artifacts }: { id: string; artifacts?: ExperimentResult["artifacts"] }) {
	const base = `/api/experiments/${encodeURIComponent(id)}`;
	return (
		<div className="flex flex-wrap gap-x-4 gap-y-2 border-t border-border/60 px-4 py-2.5 text-sm">
			<a className="underline underline-offset-4" href={`${base}/receipt`}>Download receipt</a>
			{artifacts?.filter((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256)).map((artifact) => (
				<a className="break-all underline underline-offset-4" key={artifact.name} href={`${base}/artifacts/${artifact.sha256}`}>
					Download {artifact.name} ({artifact.bytes.toLocaleString()} bytes)
				</a>
			))}
		</div>
	);
}

const outcomeLabels: Record<string, string> = { done: "complete", error: "failed", cancelled: "cancelled", deferred: "deferred", timeout: "timed out", output_limit: "output limit reached" };

/** The receipt in the lesson: one line of outcome, then the recorded output only on request. */
export function ExperimentReceipt({ result }: { result: ExperimentResult }) {
	return (
		<section className="rounded-xl border bg-card text-sm text-card-foreground" data-testid="experiment-receipt">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
				<span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					<FlaskConical className="size-3.5" aria-hidden />
					Experiment · {outcomeLabels[result.outcome] ?? result.outcome}
				</span>
				{!!result.environments?.length && (
					<span className="text-xs text-muted-foreground">
						{result.environments.map((environment) => `${environment.reused ? "reused" : "prepared"} ${environment.name}`).join(" · ")}
					</span>
				)}
			</div>
			{result.summary && (
				<details className="border-t border-border/60 px-4 py-2.5">
					<summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Recorded output</summary>
					<pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/60 p-3 text-xs">{result.summary}</pre>
				</details>
			)}
			<ExperimentReceiptLinks id={result.receiptId} artifacts={result.artifacts} />
		</section>
	);
}
