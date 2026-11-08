#!/usr/bin/python3
"""Trusted CPU supervisor. No learner/config/model imports. JSON stdin only.
The only untrusted programs execute behind the verified unit + bwrap gate.
"""
import os, sys, json, time, hashlib, ipaddress, socket, ssl, http.client, pathlib, stat, subprocess, selectors, signal, re
import importlib.util
import struct

MODEL_CACHE_ROOT = pathlib.Path(os.environ.get('LH_EXP_MODEL_CACHE') or (pathlib.Path.home() / '.cache/huggingface/hub'))
RETAINED_BLOBS_ROOT = pathlib.Path(os.environ.get('LH_EXP_RETAINED_BLOBS') or '/nonexistent/retained-blobs')
MODEL_MAX_BYTES = 128 * 1024**3

CLEAN = {'PATH':'/usr/bin','LANG':'C.UTF-8','HOME':'/workspace/home','TMPDIR':'/workspace/tmp','TRITON_LIBCUDA_PATH':'/usr/lib'}  # triton looks for libcuda via /sbin/ldconfig, absent in the sandbox
class Cancelled(Exception): pass
class Deadline(Exception): pass
GPU_GAP = 'GPU unsupported: admission guard process-group ownership does not cover independently launched systemd cgroup; reviewed cgroup registration/preemption adapter required.'

def cgroup_empty(cg):
    if not cg or not cg.startswith('/user.slice/') or '..' in pathlib.PurePosixPath(cg).parts:
        return False
    root=pathlib.Path('/sys/fs/cgroup'+cg)
    try: root.stat()
    except FileNotFoundError: return True
    return 'populated 0' in (root/'cgroup.events').read_text().splitlines()

def exact(value, keys):
    if type(value) is not dict or set(value)!=set(keys.split()): raise ValueError('Exact object keys required')
    return value

def text(value, maximum):
    if type(value) is not str or not value or len(value.encode('utf-16-le'))//2>maximum or '\0' in value: raise ValueError('Bounded string required')
    if re.search(r'(?i)(bearer\s+|(?:api[_-]?key|token|password|secret)\s*[=:])',value): raise ValueError('Secret-bearing plan denied')
    return value

def integer(value, low, high):
    if type(value) is not int or not low<=value<=high: raise ValueError('Invalid resource bound')
    return value

def array(value, maximum):
    if type(value) is not list or len(value)>maximum: raise ValueError('Invalid bounded array')
    return value

def validate_plan(value):
    from urllib.parse import urlsplit
    version = value.get('version') if type(value) is dict else None
    v2 = type(version) is int and version in (2, 3)
    v3 = type(version) is int and version == 3
    with_model = v3 and 'model' in value
    p=exact(value,'version title purpose commands downloads inputs limits network gpu'+(' exports' if v2 else '')+(' environments' if v3 else '')+(' model' if with_model else ''))
    if type(p['version']) is not int or p['version'] not in (1,2,3) or p['network'] not in ('off','internal-loopback') or type(p['gpu']) is not bool: raise ValueError('Unsupported plan')
    commands=[]
    for c in array(p['commands'],16):
        argv=[text(a,8192) for a in array(c,64)]
        if not argv: raise ValueError('Empty argv')
        commands.append(argv)
    if not commands: raise ValueError('Commands required')
    if v3 and len(canonical(commands))>65536: raise ValueError('Commands exceed v3 argument bound')
    downloads=[]
    for d in array(p['downloads'],384 if v3 else 16):
        omit_backend = v3 and type(d) is dict and 'omitBuildBackendSha256' in d
        exact(d,'name url sha256 maxBytes'+(' omitBuildBackendSha256' if omit_backend else ''))
        name=text(d['name'],160 if v3 else 80); digest=text(d['sha256'],64);url=text(d['url'],2048);u=urlsplit(url)
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*',name) or not re.fullmatch('[a-f0-9]{64}',digest): raise ValueError('Invalid identity')
        if u.scheme!='https' or not u.hostname or u.username or u.password or u.fragment or u.port not in (None,443) or any(ord(c)<33 for c in url): raise ValueError('HTTPS identity required')
        try: ipaddress.ip_address(u.hostname)
        except ValueError: pass
        else: raise ValueError('IP literals denied')
        item = dict(name=name,url=url,sha256=digest,maxBytes=integer(d['maxBytes'],1,(49152 if v2 else 4096)*1048576))
        if omit_backend:
            omit_digest = text(d['omitBuildBackendSha256'],64)
            if not name.endswith('.whl') or not re.fullmatch('[a-f0-9]{64}',omit_digest):
                raise ValueError('Invalid approved build_backend.py omission')
            item['omitBuildBackendSha256'] = omit_digest
        downloads.append(item)
    if len({d['name'] for d in downloads})!=len(downloads): raise ValueError('Duplicate download')
    inputs=[text(i,80) for i in array(p['inputs'],16)]
    if any(not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*@[a-f0-9]{64}',i) for i in inputs) or len(set(inputs))!=len(inputs): raise ValueError('Invalid immutable inputs')
    l=exact(p['limits'],'wallSeconds memoryMiB tasks diskMiB outputBytes'+(' stagedCacheMiB artifactBytes' if v2 else ''))
    bounds=[('wallSeconds',1,3600 if v2 else 900),('memoryMiB',64,24576 if v2 else 8192),('tasks',4,256 if v2 else 64),('diskMiB',1,16384 if v2 else 4096),('outputBytes',128,65536)]
    if v2: bounds += [('stagedCacheMiB',0,49152),('artifactBytes',0,536870912)]
    limits={k:integer(l[k],a,b) for k,a,b in bounds}
    if sum(d['maxBytes'] for d in downloads)>limits['stagedCacheMiB' if v2 else 'diskMiB']*1048576: raise ValueError('Preparation disk bound')
    out=dict(version=p['version'],title=text(p['title'],160),purpose=text(p['purpose'],2000),commands=commands,downloads=downloads,inputs=inputs,limits=limits,network=p['network'],gpu=p['gpu'])
    if v2:
        exports=[]
        for item in array(p['exports'],16):
            exact(item,'path maxBytes')
            path=text(item['path'],160)
            if not re.fullmatch(r'[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*',path) or any(x in ('.','..') for x in path.split('/')): raise ValueError('Normalized relative export path required')
            exports.append(dict(path=path,maxBytes=integer(item['maxBytes'],1,limits['artifactBytes'])))
        if len({x['path'] for x in exports})!=len(exports) or sum(x['maxBytes'] for x in exports)>limits['artifactBytes']: raise ValueError('Duplicate or unbounded export')
        out['exports']=exports
    if v3:
        environments = []
        declared = {item['name'] for item in downloads}
        for raw in array(p['environments'],4):
            exact(raw,'name wheels maxInstalledMiB')
            name = text(raw['name'],32)
            if not re.fullmatch(r'[a-z][a-z0-9-]{0,31}',name): raise ValueError('Invalid environment name')
            wheels = [text(wheel,160) for wheel in array(raw['wheels'],256)]
            if not wheels or len(set(wheels))!=len(wheels) or any(wheel not in declared or not wheel.endswith('.whl') for wheel in wheels):
                raise ValueError('Environment requires unique declared wheel downloads')
            environments.append(dict(name=name,wheels=wheels,maxInstalledMiB=integer(raw['maxInstalledMiB'],1,32768)))
        if len({env['name'] for env in environments})!=len(environments) or sum(env['maxInstalledMiB'] for env in environments)>65536:
            raise ValueError('Duplicate environment name or aggregate installed size exceeded')
        referenced = {wheel for environment in environments for wheel in environment['wheels']}
        if any('omitBuildBackendSha256' in item and item['name'] not in referenced for item in downloads):
            raise ValueError('Wheel omission requires an environment')
        out['environments'] = environments
    if with_model:
        out['model'] = validate_model(p['model'])
    if len(canonical(out))>(163840 if v3 else 65536): raise ValueError('Plan too large')
    return out

def validate_model(value):
    model = exact(value, 'repo revision files')
    repo = text(model['repo'], 160)
    revision = text(model['revision'], 64)
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo) or any(part in ('.', '..') for part in repo.split('/')):
        raise ValueError('Invalid cached model repository')
    if not re.fullmatch(r'[a-f0-9]{40,64}', revision):
        raise ValueError('Invalid cached model revision')
    files = []
    for raw in array(model['files'], 128):
        item = exact(raw, 'name sha256 bytes')
        name, digest = text(item['name'], 160), text(item['sha256'], 64)
        if name in ('.', '..') or not re.fullmatch(r'[-A-Za-z0-9_.]+', name) or not re.fullmatch(r'[a-f0-9]{64}', digest):
            raise ValueError('Invalid cached model file identity')
        files.append(dict(name=name, sha256=digest, bytes=integer(item['bytes'], 0, MODEL_MAX_BYTES)))
    if not files or len({item['name'] for item in files}) != len(files) or sum(item['bytes'] for item in files) > MODEL_MAX_BYTES:
        raise ValueError('Cached model file list is empty, repeated or oversized')
    return dict(repo=repo, revision=revision, files=files)


