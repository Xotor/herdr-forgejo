"""Read-only Forgejo adapter. Credentials never leave this process."""
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit, urlencode, quote
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError, URLError


def git(cwd, *args):
    p = subprocess.run(['git', '-C', str(cwd), *args], capture_output=True, encoding='utf-8', errors='strict')
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


if __name__ == '__main__':
    try:
        main()
    except ValueError as e:
        print(json.dumps({'error': str(e)}))
    except Exception:
        print(json.dumps({'error': 'Could not load Forgejo issues. Check Git, .env and network access.'}))
