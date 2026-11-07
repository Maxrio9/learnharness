#!/usr/bin/python3
"""Trusted namespace runner; artifact bytes remain untrusted experimental data."""
import os,sys,stat,json,base64,hashlib,subprocess,re

def open_artifact(root,path,maximum):
 if type(path) is not str or not re.fullmatch(r'[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*',path) or any(x in ('.','..') for x in path.split('/')):raise ValueError('Normalized relative path required')
 directory=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  components=path.split('/')
  for part in components[:-1]:
   nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory);os.close(directory);directory=nxt
  fd=os.open(components[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
  try:
   info=os.fstat(fd)
   if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>maximum:raise ValueError('Bounded regular single-link artifact required')
   return os.fdopen(fd,'rb')
  except BaseException:os.close(fd);raise
 finally:os.close(directory)

def emit(value):
 sys.stderr.write(json.dumps(value,separators=(',',':'))+'\n');sys.stderr.flush()

def run(commands,exports,root='/workspace'):
 status=0
 for argv in commands:
  result=subprocess.run(argv,stdin=subprocess.DEVNULL,stdout=sys.stdout,stderr=sys.stdout,close_fds=True)
  if result.returncode:status=result.returncode;break
 try:
  for item in exports:
   with open_artifact(root,item['path'],item['maxBytes']) as f:
    before=os.fstat(f.fileno());digest=hashlib.sha256();count=0
    emit({'type':'artifact-start','name':item['path'],'bytes':before.st_size})
    while True:
     data=f.read(24576)
     if not data:break
     count+=len(data)
     if count>item['maxBytes'] or count>before.st_size:raise ValueError('Artifact changed or exceeded approved bytes')
     digest.update(data);emit({'type':'artifact-chunk','data':base64.b64encode(data).decode('ascii')})
    after=os.fstat(f.fileno())
    if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) or count!=before.st_size or after.st_nlink!=1:raise ValueError('Artifact changed during export')
    emit({'type':'artifact-end','name':item['path'],'bytes':count,'sha256':digest.hexdigest()})
 except BaseException as error:
  emit({'type':'export-error','error':type(error).__name__});return 125
 emit({'type':'result','exitCode':status})
 return status if 0<=status<=255 else 125

if __name__=='__main__':raise SystemExit(run(json.loads(sys.argv[1]),json.loads(sys.argv[2])))
