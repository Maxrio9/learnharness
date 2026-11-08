#!/usr/bin/python3
"""Trusted engine launcher for sandboxed serving comparisons: one command per run, fallback ladders, honest receipts.

The specialist describes WHAT to measure (engines, ordered launch candidates, prompt sizes); this script owns HOW:
start a server, wait for it while checking that the process is still alive, smoke-test it, measure it with the
trusted streaming probe, tear it down, and move to the next candidate when one fails. Every attempt (including
failed ones, with a bounded log tail) is recorded, so the receipt says which configuration really produced the
numbers and why earlier candidates did not. It always writes out/ladder_summary.json and exits 0 once it has
finished, even if an engine had no working candidate, so partial evidence is never thrown away.

Spec (JSON file, argv[1]):
 model: served model name; out: output directory (default 'out'); seed: prompt seed; ready_seconds: per-candidate start bound
 prompts: {set_name: {count, words}}; max_tokens; concurrency: [ints]; warmup: int; request_timeout: seconds
 engines: [{name, port, candidates: [{label, argv: [...], env: {...}}]}]
"""
import importlib.util
import json
import os
import random
import signal
import socket
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
WORDS = ('alpha river stone window garden metal signal copper forest engine bridge planet ladder violet marble harbor '
         'thunder pencil canvas rocket meadow lantern anchor compass velvet mirror falcon cipher ribbon summit orchard '
         'ember prairie quartz saddle timber valley whisper yonder zephyr basalt cobalt dune echo fjord glacier hollow').split()


def load_probe():
    spec = importlib.util.spec_from_file_location('serving_probe', os.path.join(HERE, 'serving_probe.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def make_prompts(spec):
    rng = random.Random(int(spec.get('seed', 20260717)))
    out = {}
    for name, cfg in spec['prompts'].items():
        out[name] = [' '.join(rng.choice(WORDS) for _ in range(int(cfg['words']))) for _ in range(int(cfg['count']))]
    return out


def tail(path, limit=2400):
    try:
        with open(path, 'rb') as file:
            file.seek(0, os.SEEK_END)
            size = file.tell()
            file.seek(max(0, size - 16384))
            text = file.read().decode('utf-8', 'replace')
    except OSError:
        return ''
    lines = [line.rstrip() for line in text.splitlines() if line.strip()]
    return '\n'.join(lines[-24:])[-limit:]


def ready(port):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/v1/models', timeout=2) as response:
            return response.status == 200
    except (OSError, ValueError):
        return False


def port_closed(port):
    with socket.socket() as probe:
        probe.settimeout(0.5)
        return probe.connect_ex(('127.0.0.1', port)) != 0


def stop(process, port):
    if process.poll() is None:
        for sig, wait in ((signal.SIGTERM, 15), (signal.SIGKILL, 15)):
            try:
                os.killpg(process.pid, sig)
            except ProcessLookupError:
                break
            deadline = time.monotonic() + wait
            while process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.2)
            if process.poll() is not None:
                break
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)  # reap stragglers of an engine that already exited
        except (ProcessLookupError, PermissionError):
            pass
    deadline = time.monotonic() + 10
    while not port_closed(port) and time.monotonic() < deadline:
        time.sleep(0.2)
    return port_closed(port)


