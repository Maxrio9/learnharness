#!/usr/bin/python3
"""Bounded OpenAI-compatible streaming probe for a private loopback sandbox.

This is measurement machinery; it does not choose prompts, start an engine,
request GPU admission, or interpret the learner's results. Chunk timing is
reported separately from token timing. Token timing requires one explicit
token ID in every content-bearing event; no event-to-token guess is made.
"""
import http.client
import json
import math
import multiprocessing
import os
import selectors
import sys
import time

MAX_FRAME=262144

def percentile(values, fraction):
    if not values:return None
    data=sorted(values);pos=(len(data)-1)*fraction;lo=math.floor(pos);hi=math.ceil(pos)
    return data[lo]+(data[hi]-data[lo])*(pos-lo)

def validate(plan):
    keys={'port','model','prompts','max_tokens','timeout_seconds','concurrency','return_token_ids'}
    if type(plan) is not dict or set(plan)!=keys:raise ValueError('Exact probe parameters required')
    for key,low,high in [('port',1024,65535),('max_tokens',1,2048),('timeout_seconds',1,300),('concurrency',1,32)]:
        if type(plan[key]) is not int or not low<=plan[key]<=high:raise ValueError('Invalid bound: '+key)
    if type(plan['model']) is not str or not 1<=len(plan['model'])<=256:raise ValueError('Invalid model')
    if type(plan['return_token_ids']) is not bool:raise ValueError('Invalid token ID option')
    prompts=plan['prompts']
    if type(prompts) is not list or not 1<=len(prompts)<=128 or any(type(x) is not str or not 1<=len(x.encode())<=65536 for x in prompts):raise ValueError('Invalid prompt set')
    if sum(len(x.encode()) for x in prompts)>1048576:raise ValueError('Prompt bytes exceed bound')
    return plan

def request_one(plan,index,prompt):
    started=time.monotonic();deadline=started+plan['timeout_seconds'];first=None;events=[];tokens=[];unverified=False;done=False;usage=None;finish=None;total_bytes=0;total_events=0
    conn=http.client.HTTPConnection('127.0.0.1',plan['port'],timeout=plan['timeout_seconds'])
    try:
        payload={'model':plan['model'],'prompt':prompt,'max_tokens':plan['max_tokens'],'stream':True,'stream_options':{'include_usage':True}}
        if plan['return_token_ids']:payload['return_token_ids']=True
        body=json.dumps(payload,separators=(',',':')).encode()
        conn.request('POST','/v1/completions',body,{'Content-Type':'application/json','Accept':'text/event-stream'})
        response=conn.getresponse()
        if response.status!=200:return {'index':index,'ok':False,'error':'HTTP '+str(response.status),'elapsed_s':time.monotonic()-started}
        if 'text/event-stream' not in response.getheader('content-type','').lower():raise ValueError('Expected event stream')
        frame=[];size=0
        while time.monotonic()<deadline:
            if conn.sock:conn.sock.settimeout(max(.001,deadline-time.monotonic()))
            line=response.readline(MAX_FRAME+1)
            if not line:break
            total_bytes+=len(line)
            if total_bytes>8388608:raise ValueError('Stream exceeds byte budget')
            size+=len(line)
            if len(line)>MAX_FRAME or size>MAX_FRAME:raise ValueError('Stream frame exceeds bound')
            if line in (b'\n',b'\r\n'):
                raw=b'\n'.join(frame);frame=[];size=0
                if not raw:continue
                if raw==b'[DONE]':done=time.monotonic()<=deadline;break
                total_events+=1
                if total_events>plan['max_tokens']*8+128:raise ValueError('Excessive stream events')
                obj=json.loads(raw)
                if type(obj) is not dict:raise ValueError('Invalid stream event')
                if obj.get('error') is not None:raise ValueError('Engine returned an error event')
                choices=obj.get('choices',[])
                if type(choices) is not list or len(choices)>1:raise ValueError('Invalid choices')
                if obj.get('usage') is not None:usage=obj['usage']
                for choice in choices:
                    if type(choice) is not dict:raise ValueError('Invalid choice')
                    if choice.get('index')!=0:raise ValueError('Unexpected completion index')
                    if finish is not None and (choice.get('text') or choice.get('token_ids') or choice.get('finish_reason') is not None):raise ValueError('Generation after terminal event')
                    if choice.get('finish_reason') is not None:
                        if choice['finish_reason'] not in ('stop','length'):raise ValueError('Unsuccessful finish')
                        finish=choice['finish_reason']
                    content=choice.get('text','')
                    if not isinstance(content,str):raise ValueError('Invalid text chunk')
                    now=time.monotonic()
                    ids=choice.get('token_ids')
                    if type(ids) is list and len(ids)==1 and type(ids[0]) is int:tokens.append(now)
                    elif content or (ids is not None and ids!=[]):unverified=True
                    if not content:continue
                    first=first or now;events.append(now)
                    if len(events)>plan['max_tokens']*8+32:raise ValueError('Excessive stream events')
            elif line.startswith(b'data:'):
                frame.append(line[5:].strip())
        elapsed=time.monotonic()-started
        if not done or finish is None:return {'index':index,'ok':False,'error':'Incomplete, failed or timed out stream','elapsed_s':elapsed}
        chunk_gaps=[b-a for a,b in zip(events,events[1:])]
        completion=usage.get('completion_tokens') if type(usage) is dict else None
        if type(completion) is not int or completion<0 or completion>plan['max_tokens']:completion=None
        token_gaps=[b-a for a,b in zip(tokens,tokens[1:])] if not unverified and completion is not None and completion>0 and len(tokens)==completion else None
        return {'index':index,'ok':True,'elapsed_s':elapsed,'first_visible_text_s':None if first is None else first-started,
                'first_token_s':tokens[0]-started if token_gaps is not None and tokens else None,
                'content_events':len(events),'chunk_gap_s':chunk_gaps,'token_gap_s':token_gaps,'completion_tokens':completion}
    except (OSError,TimeoutError,ValueError,TypeError,KeyError,RecursionError,json.JSONDecodeError,http.client.HTTPException) as error:
        return {'index':index,'ok':False,'error':type(error).__name__,'elapsed_s':time.monotonic()-started}
    finally:conn.close()