def canonical(plan):
    return json.dumps(plan,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode('utf8')

def validate_request(request):
    exact(request,'jobId plan digest admin');unit_name(request['jobId'])
    plan=validate_plan(request['plan'])
    if type(request['digest']) is not str or hashlib.sha256(canonical(plan)).hexdigest()!=request['digest']: raise ValueError('Plan digest mismatch')
    if type(request['admin']) is not str or not pathlib.Path(request['admin']).is_absolute(): raise ValueError('Absolute private admin required')
    return {**request,'plan':plan}

def regular(path):
    p=pathlib.Path(path)
    for parent in [p,*p.parents]:
        if parent.is_symlink(): raise ValueError('Symlink denied')
    s=p.stat()
    if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1: raise ValueError('Regular single-link input required')
    if s.st_uid!=os.getuid() or s.st_mode & 0o077: raise ValueError('Private admin-owned input required')
    return p

def private_dir(path):
    p=pathlib.Path(path)
    for parent in [p,*p.parents]:
        if parent.is_symlink(): raise ValueError('Symlink admin root denied')
    p.mkdir(mode=0o700,parents=True,exist_ok=True)
    if p.stat().st_uid!=os.getuid() or p.stat().st_mode & 0o077: raise ValueError('Private owned directory required')
    return p

def record_launch_intent(admin, job, unit):
    """Persist the exact unit identity before any workload launch is possible."""
    if unit != unit_name(job):
        raise ValueError('Unexpected launch intent unit identity')
    directory = private_dir(admin / 'launches')
    dir_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        marker = job + '.json'
        fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dir_fd)
        with os.fdopen(fd, 'wb') as output:
            output.write(canonical({'jobId': job, 'unit': unit}))
            output.flush()
            os.fsync(output.fileno())
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)
    check_launch_fence(admin, job)


def check_launch_fence(admin, job):
    try:
        (admin / 'launches' / (job + '.cancel')).lstat()
    except FileNotFoundError:
        return
    raise Cancelled('Cancellation fenced the workload before launch')


def public_addresses(host):
    try: ipaddress.ip_address(host); raise ValueError('IP literals denied')
    except ValueError as e:
        if str(e)=='IP literals denied': raise
    results=socket.getaddrinfo(host,443,type=socket.SOCK_STREAM)
    addresses=[]
    for family,_,_,_,addr in results:
        ip=ipaddress.ip_address(addr[0])
        if any(ip in ipaddress.ip_network(n) for n in ['192.0.0.0/24','192.0.2.0/24','198.18.0.0/15','198.51.100.0/24','203.0.113.0/24','64:ff9b::/96','64:ff9b:1::/48','2002::/16']) or not ip.is_global or ip.is_multicast or ip.is_reserved or getattr(ip,'ipv4_mapped',None) or ip in ipaddress.ip_network('100.64.0.0/10') or (ip.version==6 and ip in ipaddress.ip_network('2001::/23')):
            raise ValueError('Non-public DNS result denied')
        addresses.append((family,addr))
    if not addresses: raise ValueError('Empty DNS result')
    return addresses

class PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self,host,address,timeout):
        super().__init__(host,443,timeout=timeout,context=ssl.create_default_context())
        self.address=address
    def connect(self):
        family,addr=self.address
        raw=socket.socket(family,socket.SOCK_STREAM)
        raw.settimeout(self.timeout)
        try:
            raw.connect(addr)
            self.sock=self._context.wrap_socket(raw,server_hostname=self.host)
        except BaseException: raw.close(); raise

def file_digest(path):
    h=hashlib.sha256()
    with regular(path).open("rb") as f:
        while True:
            b=f.read(65536)
            if not b: break
            h.update(b)
    return h.hexdigest()

def reserve_cache(cache,budget):
    used=0
    for entry in cache.iterdir():
        p=regular(entry)
        if not re.fullmatch('[a-f0-9]{64}',p.name): raise ValueError('Unrecognized cache entry; admin cleanup required')
        used+=p.stat().st_size
        if used>budget: raise ValueError('Aggregate preparation cache disk bound exceeded')
    return used

def download(item,cache,deadline):
    from urllib.parse import urlsplit
    if time.monotonic()>=deadline: raise TimeoutError('Preparation deadline before DNS')
    u=urlsplit(item['url'])
    if u.scheme!='https' or u.username or u.password or u.fragment or (u.port and u.port!=443) or not u.hostname: raise ValueError('HTTPS hostname:443 only')
    addresses=public_addresses(u.hostname)
    target=cache/item['sha256']
    if target.exists():
        p=regular(target)
        if p.stat().st_size>item['maxBytes'] or file_digest(p)!=item['sha256']: raise ValueError('Cache digest/bound mismatch')
        return target,p.stat().st_size
    partial=cache/(item['sha256']+'.'+os.urandom(8).hex()+'.partial')
    conn=PinnedHTTPS(u.hostname,addresses[0],max(.1,min(5,deadline-time.monotonic())))
    count=0; digest=hashlib.sha256()
    try:
        conn.request('GET',(u.path or '/')+('?' + u.query if u.query else ''),headers={'Accept-Encoding':'identity','Connection':'close'})
        response=conn.getresponse()
        if response.status!=200: raise ValueError('Non-200 response/redirect denied')
        if response.getheader('Content-Encoding','identity')!='identity': raise ValueError('Encoded response denied')
        length=response.getheader('Content-Length')
        if length and (not length.isdigit() or int(length)>item['maxBytes']): raise ValueError('Download bound exceeded')
        fd=os.open(partial,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'wb') as out:
            while True:
                if time.monotonic()>=deadline: raise TimeoutError('Preparation timeout')
                data=response.read1(min(65536,item['maxBytes']-count+1))
                if not data: break
                count+=len(data)
                if count>item['maxBytes']: raise ValueError('Download bound exceeded')
                digest.update(data);out.write(data)
            out.flush();os.fsync(out.fileno())
        if digest.hexdigest()!=item['sha256']: raise ValueError('Download digest mismatch')
        # No overwrite of raced/untrusted cache entries.
        try: os.link(partial,target,follow_symlinks=False)
        except FileExistsError:
            if file_digest(target)!=item['sha256']: raise ValueError('Cache race')
        return target,count
    finally:
        conn.close()
        partial.unlink(missing_ok=True)

def manager_env():
    uid=os.getuid()
    return {'PATH':'/usr/bin','LANG':'C.UTF-8','HOME':str(pathlib.Path.home()),'XDG_RUNTIME_DIR':f'/run/user/{uid}','DBUS_SESSION_BUS_ADDRESS':f'unix:path=/run/user/{uid}/bus'}

def control(args,timeout=5):
    return subprocess.run(['/usr/bin/systemctl','--user',*args],env=manager_env(),stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=timeout)

def unit_name(job):
    if not re.fullmatch(r'job_[A-Za-z0-9_-]{1,100}',job): raise ValueError('Invalid owned job identity')
    return 'lh-experiment-'+hashlib.sha256(job.encode()).hexdigest()[:32]+'.service'

def model_file_mounts(model):
    """Resolve the snapshot through known blob layouts and pin every verified inode."""
    repo = MODEL_CACHE_ROOT / ('models--' + model['repo'].replace('/', '--'))
    snapshot = repo / 'snapshots' / model['revision']
    if not snapshot.is_dir() or any(path.is_symlink() for path in [snapshot, *snapshot.parents]):
        raise ValueError('Approved cached model snapshot unavailable or redirected')
    repo_blobs = repo / 'blobs'
    shared_blobs = MODEL_CACHE_ROOT / 'blobs'
    opened = []
    try:
        for item in model['files']:
            entry = snapshot / item['name']
            path = entry.resolve(strict=True)
            cached_repo_blob = path.parent == repo_blobs and re.fullmatch(r'[a-f0-9]{40,64}', path.name)
            shared_blob = re.fullmatch(r'[a-f0-9]{64}', path.name) and (
                path.parent == RETAINED_BLOBS_ROOT or
                any(path.parent == root / path.name[:2] for root in (shared_blobs, RETAINED_BLOBS_ROOT)))
            if path != entry and not cached_repo_blob and not shared_blob:
                raise ValueError('Cached model file points outside allowed blob layouts: ' + item['name'])
            if any(parent.is_symlink() for parent in path.parents):
                raise ValueError('Cached model blob parent is a symlink')
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            opened.append((item['name'], path, fd, None))
            before = os.fstat(fd)
            if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_mode & 0o022 or
                    before.st_size != item['bytes'] or before.st_dev != snapshot.stat().st_dev):
                raise ValueError('Cached model file ownership, filesystem or size mismatch: ' + item['name'])
            with os.fdopen(os.dup(fd), 'rb') as source:
                digest = hashlib.file_digest(source, 'sha256').hexdigest()
            after = os.fstat(fd)
            if digest != item['sha256'] or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError('Cached model file digest mismatch: ' + item['name'])
            opened[-1] = (item['name'], path, fd, after)
        return opened
    except BaseException:
        for _, _, fd, _ in opened:
            os.close(fd)
        raise


def recheck_model_mounts(model_mounts):
    # systemd's separately parented unit cannot bind the supervisor's proc fd
    # under Yama. Hold each verified inode open and check the bind pathname
    # immediately before opening the trusted namespace gate.
    for name, path, fd, expected in model_mounts:
        current = path.stat(follow_symlinks=False)
        fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        held = os.fstat(fd)
        if any(getattr(expected, field) != getattr(current, field) or getattr(expected, field) != getattr(held, field) for field in fields):
            raise ValueError('Cached model bind path changed: ' + name)


