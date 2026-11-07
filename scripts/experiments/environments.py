#!/usr/bin/python3
"""Trusted, bounded materialization of hash-verified wheels. No package code runs here."""
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import tempfile
import zipfile

MIB = 1024**2
RUNTIME_ROOT = pathlib.Path(os.environ.get('LH_EXP_PYTHON_RUNTIME') or (pathlib.Path.home() / '.local/share/uv/python/cpython-3.12.15-linux-x86_64-gnu'))
PYTHON = RUNTIME_ROOT / 'bin/python3.12'
SANDBOX_RUNTIME = '/opt/lh-python'
RUNTIME_LABEL = 'CPython 3.12.15 linux-x86_64'
# Optional storage-reservation helper and the scratch roots it may use (os.pathsep-separated). Unset = none.
STORAGE = os.environ.get('LH_EXP_STORAGE_HELPER', '')
STORAGE_DESTINATIONS = tuple(pathlib.Path(p) for p in os.environ.get('LH_EXP_STORAGE_DESTINATIONS', '').split(os.pathsep) if p)
RUNTIME_PROBE = '''import json, sys, sysconfig
print(json.dumps(dict(version=list(sys.version_info[:3]), abi=sysconfig.get_config_var('SOABI'), platform=sysconfig.get_platform(), libc=__import__('os').confstr('CS_GNU_LIBC_VERSION'))))'''
ENTRY_LIMIT = 120000


def runtime_identity():
    # Only the managed standalone runtime enters the sandbox. Check every link
    # before binding the tree. The user install has no credentials or host venv.
    if any(path.is_symlink() for path in [RUNTIME_ROOT, *RUNTIME_ROOT.parents]):
        raise ValueError('Unexpected symlink in managed Python root')
    files = []
    total = 0
    for directory, dirs, names in os.walk(RUNTIME_ROOT, followlinks=False):
        for name in dirs + names:
            path = pathlib.Path(directory) / name
            info = path.lstat()
            if info.st_uid != os.getuid() or info.st_mode & 0o022 and not stat.S_ISLNK(info.st_mode):
                raise ValueError('Managed Python runtime ownership or permissions changed')
            if stat.S_ISLNK(info.st_mode):
                target = path.resolve(strict=True)
                if not target.is_relative_to(RUNTIME_ROOT):
                    raise ValueError('Managed Python symlink escapes runtime root')
                files.append((path, os.readlink(path)))
            elif stat.S_ISREG(info.st_mode):
                total += info.st_size
                files.append((path, None))
            elif not stat.S_ISDIR(info.st_mode):
                raise ValueError('Managed Python runtime contains special file')
            if total > 512 * MIB or len(files) > ENTRY_LIMIT:
                raise ValueError('Managed Python runtime exceeds expected size')
    output = subprocess.check_output([str(PYTHON), '-I', '-S', '-B', '-c', RUNTIME_PROBE], timeout=5)
    info = json.loads(output)
    if info['version'] != [3, 12, 15] or info['abi'] != 'cpython-312-x86_64-linux-gnu' or info['platform'] != 'linux-x86_64':
        raise ValueError('Expected desktop CPython 3.12.15 linux-x86_64 runtime is unavailable')
    if not (RUNTIME_ROOT / 'include/python3.12/Python.h').is_file():
        raise ValueError('Managed Python runtime headers unavailable')
    digest = hashlib.sha256()
    for path, link in sorted(files):
        digest.update(json.dumps([str(path.relative_to(RUNTIME_ROOT)), link]).encode())
        if link is None:
            with path.open('rb') as source:
                digest.update(hashlib.file_digest(source, 'sha256').digest())
    info['runtimeSha256'] = digest.hexdigest()
    info['installerSha256'] = hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()
    return info


def environment_identity(environment, items, runtime):
    wheels = sorted((name, items[name]['sha256'], items[name].get('omitBuildBackendSha256')) for name in environment['wheels'])
    manifest = {'runtime': runtime, 'wheels': wheels}
    identity = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return identity


