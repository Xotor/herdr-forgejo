"""Exercise populated cards for all three panels with Herdr's native checker."""
from pathlib import Path
import shutil
import subprocess

root = Path(__file__).parent.parent
for kind in ['issues', 'prs', 'actions']:
    folder = root / 'tests/_native' / kind
    folder.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(root / 'mods/forgejo-issues/main.js', folder / 'view.js')
    fixture = '''import Panel, {actionTiming, actionStatus} from './view.js';
export default class Fixture extends Panel {
  get kind() { return 'KIND'; }
  init(p, cx) {
    super.init(p, cx);
    this.serial = 1; this.loading = true; this.deadline = 10;
    this.checkDeadline(cx, 20);
    if (this.loading || this.enriching || this.serial !== 2 || !this.error) throw new Error('Loading deadline failed');
    this.data = {issues:[]}; this.enriching = true;
    this.checkDeadline(cx, 20);
    if (this.enriching || !this.data || !this.error.includes('loaded list')) throw new Error('Enrichment deadline lost primary list');
    this.error = null;
    if (this.kind === 'actions') {
      this.toggleState('running',cx); this.toggleState('success',cx); this.toggleState('waiting',cx);
      if (this.actionStates.size !== 3) throw new Error('Multi-status selection failed');
      this.toggleState('success',cx);
      if (this.actionStates.has('success') || this.actionStates.size !== 2) throw new Error('Status deselection failed');
      this.toggleState('all',cx);
      if (this.actionStates.size) throw new Error('All reset failed');
      const timing=actionTiming({state:'success',started_at:'2026-01-01T12:00:00Z',finished_at:'2026-01-01T12:01:30Z'});
      if (!timing.includes('1m 30s')) throw new Error('Completed duration failed');
      const live=actionTiming({state:'running',started_at:'2026-01-01T12:00:00Z'},Date.parse('2026-01-01T12:00:10Z'));
      if (!live.includes('Elapsed: 10s')) throw new Error('Live duration failed');
      if (actionStatus('queued') !== 'waiting') throw new Error('Queued status failed');
    }
    this.context = {key:'demo/repo', base:'https://example.invalid', repo:'demo/repo'};
    const row = {number:12, title:'Example item', labels:['Ready','frontend'], assignees:[],
      state: this.kind === 'actions' ? 'success' : 'open', detail:'ci.yml · main', started_at:'2026-01-01T12:00:00Z',finished_at:'2026-01-01T12:01:30Z',
      links:[{kind:'issues',number:1,reason:'mentioned in PR'},{kind:'prs',number:2,reason:'exact commit'}, {kind:'actions',number:3,reason:'via PR #2'}]};
    this.data = {[this.kind]:Array.from({length:80},(_,i)=>({...row,number:i+1})),labels:['Ready','frontend']};
  }
}'''.replace('KIND', kind)
    (folder / 'main.js').write_text(fixture, encoding='utf-8')
    run = subprocess.run(['herdr-app', 'check', str(folder)], capture_output=True, text=True)
    print(run.stdout, run.stderr)
    if 'check passed' not in run.stdout + run.stderr:
        raise SystemExit(1)
