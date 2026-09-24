#!/usr/bin/env python3
"""Optional end-to-end test using installed OpenCode and LOCAL fake inference.

Run with: python3 opencode-jev/smoke.py
Requires localhost listening permissions and OpenCode on PATH. Keeps diagnostics
in an isolated temporary directory; never calls a paid model or the JEV API.
"""
import os, json, tempfile, subprocess, threading, time, socket, shutil
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
REPO=Path(__file__).resolve().parent.parent
ROOT=Path(tempfile.mkdtemp(prefix='jev-live-smoke-')).resolve()
PROJECT=ROOT/'project'; PROJECT.mkdir()
(PROJECT/'.opencode/plugins').mkdir(parents=True)
PLUGIN=ROOT/'plugin'; PLUGIN.mkdir()
shutil.copytree(REPO/'opencode-jev', PLUGIN/'opencode-jev')
shutil.copy(REPO/'index.ts', PLUGIN/'index.ts')
(PROJECT/'.opencode/plugins/jev.ts').write_text('export { default } from '+json.dumps((PLUGIN/'index.ts').as_uri())+'\n')
for name in ['jev_evaluate.py','opencode_jev_bridge.py']:
 shutil.copy(REPO/name,PLUGIN/name)
(PROJECT/'answer.js').write_text('export const answer = 0;\n')
mockpython=ROOT/'mock-python'
mockpython.write_text('''#!/usr/bin/env python3
import sys,json
from pathlib import Path
sys.path.insert(0,sys.argv[1].rsplit('/',1)[0])
import opencode_jev_bridge as bridge
import jev_evaluate as jev
jev.api_key_from_env=lambda: 'local-mock'
def judge(payload,*args,**kwargs):
 if 'needs_code' in payload['questions']:
  # Routing: conversation questions skip the drafting loop.
  chat='Explain' in payload['state']['latest_message']
  return {'model':jev.DEFAULT_MODEL,'answers':{'needs_code':{'type':'noul','noul':0.05 if chat else 0.95}}}
 assert Path('answer.js').read_text() == 'export const answer = 0;\\n', 'draft was applied before evaluation finished'
 assert 'check_1' in payload['questions'], 'worker checklist was not sent to JEV'
 passed='SELECTED_FINAL' in payload['state']['candidate_code']
 answers={}
 for name,q in payload['questions'].items():
  answers[name]=({'type':'noul','noul':0.99 if passed else 0.1} if q['type']=='noul' else {'type':'score','score':2.0,'confidence':1.0,'probabilities':{'0':0.0,'1':0.0,'2':1.0,'3':0.0}})
 return {'model':jev.DEFAULT_MODEL,'answers':answers}
jev.ask_jev=judge
print(json.dumps(bridge.handle(json.load(sys.stdin))))
''')
mockpython.chmod(0o700)
(PROJECT/'opencode-jev.json').write_text(json.dumps({'python':str(mockpython),'maxRevisions':1,'timeout':15,'generationTimeout':30}))
state={'requests':0,'drafts':0,'presentations':0,'paths':[],'errors':[],'scenario':'files'}
worker_started=threading.Event(); release_worker=threading.Event()
class Model(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_POST(self):
  req=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
  state['requests']+=1; state['paths'].append(self.path)
  msgs=req.get('messages',[])
  tools=req.get('tools',[])
  tool_names=[x['function']['name'] for x in tools]
  (ROOT/f'request-{state["requests"]}.json').write_text(json.dumps(req,indent=2))
  final=any('The JEV harness has finished' in json.dumps(m) for m in msgs)
  content='JEV local smoke'; tool_call=None
  worker=any('You work privately for the JEV harness.' in json.dumps(m) for m in msgs if m.get('role')=='system')
  direct=any("Answer the user's latest message directly" in json.dumps(m) for m in msgs)
  if worker and direct:
   state['direct']=state.get('direct',0)+1
   if 'read' not in tool_names or set(tool_names)-{'read','grep','glob','list'}: state['errors'].append('direct answer tools are not read-only: '+str(tool_names))
   content='CHAT_ANSWER: loops let a judge catch mistakes before you see them.'
  elif worker:
   if state['scenario']=='cancel':
    worker_started.set(); release_worker.wait(20)
   if (PROJECT/'answer.js').read_text() != 'export const answer = 0;\n': state['errors'].append('early file change')
   if req['model'] != 'mock': state['errors'].append('worker model changed')
   if 'read' not in tool_names or set(tool_names)-{'read','grep','glob','list'}: state['errors'].append('worker tools are not read-only: '+str(tool_names))
   if 'export const answer = 0' in json.dumps([m for m in msgs if m.get('role')!='tool']): state['errors'].append('project pasted into worker prompt')
   last_user=json.dumps([m for m in msgs if m.get('role')=='user'][-1:])
   if 'make a checklist' in last_user:
    # The harness asks for specific checks before the first draft.
    state['checklists']=state.get('checklists',0)+1
    content=json.dumps({'checks':['answer.js exports answer equal to 2']})
   elif state['scenario']=='files' and not any(m.get('role')=='tool' for m in msgs):
    # First step: inspect the project with the read tool, as a real worker would.
    tool_call={'index':0,'id':'call_read','type':'function','function':{'name':'read','arguments':json.dumps({'filePath':str(PROJECT/'answer.js')})}}
   else:
    state['drafts']+=1
    tool_output=json.dumps([m for m in msgs if m.get('role')=='tool'])
    if state['scenario']=='files' and 'export const answer = 0' not in tool_output: state['errors'].append('read tool did not return the file: '+tool_output[-500:])
    revision=state['drafts']>1
    if revision and not any('JEV feedback on the last attempt' in json.dumps(m) for m in msgs): state['errors'].append('missing feedback')
    draft={'answer':'SELECTED_FINAL: Updated answer.js.' if revision else 'PRIVATE_DRAFT_BAD', 'files':[{'path':'answer.js','edits':[{'search':'answer = 0','replace':f'answer = {2 if revision else 1}'}]}]}
    if state['scenario']=='chat':
     draft['files']=[]
     draft['answer']='SELECTED_FINAL:\n```js\nfunction answer() { return 2; }\n```' if revision else 'PRIVATE_DRAFT_BAD: function answer() { return 1; }'
    content=json.dumps(draft)
  elif final:
   state['presentations']+=1
   if 'PRIVATE_DRAFT_BAD' in json.dumps(msgs) or 'SELECTED_FINAL' in json.dumps(msgs): state['errors'].append('result sent to presenter model')
   if tool_names: state['errors'].append('presenter unexpectedly has tools: '+str(tool_names))
   # The plugin replaces this acknowledgement with the selected result verbatim.
   content='Done'
  delta,finish=({'role':'assistant','tool_calls':[tool_call]},'tool_calls') if tool_call else ({'role':'assistant','content':content},'stop')
  try:
   self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.end_headers()
  except (BrokenPipeError,ConnectionResetError): return
  for d,reason in [(delta,None),({},finish)]:
   item={'id':'chatcmpl-mock','object':'chat.completion.chunk','created':1,'model':'mock','choices':[{'index':0,'delta':d,'finish_reason':reason}]}
   try: self.wfile.write(('data: '+json.dumps(item)+'\n\n').encode())
   except (BrokenPipeError,ConnectionResetError): return
  try: self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
  except (BrokenPipeError,ConnectionResetError): pass
server=ThreadingHTTPServer(('127.0.0.1',0),Model)
threading.Thread(target=server.serve_forever,daemon=True).start()
config={'$schema':'https://opencode.ai/config.json','model':'mock/mock','small_model':'mock/mock','provider':{'mock':{'npm':'@ai-sdk/openai-compatible','name':'Local mock','options':{'baseURL':f'http://127.0.0.1:{server.server_port}/v1','apiKey':'mock'},'models':{'mock':{'name':'Local mock','limit':{'context':32000,'output':8192}}}}},'permission':{'edit':'allow','bash':'deny'},'autoupdate':False}
(PROJECT/'opencode.json').write_text(json.dumps(config))
env=os.environ.copy()
for kind in ['DATA','CONFIG','CACHE','STATE']: env['XDG_'+kind+'_HOME']=str(ROOT/kind.lower())
env.update(OPENCODE_DISABLE_DEFAULT_PLUGINS='true',OPENCODE_DISABLE_MODELS_FETCH='true',OPENCODE_DISABLE_AUTOUPDATE='true')
with socket.socket() as sock: sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
log=open(ROOT/'server.log','w')
p=subprocess.Popen(['opencode','serve','--port',str(port),'--print-logs'],cwd=PROJECT,env=env,stdout=log,stderr=log)
base=f'http://127.0.0.1:{port}'
def api(route,body=None,timeout=15):
 req=Request(base+route,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'})
 with urlopen(req,timeout=timeout) as r:
  data=r.read()
  return json.loads(data) if data else None
try:
 for i in range(100):
  try: api('/global/health',timeout=1);break
  except Exception: time.sleep(.2)
 else: raise RuntimeError('server did not start')
 session=api('/session',{'title':'JEV local smoke'},timeout=45)
 sid=session['id']
 api('/session/'+sid+'/prompt_async',{'model':{'providerID':'mock','modelID':'mock'},'parts':[{'type':'text','text':'Write answer.js exporting answer = 2.'}]})
 deadline=time.monotonic()+50
 while time.monotonic()<deadline:
  reports=sorted((PROJECT/'.opencode/jev').glob('runs/*/*.json'))
  if state['presentations']:
   assert not state['errors'],state['errors']
   assert len(reports)==2,len(reports)
   records=[json.loads(f.read_text()) for f in reports]
   assert records[-1]['report']['decision']=='rubric_satisfied',records[-1]['report']['decision']
   assert 'answer = 2' in (PROJECT/'answer.js').read_text()
   messages=api('/session/'+sid+'/message')
   final_text='\n'.join(part.get('text','') for m in messages if m['info']['role']=='assistant' for part in m['parts'] if part['type']=='text')
   if 'SELECTED_FINAL' not in final_text: time.sleep(.1);continue
   assert 'JEV harness failed' not in final_text,final_text
   assert final_text.startswith('SELECTED_FINAL: Updated answer.js.') and '**Changed files:** answer.js' in final_text and 'Done' not in final_text,final_text
   assert 'PRIVATE_DRAFT_BAD' not in json.dumps(messages),'private draft leaked into main chat'
   assert len([m for m in messages if m['info']['role']=='user'])==1,'feedback added to main chat'
   assert state['drafts']==2 and state['checklists']==1,state
   assert records[0]['checks']==['answer.js exports answer equal to 2'],records[0].get('checks')
   private=api('/session/'+records[0]['childID']+'/message')
   assert 'PRIVATE_DRAFT_BAD' in json.dumps(private),'draft missing from private worker'
   assert records[1]['model']=={'providerID':'mock','modelID':'mock'},records[1]['model']
   assert records[1]['bestRound']==2,records[1]['bestRound']
   break
  time.sleep(.25)
 else:
  print('state:',state)
  try: print('messages:',json.dumps(api('/session/'+sid+'/message'))[-7000:])
  except Exception as e: print(type(e).__name__,str(e))
  raise RuntimeError('automatic refinement did not finish')
 # A normal second session can ask for a snippet without any file changes.
 state.update(scenario='chat',drafts=0,presentations=0)
 (PROJECT/'answer.js').write_text('export const answer = 0;\n')
 chat=api('/session',{'title':'JEV chat-only smoke'})['id']
 api('/session/'+chat+'/prompt_async',{'model':{'providerID':'mock','modelID':'mock'},'parts':[{'type':'text','text':'Return a JavaScript function named answer that returns 2, as a code block. Do not change any files.'}]})
 deadline=time.monotonic()+30
 while time.monotonic()<deadline:
  messages=api('/session/'+chat+'/message')
  final_text='\n'.join(part.get('text','') for m in messages if m['info']['role']=='assistant' for part in m['parts'] if part['type']=='text')
  if 'SELECTED_FINAL' in final_text or 'JEV harness failed' in final_text: break
  time.sleep(.1)
 else: raise RuntimeError('chat-only refinement did not finish')
 assert 'JEV harness failed' not in final_text,final_text
 assert not state['errors'],state['errors']
 assert state['drafts']==2,state
 assert 'function answer() { return 2; }' in final_text,final_text
 assert 'PRIVATE_DRAFT_BAD' not in json.dumps(messages),'chat draft leaked'
 assert (PROJECT/'answer.js').read_text()=='export const answer = 0;\n','chat-only task edited files'
 # A conversation question gets one direct answer: no drafts, no grading, no file changes.
 state.update(scenario='conversation',drafts=0,presentations=0)
 runs_before=len(list((PROJECT/'.opencode/jev').glob('runs/*/*.json')))
 talk=api('/session',{'title':'JEV conversation smoke'})['id']
 api('/session/'+talk+'/prompt_async',{'model':{'providerID':'mock','modelID':'mock'},'parts':[{'type':'text','text':'Explain why evaluator-optimizer loops help.'}]})
 deadline=time.monotonic()+30
 while time.monotonic()<deadline:
  messages=api('/session/'+talk+'/message')
  final_text='\n'.join(part.get('text','') for m in messages if m['info']['role']=='assistant' for part in m['parts'] if part['type']=='text')
  if 'CHAT_ANSWER' in final_text or 'JEV harness failed' in final_text: break
  time.sleep(.1)
 else: raise RuntimeError('conversation answer did not finish')
 assert not state['errors'],state['errors']
 assert final_text=='CHAT_ANSWER: loops let a judge catch mistakes before you see them.',final_text
 assert state['drafts']==0 and state['direct']==1,state
 assert len(list((PROJECT/'.opencode/jev').glob('runs/*/*.json')))==runs_before,'conversation was graded'
 assert (PROJECT/'answer.js').read_text()=='export const answer = 0;\n','conversation edited files'
 # Abort the visible turn while the private provider request is still blocked.
 state.update(scenario='cancel',drafts=0,presentations=0)
 cancelled=api('/session',{'title':'JEV cancellation smoke'})['id']
 api('/session/'+cancelled+'/prompt_async',{'model':{'providerID':'mock','modelID':'mock'},'parts':[{'type':'text','text':'Write answer.js exporting answer = 2.'}]})
 assert worker_started.wait(10),'private worker never started'
 children=api('/session/'+cancelled+'/children')
 assert len(children)==1,children
 api('/session/'+cancelled+'/abort',{})
 deadline=time.monotonic()+10
 while time.monotonic()<deadline:
  private=api('/session/'+children[0]['id']+'/message')
  if any(m['info'].get('error',{}).get('name')=='MessageAbortedError' for m in private): break
  time.sleep(.1)
 else: raise RuntimeError('parent cancellation did not abort the private worker')
 release_worker.set()
 assert state['presentations']==0,'cancelled draft was presented'
 assert (PROJECT/'answer.js').read_text()=='export const answer = 0;\n','cancelled draft was applied'
 assert len(list((PROJECT/'.opencode/jev').glob('runs/*/*.json')))==4,'cancelled draft was evaluated'
 print(json.dumps({'success':True,'opencode':subprocess.check_output(['opencode','--version'],text=True).strip(),'scenarios':['read-only tool use','search/replace edits','verbatim result','chat-only code','conversation routing','parent cancellation'],'evaluatedDrafts':4,'privateSessionsReadable':True,'artifacts':str(ROOT)}))
finally:
 release_worker.set()
 p.terminate()
 try:p.wait(timeout=5)
 except subprocess.TimeoutExpired:p.kill();p.wait()
 log.close();server.shutdown()
 print('smoke artifacts:',ROOT)
 if state['errors']: print('errors:',state['errors'])
