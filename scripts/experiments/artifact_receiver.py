#!/usr/bin/python3
"""Trusted bounded artifact stream sink. Never interprets artifact content."""
import os,pathlib,json,hashlib,base64,re
class Receiver:
 def __init__(self,root,exports,budget):
  self.root=pathlib.Path(root)
  for p in [self.root,*self.root.parents]:
   if p.is_symlink():raise ValueError('Export directory symlink')
  self.root.mkdir(mode=0o700,parents=False,exist_ok=False)
  self.approved={x['path']:x for x in exports};self.budget=budget;self.total=0;self.buffer=bytearray();self.active=None;self.completed=[];self.result=None
 def feed(self,data):
  self.buffer.extend(data)
  while b'\n' in self.buffer:
   line,_,rest=self.buffer.partition(b'\n');self.buffer=bytearray(rest)
   if len(line)>65536:raise ValueError('Artifact protocol line too long')
   def unique(pairs):
    out={}
    for k,v in pairs:
     if k in out:raise ValueError('Duplicate protocol key')
     out[k]=v
    return out
   event=json.loads(line,object_pairs_hook=unique);self.event(event)
  if len(self.buffer)>65536:raise ValueError('Artifact protocol buffer bound')
 def event(self,event):
  if type(event) is not dict or self.result is not None:raise ValueError('Invalid terminal artifact protocol')
  kind=event.get('type')
  if kind=='artifact-start':
   if set(event)!= {'type','name','bytes'} or self.active is not None or event['name'] not in self.approved or any(x['name']==event['name'] for x in self.completed):raise ValueError('Unapproved or duplicate artifact')
   item=self.approved[event['name']];size=event['bytes']
   if type(size) is not int or not 0<=size<=item['maxBytes'] or self.total+size>self.budget:raise ValueError('Artifact exceeds approved bytes')
   tmp=self.root/('.'+os.urandom(16).hex()+'.partial')
   fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
   self.active={'name':event['name'],'size':size,'bytes':0,'digest':hashlib.sha256(),'file':os.fdopen(fd,'wb'),'tmp':tmp}
  elif kind=='artifact-chunk':
   if set(event)!={'type','data'} or not self.active or type(event['data']) is not str or len(event['data'])>32768:raise ValueError('Invalid artifact chunk')
   data=base64.b64decode(event['data'],validate=True);active=self.active
   if active['bytes']+len(data)>active['size']:raise ValueError('Artifact stream exceeds declaration')
   active['file'].write(data);active['digest'].update(data);active['bytes']+=len(data)
  elif kind=='artifact-end':
   active=self.active
   if set(event)!= {'type','name','bytes','sha256'} or not active or event['name']!=active['name'] or type(event['bytes']) is not int or event['bytes']!=active['bytes'] or active['bytes']!=active['size'] or event['sha256']!=active['digest'].hexdigest():raise ValueError('Artifact length/hash mismatch')
   active['file'].flush();os.fsync(active['file'].fileno());active['file'].close()
   dest=self.root/event['sha256']
   try:os.link(active['tmp'],dest,follow_symlinks=False)
   except FileExistsError:
    fd=os.open(dest,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
     st=os.fstat(fd)
     if not __import__('stat').S_ISREG(st.st_mode) or st.st_nlink!=1 or st.st_uid!=os.getuid() or st.st_mode&0o077 or st.st_size!=active['bytes']:raise ValueError('Invalid existing artifact')
     digest=hashlib.sha256()
     while True:
      chunk=os.read(fd,65536)
      if not chunk:break
      digest.update(chunk)
     if digest.hexdigest()!=event['sha256']:raise ValueError('Existing artifact hash mismatch')
    finally:os.close(fd)
   active['tmp'].unlink()
   self.total+=active['bytes'];self.completed.append({'name':active['name'],'bytes':active['bytes'],'sha256':event['sha256']});self.active=None
  elif kind=='result':
   if set(event)!= {'type','exitCode'} or self.active or type(event['exitCode']) is not int or not -255<=event['exitCode']<=255:raise ValueError('Invalid worker result')
   self.result=event['exitCode']
  else:raise ValueError('Unknown or failed artifact protocol')
 def finish(self):
  if self.buffer or self.active or self.result is None or len(self.completed)!=len(self.approved):raise ValueError('Incomplete requested artifact export')
  directory=os.open(self.root,os.O_RDONLY|os.O_DIRECTORY)
  try:os.fsync(directory)
  finally:os.close(directory)
  return self.completed
 def abort(self):
  if self.active:
   self.active['file'].close();self.active['tmp'].unlink(missing_ok=True);self.active=None
