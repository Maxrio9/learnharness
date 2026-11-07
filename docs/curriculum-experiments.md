# Curriculum experiments

Ask the tutor for a specific measurement. The experiment specialist can prepare a single proposal containing the setup, all runs in the comparison, and the results to export. The tutor continues teaching while the specialist prepares it. The proposal is inert until the learner approves it in the lesson.

Use **Review exact commands, downloads and limits** to inspect the plan. **Approve setup and run** authorizes one run, including any downloads and setup the plan requires. **Review again** creates a fresh inert proposal after rejection or expiry. A separate experiment still needs its own approval, even when it reuses everything from the previous run.

The receipt shows which environments were prepared or reused. Reuse requires the same pinned wheels and compatible managed runtime, with the installed files verified before use. The engine never installs packages on the host. Its Python environment and approved model files are read-only. Write experiment results to the private workspace, and declare the files to export before approval.

For local curriculum maintenance:

- Inspect for a curated recipe that matches the experiment. It can be proposed without reconstructing commands or package lists. A new experiment can combine existing wheel locks in separate named environments and use only the selected model files it needs.
- For a new Python stack, curate a complete CPython 3.12 Linux x86-64 wheel closure with exact HTTPS URLs, SHA-256 hashes and size bounds. An environment is a set of approved wheels, not a mutable virtual environment or a general OS image.
- Local administrative inputs live under the configured LearnHarness data directory in `admin/experiments`: `recipes` holds exact version 3 plans, `environment-locks` holds labels, installation ceilings and pinned wheels, and `model-locks` holds cached snapshot manifests. Each file is named by the SHA-256 of its exact JSON bytes and is private to the app owner. The experiment agent can discover and propose them; it cannot add, change or approve them.
- Serving comparisons use private loopback. Compare the same model revision and workload, report engine and kernel settings, and distinguish a smoke run from a performance benchmark.
- For CUDA/NVTX capture, launch the target through `nsys profile --trace=cuda,nvtx --sample=none --cpuctxsw=none` within the approved GPU job, and export the `.nsys-rep`. Allow RAM for the workload, profiler, and memory-backed workspace. Cross-process attachment, system-wide sampling, and hardware counters are outside this workflow.
