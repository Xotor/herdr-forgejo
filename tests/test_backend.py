import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('backend', Path(__file__).parent.parent / 'mods/forgejo-issues/backend.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)


class Tests(unittest.TestCase):
    def test_remotes(self):
        self.assertEqual(b.remote_parts('git@forge.example:owner/repo.git'), ('forge.example', 'https://forge.example', 'owner/repo'))
        self.assertEqual(b.remote_parts('https://forge.example/owner/repo.git')[2], 'owner/repo')

    def test_worktree_uses_base_credentials(self):
        with tempfile.TemporaryDirectory() as d:
            base = Path(d) / 'base'
            base.mkdir()
            def git(*args):
                subprocess.run(['git', '-C', str(base), *args], check=True, capture_output=True)
            git('init')
            git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'init')
            git('remote', 'add', 'origin', 'git@forge.example:owner/repo.git')
            (base / '.env').write_text('FORGEJO_TOKEN="fake-token"\n')
            work = Path(d) / 'worktree'
            git('worktree', 'add', '-b', 'fix/123-login', str(work))
            ctx, token = b.context(work)
            self.assertEqual(token, 'fake-token')
            self.assertEqual(ctx['branch'], 'fix/123-login')
            self.assertEqual(ctx['key'], b.context(base)[0]['key'])
            self.assertNotIn('token', str(ctx))

    def test_public_host_mismatch(self):
        with patch.object(b, 'git', side_effect=['/base', '/base/.git', 'https://github.com/owner/repo.git']), patch.object(b, 'dotenv', return_value={'FORGEJO_TOKEN': 'secret', 'FORGEJO_URL': 'https://forge.example'}):
            with self.assertRaisesRegex(ValueError, 'not your Forgejo'):
                b.context('/base')

    def test_pagination_and_pr_exclusion(self):
        rows = [{'number': 1, 'title': 'Issue', 'labels': [], 'assignees': None}, {'number': 2, 'pull_request': { 'url': 'pr' }}]
        with patch.object(b, 'request', side_effect=[(rows, {'Link': '<next>; rel="next"'}), ([], {})]) as req:
            result = b.issues({'base': 'https://forge.example', 'repo': 'owner/repo'}, 'secret')
            self.assertEqual(len(result['issues']), 1)
            self.assertEqual(req.call_count, 2)


if __name__ == '__main__':
    unittest.main()