def storage(args):
    # The app's restricted mount namespace cannot write the admission ledger.
    # Ask the user manager to run the fixed storage helper with no app secrets.
    uid = os.getuid()
    env = {'PATH': '/usr/bin', 'LANG': 'C.UTF-8', 'XDG_RUNTIME_DIR': f'/run/user/{uid}',
           'DBUS_SESSION_BUS_ADDRESS': f'unix:path=/run/user/{uid}/bus'}
    command = ['/usr/bin/systemd-run', '--user', '--quiet', '--wait', '--pipe', '--collect',
               '--property=RuntimeMaxSec=15s', '--property=NoNewPrivileges=yes',
               '--property=MemoryMax=128M', '--property=TasksMax=8',
               '/usr/bin/env', '-i', 'PATH=/usr/bin', 'LANG=C.UTF-8', STORAGE, *args]
    result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=20)
    if result.returncode:
        raise ValueError('Desktop storage admission helper failed: ' + result.stderr.strip()[-400:])
    return json.loads(result.stdout)


def reserve(job, required):
    row = storage(['reserve', '--owner', 'learnharness-' + job, '--kind', 'scratch',
                   '--gib', str((required + 16 * MIB) / 1024**3), '--ttl', '3900'])
    if not isinstance(row, dict) or not re.fullmatch(r'[a-f0-9]{32}', row.get('id', '')):
        raise ValueError('Unrecognized storage reservation')
    return row


def reserved_store(row, private_dir):
    destination = pathlib.Path(row['destination'])
    if destination not in STORAGE_DESTINATIONS or destination.is_symlink():
        raise ValueError('Unexpected storage reservation destination')
    store = private_dir(destination / 'learnharness')
    if store.stat().st_dev != row['device']:
        raise ValueError('Storage reservation filesystem changed')
    return store


def stores():
    """Candidates only. Callers revalidate directories before opening content."""
    for destination in STORAGE_DESTINATIONS:
        store = destination / 'learnharness'
        if store.is_dir() and not any(p.is_symlink() for p in [store, *store.parents]):
            info = store.stat()
            if info.st_uid == os.getuid() and not info.st_mode & 0o077:
                yield store


def expected_wheel(name):
    from packaging.tags import compatible_tags, cpython_tags, platform_tags
    from packaging.utils import parse_wheel_filename

    distribution, version, _, tags = parse_wheel_filename(name)
    platforms = list(platform_tags())
    supported = set(cpython_tags((3, 12), ['cp312'], platforms))
    supported.update(compatible_tags((3, 12), 'cp312', platforms))
    if tags.isdisjoint(supported):
        raise ValueError('Wheel is not compatible with desktop CPython 3.12: ' + name)
    return distribution, version


def wheel_path(member, data_name):
    name = member.filename.removesuffix('/')
    parts = name.split('/')
    if (not name or len(name.encode()) > 1024 or any(part in ('', '.', '..') or '\\' in part or ':' in part or
           any(ord(char) < 32 or ord(char) == 127 for char in part) for part in parts)):
        raise ValueError('Unsafe path inside wheel')
    kind = stat.S_IFMT(member.external_attr >> 16)
    if kind not in (0, stat.S_IFDIR if member.is_dir() else stat.S_IFREG):
        raise ValueError('Wheel contains a link or special file')
    if not parts[0].endswith('.data'):
        return pathlib.Path('site-packages', *parts)
    if parts[0] != data_name or len(parts) < 2:
        if member.is_dir() and parts == [data_name]:
            return None
        raise ValueError('Unexpected wheel data directory')
    scheme = {'purelib': 'site-packages', 'platlib': 'site-packages',
              'scripts': 'bin', 'headers': 'include', 'data': 'share'}.get(parts[1])
    if scheme is None:
        raise ValueError('Unknown wheel data scheme')
    return pathlib.Path(scheme, *parts[2:])


def receipt_entry(environment, identity, installed, reused):
    return {'name': environment['name'], 'id': identity, 'runtime': RUNTIME_LABEL,
            'installedBytes': installed, 'reused': reused}


