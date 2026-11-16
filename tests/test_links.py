import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

s = importlib.util.spec_from_file_location('backend', Path(__file__).parent.parent / 'mods/forgejo-issues/backend.py')
b = importlib.util.module_from_spec(s); s.loader.exec_module(b)

class LinkTests(unittest.TestCase):
    def test_normalization_and_partial_actions_failure(self):
        def fetch(ctx, token, suffix, *args):
            if suffix == 'issues':
                return [{'number': 1, 'title': 'One'}, {'number': 2, 'title': 'Two'}], False
            if suffix == 'pulls':
                return [{'number': 9, 'title': 'Fix', 'body': 'Closes demo/repo#1; other/repo#2', 'state': 'open', 'head': {'sha': 'abc'}}], False
            if suffix == 'actions/runs':
                raise ValueError('Forgejo returned HTTP 403.')
            return [], False
        with patch.object(b, 'collection', side_effect=fetch):
            result = b.board({'base': 'https://example.invalid', 'repo': 'demo/repo'}, 'fake-token')
        self.assertEqual(len(result['prs']), 1)
        self.assertEqual(result['issues'][1]['links'], [])
        self.assertEqual(result['prs'][0]['links'][0]['number'], 1)
        self.assertTrue(result['warnings'][0].startswith('actions:'))

    def test_exact_sha_and_bidirectional_issue_reference(self):
        issues = [{'number': 1}, {'number': 2}]
        prs = [{'number': 9, '_issue_refs': [1], '_shas': ['abc']}]
        runs = [{'number': 20, 'sha': 'abc', '_pr_numbers': []}, {'number': 21, 'sha': 'other', '_pr_numbers': []}]
        b.link_graph(issues, prs, runs)
        self.assertTrue(any(l['kind'] == 'prs' and l['number'] == 9 for l in issues[0]['links']))
        self.assertTrue(any(l['kind'] == 'actions' and l['number'] == 20 for l in issues[0]['links']))
        self.assertEqual(issues[1]['links'], [])
        self.assertEqual(runs[1]['links'], [])

    def test_api_pr_reference_without_sha(self):
        prs = [{'number': 9, '_issue_refs': [], '_shas': []}]
        runs = [{'number': 20, 'sha': '', '_pr_numbers': [9]}]
        b.link_graph([], prs, runs)
        self.assertEqual(runs[0]['links'][0]['reason'], 'API PR reference')

    def test_unknown_reference_is_not_fabricated(self):
        prs = [{'number': 9, '_issue_refs': [999], '_shas': []}]
        b.link_graph([], prs, [])
        self.assertEqual(prs[0]['links'], [])
