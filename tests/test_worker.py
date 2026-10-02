import base64
import hashlib
import hmac
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from worker import main as worker


class WorkerTests(unittest.TestCase):
    def test_normalizes_allowed_youtube_urls(self):
        self.assertEqual(
            worker.normalize_youtube_url('https://youtu.be/ABCDEFGHI01?si=x'),
            'https://www.youtube.com/watch?v=ABCDEFGHI01',
        )
        self.assertEqual(
            worker.normalize_youtube_url('https://www.youtube.com/shorts/ABC_def-901'),
            'https://www.youtube.com/watch?v=ABC_def-901',
        )

    def test_rejects_non_https_credentials_and_other_hosts(self):
        for url in [
            'http://www.youtube.com/watch?v=ABCDEFGHI01',
            'https://user:pass@www.youtube.com/watch?v=ABCDEFGHI01',
            'https://youtube.com.evil.test/watch?v=ABCDEFGHI01',
            'https://www.youtube.com/playlist?list=PL123',
        ]:
            with self.subTest(url=url):
                with self.assertRaises(worker.JobError):
                    worker.normalize_youtube_url(url)

    def test_envelope_matches_standard_hmac_and_tamper_changes_signature(self):
        secret = 'a' * 64
        payload = {'ts': 10, 'job_id': '00000000-0000-0000-0000-000000000001', 'run_id': '1.1', 'action': 'claim', 'data': {}}
        wrapped = json.loads(worker.envelope(secret, payload))
        expected = hmac.new(secret.encode(), wrapped['payload'].encode(), hashlib.sha256).hexdigest()
        self.assertEqual(wrapped['signature'], expected)
        self.assertNotEqual(wrapped['signature'], hmac.new(secret.encode(), (wrapped['payload'] + ' ').encode(), hashlib.sha256).hexdigest())

    def test_bridge_rejects_callback_url_shape_and_loose_uuid(self):
        for args in [
            ('https://script.google.com/macros/s/ABC/exec?x=1', 'a' * 64, '00000000-0000-0000-0000-000000000001', '1.1'),
            ('https://evil.test/macros/s/ABC/exec', 'a' * 64, '00000000-0000-0000-0000-000000000001', '1.1'),
            ('https://script.google.com/macros/s/ABC/exec', 'short', '00000000-0000-0000-0000-000000000001', '1.1'),
            ('https://script.google.com/macros/s/ABC/exec', 'a' * 64, 'zzzzzzzz-0000-0000-0000-000000000001', '1.1'),
        ]:
            with self.subTest(args=args):
                with self.assertRaises(worker.JobError):
                    worker.Bridge(*args)

    def test_upload_retries_at_authoritative_offset_and_checks_completion(self):
        data = b'a' * 262144 + b'b' * 10
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'media.mp4'
            path.write_bytes(data)
            checksum = hashlib.md5(data).hexdigest()
            calls = []
            class FakeBridge:
                def call(self, action, payload=None):
                    calls.append((action, payload))
                    if action == 'init':
                        assert payload['md5'] == checksum
                        return {'done': False, 'offset': 0, 'chunk_size': 262144}
                    if action == 'chunk' and payload['offset'] == 0:
                        return {'done': False, 'offset': 262144, 'chunk_size': 262144}
                    if action == 'chunk' and payload['offset'] == 262144:
                        assert base64.b64decode(payload['content']) == b'b' * 10
                        return {'done': True, 'offset': len(data), 'chunk_size': 262144}
                    raise AssertionError(payload)
            result = worker.upload(FakeBridge(), path, 'media.mp4', 'video/mp4')
        self.assertTrue(result['done'])
        self.assertEqual([c[0] for c in calls], ['init', 'chunk', 'chunk'])


if __name__ == '__main__':
    unittest.main()