def find_environment(environment, identity, private_dir, regular):
    for store in stores():
        parent = store / 'environments'
        root = parent / identity
        if not root.exists() and not root.is_symlink():
            continue
        private_dir(root)
        manifest_path = regular(root / 'manifest.json')
        if manifest_path.stat().st_size > 4096:
            raise ValueError('Invalid cached environment manifest')
        manifest = json.loads(manifest_path.read_text())
        size = manifest.get('installedBytes')
        if manifest.get('id') != identity or type(size) is not int or not 0 < size <= environment['maxInstalledMiB'] * MIB:
            raise ValueError('Cached environment integrity or installed bound mismatch')
        verified_bytes, tree_digest = snapshot_tree(root, environment['maxInstalledMiB'] * MIB)
        if verified_bytes != size or tree_digest != manifest.get('treeSha256'):
            raise ValueError('Cached environment content changed')
        return root, receipt_entry(environment, identity, size, True)
    return None


def snapshot_tree(root, limit):
    """Count disk blocks and seal the full tree. No symlinks or writable file aliases."""
    total = root.stat().st_blocks * 512
    digest = hashlib.sha256()
    count = 0
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs.sort()
        for name in dirs + sorted(files):
            path = pathlib.Path(directory) / name
            if path == root / 'manifest.json':
                continue
            count += 1
            info = path.lstat()
            total += info.st_blocks * 512
            if count > ENTRY_LIMIT or total > limit:
                raise ValueError('Environment exceeds installed size or file count')
            if info.st_uid != os.getuid() or info.st_mode & 0o077 or not (stat.S_ISDIR(info.st_mode) or
                    stat.S_ISREG(info.st_mode) and info.st_nlink == 1):
                raise ValueError('Environment contains an unsafe installed entry')
            rel = path.relative_to(root).as_posix()
            digest.update(json.dumps([rel, info.st_mode, info.st_size], ensure_ascii=True).encode())
            if stat.S_ISREG(info.st_mode):
                with path.open('rb') as source:
                    digest.update(hashlib.file_digest(source, 'sha256').digest())
    return total, digest.hexdigest()


