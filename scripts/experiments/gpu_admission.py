"""Trusted foreground desktop lease helpers; never imported inside the sandbox."""
import hashlib,json,os,pathlib,subprocess,time,urllib.error,urllib.request

OWNER='learnharness-experiment'
# GPU experiments need a trusted foreground-admission service. Without these settings they are refused.
ADMISSION_URL=os.environ.get('LH_EXP_ADMISSION_URL','')          # e.g. http://127.0.0.1:PORT
CONFIG=pathlib.Path(os.environ.get('LH_EXP_ADMISSION_CONFIG','/nonexistent'))   # JSON with experiment_cgroup_gate {path, sha256}
PROFILE=os.environ.get('LH_EXP_RESERVE_PROFILE','')               # trusted script printing {"reserve_gib", "graphical_desktop"}
class Deferred(Exception):pass

def call(action,body):
 if not ADMISSION_URL:raise Deferred('GPU admission is not configured (set LH_EXP_ADMISSION_URL)')
 request=urllib.request.Request(ADMISSION_URL.rstrip('/')+'/admission/'+action,data=json.dumps(body).encode(),headers={'Content-Type':'application/json','X-Inference-Class':'foreground'})
 try:
  with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request,timeout=5) as response:return json.loads(response.read(65536))
 except urllib.error.HTTPError as error:
  if error.code in (409,423,429,503):
   try: reason=json.loads(error.read(4096)).get('reason','')
   except (ValueError,UnicodeError): reason=''
   raise Deferred('Foreground desktop admission deferred'+(': '+str(reason)[:200] if reason else '')) from error
  raise

def preflight():
 if not (ADMISSION_URL and PROFILE and CONFIG.is_file()):raise Deferred('GPU admission is not configured (LH_EXP_ADMISSION_URL, LH_EXP_ADMISSION_CONFIG, LH_EXP_RESERVE_PROFILE)')
 env={'PATH':'/usr/bin','LANG':'C.UTF-8'}
 profile=json.loads(subprocess.run(['/usr/bin/python3','-I',PROFILE],env=env,capture_output=True,text=True,check=True,timeout=10).stdout)
 if profile.get('reserve_gib') not in (0,4) or profile.get('reserve_gib')!=(4 if profile.get('graphical_desktop') else 0):raise RuntimeError('Desktop reserve is unknown')
 free=int(subprocess.run(['/usr/bin/nvidia-smi','--id=0','--query-gpu=memory.free','--format=csv,noheader,nounits'],env=env,capture_output=True,text=True,check=True,timeout=5).stdout.strip())
 if free<profile['reserve_gib']*1024+512:raise Deferred('Insufficient GPU headroom for desktop reserve')
 config=json.loads(CONFIG.read_text());pin=config['experiment_cgroup_gate'];gate=pathlib.Path(pin['path'])
 if not gate.is_absolute() or gate.is_symlink() or hashlib.sha256(gate.read_bytes()).hexdigest()!=pin['sha256']:raise RuntimeError('Trusted gate pin mismatch')
 return {'freeMiB':free,'reserveMiB':profile['reserve_gib']*1024},str(gate)

def request():
 value=call('request',{'owner':OWNER,'class':'foreground','ttl_seconds':45,'pids':[]})
 if value.get('granted') is not True or value.get('owner')!=OWNER or value.get('class')!='foreground':raise Deferred('Foreground lease not granted')
 return value['lease_id']

def register(ident,claim):
 value=call('renew',{'owner':OWNER,'lease_id':ident,'owned_cgroup':claim})
 owned=value.get('owned_cgroup')
 if value.get('granted') is not True or type(owned) is not dict or any(owned.get(k)!=v for k,v in claim.items()) or type(owned.get('inode')) is not int or owned.get('restartDisabled') is not True:raise RuntimeError('Exact owned cgroup not acknowledged')
 return owned

def check(ident,owned,renew=False):
 value=call('renew' if renew else 'check',{'owner':OWNER,'lease_id':ident})
 if value.get('granted') is not True or value.get('owned_cgroup')!=owned:raise Deferred('GPU ownership expired, was revoked or changed')

def release(ident):
 if call('release',{'owner':OWNER,'lease_id':ident}).get('released') is not True:raise RuntimeError('GPU lease release unconfirmed')

def identity(pid):
 root=pathlib.Path('/proc')/str(pid)
 if root.stat().st_uid!=os.getuid():raise ValueError('Foreign gate PID')
 return int((root/'stat').read_text().rsplit(')',1)[1].split()[19])
