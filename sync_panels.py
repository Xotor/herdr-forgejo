"""Build the two self-contained companion mods from the shared panel source."""
from pathlib import Path
import shutil
root = Path(__file__).parent / 'mods'
for kind in ('prs', 'actions'):
    target = root / ('forgejo-' + kind)
    target.mkdir(exist_ok=True)
    shutil.copyfile(root / 'forgejo-issues/main.js', target / 'view.js')
    shutil.copyfile(root / 'forgejo-issues/backend.py', target / 'backend.py')
    (target / 'mod.json').write_text('{"place":"none"}\n')
    (target / 'main.js').write_text('import Panel from "./view.js";\nexport default class Companion extends Panel { get kind() { return "' + kind + '"; } }\n')