def bwrap_args(plan,inputs,workspace_bytes=None,environments=(),runtime_root=None,model_mounts=()):
    l=plan['limits']
    if workspace_bytes is None: workspace_bytes=l['diskMiB']*1048576
    args=['/usr/bin/bwrap','--unshare-all','--unshare-user','--die-with-parent','--new-session','--disable-userns','--cap-drop','ALL','--clearenv','--ro-bind','/usr/bin','/usr/bin','--ro-bind','/usr/lib','/usr/lib','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib']
    if pathlib.Path('/usr/lib64').exists(): args+=['--ro-bind','/usr/lib64','/usr/lib64','--symlink','usr/lib64','/lib64']
    args+=['--dir','/dev']
    for name in ['null','zero','random','urandom']: args+=['--dev-bind','/dev/'+name,'/dev/'+name]
    args+=['--proc','/proc','--remount-ro','/proc','--symlink','/proc/self/fd','/dev/fd','--dir','/inputs']
    for name,path in inputs: args+=['--ro-bind',str(path),'/inputs/'+name]
    args+=['--size',str(workspace_bytes),'--tmpfs','/workspace','--dir','/workspace/tmp','--dir','/workspace/home','--symlink','workspace/tmp','/tmp','--chdir','/workspace']
    for key,value in CLEAN.items(): args+=['--setenv',key,value]
    if plan['version']==3:
        args += ['--dir','/workspace/shm','--symlink','/workspace/shm','/dev/shm','--dir','/environments','--dir','/tools']
        probe = pathlib.Path(__file__).with_name('serving_probe.py').resolve()
        args += ['--ro-bind',str(probe),'/tools/serving_probe.py']
        ladder = pathlib.Path(__file__).with_name('engine_ladder.py').resolve()
        args += ['--ro-bind',str(ladder),'/tools/engine_ladder.py']
        if runtime_root:
            args += ['--dir','/opt','--ro-bind',str(runtime_root),'/opt/lh-python',
                     '--size','4096','--tmpfs','/opt/lh-python/lib/python3.12/site-packages',
                     '--remount-ro','/opt/lh-python/lib/python3.12/site-packages',
                     '--ro-bind','/usr/include','/usr/include']
        for name, path in environments:
            args += ['--ro-bind',str(path),'/environments/'+name]
    if model_mounts:
        args += ['--dir','/model']
        for name, path, _, _ in model_mounts:
            args += ['--ro-bind',str(path),'/model/'+name]
    if plan['version']>=2:
        # Code is trusted installed runner source, never a learner-provided path.
        runner=pathlib.Path(__file__).with_name('sandbox_runner.py').read_text()
        args+=['--remount-ro','/','--','/usr/bin/python3','-I','-c',runner,json.dumps(plan['commands'],separators=(',',':'),ensure_ascii=False),json.dumps(plan['exports'],separators=(',',':'))]
    else:
        args+=['--remount-ro','/','--','/usr/bin/python3','-I','-c',
           'import json,subprocess,sys; commands=json.loads(sys.argv[1]);\nfor argv in commands:\n r=subprocess.run(argv,stdin=subprocess.DEVNULL)\n if r.returncode: sys.exit(r.returncode)\n',json.dumps(plan['commands'],separators=(',',':'),ensure_ascii=False)]
    return args

def verify_controls(unit,limits):
    r=control(['show',unit])
    if r.returncode: raise RuntimeError('Cannot inspect effective service controls')
    props=dict(line.split('=',1) for line in r.stdout.splitlines() if '=' in line)
    expected={'KillMode':'control-group','SendSIGKILL':'yes','NoNewPrivileges':'yes','MemoryMax':str(limits['memoryMiB']*1048576),'MemorySwapMax':'0','TasksMax':str(limits['tasks']),'LimitFSIZE':str(limits['diskMiB']*1048576),'CPUQuotaPerSecUSec':'1s','RuntimeMaxUSec':str(limits['wallSeconds'])+'s'}
    def seconds(value):
        parts=re.findall(r'(\d+(?:\.\d+)?)(us|ms|s|min|h|d)',value or '')
        if not parts or ''.join(n+u for n,u in parts)!=(value or '').replace(' ',''): return -1
        return sum(float(n)*{'us':.000001,'ms':.001,'s':1,'min':60,'h':3600,'d':86400}[u] for n,u in parts)
    for k,v in expected.items():
        if k=='RuntimeMaxUSec':
            if seconds(props.get(k))!=limits['wallSeconds']: raise RuntimeError('Effective runtime limit mismatch')
        elif props.get(k)!=v: raise RuntimeError('Effective systemd control mismatch: '+k)
    cg=props.get('ControlGroup','')
    if not cg.startswith('/user.slice/') or not cg.endswith('/'+unit) or '..' in cg: raise RuntimeError('Unexpected cgroup identity')
    root=pathlib.Path('/sys/fs/cgroup'+cg)
    actual={name:(root/name).read_text().strip() for name in ['memory.max','memory.swap.max','pids.max','cpu.max']}
    if actual['memory.max']!=expected['MemoryMax'] or actual['memory.swap.max']!='0' or actual['pids.max']!=expected['TasksMax']: raise RuntimeError('Hard cgroup limits unavailable')
    quota,period=map(int,actual['cpu.max'].split())
    if quota!=period: raise RuntimeError('CPU cgroup quota unavailable')
    if not props.get('MainPID','').isdigit() or int(props['MainPID'])<=0 or not re.fullmatch(r'[0-9a-f]{32}',props.get('InvocationID','')): raise RuntimeError('Live gate identity unavailable')
    return {'cgroup':cg,'properties':{k:props[k] for k in [*expected,'MainPID','InvocationID']},'cgroupControls':actual}

