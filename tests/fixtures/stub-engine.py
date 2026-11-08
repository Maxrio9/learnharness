#!/usr/bin/python3
"""Fake OpenAI-compatible engine for engine_ladder tests. Modes: ok | crash | hang | badreq."""
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
mode, port = sys.argv[1], int(sys.argv[2])
if mode == 'crash':
    print('RuntimeError: Could not find nvcc and default cuda_home=/usr/local/cuda does not exist', flush=True); sys.exit(1)
if mode == 'hang':
    time.sleep(600)
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(b'{"data":[]}')
    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0)); body = json.loads(self.rfile.read(n))
        if mode == 'badreq':
            self.send_response(500); self.end_headers(); return
        self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.end_headers()
        for i in range(min(body['max_tokens'], 6)):
            self.wfile.write(('data: '+json.dumps({'choices':[{'index':0,'text':'w%d '%i,'finish_reason':None}]})+'\n\n').encode()); self.wfile.flush(); time.sleep(0.01)
        self.wfile.write(('data: '+json.dumps({'choices':[{'index':0,'text':'','finish_reason':'length'}],'usage':{'completion_tokens':min(body['max_tokens'],6)}})+'\n\n').encode())
        self.wfile.write(b'data: [DONE]\n\n'); self.wfile.flush()
ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
