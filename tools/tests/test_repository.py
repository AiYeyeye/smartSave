"""Regression checks for accidentally staging private material."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('repository_check', Path(__file__).resolve().parents[1] / 'check-repository.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class PublicationBoundaryTest(unittest.TestCase):
    def test_rejects_private_material_even_if_force_added_or_renamed(self):
        for path in ['.local/private/design.md', '.trellis/tasks/prd.md', '.agents/skills/x.md',
                     'docs/research/notes.md', 'docs/reference/design.docx', 'extension/debug.log',
                     'extension/release-candidate.json', 'extension/.env.production',
                     'extension/node_modules/package/index.js', 'misc-notes.md']:
            with self.subTest(path=path):
                self.assertTrue(checker.path_errors(path))

    def test_accepts_public_source_and_synthetic_fixtures(self):
        for path in ['AGENTS.zh-CN.md', 'docs/reference/export-json-v1.md',
                     'extension/tests/fixtures/export-v1-compatibility.json',
                     'extension/.env.example', 'docs/media/screenshots/01-bookmarks.png']:
            with self.subTest(path=path):
                self.assertEqual(checker.path_errors(path), [])

    def test_credential_findings_never_return_secret_text(self):
        token = b'sk-' + b'X' * 40
        findings = checker.content_errors(b'apiKey = "' + token + b'"')
        self.assertEqual(findings, ['provider token'])
        self.assertNotIn(token.decode(), str(findings))
        self.assertEqual(checker.content_errors(b'apiKey = process.env.TEST_KEY'), [])


if __name__ == '__main__':
    unittest.main()
