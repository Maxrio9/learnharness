"""Focused wheel boundary checks (run with python3 -I tests/experiment-environments.test.py)."""
import hashlib
import importlib.util
import json
import os
import pathlib
import stat
import struct
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'experiments'


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


environments = load('environments')
supervisor = load('supervisor')


class WheelBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.store = self.root / 'learnharness'
        self.store.mkdir(mode=0o700)
        original = environments.STORAGE_DESTINATIONS
        self.addCleanup(setattr, environments, 'STORAGE_DESTINATIONS', original)
        environments.STORAGE_DESTINATIONS = (self.root,)
        self.addCleanup(os.umask, os.umask(0o077))

    def wheel(self, project, entries):
        name = f'{project}-1.0-py3-none-any.whl'
        with zipfile.ZipFile(self.root / name, 'w', compression=zipfile.ZIP_DEFLATED) as out:
            out.writestr(f'{project}-1.0.dist-info/WHEEL', 'Wheel-Version: 1.0\nTag: py3-none-any\n')
            for path, payload in entries:
                out.writestr(path, payload)
        return name

    def install(self, names, bound=1, specs=None):
        definition = {'name': 'fixture', 'wheels': names, 'maxInstalledMiB': bound}
        paths = {name: self.root / name for name in names}
        return environments.install_environment(self.store, definition, 'a' * 64, paths, supervisor.private_dir, specs)

    def assert_unpublished(self):
        self.assertEqual(list((self.store / 'environments').iterdir()), [])

    def test_path_and_special_files_are_rejected(self):
        link = zipfile.ZipInfo('fixture/link')
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        for name, payload in [('../escaped', b'bad'), (link, b'/etc/passwd')]:
            with self.subTest(name=name):
                wheel = self.wheel('unsafe', [(name, payload)])
                with self.assertRaisesRegex(ValueError, 'Unsafe path|link or special'):
                    self.install([wheel])
                self.assert_unpublished()
                self.assertFalse((self.root / 'escaped').exists())

    def test_expanded_size_and_conflicts_are_rejected_without_publishing(self):
        giant = self.wheel('giant', [('giant.bin', bytes(2 * 1024**2))])
        with self.assertRaisesRegex(ValueError, 'installed size bound'):
            self.install([giant])
        self.assert_unpublished()
        first = self.wheel('first', [('overlap.py', b'value=1')])
        second = self.wheel('second', [('overlap.py', b'value=2')])
        with self.assertRaisesRegex(ValueError, 'Conflicting wheel file'):
            self.install([first, second])
        self.assert_unpublished()

    def test_archive_directory_limits_are_checked_before_opening(self):
        with patch.object(zipfile, 'ZIP64_LIMIT', 0):
            wheel = self.wheel('zip64', [('fixture.py', b'value=1')])
        self.assertEqual(supervisor.bound_central_directory(self.root / wheel, 2), 2)
        with self.assertRaisesRegex(ValueError, 'central directory exceeds bounds'):
            supervisor.bound_central_directory(self.root / wheel, 1)
        wheel = self.wheel('forged', [('fixture.py', b'value=1')])
        path = self.root / wheel
        data = bytearray(path.read_bytes())
        end = data.rfind(b'PK\x05\x06')
        struct.pack_into('<2H', data, end + 8, 1, 1)
        path.write_bytes(data)
        with self.assertRaisesRegex(ValueError, 'entry count mismatch'):
            supervisor.bound_central_directory(path, 10)

    def test_build_helper_omission_requires_exact_digest(self):
        wheel = self.wheel('fixture', [('build_backend.py', b'publisher stray file'), ('keep.py', b'value=1')])
        specs = {wheel: {'omitBuildBackendSha256': '0' * 64}}
        with self.assertRaisesRegex(ValueError, 'omission digest mismatch'):
            self.install([wheel], specs=specs)
        self.assert_unpublished()
        specs[wheel]['omitBuildBackendSha256'] = hashlib.sha256(b'publisher stray file').hexdigest()
        root, _ = self.install([wheel], specs=specs)
        self.assertFalse((root / 'site-packages/build_backend.py').exists())
        self.assertTrue((root / 'site-packages/keep.py').is_file())

    def test_interrupted_staging_cannot_publish(self):
        wheel = self.wheel('fixture', [('fixture.py', b'value=1')])
        with patch.object(environments, 'snapshot_tree', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.install([wheel])
        self.assert_unpublished()

    def test_prepare_without_execution_and_verify_cached_tree(self):
        marker = self.root / 'executed'
        wheel = self.wheel('fixture', [('fixture-1.0.data/purelib/fixture/__init__.py', b'value=1'),
                                      ('run-on-import.pth', f'import pathlib; pathlib.Path({str(marker)!r}).touch()')])
        root, receipt = self.install([wheel])
        self.assertFalse(marker.exists())
        self.assertTrue((root / 'site-packages/fixture/__init__.py').is_file())
        definition = {'name': 'fixture', 'wheels': [wheel], 'maxInstalledMiB': 1}
        _, reused = environments.find_environment(definition, receipt['id'], supervisor.private_dir, supervisor.regular)
        self.assertTrue(reused['reused'])
        (root / 'site-packages/fixture/__init__.py').write_text('value=2')
        with self.assertRaisesRegex(ValueError, 'content changed'):
            environments.find_environment(definition, receipt['id'], supervisor.private_dir, supervisor.regular)


class LaunchFenceTests(unittest.TestCase):
    def test_fence_prevents_launch_and_intent_cannot_be_replayed(self):
        job = 'job_launch_fixture'
        unit = supervisor.unit_name(job)
        with tempfile.TemporaryDirectory() as directory:
            admin = pathlib.Path(directory)
            launches = supervisor.private_dir(admin / 'launches')
            (launches / (job + '.cancel')).touch(mode=0o600)
            with self.assertRaisesRegex(supervisor.Cancelled, 'fenced'):
                supervisor.record_launch_intent(admin, job, unit)
            marker = launches / (job + '.json')
            self.assertEqual(json.loads(marker.read_text()), {'jobId': job, 'unit': unit})
            self.assertEqual(stat.S_IMODE(marker.stat().st_mode), 0o600)
            with self.assertRaises(FileExistsError):
                supervisor.record_launch_intent(admin, job, unit)


class ModelMountTests(unittest.TestCase):
    def test_selected_consolidated_blob_is_pinned_and_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            cache = root / 'cache'
            revision = '1' * 40
            snapshot = cache / 'models--Fixture--model' / 'snapshots' / revision
            snapshot.mkdir(parents=True)
            digest_name = 'a' * 64
            consolidated = cache / 'blobs' / digest_name[:2] / digest_name
            consolidated.parent.mkdir(parents=True)
            consolidated.write_bytes(b'example')
            (snapshot / 'weights.bin').symlink_to(consolidated)
            model = {'repo': 'Fixture/model', 'revision': revision, 'files': [
                {'name': 'weights.bin', 'sha256': hashlib.sha256(b'example').hexdigest(), 'bytes': 7}]}
            with patch.object(supervisor, 'MODEL_CACHE_ROOT', cache):
                mounts = supervisor.model_file_mounts(model)
                try:
                    self.assertEqual(mounts[0][1], consolidated)
                    supervisor.recheck_model_mounts(mounts)
                    consolidated.write_bytes(b'changed')
                    with self.assertRaisesRegex(ValueError, 'bind path changed'):
                        supervisor.recheck_model_mounts(mounts)
                finally:
                    for _, _, fd, _ in mounts:
                        os.close(fd)
                with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                    supervisor.model_file_mounts(model)
                (snapshot / 'weights.bin').unlink()
                outside = root / 'outside.bin'
                outside.write_bytes(b'example')
                (snapshot / 'weights.bin').symlink_to(outside)
                with self.assertRaisesRegex(ValueError, 'outside allowed blob layouts'):
                    supervisor.model_file_mounts(model)

    def test_model_names_are_basenames_and_distinct(self):
        item = {'name': 'config.json', 'sha256': 'a' * 64, 'bytes': 0}
        model = {'repo': 'Fixture/model', 'revision': '1' * 40, 'files': [item]}
        self.assertEqual(supervisor.validate_model(model), model)
        with self.assertRaisesRegex(ValueError, 'file identity'):
            supervisor.validate_model({**model, 'files': [{**item, 'name': '../config.json'}]})
        with self.assertRaisesRegex(ValueError, 'repeated'):
            supervisor.validate_model({**model, 'files': [item, item]})


if __name__ == '__main__':
    unittest.main()
