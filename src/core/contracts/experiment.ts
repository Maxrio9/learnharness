/** A prepared environment recorded by the supervisor. */
export interface ExperimentEnvironmentResult {
	name: string;
	id: string;
	runtime: string;
	installedBytes: number;
	reused: boolean;
}

/** Native deterministic-operator result; never a host filesystem path. */
export interface ExperimentResult {
	receiptId: string;
	outcome: string;
	summary: string;
	artifacts?: { name: string; sha256: string; bytes: number }[];
	/** Run facts and a bounded structural digest of exported measurements, for the tutor's context. */
	evidence?: string;
	environments?: ExperimentEnvironmentResult[];
}