def _worker(plan,index,prompt,read_fd,write_fd):
    os.close(read_fd)
    try:
        data=json.dumps(request_one(plan,index,prompt),separators=(',',':'),allow_nan=False).encode()+b'\n'
        if len(data)>2097152:raise ValueError('Worker result exceeds bound')
        while data:data=data[os.write(write_fd,data):]
    finally:os.close(write_fd)

def run(plan):
    plan=validate(plan);started=time.monotonic();rows=[None]*len(plan['prompts']);active={};next_index=0
    context=multiprocessing.get_context('fork');selector=selectors.DefaultSelector()
    try:
        while next_index<len(rows) or active:
            while next_index<len(rows) and len(active)<plan['concurrency']:
                reader,writer=os.pipe();index=next_index;next_index+=1;os.set_blocking(reader,False)
                process=context.Process(target=_worker,args=(plan,index,plan['prompts'][index],reader,writer),daemon=True)
                process.start();os.close(writer);active[reader]=[process,index,time.monotonic()+plan['timeout_seconds'],bytearray()];selector.register(reader,selectors.EVENT_READ)
            for key,_ in selector.select(.05):
                reader=key.fd;process,index,deadline,buffer=active[reader]
                try:chunk=os.read(reader,65536)
                except BlockingIOError:continue
                buffer.extend(chunk)
                if len(buffer)>2097152:rows[index]={'index':index,'ok':False,'error':'Worker result exceeds bound'}
                elif not chunk:rows[index]={'index':index,'ok':False,'error':'Incomplete worker result'}
                elif b'\n' in buffer:
                    try:
                        if not buffer.endswith(b'\n') or buffer.count(b'\n')!=1:raise ValueError('Invalid frame')
                        rows[index]=json.loads(buffer)
                    except (ValueError,RecursionError):rows[index]={'index':index,'ok':False,'error':'Invalid worker result'}
            for reader,(process,index,deadline,_) in list(active.items()):
                if rows[index] is None and time.monotonic()>=deadline:rows[index]={'index':index,'ok':False,'error':'Request deadline exceeded'}
                if rows[index] is None:continue
                if process.is_alive():process.kill()
                process.join(timeout=.5)
                if process.is_alive():raise RuntimeError('Worker termination unconfirmed')
                selector.unregister(reader);os.close(reader);del active[reader]
    finally:
        for reader,(process,_,_,_) in active.items():
            if process.is_alive():process.kill()
            process.join(timeout=.5);selector.unregister(reader);os.close(reader)
        selector.close()
    elapsed=time.monotonic()-started;success=[x for x in rows if x['ok']]
    ttft=[x['first_visible_text_s'] for x in success if x['first_visible_text_s'] is not None]
    all_token_times=bool(success) and all(x['token_gap_s'] is not None for x in success)
    gaps=[v for x in success for v in (x['token_gap_s'] or [])] if all_token_times else []
    first_tokens=[x['first_token_s'] for x in success] if all_token_times else []
    measured=all(x['completion_tokens'] is not None for x in success)
    for row in success:
        chunks=row.pop('chunk_gap_s');tokens=row.pop('token_gap_s')
        row['chunk_gap_p50_s']=percentile(chunks,.5);row['chunk_gap_p95_s']=percentile(chunks,.95)
        row['token_timing_verified']=tokens is not None
    return {'requests':rows,'summary':{'total':len(rows),'success':len(success),'failed':len(rows)-len(success),'elapsed_s':elapsed,
      'first_visible_text_p50_s':percentile(ttft,.5),'first_visible_text_p95_s':percentile(ttft,.95),
      'first_token_p50_s':percentile(first_tokens,.5),'first_token_p95_s':percentile(first_tokens,.95),
      'itl_p50_s':percentile(gaps,.5),'itl_p95_s':percentile(gaps,.95),
      'completion_tokens_per_s':sum(x['completion_tokens'] for x in success)/elapsed if success and measured else None,
      'token_timing':'client-observed delivery, explicit one-token IDs only; null when unavailable'}}

if __name__=='__main__':
    try:
        if len(sys.argv)>2:raise ValueError('At most one plan file')
        if len(sys.argv)==2:
            with open(sys.argv[1],'rb') as file:raw=file.read(1100000)
        else:raw=sys.stdin.buffer.read(1100000)
        if len(raw)>=1100000:raise ValueError('Probe input too large')
        result=run(json.loads(raw));print(json.dumps(result,separators=(',',':'),allow_nan=False))
        if result['summary']['failed']:raise SystemExit(1)
    except (ValueError,TypeError,KeyError,json.JSONDecodeError) as error:
        print(json.dumps({'error':type(error).__name__}));raise SystemExit(2)