def install_environment(store, environment, identity, wheels, private_dir, download_specs=None):
    from packaging.utils import canonicalize_name
    from packaging.version import Version

    limit = environment['maxInstalledMiB'] * MIB
    parent = private_dir(store / 'environments')
    root = parent / identity
    stage = pathlib.Path(tempfile.mkdtemp(prefix='.staging-', dir=parent))
    try:
        private_dir(stage / 'site-packages')
        seen_distributions = set()
        block = max(4096, os.statvfs(stage).f_frsize)
        allocation = 4 * block
        accounted_dirs = {stage / 'site-packages', stage}
        entries = 0

        def directory(path):
            nonlocal allocation
            if path in accounted_dirs:
                return
            directory(path.parent)
            allocation += block
            if allocation > limit:
                raise ValueError('Expanded wheel directories exceed installed size bound')
            private_dir(path)
            accounted_dirs.add(path)
        for name in sorted(environment['wheels']):
            omitted_digest = (download_specs or {}).get(name, {}).get('omitBuildBackendSha256')
            omitted = False
            distribution, version = expected_wheel(name)
            if distribution in seen_distributions:
                raise ValueError('Duplicate wheel distribution: ' + distribution)
            seen_distributions.add(distribution)
            with zipfile.ZipFile(wheels[name]) as wheel:
                members = wheel.infolist()
                entries += len(members)
                if entries > ENTRY_LIMIT:
                    raise ValueError('Environment wheel file count exceeded')
                metadata = [member.filename.split('/')[0] for member in members
                            if member.filename.endswith('.dist-info/WHEEL') and member.filename.count('/') == 1]
                if len(metadata) != 1:
                    raise ValueError('Wheel requires one distribution metadata directory')
                stem = metadata[0].removesuffix('.dist-info')
                package, separator, wheel_version = stem.rpartition('-')
                if not separator or canonicalize_name(package) != distribution or Version(wheel_version) != version:
                    raise ValueError('Wheel name and metadata differ')
                for member in members:
                    relative = wheel_path(member, stem + '.data')
                    if relative is None:
                        continue
                    # Some publishers accidentally ship an unrelated build helper
                    # at the import root. Permit only this exact digest-bound omission.
                    if omitted_digest is not None and member.filename == 'build_backend.py':
                        if omitted or member.is_dir() or member.file_size > 262144:
                            raise ValueError('Ambiguous or oversized approved build_backend.py omission')
                        with wheel.open(member) as source:
                            if hashlib.file_digest(source, 'sha256').hexdigest() != omitted_digest:
                                raise ValueError('Approved build_backend.py omission digest mismatch')
                        omitted = True
                        continue
                    target = stage / relative
                    if member.is_dir():
                        directory(target)
                        continue
                    # Estimate allocated data blocks before materializing payload bytes.
                    allocation += ((member.file_size + block - 1) // block + 1) * block
                    if allocation > limit:
                        raise ValueError('Expanded wheels exceed installed size bound')
                    directory(target.parent)
                    mode = 0o700 if member.external_attr >> 16 & 0o111 else 0o600
                    if target.exists():
                        # Namespace packages sometimes ship the same __init__.py.
                        # Accept only byte-identical content and identical permissions.
                        info = target.stat()
                        if not stat.S_ISREG(info.st_mode) or info.st_size != member.file_size or stat.S_IMODE(info.st_mode) != mode:
                            raise ValueError('Conflicting wheel file: ' + relative.as_posix())
                        with wheel.open(member) as source, target.open('rb') as existing:
                            if hashlib.file_digest(source, 'sha256').digest() != hashlib.file_digest(existing, 'sha256').digest():
                                raise ValueError('Conflicting wheel file: ' + relative.as_posix())
                        continue
                    with wheel.open(member) as source, target.open('xb') as dest:
                        count = 0
                        while chunk := source.read(65536):
                            count += len(chunk)
                            if count > member.file_size:
                                raise ValueError('Expanded wheel member exceeded declared size')
                            dest.write(chunk)
                        if count != member.file_size:
                            raise ValueError('Expanded wheel member size mismatch')
                        dest.flush()
                        os.fsync(dest.fileno())
                    target.chmod(mode)
                if omitted_digest is not None and not omitted:
                    raise ValueError('Approved build_backend.py omission is missing')
        bootstrap = stage / '.bootstrap'
        directory(bootstrap)
        (bootstrap / 'sitecustomize.py').write_text(
            'import os, site\nsite.addsitedir(os.path.join(os.path.dirname(os.path.dirname(__file__)), "site-packages"))\n')
        launcher = stage / 'python'
        launcher.write_text('#!/usr/bin/sh\nset -eu\nroot=$(/usr/bin/dirname -- "$(/usr/bin/readlink -f -- "$0")")\n'
                            'export PYTHONPATH="$root/.bootstrap" PYTHONDONTWRITEBYTECODE=1 PYTHONNOUSERSITE=1 PYTHONSAFEPATH=1\n'
                            f'exec {SANDBOX_RUNTIME}/bin/python3.12 "$@"\n')
        launcher.chmod(0o700)
        for path in (bootstrap / 'sitecustomize.py', launcher):
            path.chmod(0o700 if path == launcher else 0o600)
            with path.open('rb') as source:
                os.fsync(source.fileno())
        installed, tree_digest = snapshot_tree(stage, limit)
        manifest = stage / 'manifest.json'
        with manifest.open('x') as dest:
            manifest.chmod(0o600)
            json.dump({'id': identity, 'installedBytes': installed, 'treeSha256': tree_digest}, dest)
            dest.flush()
            os.fsync(dest.fileno())
        for directory, _, _ in os.walk(stage, topdown=False):
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        stage.rename(root)
        fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        return root, receipt_entry(environment, identity, installed, False)
    finally:
        if stage.exists():
            shutil.rmtree(stage)
