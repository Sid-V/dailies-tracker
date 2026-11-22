import { merge, normalize, sameData } from './model.js';

export function b64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function b64DecodeUtf8(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export class SyncError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class GitHubStore {
  constructor({ owner, repo, path = 'data.json', branch = '', token }, fetchImpl = globalThis.fetch.bind(globalThis)) {
    this.cfg = { owner, repo, path, branch, token };
    this.fetch = fetchImpl;
  }

  url(suffix = '') {
    const { owner, repo } = this.cfg;
    return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
  }

  async request(url, init = {}) {
    const res = await this.fetch(url, {
      ...init,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.cfg.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    return res;
  }

  contentsUrl() {
    const path = this.cfg.path.split('/').map(encodeURIComponent).join('/');
    const ref = this.cfg.branch ? `?ref=${encodeURIComponent(this.cfg.branch)}` : '';
    return this.url(`/contents/${path}${ref}`);
  }

  async checkAccess() {
    const res = await this.request(this.url());
    if (res.status === 401) throw new SyncError('Token rejected (expired or wrong).', 401);
    if (res.status === 404) throw new SyncError('Repo not found, or the token has no access to it.', 404);
    if (!res.ok) throw new SyncError(`GitHub error ${res.status}`, res.status);
    const repo = await res.json();
    return { private: !!repo.private, canPush: repo.permissions ? !!repo.permissions.push : null };
  }

  async read() {
    const res = await this.request(this.contentsUrl());
    if (res.status === 404) return { data: null, sha: null };
    if (res.status === 401) throw new SyncError('Token rejected (expired or wrong).', 401);
    if (!res.ok) throw new SyncError(`GitHub read failed (${res.status})`, res.status);
    const body = await res.json();
    let text;
    if (body.content) text = b64DecodeUtf8(body.content);
    else if (body.download_url) text = await (await this.fetch(body.download_url, { cache: 'no-store' })).text();
    else text = '{}';
    return { data: normalize(JSON.parse(text || '{}')), sha: body.sha };
  }

  async write(data, sha, message = 'Update dailies') {
    const payload = {
      message,
      content: b64EncodeUtf8(JSON.stringify(data, null, 2) + '\n'),
      ...(sha ? { sha } : {}),
      ...(this.cfg.branch ? { branch: this.cfg.branch } : {}),
    };
    const url = this.contentsUrl().split('?')[0];
    const res = await this.request(url, { method: 'PUT', body: JSON.stringify(payload) });
    if (res.status === 409 || res.status === 422) throw new SyncError('conflict', 409);
    if (res.status === 401) throw new SyncError('Token rejected (expired or wrong).', 401);
    if (res.status === 403 || res.status === 404)
      throw new SyncError('Token cannot write to this repo (needs Contents: read & write).', res.status);
    if (!res.ok) throw new SyncError(`GitHub write failed (${res.status})`, res.status);
    const body = await res.json();
    return body.content.sha;
  }
}

// Pull, merge with local, and push back only if the remote is missing something.
export async function syncData(store, local, { attempts = 4, message } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const remote = await store.read();
    const merged = merge(local, remote.data || {});
    if (remote.data && sameData(merged, remote.data)) return { data: merged, pushed: false };
    try {
      await store.write(merged, remote.sha, message);
      return { data: merged, pushed: true };
    } catch (err) {
      if (err.status !== 409) throw err;
      lastErr = err;
      local = merged;
    }
  }
  throw lastErr || new SyncError('Sync failed after retries');
}