def scrub(value):
    s=re.sub(r'\x1b\][^\x07]*(?:\x07|\x1b\\)','',str(value))
    s=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',s)
    s=''.join(c for c in s if c in '\n\t' or ord(c)>=32 and not 127<=ord(c)<=159)
    s=re.sub(r'/(?:home|Users|run/user|tmp)/[^\s\"\x27]+','[REDACTED_PATH]',s)
    return re.sub(r'(?i)(?:bearer\s+|(?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s]+','[REDACTED_SECRET]',s)

def bound_central_directory(path, entry_budget):
    """Read bounded ZIP metadata before ZipFile allocates one object per member."""
    with path.open('rb') as source:
        file_size = source.seek(0, os.SEEK_END)
        tail_start = max(0, file_size - (22 + 65535))
        source.seek(tail_start)
        tail = source.read()
        end_index = tail.rfind(b'PK\x05\x06')
        if end_index < 0 or len(tail) - end_index < 22:
            raise ValueError('Wheel central directory missing')
        _, disk, start_disk, disk_count, count, size, start, comment = struct.unpack_from('<4s4H2IH', tail, end_index)
        end_offset = tail_start + end_index
        if disk or start_disk or disk_count != count or len(tail) - end_index != 22 + comment:
            raise ValueError('Unsupported wheel archive layout')
        if end_offset >= 20:
            source.seek(end_offset - 20)
            locator = source.read(20)
            if locator.startswith(b'PK\x06\x07'):
                _, disk, record_offset, disks = struct.unpack('<4sIQI', locator)
                if disk or disks != 1 or not 0 <= record_offset <= end_offset - 76:
                    raise ValueError('Invalid wheel ZIP64 locator')
                source.seek(record_offset)
                sig, record_size, _, _, disk, start_disk, disk_count, count, size, start = struct.unpack(
                    '<4sQ2H2I4Q', source.read(56))
                if sig != b'PK\x06\x06' or record_size < 44 or record_offset + 12 + record_size != end_offset - 20 or disk or start_disk or disk_count != count:
                    raise ValueError('Invalid wheel ZIP64 directory')
                end_offset = record_offset
        if not 0 < count <= entry_budget or size > 16 * 1048576 or start + size != end_offset:
            raise ValueError('Wheel central directory exceeds bounds')
        source.seek(start)
        offset = 0
        for _ in range(count):
            header = source.read(46)
            if len(header) != 46 or not header.startswith(b'PK\x01\x02'):
                raise ValueError('Malformed wheel directory entry')
            name, extra, comment = struct.unpack_from('<3H', header, 28)
            if not 0 < name <= 1024:
                raise ValueError('Wheel directory path exceeds bounds')
            tail_bytes = name + extra + comment
            offset += 46 + tail_bytes
            if offset > size:
                raise ValueError('Malformed wheel directory length')
            source.seek(tail_bytes, os.SEEK_CUR)
        if offset != size:
            raise ValueError('Wheel directory entry count mismatch')
        return count


def prepare_v3(plan, job, admin, legacy_cache, deadline, receipt):
    spec = importlib.util.spec_from_file_location('environments', pathlib.Path(__file__).with_name('environments.py'))
    environments = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(environments)
    items = {item['name']: item for item in plan['downloads']}
    mounts = []
    receipt['environments'] = []
    missing = []
    if plan['environments']:
        runtime = environments.runtime_identity()
        for environment in plan['environments']:
            identity = environments.environment_identity(environment, items, runtime)
            found = environments.find_environment(environment, identity, private_dir, regular)
            if found:
                root, entry = found
                mounts.append((environment['name'], root))
                receipt['environments'].append(entry)
            else:
                missing.append((environment, identity))

    # Each v3 job accounts only for its inputs. Existing content remains subject
    # to storage admission through actual free space, not the new job's limit.
    wheel_names = {name for environment in plan['environments'] for name in environment['wheels']}
    needed_wheels = {name for environment, _ in missing for name in environment['wheels']}
    wheel_paths = {}
    caches = [legacy_cache, *(store / 'cache' for store in environments.stores())]
    new_downloads = []
    for item in plan['downloads']:
        if item['name'] in wheel_names and item['name'] not in needed_wheels:
            continue
        cached = next((path for cache in caches
                       if (path := cache / item['sha256']).exists() or path.is_symlink()), None)
        if cached is None:
            new_downloads.append(item)
            continue
        if regular(cached).stat().st_size > item['maxBytes'] or file_digest(cached) != item['sha256']:
            raise ValueError('Cached download digest or size mismatch')
        wheel_paths[item['name']] = cached

    required = sum(item['maxBytes'] for item in new_downloads)
    required += sum(environment['maxInstalledMiB'] * 1048576 for environment, _ in missing)
    reservation = None
    try:
        if required:
            reservation = environments.reserve(job, required)
            store = environments.reserved_store(reservation, private_dir)
            cache = private_dir(store / 'cache')
            receipt['storagePreparation'] = {'reservedBytes': reservation['bytes']}
            for item in new_downloads:
                path, _ = download(item, cache, deadline)
                wheel_paths[item['name']] = path
            for environment, identity in missing:
                # Two labels with the same wheel set share one immutable environment.
                found = environments.find_environment(environment, identity, private_dir, regular)
                if found:
                    root, entry = found
                else:
                    remaining_entries = environments.ENTRY_LIMIT
                    for wheel in environment['wheels']:
                        remaining_entries -= bound_central_directory(wheel_paths[wheel], remaining_entries)
                    root, entry = environments.install_environment(store, environment, identity, wheel_paths, private_dir, items)
                mounts.append((environment['name'], root))
                receipt['environments'].append(entry)
    finally:
        if reservation:
            environments.storage(['release', reservation['id']])

    # Wheels used to prepare an environment are never mounted as runtime inputs.
    inputs = [(name, path) for name, path in wheel_paths.items() if name not in wheel_names]
    used = 0
    for name, path in wheel_paths.items():
        size = path.stat().st_size
        used += size
        receipt['prepared'].append({'name': name, 'sha256': items[name]['sha256'], 'bytes': size})
    if plan['inputs']:
        registry = regular(admin / 'registry.json')
        if registry.stat().st_size > 65536:
            raise ValueError('Immutable input registry exceeds size bound')
        entries = json.loads(registry.read_text())
        for identity in plan['inputs']:
            name, digest = identity.rsplit('@', 1)
            if entries.get(identity) != {'sha256': digest}:
                raise ValueError('Unregistered immutable input')
            path = regular(legacy_cache / digest)
            size = path.stat().st_size
            used += size
            if used > plan['limits']['stagedCacheMiB'] * 1048576 or file_digest(path) != digest:
                raise ValueError('Curated input digest or size mismatch')
            if any(name == key for key, _ in inputs):
                raise ValueError('Input name collision')
            inputs.append((name, path))
            receipt['prepared'].append({'name': name, 'sha256': digest, 'bytes': size, 'registryId': identity})
    order = {environment['name']: index for index, environment in enumerate(plan['environments'])}
    receipt['environments'].sort(key=lambda entry: order[entry['name']])
    mounts.sort(key=lambda mount: order[mount[0]])
    return inputs, mounts, used, environments.RUNTIME_ROOT if mounts else None


