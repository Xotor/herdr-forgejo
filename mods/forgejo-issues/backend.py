"""Read-only Forgejo adapter. Credentials never leave this process."""
import json
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit, urlencode, quote
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError, URLError


def git(cwd, *args):
    p = subprocess.run(['git', '-C', str(cwd), *args], capture_output=True, encoding='utf-8', errors='strict', timeout=10)
    if p.returncode:
        raise ValueError('The focused folder is not an available Git repository.')
    return p.stdout.strip()


def dotenv(path):
    values = {}
    if not path.exists():
        return values
    for line in path.read_text(encoding='utf-8-sig').splitlines():
        m = re.match(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$', line)
        if not m:
            continue
        value = m[2]
        if value.startswith(('"', "'")):
            q = value[0]
            end = value.find(q, 1)
            if end < 0:
                raise ValueError('Unterminated quoted value in base project .env.')
            value = value[1:end]
        else:
            value = re.split(r'\s+#', value, maxsplit=1)[0].strip()
        values[m[1]] = value
    return values


def remote_parts(remote):
    if '://' not in remote:
        m = re.match(r'(?:[^@/]+@)?([^:/]+):(.+)', remote)
        if not m:
            raise ValueError('Cannot determine Forgejo repository from Git remote.')
        host, path = m.groups()
        base = 'https://' + host
    else:
        u = urlsplit(remote)
        host, path = u.hostname, u.path
        base = 'https://' + (u.netloc.split('@')[-1] if u.scheme in ('http', 'https') else host)
    parts = path.strip('/').removesuffix('.git').split('/')
    if len(parts) < 2:
        raise ValueError('Git remote needs an owner and repository.')
    return host, base, '/'.join(parts[-2:])


def context(cwd):
    root = git(cwd, 'rev-parse', '--show-toplevel')
    common = Path(git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
    base_root = common.parent
    # Git's common directory is shared by all worktrees, including linked worktrees.
    config = dotenv(base_root / '.env')
    if not config.get('FORGEJO_TOKEN'):
        raise ValueError('Set FORGEJO_TOKEN in the base project .env (not the worktree).')
    remote = git(cwd, 'remote', 'get-url', config.get('FORGEJO_REMOTE', 'origin'))
    host, inferred, repo = remote_parts(remote)
    base = config.get('FORGEJO_URL', inferred).rstrip('/')
    u = urlsplit(base)
    if u.scheme != 'https' or not u.hostname or u.username or u.password or u.query or u.fragment:
        raise ValueError('Forgejo URL must be an HTTPS base URL without credentials or query parameters.')
    if host in ('github.com', 'gitlab.com', 'bitbucket.org') and host != u.hostname:
        raise ValueError('This project points to ' + host + ', not your Forgejo host. Open a Forgejo project or set FORGEJO_REMOTE to its Git remote.')
    branch = git(cwd, 'branch', '--show-current')
    return {'base': base, 'repo': repo, 'branch': branch, 'root': root,
            'baseRoot': str(base_root), 'key': base + '/' + repo}, config['FORGEJO_TOKEN']


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def request(base, endpoint, token):
    req = Request(base + '/api/v1/' + endpoint, headers={'Authorization': 'token ' + token, 'Accept': 'application/json'})
    try:
        with build_opener(NoRedirect).open(req, timeout=15) as response:
            return json.load(response), response.headers
    except HTTPError as e:
        raise ValueError(f'Forgejo returned HTTP {e.code}. Check repository access and token permissions.') from None
    except (URLError, TimeoutError):
        raise ValueError('Cannot reach Forgejo. Check network access and the configured URL.') from None


def issues(ctx, token):
    result = []
    endpoint = 'repos/' + '/'.join(quote(s, safe='') for s in ctx['repo'].split('/')) + '/issues?'
    limited = False
    for page in range(1, 101):
        rows, headers = request(ctx['base'], endpoint + urlencode({'state': 'all', 'type': 'issues', 'limit': 50, 'page': page}), token)
        if not isinstance(rows, list):
            raise ValueError('Unexpected Forgejo issue response.')
        for row in rows:
            if row.get('pull_request'):
                continue
            result.append({k: row.get(k) for k in ('number', 'title', 'state', 'html_url', 'created_at', 'updated_at')}
                          | {'labels': [x.get('name', '') for x in row.get('labels', [])],
                             'assignees': [x.get('login', '') for x in row.get('assignees') or []]})
        if not rows or ('rel="next"' not in headers.get('Link', '') and len(rows) < 50):
            break
    else:
        limited = True
    return {'issues': result, 'limited': limited}


def main():
    ctx, token = context(sys.argv[2])
    if sys.argv[1].startswith('panel:'):
        kind = sys.argv[1].split(':', 1)[1]
        if kind not in ('issues', 'prs', 'actions'):
            raise ValueError('Unknown panel.')
        print(json.dumps(ctx | board(ctx, token, primary=kind), ensure_ascii=True))
        return
    if sys.argv[1] == 'board':
        print(json.dumps(ctx | board(ctx, token), ensure_ascii=True))
        return
    out = ctx if sys.argv[1] == 'context' else ctx | issues(ctx, token)
    if sys.argv[1] != 'context':
        labels = []
        endpoint = 'repos/' + '/'.join(quote(s, safe='') for s in ctx['repo'].split('/')) + '/labels?'
        for page in range(1, 101):
            rows, headers = request(ctx['base'], endpoint + urlencode({'limit': 50, 'page': page}), token)
            labels.extend(row['name'] for row in rows)
            if not rows or ('rel="next"' not in headers.get('Link', '') and len(rows) < 50):
                break
        out['labels'] = labels
    print(json.dumps(out, ensure_ascii=True))


def collection(ctx, token, suffix, params=None, pages=100):
    endpoint = 'repos/' + '/'.join(quote(s, safe='') for s in ctx['repo'].split('/')) + '/' + suffix + '?'
    result = []
    for page in range(1, pages + 1):
        data, headers = request(ctx['base'], endpoint + urlencode(dict(params or {}, page=page, limit=50)), token)
        rows = (data.get('workflow_runs', data.get('runs', [])) or []) if isinstance(data, dict) else data
        if not isinstance(rows, list):
            raise ValueError('Unexpected Forgejo list response.')
        result.extend(rows)
        if not rows or ('rel="next"' not in headers.get('Link', '') and len(rows) < 50):
            return result, False
    return result, True


def link_graph(issue_rows, pulls, runs):
    """Only confirmed repository objects and explicit references / exact SHAs."""
    by_issue = {i['number']: i for i in issue_rows}
    by_pr = {p['number']: p for p in pulls}
    for row in [*issue_rows, *pulls, *runs]:
        row['links'] = []

    def connect(left, right, left_kind, right_kind, reason):
        for source, target, kind in ((left, right, right_kind), (right, left, left_kind)):
            link = {'kind': kind, 'number': target['number'], 'reason': reason}
            if link not in source['links']:
                source['links'].append(link)

    for pr in pulls:
        for number in pr.pop('_issue_refs', []):
            if number in by_issue:
                connect(pr, by_issue[number], 'prs', 'issues', 'mentioned in PR')
    for run in runs:
        explicit = run.pop('_pr_numbers', [])
        sha = run.get('sha')
        for pr in pulls:
            reason = 'API PR reference' if pr['number'] in explicit else 'exact commit' if sha and sha in pr.get('_shas', []) else None
            if reason:
                connect(run, pr, 'actions', 'prs', reason)
                for ref in pr['links'][:]:
                    if ref['kind'] == 'issues':
                        connect(run, by_issue[ref['number']], 'actions', 'issues', 'via PR #' + str(pr['number']))
    for pr in pulls:
        pr.pop('_shas', None)


def board(ctx, token, primary=None):
    warnings = []
    output = {'issues': [], 'prs': [], 'actions': [], 'labels': [], 'limited': False, 'limits': {}}
    specs = [('issues', 'issues', {'state': 'all', 'type': 'issues', 'sort': 'recentupdate'}, 100),
             ('prs', 'pulls', {'state': 'all', 'sort': 'recentupdate'}, 100), ('actions', 'actions/runs', {}, 10)]
    if primary:
        specs = [(kind, suffix, params, 2) for kind, suffix, params, pages in specs if kind == primary]
    pool = ThreadPoolExecutor(max_workers=4)
    pending = {kind: pool.submit(collection, ctx, token, suffix, params, pages) for kind, suffix, params, pages in specs}
    if primary != 'actions':
        pending['labels'] = pool.submit(collection, ctx, token, 'labels')
    for kind, suffix, params, pages in specs:
        try:
            raw, limited = pending[kind].result()
            output['limited'] |= limited
            output['limits'][kind] = limited
            for row in raw:
                if kind == 'issues' and row.get('pull_request'):
                    continue
                normal = {k: row.get(k) for k in ('number', 'title', 'created_at', 'updated_at')}
                expected = ctx['base'].rstrip('/') + '/' + ctx['repo'] + '/'
                candidate = row.get('html_url') or ''
                if candidate.startswith(expected) and re.fullmatch(r'(?:issues|pulls|actions/runs)/\d+', candidate[len(expected):]):
                    normal['web_url'] = candidate
                normal.update(state=row.get('state', 'unknown'), labels=[x['name'] for x in row.get('labels') or []],
                              assignees=[x['login'] for x in row.get('assignees') or []])
                if kind == 'prs':
                    text = row.get('title', '') + '\n' + (row.get('body') or '')
                    # Strip foreign repo-qualified references before matching bare #123.
                    own_url = re.escape(ctx['base'].rstrip('/') + '/' + ctx['repo']) + r'/(?:issues|pulls)/(\d+)'
                    refs = [int(n) for n in re.findall(own_url, text)]
                    refs += [int(n) for n in re.findall(r'(?<![\w/])' + re.escape(ctx['repo']) + r'#(\d+)\b', text)]
                    text = re.sub(r'https?://\S+|[\w.-]+/[\w.-]+#\d+', '', text)
                    refs += [int(n) for n in re.findall(r'(?<![\w/])#(\d+)\b', text)]
                    head, base = row.get('head') or {}, row.get('base') or {}
                    normal.update(state='merged' if row.get('merged') else 'draft' if row.get('draft') and row.get('state') == 'open' else row.get('state'),
                                  detail=str(head.get('ref', '?')) + ' → ' + str(base.get('ref', '?')),
                                  _issue_refs=sorted(set(refs)), _shas=[s for s in [head.get('sha'), row.get('merge_commit_sha')] if s])
                if kind == 'actions':
                    payload = row.get('event_payload') or {}
                    if isinstance(payload, str):
                        try:
                            payload = json.loads(payload)
                        except (ValueError, TypeError):
                            payload = {}
                    if not isinstance(payload, dict):
                        payload = {}
                    pr = payload.get('pull_request') or {}
                    numbers = [p.get('number') for p in row.get('pull_requests') or [] if isinstance(p, dict)]
                    if isinstance(pr, dict) and pr.get('number'):
                        numbers.append(pr['number'])
                    if str(row.get('event', '')).startswith('pull_request') and payload.get('number'):
                        numbers.append(payload['number'])
                    normal.update(number=row.get('index_in_repo', row.get('run_number', row.get('id'))), title=row.get('title') or row.get('workflow_id') or 'Workflow run',
                                  state=row.get('status', 'unknown'), created_at=row.get('created', row.get('created_at')), updated_at=row.get('updated', row.get('updated_at')),
                                  started_at=row.get('started', row.get('run_started_at')), finished_at=row.get('stopped', row.get('completed_at')),
                                  duration_seconds=(row['duration'] / 1000000000) if isinstance(row.get('duration'), (int, float)) else None,
                                  sha=row.get('commit_sha', row.get('head_sha')), detail=' · '.join(str(x) for x in [row.get('workflow_id'), row.get('prettyref'), row.get('event')] if x),
                                  _pr_numbers=[int(n) for n in numbers if str(n).isdigit()])
                output[kind].append(normal)
        except ValueError as error:
            warnings.append(kind + ': ' + str(error))
    try:
        labels, _ = pending['labels'].result() if 'labels' in pending else ([], False)
        output['labels'] = [x['name'] for x in labels]
    except ValueError as error:
        warnings.append('labels: ' + str(error))
    pool.shutdown(wait=True)
    link_graph(output['issues'], output['prs'], output['actions'])
    output['warnings'] = warnings
    return output


if __name__ == '__main__':
    try:
        main()
    except ValueError as e:
        print(json.dumps({'error': str(e)}))
    except Exception:
        print(json.dumps({'error': 'Could not load Forgejo issues. Check Git, .env and network access.'}))
