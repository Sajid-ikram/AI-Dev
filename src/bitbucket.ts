import { requireEnv } from './config.ts';

export interface BitbucketRepo {
  workspace: string;
  slug: string;
}

/** The workspace and repo slug from a Bitbucket Cloud URL, or undefined for any other remote. */
export function bitbucketRepo(url: string): BitbucketRepo | undefined {
  const m = /^https:\/\/(?:[^@/]+@)?bitbucket\.org\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  return m ? { workspace: m[1], slug: m[2] } : undefined;
}

async function api(path: string, init: { method?: string; body?: unknown } = {}): Promise<any> {
  // Bearer works for both kinds of BITBUCKET_TOKEN: an Atlassian API token and a repository access token.
  const token = requireEnv('BITBUCKET_TOKEN', 'to open pull requests');
  const res = await fetch(`https://api.bitbucket.org/2.0${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.ok) return res.json();
  const detail = (await res.text()).slice(0, 400);
  if (res.status === 402) {
    throw new Error(`Bitbucket made the workspace read-only (HTTP 402), usually because it's over its plan's user limit: ${detail}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Bitbucket rejected BITBUCKET_TOKEN (HTTP ${res.status}). It needs pull request write access: ${detail}`);
  }
  throw new Error(`Bitbucket ${init.method ?? 'GET'} ${path} returned HTTP ${res.status}: ${detail}`);
}

/**
 * Opens a pull request from `branch`, or returns the one already open for it: after a rerun,
 * the force-pushed branch updates the existing pull request.
 */
export async function openPullRequest(
  repo: BitbucketRepo,
  pr: { branch: string; destination: string; title: string; description: string; reviewers: string[] },
): Promise<{ url: string; id: number; created: boolean }> {
  const base = `/repositories/${repo.workspace}/${repo.slug}/pullrequests`;
  const query = encodeURIComponent(`source.branch.name="${pr.branch}" AND state="OPEN"`);
  const open = (await api(`${base}?q=${query}`)).values?.[0];
  if (open) return { url: open.links.html.href, id: open.id, created: false };
  const created = await api(base, {
    method: 'POST',
    body: {
      title: pr.title,
      description: pr.description,
      source: { branch: { name: pr.branch } },
      destination: { branch: { name: pr.destination } },
      reviewers: reviewerRefs(pr.reviewers),
      close_source_branch: true,
    },
  });
  return { url: created.links.html.href, id: created.id, created: true };
}

/** Bitbucket names a user by account ID, or by UUID in braces. */
export function reviewerRefs(ids: string[]): ({ account_id: string } | { uuid: string })[] {
  return ids.map((id) => (id.startsWith('{') ? { uuid: id } : { account_id: id }));
}
