"""Private stdio RPC over SSH. K3s operations stay on the VPS; no secrets leave it."""
import base64
import fcntl
import json
import os
import pathlib
import re
import subprocess
import sys
import threading
import time

KUBE = ['sudo', '-n', 'k3s', 'kubectl', '-n', 'hookrelay']
send_lock = threading.Lock()
original = None
session = None
observer = None
observer_thread = None
resource_stop = threading.Event()
proxy_name = 'hookrelay-benchmark-receiver'


def run(args, text=None, timeout=190):
    result = subprocess.run(args, input=text, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        # Raw errors may include connection details; only emit the operation name.
        raise RuntimeError('Remote operation failed: ' + ' '.join(args[:6]))
    return result.stdout.strip()


def kube(*args, text=None):
    return run(KUBE + list(args), text=text)


def get(kind, name=None):
    args = ['get', kind] + ([name] if name else []) + ['-o', 'json']
    return json.loads(kube(*args))


def database_query(sql):
    source = '''import pg from 'pg';
const p = new pg.Pool({host:process.env.DB_HOST,port:Number(process.env.DB_PORT),
user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,
connectionTimeoutMillis:3000,query_timeout:5000});
try { console.log(JSON.stringify((await p.query(process.argv[1])).rows)); }
finally { await p.end(); }'''
    return json.loads(kube('exec', 'deployment/relay', '--', 'node', '--input-type=module', '-e', source, sql))


def emit(value):
    with send_lock:
        print(json.dumps(value, separators=(',', ':')), flush=True)


def deployment_env(deployment, key):
    return next((entry for entry in deployment['spec']['template']['spec']['containers'][0].get('env', []) if entry['name'] == key), None)


def patch(deployment, key, entry, replicas=None):
    data = get('deployment', deployment)
    container = data['spec']['template']['spec']['containers'][0]
    environment = [e for e in container.get('env', []) if e['name'] != key]
    if entry is not None:
        environment.append(entry)
    container['env'] = environment
    spec = {'template': {'spec': {'containers': [container]}}}
    if replicas is not None:
        spec['replicas'] = replicas
    # JSON merge replaces env as a whole, preserving every unrelated entry.
    kube('patch', 'deployment', deployment, '--type=merge', '-p', json.dumps({'spec': spec}))
    kube('rollout', 'status', 'deployment/' + deployment, '--timeout=180s')


def stop_observer():
    global observer, observer_thread
    if observer:
        process = observer
        observer = None
        process.stdin.close()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
    if observer_thread:
        observer_thread.join(timeout=10)
        observer_thread = None


def snapshot():
    deployments = {name: get('deployment', name) for name in ['hookrelay', 'worker', 'relay', 'test-receiver']}
    if any(len(data['spec']['template']['spec']['containers']) != 1 for data in deployments.values()):
        raise RuntimeError('This benchmark expects one container per application Pod')
    images = {name: data['spec']['template']['spec']['containers'][0]['image'] for name, data in deployments.items()}
    limits = {name: data['spec']['template']['spec']['containers'][0].get('resources', {}) for name, data in deployments.items()}
    infrastructure = {name: get('statefulset', name)['spec']['template']['spec']['containers'][0].get('resources', {}) for name in ['postgres', 'redis']}
    restore = {
        'replicas': deployments['worker']['spec']['replicas'],
        'concurrency': deployment_env(deployments['worker'], 'WORKER_CONCURRENCY'),
        'target': deployment_env(deployments['hookrelay'], 'WEBHOOK_TARGET_URL'),
    }
    cpu_model = next((line.split(':', 1)[1].strip() for line in pathlib.Path('/proc/cpuinfo').read_text().splitlines() if line.startswith('model name')), 'unknown')
    memory = int(next(line.split()[1] for line in pathlib.Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemTotal:'))) * 1024
    return {'images': images, 'resources': limits, 'infrastructureResources': infrastructure, 'restore': restore,
            'hardware': {'cpuModel': cpu_model, 'logicalCpus': os.cpu_count(), 'memoryBytes': memory},
            'version': json.loads(kube('version', '-o', 'json'))['serverVersion']['gitVersion']}


def install_proxy(image, source):
    for kind in ['deployment', 'service', 'configmap']:
        if kube('get', kind, proxy_name, '--ignore-not-found', '-o', 'name'):
            raise RuntimeError('Benchmark receiver already exists; restore the previous session first')
    labels = {'app': proxy_name, 'hookrelay-benchmark-session': session}
    objects = [
        {'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': proxy_name, 'namespace': 'hookrelay', 'labels': labels},
         'data': {'receiver-proxy.mjs': source}},
        {'apiVersion': 'apps/v1', 'kind': 'Deployment', 'metadata': {'name': proxy_name, 'namespace': 'hookrelay', 'labels': labels},
         'spec': {'replicas': 1, 'selector': {'matchLabels': {'app': proxy_name}}, 'template': {'metadata': {'labels': labels}, 'spec': {
             'imagePullSecrets': [{'name': 'ghcr-credentials'}],
             'containers': [{'name': 'receiver-proxy', 'image': image, 'command': ['node', '/bench/receiver-proxy.mjs'],
                 'ports': [{'containerPort': 3002}], 'volumeMounts': [{'name': 'source', 'mountPath': '/bench', 'readOnly': True}],
                 'resources': {'requests': {'cpu': '50m', 'memory': '32Mi'}, 'limits': {'memory': '128Mi'}},
                 'readinessProbe': {'httpGet': {'path': '/health', 'port': 3002}, 'periodSeconds': 2},
                 'livenessProbe': {'httpGet': {'path': '/health', 'port': 3002}, 'periodSeconds': 5}}],
             'volumes': [{'name': 'source', 'configMap': {'name': proxy_name}}]}}}},
        {'apiVersion': 'v1', 'kind': 'Service', 'metadata': {'name': proxy_name, 'namespace': 'hookrelay', 'labels': labels},
         'spec': {'type': 'ClusterIP', 'selector': {'app': proxy_name}, 'ports': [{'port': 3002, 'targetPort': 3002}]}},
    ]
    for item in objects:
        kube('create', '-f', '-', text=json.dumps(item))
    kube('rollout', 'status', 'deployment/' + proxy_name, '--timeout=180s')
    patch('hookrelay', 'WEBHOOK_TARGET_URL', {'name': 'WEBHOOK_TARGET_URL', 'value': 'http://' + proxy_name + ':3002/webhooks'})


def resource_samples():
    while not resource_stop.wait(5):
        try:
            lines = kube('top', 'pods', '--no-headers').splitlines()
            # Only Pod names and resource units; never node names, addresses, or credentials.
            values = [{'pod': parts[0], 'cpu': parts[1], 'memory': parts[2]} for line in lines if len(parts := line.split()) >= 3]
            emit({'kind': 'resources', 'pods': values})
        except Exception:
            emit({'kind': 'resources', 'error': 'K3s metrics unavailable'})


def start_observer(type_name, source):
    global observer, observer_thread
    stop_observer()
    endpoints = [{'name': 'relay', 'url': 'http://127.0.0.1:9466/metrics'}]
    pods = json.loads(kube('get', 'pods', '-l', 'app in (hookrelay,worker)', '-o', 'json'))['items']
    for pod in pods:
        if pod['metadata'].get('deletionTimestamp') or not pod['status'].get('podIP'):
            continue
        service = pod['metadata']['labels']['app']
        endpoints.append({'name': service + '/' + pod['metadata']['name'],
                          'url': 'http://' + pod['status']['podIP'] + ':' + ('9464' if service == 'hookrelay' else '9465') + '/metrics'})
    configuration = base64.b64encode(json.dumps({'type': type_name, 'endpoints': endpoints}).encode()).decode()
    observer = subprocess.Popen(KUBE + ['exec', '-i', 'deployment/relay', '--', 'env', 'BENCH_OBSERVER=' + configuration,
                                      'node', '--input-type=module', '-e', source], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    process = observer

    def forward():
        for line in process.stdout:
            try:
                message = json.loads(line)
                message['type'] = type_name
                emit(message)
            except Exception:
                emit({'kind': 'observerError', 'type': type_name, 'error': 'Invalid observer output'})
        if observer is process:
            emit({'kind': 'observerError', 'type': type_name, 'error': 'Observer exited'})

    observer_thread = threading.Thread(target=forward, daemon=True)
    observer_thread.start()


def restore(state):
    stop_observer()
    patch('worker', 'WORKER_CONCURRENCY', state['concurrency'], state['replicas'])
    patch('hookrelay', 'WEBHOOK_TARGET_URL', state['target'])
    pending = database_query("SELECT count(*)::int AS pending FROM events WHERE status='pending' AND target_url='http://hookrelay-benchmark-receiver:3002/webhooks'")[0]['pending']
    if pending:
        return {'restored': True, 'fixtureRetained': True, 'pending': pending}
    for kind in ['deployment', 'service', 'configmap']:
        name = kube('get', kind, proxy_name, '--ignore-not-found', '-o', 'name')
        if name:
            item = get(kind, proxy_name)
            if item['metadata'].get('labels', {}).get('hookrelay-benchmark-session') != session:
                raise RuntimeError('Refusing to remove resources owned by another benchmark')
            kube('delete', kind, proxy_name, '--wait=true', '--timeout=60s')
    return {'restored': True, 'fixtureRetained': False}


def dispatch(message):
    global original, session
    action = message['action']
    if action == 'inspect':
        return snapshot()
    if action == 'setup':
        session = message['session']
        if not re.fullmatch(r'[a-f0-9-]{36}', session):
            raise ValueError('Invalid session')
        state = snapshot()
        image = state['images']['hookrelay']
        expected_commit = message['commit']
        if not re.fullmatch(r'[a-f0-9]{40}', expected_commit) or ':sha-' + expected_commit + '@sha256:' not in image:
            raise RuntimeError('Deploy the selected commit with a pinned digest before benchmarking')
        if any(candidate != image for candidate in state['images'].values()):
            raise RuntimeError('Application images disagree')
        if database_query("SELECT count(*)::int AS pending FROM events WHERE status='pending'")[0]['pending']:
            raise RuntimeError('Drain existing work before benchmarking')
        original = state['restore']
        install_proxy(image, message['proxy'])
        threading.Thread(target=resource_samples, daemon=True).start()
        return state
    if action == 'configure':
        replicas, concurrency = message['replicas'], message['concurrency']
        if not isinstance(replicas, int) or not 0 <= replicas <= 4 or not isinstance(concurrency, int) or not 1 <= concurrency <= 100:
            raise ValueError('Invalid worker configuration')
        stop_observer()
        patch('worker', 'WORKER_CONCURRENCY', {'name': 'WORKER_CONCURRENCY', 'value': str(concurrency)}, replicas)
        return {'configured': True}
    if action == 'observe':
        if not re.fullmatch(r'benchmark\.[a-f0-9-]{36}', message['type']):
            raise ValueError('Invalid event type')
        start_observer(message['type'], message['source'])
        return {'observing': True}
    if action == 'restore':
        resource_stop.set()
        result = restore(original)
        original = None
        return result
    raise ValueError('Unknown action')


lock = open('/tmp/hookrelay-release.lock', 'a')
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    emit({'kind': 'ready'})
    for line in sys.stdin:
        request = json.loads(line)
        try:
            emit({'id': request['id'], 'result': dispatch(request)})
        except Exception as error:
            emit({'id': request['id'], 'error': str(error)})
finally:
    resource_stop.set()
    stop_observer()
    if original is not None:
        try:
            restore(original)
            emit({'kind': 'restoredOnDisconnect'})
        except Exception:
            emit({'kind': 'restoreError', 'error': 'Restore failed; use saved state and the VPS guide'})
    lock.close()