def attempt(engine, index, candidate, spec, out_dir, probe, prompts):
    """Start one candidate and measure it. Returns (record, runs); runs is None when the candidate failed."""
    port = int(engine['port'])
    label = candidate['label']
    log = os.path.join(out_dir, f"{engine['name']}_candidate{index + 1}.log")
    record = {'label': label, 'outcome': None, 'reason': None, 'seconds': None}
    started = time.monotonic()
    env = dict(os.environ)
    env.update({str(k): str(v) for k, v in (candidate.get('env') or {}).items()})
    with open(log, 'wb') as handle:
        process = subprocess.Popen([str(a) for a in candidate['argv']], stdout=handle, stderr=subprocess.STDOUT, env=env, start_new_session=True)
    runs = None
    try:
        deadline = started + float(spec.get('ready_seconds', 300))
        while True:
            code = process.poll()
            if code is not None:
                record.update(outcome='failed', reason=f'server exited with status {code} after {time.monotonic() - started:.0f} s', log_tail=tail(log))
                return record, None
            if ready(port):
                break
            if time.monotonic() > deadline:
                record.update(outcome='failed', reason=f"server not ready within {spec.get('ready_seconds', 300)} s", log_tail=tail(log))
                return record, None
            time.sleep(1.0)
        record['ready_seconds'] = round(time.monotonic() - started, 1)
        base = {'port': port, 'model': spec['model'], 'max_tokens': int(spec.get('max_tokens', 128)),
                'timeout_seconds': int(spec.get('request_timeout', 240)), 'concurrency': 1, 'return_token_ids': False}
        smoke = probe.run({**base, 'prompts': prompts[next(iter(prompts))][:1], 'max_tokens': 8})
        if smoke['summary']['failed']:
            first = next((r.get('error') for r in smoke['requests'] if not r['ok']), 'unknown')
            record.update(outcome='failed', reason=f'server became ready but the first request failed ({first})', log_tail=tail(log))
            return record, None
        warm = int(spec.get('warmup', 2))
        if warm:
            probe.run({**base, 'prompts': prompts[next(iter(prompts))][:warm]})
        runs = []
        for set_name, items in prompts.items():
            for concurrency in spec.get('concurrency', [1]):
                result = probe.run({**base, 'prompts': items, 'concurrency': int(concurrency)})
                runs.append({'set': set_name, 'concurrency': int(concurrency), **result['summary']})
        record.update(outcome='ok', reason=None)
        return record, runs
    except Exception as error:  # a harness fault must not lose the remaining engines
        record.update(outcome='failed', reason=f'{type(error).__name__} while measuring: {str(error)[:200]}', log_tail=tail(log))
        return record, None
    finally:
        record['seconds'] = round(time.monotonic() - started, 1)
        record['port_released'] = stop(process, port)


def fmt(value, places=3):
    return 'n/a' if value is None else f'{value:.{places}f}'


def main():
    with open(sys.argv[1], 'rb') as file:
        spec = json.loads(file.read(1 << 20))
    out_dir = spec.get('out', 'out')
    os.makedirs(out_dir, exist_ok=True)
    probe = load_probe()
    prompts = make_prompts(spec)
    summary = {'schema': 'engine-ladder-1', 'model': spec['model'], 'max_tokens': spec.get('max_tokens', 128),
               'prompt_sets': {k: {'count': len(v), 'words': spec['prompts'][k]['words']} for k, v in prompts.items()},
               'seed': spec.get('seed', 20260717), 'engines': {}}
    for engine in spec['engines']:
        entry = {'status': 'failed', 'rung': None, 'attempts': [], 'runs': []}
        summary['engines'][engine['name']] = entry
        for index, candidate in enumerate(engine['candidates']):
            print(f"[{engine['name']}] candidate {index + 1}/{len(engine['candidates'])}: {candidate['label']}", flush=True)
            record, runs = attempt(engine, index, candidate, spec, out_dir, probe, prompts)
            entry['attempts'].append(record)
            print(f"[{engine['name']}]   -> {record['outcome']}" + (f": {record['reason']}" if record['reason'] else ''), flush=True)
            if runs is not None:
                entry.update(status='ok', rung=candidate['label'], runs=runs)
                break
    with open(os.path.join(out_dir, 'ladder_summary.json'), 'w') as file:
        json.dump(summary, file, indent=1, allow_nan=False)
    print('--- summary ---')
    for name, entry in summary['engines'].items():
        failed = [a for a in entry['attempts'] if a['outcome'] == 'failed']
        print(f"{name}: {entry['status']}" + (f" via '{entry['rung']}'" if entry['rung'] else '') + (f" ({len(failed)} earlier candidate(s) failed: " + '; '.join(f"{a['label']}: {a['reason']}" for a in failed) + ')' if failed else ''))
        for run in entry['runs']:
            print(f"  {run['set']} c{run['concurrency']}: ok {run['success']}/{run['total']} ttft_p50 {fmt(run['first_visible_text_p50_s'])}s ttft_p95 {fmt(run['first_visible_text_p95_s'])}s tok/s {fmt(run['completion_tokens_per_s'], 1)} wall {fmt(run['elapsed_s'], 1)}s")


if __name__ == '__main__':
    main()
