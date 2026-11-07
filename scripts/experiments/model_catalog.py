#!/usr/bin/python3
"""Read-only Hugging Face cache inventory; metadata is not an execution grant."""
import json
import os
from pathlib import Path
import re
import selectors
import signal
import socket
import subprocess
import time

def configured_roots():
 # Roots are passed by the trusted app as one JSON argument (never model-supplied); default: the standard HF cache.
 import sys
 if len(sys.argv)>1:
  value=json.loads(sys.argv[1])
  if not isinstance(value,list) or len(value)>8 or not all(isinstance(item,str) and item.startswith('/') for item in value):raise SystemExit('Invalid roots')
  return tuple(Path(item) for item in value)
 return (Path.home()/'.cache'/'huggingface'/'hub',)
MODEL=re.compile(r'^models--([A-Za-z0-9_.-]+)--([A-Za-z0-9_.-]+)$')
REVISION=re.compile(r'^[0-9a-f]{40,64}$')
SAFE=re.compile(r'^[A-Za-z0-9_.-]{1,100}$')

def in_root(path,root):
 try:
  value=path.resolve(strict=True)
  return value if value.is_relative_to(root) and value.is_file() else None
 except (OSError,RuntimeError):return None

def discover(roots,host):
 rows=[];errors=[]
 for root in roots:
  try:
   root=root.resolve(strict=True)
   if not root.is_dir():raise ValueError('Not a directory')
   repos=sorted(os.scandir(root),key=lambda x:x.name)
   for repo in repos:
    match=MODEL.fullmatch(repo.name)
    if not match or not repo.is_dir(follow_symlinks=False):continue
    snapshots=Path(repo.path)/'snapshots'
    if snapshots.is_symlink():continue
    try:revisions=sorted(os.scandir(snapshots),key=lambda x:x.name)
    except FileNotFoundError:continue
    for rev in revisions:
     if not REVISION.fullmatch(rev.name) or not rev.is_dir(follow_symlinks=False):continue
     directory=Path(rev.path);config=in_root(directory/'config.json',root)
     if config is None:continue
     try:
      if config.stat().st_size>1048576:continue
      meta=json.loads(config.read_text())
      if not isinstance(meta,dict):continue
      weights=[]
      for entry in os.scandir(directory):
       if not re.fullmatch(r'[A-Za-z0-9_.-]+\.(?:safetensors|bin|gguf)',entry.name):continue
       target=in_root(Path(entry.path),root)
       if target is not None:weights.append((entry.name,target.stat().st_size))
      kind=meta.get('model_type')
      rows.append({'host':host,'model':match.group(1)+'/'+match.group(2),'revision':rev.name,
        'model_type':kind if isinstance(kind,str) and SAFE.fullmatch(kind) else None,
        'weight_files':len(weights),'weight_bytes':sum(size for _,size in weights),
        'status':'metadata_only_unverified' if weights else 'no_weights_visible'})
      if len(rows)>=500:return {'models':rows,'errors':errors,'truncated':True}
     except (OSError,ValueError,TypeError,RecursionError):
      errors.append('snapshot_unreadable')
  except FileNotFoundError:continue
  except (OSError,ValueError):errors.append('cache_unreadable')
 return {'models':rows,'errors':errors[:20],'truncated':False}

def bounded_command(args,limit,timeout=2):
 """Collect at most limit bytes and reap the owned CLI on timeout or signal."""
 proc=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,stdin=subprocess.DEVNULL,close_fds=True,env={'PATH':'/usr/bin','HOME':str(Path.home()),'LANG':'C.UTF-8'})
 selector=selectors.DefaultSelector();data=bytearray();deadline=time.monotonic()+timeout
 try:
  os.set_blocking(proc.stdout.fileno(),False);selector.register(proc.stdout,selectors.EVENT_READ)
  while selector.get_map():
   remaining=deadline-time.monotonic()
   if remaining<=0:raise TimeoutError('Docker metadata deadline')
   for key,_ in selector.select(min(remaining,.05)):
    try:chunk=os.read(key.fd,65536)
    except BlockingIOError:continue
    if not chunk:selector.unregister(key.fileobj);continue
    data.extend(chunk)
    if len(data)>limit:raise ValueError('Docker metadata exceeds bound')
  if proc.wait(timeout=max(.01,deadline-time.monotonic()))!=0:raise ValueError('Docker metadata unavailable')
  return data.decode('utf8')
 finally:
  selector.close()
  if proc.poll() is None:proc.kill()
  try:proc.wait(timeout=.5)
  finally:proc.stdout.close()

def discover_engines():
 """Enumerate local Docker image metadata only; never start or pull an image."""
 try:
  docker=['/usr/bin/docker','--host','unix:///var/run/docker.sock']
  listing=bounded_command(docker+['image','ls','--no-trunc','--format','{{.Repository}}\t{{.Tag}}\t{{.ID}}'],131072)
  selected=[];truncated=False
  for line in listing.splitlines():
   fields=line.split('\t')
   if len(fields)!=3:continue
   repo,tag,ident=fields;engine='sglang' if 'sglang' in repo.lower() else 'vllm' if 'vllm' in repo.lower() else None
   if not engine or not re.fullmatch(r'[A-Za-z0-9_./-]{1,160}',repo) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}',tag) or not re.fullmatch(r'sha256:[a-f0-9]{64}',ident):continue
   if len(selected)>=32:truncated=True;break
   selected.append((repo+':'+tag,ident,engine))
  if not selected:return [],False,truncated
  ids=list(dict.fromkeys(item[1] for item in selected))
  values=json.loads(bounded_command(docker+['image','inspect',*ids],1048576))
  if not isinstance(values,list):raise ValueError('Invalid image metadata')
  by_id={v.get('Id'):v for v in values if isinstance(v,dict)}
  out=[]
  for image,ident,engine in selected:
   v=by_id.get(ident,{})
   architecture=v.get('Architecture');size=v.get('Size')
   if architecture not in ('amd64','arm64') or type(size) is not int or size<0 or v.get('Os')!='linux':continue
   out.append({'host':socket.gethostname(),'engine':engine,'image':image,'image_id':ident,'architecture':architecture,'size_bytes':size,'status':'metadata_only_unverified'})
  return out,False,truncated
 except (OSError,ValueError,TypeError,RecursionError,subprocess.SubprocessError):return [],True,False

class ScanDeadline(BaseException):pass

if __name__=='__main__':
 host=socket.gethostname()
 def timeout(*_):raise ScanDeadline()
 signal.signal(signal.SIGALRM,timeout);signal.signal(signal.SIGTERM,timeout);signal.setitimer(signal.ITIMER_REAL,4)
 try:
  result=discover(configured_roots(),host)
  result['engines'],failed,engine_truncated=discover_engines();result['truncated']|=engine_truncated
  if failed:result['errors'].append('engine_inventory_unavailable')
 except ScanDeadline:result={'models':[],'engines':[],'errors':['scan_deadline'],'truncated':True}
 finally:signal.setitimer(signal.ITIMER_REAL,0)
 print(json.dumps(result,separators=(',',':')))
