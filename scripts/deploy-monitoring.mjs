import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = new URL('../', import.meta.url);
const target = process.env.VPS_SSH_TARGET ?? 'hookrelay-vps';
assert.match(target ?? '', /^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*$/);
assert.ok(
  process.env.USERPROFILE ?? process.env.HOME,
  'A user home is required for the login file',
);
const manifest = await readFile(
  new URL('.tmp/monitoring/monitoring.yaml', root),
  'utf8',
);
assert.ok(
  !manifest.includes('CONFIGURATION_SHA256'),
  'Run prepare-monitoring.mjs first',
);
const maps = JSON.parse(
  await readFile(new URL('.tmp/monitoring/configmaps.json', root), 'utf8'),
);
const metadata = JSON.parse(
  await readFile(new URL('.tmp/monitoring/metadata.json', root), 'utf8'),
);
const payload = Buffer.from(
  JSON.stringify({ manifest, maps, metadata }),
).toString('base64');
const source = `import base64,fcntl,json,secrets,subprocess,time,urllib.request,urllib.parse
payload=json.loads(base64.b64decode('${payload}'))
ns='hookrelay-monitoring'
label='app.kubernetes.io/part-of'
k=['sudo','-n','k3s','kubectl']
def kube(*args,data=None,timeout=240):
 r=subprocess.run(k+list(args),input=data,text=True,capture_output=True,timeout=timeout)
 if r.returncode: raise RuntimeError('Kubernetes operation failed: '+args[0])
 return r.stdout.strip()
def obj(kind,name,namespace=ns):
 value=kube('-n',namespace,'get',kind,name,'--ignore-not-found','-o','json') if namespace else kube('get',kind,name,'--ignore-not-found','-o','json')
 return json.loads(value) if value else None
def owned(kind,name,namespace=ns):
 value=obj(kind,name,namespace)
 if value and value['metadata'].get('labels',{}).get(label)!=ns: raise RuntimeError('Refusing to replace an unowned monitoring resource')
 return value
def step(value): print(json.dumps({'kind':'progress','step':value}),flush=True)
lock=open('/tmp/hookrelay-release.lock','a')
fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
namespace=owned('namespace',ns,None)
if not namespace:
 kube('create','-f','-',data=json.dumps({'apiVersion':'v1','kind':'Namespace','metadata':{'name':ns,'labels':{label:ns}}}))
for kind,names in [('deployment',['prometheus','grafana']),('service',['prometheus','grafana']),('pvc',['prometheus-data','grafana-data']),('configmap',['hookrelay-prometheus','hookrelay-grafana-provisioning','hookrelay-grafana-dashboard']),('secret',['grafana-admin'])]:
 for name in names: owned(kind,name)
for name in ['hookrelay-api-metrics','hookrelay-worker-metrics','hookrelay-relay-metrics']: owned('service',name,'hookrelay')
step('Ownership checked; validating manifests')
kube('apply','--dry-run=server','-f','-',data=json.dumps(payload['maps']))
kube('apply','--dry-run=server','-f','-',data=payload['manifest'])
if not obj('secret','grafana-admin'):
 password=secrets.token_urlsafe(32)
 kube('create','-f','-',data=json.dumps({'apiVersion':'v1','kind':'Secret','metadata':{'name':'grafana-admin','namespace':ns,'labels':{label:ns}},'type':'Opaque','data':{'admin-password':base64.b64encode(password.encode()).decode()}}))
kube('apply','-f','-',data=json.dumps(payload['maps']))
kube('apply','-f','-',data=payload['manifest'])
step('Monitoring resources applied; waiting for readiness')
for name in ['prometheus','grafana']:
 kube('-n',ns,'rollout','status','deployment/'+name,'--timeout=240s',timeout=260)
 step(name+' ready')
prom=obj('service','prometheus')['spec']['clusterIP']
graf=obj('service','grafana')['spec']['clusterIP']
password=base64.b64decode(obj('secret','grafana-admin')['data']['admin-password']).decode()
auth=base64.b64encode(('admin:'+password).encode()).decode()
def request(address,path,authenticated=False):
 req=urllib.request.Request('http://'+address+path,headers={'Authorization':'Basic '+auth} if authenticated else {})
 with urllib.request.urlopen(req,timeout=10) as response: return json.load(response)
deadline=time.monotonic()+60
while True:
 targets=request(prom+':9090','/api/v1/targets')['data']['activeTargets']
 jobs={t['labels']['job'] for t in targets}
 if jobs=={'hookrelay-api','hookrelay-worker','hookrelay-relay'} and all(t['health']=='up' for t in targets): break
 if time.monotonic()>deadline: raise RuntimeError('Application scrape targets did not become healthy')
 time.sleep(2)
health=request(graf+':3000','/api/datasources/uid/hookrelay-prometheus/health',True)
assert health['status']=='OK'
dashboard=request(graf+':3000','/api/dashboards/uid/hookrelay-overview',True)['dashboard']
assert dashboard['uid']=='hookrelay-overview' and len(dashboard['panels'])>=11
pods=json.loads(kube('-n',ns,'get','pods','-o','json'))['items']
pod_health=[{'app':p['metadata']['labels']['app'],'ready':all(c['ready'] for c in p['status'].get('containerStatuses',[])),'restarts':sum(c['restartCount'] for c in p['status'].get('containerStatuses',[])),'imageIds':[c['imageID'] for c in p['status'].get('containerStatuses',[])]} for p in pods if not p['metadata'].get('deletionTimestamp')]
assert len(pod_health)==2 and all(p['ready'] for p in pod_health)
print(json.dumps({'kind':'result','namespace':ns,'configurationChecksum':payload['metadata']['checksum'],'targets':[{'job':t['labels']['job'],'health':t['health']} for t in targets],'datasourceHealthy':True,'dashboardUid':dashboard['uid'],'dashboardPanels':len(dashboard['panels']),'pods':pod_health}),flush=True)
print(json.dumps({'kind':'login','username':'admin','password':password}),flush=True)
lock.close()
`;
const child = spawn(
  process.env.SSH_EXECUTABLE ?? 'ssh',
  [
    '-o',
    'BatchMode=yes',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=15',
    ...(process.env.VPS_SSH_KEY ? ['-i', process.env.VPS_SSH_KEY] : []),
    target,
    'python3 -',
  ],
  { stdio: ['pipe', 'pipe', 'pipe'] },
);
let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk;
  // Print only complete progress lines; credentials never reach tool output.
  const lines = output.split('\n');
  output = lines.pop();
  for (const line of lines) {
    const message = JSON.parse(line);
    if (message.kind === 'progress') console.log(message.step);
    else if (message.kind === 'result') result = message;
    else if (message.kind === 'login') login = message;
  }
});
child.stderr.on('data', () => {});
let result, login;
child.stdin.end(source);
const code = await new Promise((done, reject) => {
  child.on('exit', done);
  child.on('error', reject);
});
assert.equal(
  code,
  0,
  'Monitoring deployment failed; inspect resource readiness on the VPS',
);
assert.ok(result && login);
const loginDirectory = resolve(
  process.env.USERPROFILE ?? process.env.HOME,
  'HookRelayMonitoring',
);
await mkdir(loginDirectory, { recursive: true, mode: 0o700 });
await writeFile(
  resolve(loginDirectory, 'grafana-login.txt'),
  `Grafana: http://localhost:18083/d/hookrelay-overview\nUsername: ${login.username}\nPassword: ${login.password}\n`,
  { mode: 0o600 },
);
await writeFile(
  new URL('.tmp/monitoring-deployment.json', root),
  JSON.stringify({ ...result, verifiedAt: new Date().toISOString() }, null, 2) +
    '\n',
);
console.log(
  'Monitoring ready. Login saved outside the repository in your home/HookRelayMonitoring/grafana-login.txt.',
);
