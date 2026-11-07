# Fork notes

This fork of [amosblomqvist/learnharness](https://github.com/amosblomqvist/learnharness) adds machinery for
running measured experiments from a lesson. It contains **mechanism only**: no lessons, learner data, hostnames or
credentials. Everything deployment-specific is read from environment variables.

## What it adds

- **Experiment specialist**: a background agent (modelled on the research agent) that inspects the runtime and
  proposes one exact, hashed, bounded experiment plan. The tutor keeps teaching meanwhile.
- **Approval flow**: a plain-language approval card (what the plan allows, expiry, technical details on demand),
  decline / review again, and a native receipt. The agent can never approve or run anything itself.
- **Sandboxed execution**: a private workspace, read-only runtime and model files, no host credentials, reusable
  wheel environments verified by hash, resource limits, cancellation and cleanup, optional GPU admission.
- **Evidence for the tutor**: run facts plus a bounded, free-text-free digest of exported JSON measurements.
- **Robustness for local models**: turn budget with a wrap-up call, fallback to the configured researcher model on
  empty replies / exhausted turns / a 20 minute wall clock, and repair of mangled nested tool arguments.
- **Access gates** for a dedicated loopback or private-network deployment (`LH_CURRICULUM_*`), opt-in.

See `docs/curriculum-experiments.md` for the learner-facing flow.

## Configuration (all optional)

| Variable | Purpose |
|---|---|
| `LH_EXPERIMENT_LOCAL_BASE_URL` | OpenAI-compatible endpoint the specialist tries first (custom provider with model id `local`); unset = use the configured researcher model only |
| `LH_EXP_PYTHON_RUNTIME` | Managed CPython 3.12 runtime directory used for sandbox environments (default: uv's standard location under `$HOME`) |
| `LH_EXP_MODEL_CACHE` | Read-only Hugging Face cache mounted into the sandbox (default `~/.cache/huggingface/hub`) |
| `LH_EXP_RETAINED_BLOBS` | Extra directory allowed as a symlink target for cached blobs |
| `LH_EXP_MODEL_TARGETS` | JSON array of `{target, hostname, roots?}` hosts to inventory (default: this machine) |
| `LH_EXP_STORAGE_HELPER`, `LH_EXP_STORAGE_DESTINATIONS` | Optional storage-reservation helper and its scratch roots |
| `LH_EXP_ADMISSION_URL`, `LH_EXP_ADMISSION_CONFIG`, `LH_EXP_RESERVE_PROFILE` | GPU foreground admission; without all three, GPU experiments are refused |
| `LH_CURRICULUM_WEB_ORIGIN`, `LH_CURRICULUM_TAILNET_ORIGIN`, `LH_CURRICULUM_TAILNET_LOGIN` | Optional origin / private-network access gates |
| `LH_PUBLIC_RESEARCH_ONLY` | Restrict research fetches to public hosts |

## Staying current with upstream

This fork has a single branch, `main`: upstream's code plus one commit with the additions above.

```sh
git fetch upstream --tags
git rebase upstream/main        # replays our additions on top of the new upstream
npx tsc --noEmit && npm test
git push --force-with-lease origin main
```

Keep lessons and learner data out of the repository (`data/` is ignored).
