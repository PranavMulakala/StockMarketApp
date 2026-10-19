/** No accounts yet: a random id and a display name, kept in this browser. */
export interface Identity {
  userId: string;
  name: string | null;
}

const KEY = 'tape.identity';
const MUTED = 'tape.muted';

export function loadIdentity(): Identity {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const id = JSON.parse(raw) as Identity;
      if (typeof id.userId === 'string') return id;
    }
  } catch {
    // storage unavailable: fall through to a session-only identity
  }
  const fresh = { userId: crypto.randomUUID(), name: null };
  saveIdentity(fresh);
  return fresh;
}

export function saveIdentity(id: Identity) {
  try {
    localStorage.setItem(KEY, JSON.stringify(id));
  } catch {
    // ignore
  }
}

export function loadMuted(): string[] {
  try {
    return JSON.parse(localStorage.getItem(MUTED) ?? '[]') as string[];
  } catch {
    return [];
  }
}

export function saveMuted(ids: string[]) {
  try {
    localStorage.setItem(MUTED, JSON.stringify(ids));
  } catch {
    // ignore
  }
}