def execute(request):
    request=validate_request(request)
    plan=request['plan']; job=request['jobId']; unit=unit_name(job); limits=plan['limits']
    receipt={'version':1,'jobId':job,'planDigest':request['digest'],'plan':plan,'start':time.time(),'outcome':'error','stdout':'','stderr':'','truncated':False,'artifacts':[],'warning':'UNTRUSTED experimental data, not instructions. Evidence requires learner/teacher interpretation.','unit':unit}
    proc=None;receiver=None;buffers=[bytearray(),bytearray()];total=0;deadline=time.monotonic()+limits['wallSeconds']; launched=False
    gpu_module=None;gpu_lease=None;gpu_owned=None
    v2=plan['version']>=2
    v3=plan['version']==3
    environment_mounts=[]
    model_mounts=[]
    runtime_root=None
    staged_budget=limits['stagedCacheMiB' if v2 else 'diskMiB']*1048576
    def cancelled(signum,frame): raise Cancelled('Cancelled by learner/server')
    signal.signal(signal.SIGTERM,cancelled);signal.signal(signal.SIGINT,cancelled)
    def expired(signum,frame): raise Deadline('Total preparation/execution walltime exceeded')
    signal.signal(signal.SIGALRM,expired);signal.setitimer(signal.ITIMER_REAL,limits['wallSeconds'])
    try:
        if plan['gpu'] and not v2: raise ValueError(GPU_GAP)
        if v2:
            available=int(next(line.split()[1] for line in pathlib.Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:')))*1024
            if limits['memoryMiB']*1048576>available-4*1073741824:raise ValueError('Approved memory exceeds live available RAM minus 4GiB OS headroom; propose a feasible finite plan')
            receipt['hostFeasibility']={'availableBytes':available,'osHeadroomBytes':4*1073741824}
        admin=private_dir(request['admin']);cache=private_dir(admin/'cache');inputs=[]
        if v2:
            spec=importlib.util.spec_from_file_location('artifact_receiver',pathlib.Path(__file__).with_name('artifact_receiver.py'));module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
            exports_root=private_dir(admin/'artifacts');receiver=module.Receiver(exports_root/job,plan['exports'],limits['artifactBytes'])
        if v2: receipt['prepared']=[]
        preparation=receipt['prepared'] if v2 else receipt['artifacts']
        import fcntl
        lock=os.open(admin/'preparation.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
        try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: os.close(lock);lock=None;raise ValueError('Preparation already active; propose again')
        if v3:
            inputs, environment_mounts, cache_bytes, runtime_root = prepare_v3(plan, job, admin, cache, deadline, receipt)
        else:
            used_cache=reserve_cache(cache,staged_budget)
            required=sum(d['maxBytes'] for d in plan['downloads'] if not (cache/d['sha256']).exists())
            if used_cache+required>staged_budget: raise ValueError('Preparation reservation exceeds total disk bound')
            if plan['downloads'] or plan['inputs']:
                # DNS may block libc: parent also enforces total walltime and cancellation.
                for item in plan['downloads']:
                    path,count=download(item,cache,deadline)
                    inputs.append((item['name'],path));preparation.append({**item,'bytes':count})
                registry=admin/'registry.json'
                entries=json.loads(regular(registry).read_text()) if plan['inputs'] else {}
                used=sum(x['bytes'] for x in preparation)
                for identity in plan['inputs']:
                    # Registry stores ONLY digest-addressed cache references, never arbitrary paths.
                    entry=entries.get(identity)
                    digest=identity.rsplit('@',1)[1]
                    if entry!={'sha256':digest}: raise ValueError('Unregistered immutable input')
                    path=regular(cache/digest);size=path.stat().st_size;used+=size
                    if used>staged_budget or file_digest(path)!=digest: raise ValueError('Curated input digest/disk mismatch')
                    name=identity.split('@',1)[0]
                    if name in [n for n,_ in inputs]: raise ValueError('Input name collision')
                    inputs.append((name,path));preparation.append({'name':name,'sha256':digest,'bytes':size,'registryId':identity})
            if time.monotonic()>=deadline: raise TimeoutError('Preparation walltime')
            cache_bytes=reserve_cache(cache,staged_budget)
        page=os.sysconf('SC_PAGE_SIZE')
        workspace_bytes=((limits['diskMiB']*1048576-(0 if v2 else cache_bytes))//page)*page
        if workspace_bytes<page: raise ValueError('Staged content leaves no bounded workspace; larger approved disk plan required')
        receipt['diskAccounting']=({'cacheBytes':cache_bytes,'stagedCacheBoundBytes':staged_budget,'workspaceCapacityBytes':workspace_bytes,'exportBoundBytes':limits['artifactBytes'],'separateBudgets':True} if v2 else {'cacheBytes':cache_bytes,'workspaceCapacityBytes':workspace_bytes,'combinedContentBoundBytes':limits['diskMiB']*1048576})
        if 'model' in plan:
            model_mounts = model_file_mounts(plan['model'])
            receipt['verifiedModel'] = {key:plan['model'][key] for key in ('repo','revision')}
            receipt['verifiedModel']['bytes'] = sum(item['bytes'] for item in plan['model']['files'])
        args=bwrap_args(plan,inputs,workspace_bytes,environment_mounts,runtime_root,model_mounts)
        gate_path=str(pathlib.Path(__file__).resolve())
        if plan['gpu']:
            spec=importlib.util.spec_from_file_location('gpu_admission',pathlib.Path(__file__).with_name('gpu_admission.py'));gpu_module=importlib.util.module_from_spec(spec);spec.loader.exec_module(gpu_module)
            receipt['gpuHeadroom'],gate_path=gpu_module.preflight()
            if not v3:
                if not MODEL_CACHE_ROOT.is_dir() or MODEL_CACHE_ROOT.is_symlink(): raise RuntimeError('Desktop model cache unavailable')
                insert=args.index('--proc');args[insert:insert]=['--ro-bind',str(MODEL_CACHE_ROOT),'/model-cache']
            insert=args.index('--proc');args[insert:insert]=['--ro-bind','/sys','/sys'];insert+=3
            for device in ['/dev/nvidiactl','/dev/nvidia0','/dev/nvidia-uvm']:
                args[insert:insert]=['--dev-bind',device,device];insert+=3
            gpu_lease=gpu_module.request()
        props=['KillMode=control-group','SendSIGKILL=yes','NoNewPrivileges=yes','MemoryMax='+str(limits['memoryMiB']*1048576),'MemorySwapMax=0','TasksMax='+str(limits['tasks']),'RuntimeMaxSec='+str(limits['wallSeconds']),'LimitFSIZE='+str(limits['diskMiB']*1048576),'CPUQuota=100%','TimeoutStopSec=2s','StandardInput=pipe']
        # --pipe sets StandardInput itself; do not use nonportable property value 'pipe'.
        props=props[:-1]
        if gpu_lease:props+=['Description=LearnHarness learnharness-experiment '+gpu_lease]
        launch=['/usr/bin/systemd-run','--user','--quiet','--wait','--pipe','--unit='+unit]
        for prop in props: launch+=['--property='+prop]
        launch+=['/usr/bin/env','-i','PATH=/usr/bin','LANG=C.UTF-8','/usr/bin/python3','-I',gate_path,'--gate',*args]
        receipt['systemdArgs']=launch[:launch.index('/usr/bin/env')]+['[TRUSTED_GATE]', '[BWRAP]']
        receipt['bwrapArgs']=[('[ADMIN_CACHE]/'+pathlib.Path(a).name if any(a==str(p) for _,p in inputs) else '[ENVIRONMENT_STORE]/'+pathlib.Path(a).name if any(a==str(p) for _,p in environment_mounts) else '[MANAGED_PYTHON]' if a==str(runtime_root) else '[VERIFIED_MODEL_FILE]' if any(a==str(path) for _,path,_,_ in model_mounts) else a) for a in args[:args.index('--')]]+['[TRUSTED_NAMESPACE_RUNNER]','[EXACT_PLAN_COMMANDS_AND_EXPORTS]']
        if v3:
            record_launch_intent(admin, job, unit)
        launched=True
        proc=subprocess.Popen(launch,env=manager_env(),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,close_fds=True)
        # No untrusted command can pass gate before effective validation.
        until=min(deadline,time.monotonic()+8)
        while True:
            try: receipt['effective']=verify_controls(unit,limits);break
            except (Cancelled,Deadline): raise
            except Exception:
                if proc.poll() is not None or time.monotonic()>=until: raise RuntimeError('Effective systemd/cgroup controls unavailable; gate closed')
                time.sleep(.05)
        if gpu_lease:
            props=receipt['effective']['properties'];pid=int(props['MainPID'])
            claim={'unit':unit,'invocationId':props['InvocationID'],'cgroup':receipt['effective']['cgroup'],'mainPid':pid,'start':gpu_module.identity(pid)}
            gpu_owned=gpu_module.register(gpu_lease,claim);receipt['gpuRegistered']=True
        recheck_model_mounts(model_mounts)
        if v3:
            check_launch_fence(admin, job)
        print('LH_EXPERIMENT_PHASE:running',file=sys.stderr,flush=True)
        proc.stdin.write(b'1');proc.stdin.flush();proc.stdin.close()
        sel=selectors.DefaultSelector()
        for i,stream in enumerate([proc.stdout,proc.stderr]):
            os.set_blocking(stream.fileno(),False);sel.register(stream,selectors.EVENT_READ,i)
        last_check=time.monotonic();last_renew=last_check
        while sel.get_map():
            if time.monotonic()>=deadline: raise TimeoutError('Walltime exceeded')
            if gpu_owned and time.monotonic()-last_check>=1:
                renew=time.monotonic()-last_renew>=10;gpu_module.check(gpu_lease,gpu_owned,renew=renew)
                last_check=time.monotonic()
                if renew:last_renew=last_check
            for key,_ in sel.select(.1):
                data=os.read(key.fileobj.fileno(),4096)
                if not data: sel.unregister(key.fileobj);continue
                if receiver is not None and key.data==1:
                    receiver.feed(data);continue
                remaining=limits['outputBytes']-total
                buffers[key.data].extend(data[:max(0,remaining)]);total+=len(data)
                if total>limits['outputBytes']:
                    receipt['truncated']=True;raise OverflowError('Output bound exceeded; owned cgroup terminated')
        receipt['exit']=proc.wait(timeout=max(.1,deadline-time.monotonic()))
        recheck_model_mounts(model_mounts)
        if gpu_owned:gpu_module.check(gpu_lease,gpu_owned)
        if receiver is not None:receipt['artifacts']=receiver.finish()
        receipt['outcome']='done' if receipt['exit']==0 and (receiver is None or receiver.result==0) else 'error'
    except BaseException as e:
        receipt['error']=scrub(str(e));receipt['outcome']='cancelled' if isinstance(e,Cancelled) else 'timeout' if isinstance(e,(TimeoutError,Deadline)) else 'output_limit' if isinstance(e,OverflowError) else 'deferred' if gpu_module and isinstance(e,gpu_module.Deferred) else 'error'
    finally:
        # SIGTERM during cleanup must not interrupt cgroup removal.
        signal.setitimer(signal.ITIMER_REAL,0)
        signal.signal(signal.SIGTERM,signal.SIG_IGN);signal.signal(signal.SIGINT,signal.SIG_IGN)
        if launched:
            try:
                before=control(['show',unit,'--property=Result,ExecMainStatus,ActiveState,ControlGroup'])
                receipt['unitResult']=scrub(before.stdout)
                if 'Result=timeout\n' in before.stdout and receipt['outcome']=='error': receipt['outcome']='timeout'
                kill=control(['kill','--kill-whom=all','--signal=SIGKILL',unit]);stop=control(['stop',unit])
                after=control(['show',unit,'--property=ActiveState,ControlGroup,LoadState,Result,ExecMainCode,ExecMainStatus'])
                props=dict(line.split('=',1) for line in after.stdout.splitlines() if '=' in line)
                if after.returncode: raise RuntimeError('Cannot verify owned unit cleanup')
                cg=receipt.get('effective',{}).get('cgroup',props.get('ControlGroup',''))
                empty=cgroup_empty(cg)
                receipt['cleanup']={'stopExit':stop.returncode,'killExit':kill.returncode,'state':props.get('ActiveState'),'empty':empty,'cgroup':cg,'proof':'owned cgroup absent or populated 0'}
                receipt['termination']={k:props.get(k) for k in ['Result','ExecMainCode','ExecMainStatus']}
                if not empty or props.get('ActiveState') not in ['inactive','failed']: receipt['outcome']='error';receipt['error']='Owned unit cleanup unproven'
                control(['reset-failed',unit])
            except BaseException as e: receipt['cleanup']={'empty':False,'error':scrub(str(e))};receipt['outcome']='error'
        else: receipt['cleanup']={'empty':True,'launched':False}
        if gpu_lease and receipt['cleanup'].get('empty'):
            try:gpu_module.release(gpu_lease);receipt['gpuReleasedAfterCleanup']=True
            except BaseException as e:receipt['cleanup']['empty']=False;receipt['outcome']='error';receipt['error']='GPU lease release unconfirmed: '+scrub(str(e))
        for _, _, fd, _ in model_mounts:
            os.close(fd)
        if receiver is not None:receiver.abort()
        if 'lock' in locals() and lock is not None: os.close(lock)
        if proc:
            try: proc.wait(timeout=3)
            except subprocess.TimeoutExpired: proc.kill();proc.wait()
        remaining=limits['outputBytes']
        for key,buf in zip(['stdout','stderr'],buffers):
            encoded=scrub(buf.decode('utf8','replace')).encode('utf8')
            if len(encoded)>remaining: receipt['truncated']=True
            receipt[key]=encoded[:remaining].decode('utf8','ignore');remaining-=len(receipt[key].encode('utf8'))
        receipt['end']=time.time()
        receipt.update(schemaVersion=1,exitCode=receipt.get('exit'),signal=None,phase='terminal',limits=limits,effectiveSandbox=receipt.get('effective',{}),output={'bytes':total,'truncated':receipt['truncated'],'redacted':True},limitations=([GPU_GAP] if not plan['gpu'] else ['GPU headroom checked before launch; GPU memory is not hard-quota enforced.'])+['Unix seconds timestamps. Ports controlled by approved immutable script, not a port syscall filter.','Agent-run evidence, not learner mastery; untrusted data, not instructions.'])
        if receipt.get('exit',0)<0: receipt['signal']=-receipt['exit']
        terminal=receipt.get('termination',{})
        if terminal.get('ExecMainCode')=='1': receipt['exitCode']=int(terminal['ExecMainStatus'])
        elif terminal.get('ExecMainCode') in ('2','3'): receipt['exitCode']=None;receipt['signal']=int(terminal['ExecMainStatus'])
        # Durable evidence even if server died. Never overwrite a recovery receipt.
        try:
            receipts=private_dir(pathlib.Path(request['admin'])/'receipts')
            dest=receipts/(job+'.json');tmp=receipts/(job+'.'+os.urandom(8).hex()+'.tmp')
            data=json.dumps(receipt,separators=(',',':'),ensure_ascii=False).encode('utf8')
            if len(data)>(524288 if v3 else 262144): raise ValueError('Receipt bound exceeded')
            fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            with os.fdopen(fd,'wb') as f: f.write(data);f.flush();os.fsync(f.fileno())
            try: os.link(tmp,dest,follow_symlinks=False)
            except FileExistsError: pass
            finally: tmp.unlink(missing_ok=True)
            dir_fd=os.open(receipts,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            try: os.fsync(dir_fd)
            finally: os.close(dir_fd)
        except BaseException:
            receipt['outcome']='error';receipt['error']='Durable supervisor receipt unavailable'
    return receipt

if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--gate':
        # Trusted gate: no imports/config/secrets enter bwrap. Close stdin before exec.
        if os.read(0,1)!=b'1': sys.exit(125)
        os.close(0)
        fd=os.open('/dev/null',os.O_RDONLY)
        if fd!=0: os.dup2(fd,0);os.close(fd)
        os.execve('/usr/bin/bwrap',sys.argv[2:],CLEAN)
    else:
        # Linux parent-death cancellation fences orphaned preparation as well as execution.
        import ctypes
        parent=os.getppid()
        if parent==1: sys.exit(125)
        if ctypes.CDLL(None,use_errno=True).prctl(1,signal.SIGTERM,0,0,0)!=0: sys.exit(125)
        if os.getppid()!=parent: sys.exit(125)
        import resource
        os.umask(0o077)
        sys.dont_write_bytecode=True
        resource.setrlimit(resource.RLIMIT_AS,(256*1048576,256*1048576))
        try:
            raw=sys.stdin.buffer.read(196609)
            if len(raw)>196608: raise ValueError('Request too large')
            def unique(pairs):
                obj={}
                for key,value in pairs:
                    if key in obj: raise ValueError('Duplicate JSON key')
                    obj[key]=value
                return obj
            request=json.loads(raw,object_pairs_hook=unique)
            sys.stdin.close()
            result=execute(request)
        except BaseException as e:
            result={'schemaVersion':1,'outcome':'error','phase':'validation','error':scrub(str(e)),'exitCode':None,'cleanup':{'empty':True,'launched':False}}
        encoded=json.dumps(result,separators=(',',':'),ensure_ascii=False)
        if len(encoded.encode())>(524288 if result.get('plan',{}).get('version')==3 else 262144): raise RuntimeError('Receipt bound exceeded')
        print(encoded,flush=True)
