"""Run with python load/vps-controller.test.py; no cluster access required."""
import pathlib
import unittest
from unittest.mock import Mock


def controller():
    source = pathlib.Path(__file__).with_name('vps-controller.py').read_text()
    # fcntl is Linux-only; the entry point and release lock run only on the VPS.
    source = source.replace('import fcntl\n', '')
    namespace = {}
    exec(source.split("lock = open('/tmp/hookrelay-release.lock'")[0], namespace)
    return namespace


class ControllerTests(unittest.TestCase):
    def test_relay_settings_restore_together_before_other_workloads(self):
        context = controller()
        settings = {'RELAY_BATCH_SIZE': None, 'RELAY_PUBLISH_INTERVAL_SECONDS': None}
        context['stop_observer'] = Mock()
        context['get'] = Mock(return_value={'spec': {'template': {'spec': {'containers': [{'env': [{'name': 'RELAY_BATCH_SIZE', 'value': '100'}, {'name': 'RELAY_PUBLISH_INTERVAL_SECONDS', 'value': '1'}]}]}}}})
        context['patch_environment'] = Mock()
        context['patch'] = Mock()
        context['database_query'] = Mock(return_value=[{'pending': 1}])
        context['restore']({'relay': settings, 'concurrency': None, 'replicas': 1, 'target': None})
        context['patch_environment'].assert_called_once_with('relay', settings)

    def test_patch_preserves_container_and_removes_only_selected_environment(self):
        context = controller()
        container = {'name': 'worker', 'image': 'pinned-image',
                     'resources': {'limits': {'memory': '256Mi'}},
                     'readinessProbe': {'httpGet': {'path': '/health', 'port': 9465}},
                     'envFrom': [{'configMapRef': {'name': 'configuration'}}],
                     'env': [{'name': 'OTHER', 'value': 'keep'},
                             {'name': 'WORKER_CONCURRENCY', 'value': '4'}]}
        context['get'] = Mock(return_value={'spec': {'template': {'spec': {'containers': [container]}}}})
        context['kube'] = Mock()
        context['patch']('worker', 'WORKER_CONCURRENCY', None, 1)
        payload = context['json'].loads(context['kube'].call_args_list[0].args[-1])
        patched = payload['spec']['template']['spec']['containers'][0]
        self.assertEqual(patched['image'], 'pinned-image')
        self.assertEqual(patched['resources'], container['resources'])
        self.assertEqual(patched['readinessProbe'], container['readinessProbe'])
        self.assertEqual(patched['envFrom'], container['envFrom'])
        self.assertEqual(patched['env'], [{'name': 'OTHER', 'value': 'keep'}])
        self.assertEqual(payload['spec']['replicas'], 1)

    def test_pending_delivery_retains_receiver(self):
        context = controller()
        context['stop_observer'] = Mock()
        context['patch'] = Mock()
        context['database_query'] = Mock(return_value=[{'pending': 2}])
        context['kube'] = Mock()
        result = context['restore']({'concurrency': None, 'replicas': 1, 'target': {'name': 'WEBHOOK_TARGET_URL', 'value': 'original'}})
        self.assertTrue(result['fixtureRetained'])
        self.assertEqual(context['patch'].call_count, 2)
        context['kube'].assert_not_called()

    def test_cleanup_refuses_foreign_session(self):
        context = controller()
        context['session'] = 'this-session'
        context['stop_observer'] = Mock()
        context['patch'] = Mock()
        context['database_query'] = Mock(return_value=[{'pending': 0}])
        context['kube'] = Mock(return_value='deployment/receiver')
        context['get'] = Mock(return_value={'metadata': {'labels': {'hookrelay-benchmark-session': 'another-session'}}})
        with self.assertRaisesRegex(RuntimeError, 'another benchmark'):
            context['restore']({'concurrency': None, 'replicas': 1, 'target': None})
        self.assertFalse(any(call.args[0] == 'delete' for call in context['kube'].call_args_list))


if __name__ == '__main__':
    unittest.main()
