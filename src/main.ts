import './style.css';
import { decryptMessage, encryptMessage, initializeIdentity, safetyCodes, voiceEncryptionKey } from './crypto';
import { VoiceClient, type VoiceState, type VoiceUpdate } from './voice';

type User = { id: string; username: string };
type ChatMessage = { id: string; from: User; text: string; createdAt: string; iv?: string; ciphertext?: string; encryptionVersion: number };
type Friends = { friends: User[]; incoming: User[]; outgoing: User[] };
const app = document.querySelector<HTMLDivElement>('#app')!;
const apiBase = (import.meta.env.VITE_PULSE_API_URL || window.location.origin).replace(/\/$/, '');
let token = localStorage.getItem('pulse.authToken') || '';
let me: User | undefined;
let friends: Friends = { friends: [], incoming: [], outgoing: [] };
let messages: ChatMessage[] = [];
let activeFriend: User | undefined;
let voiceState: VoiceState = 'disconnected';
let voiceMessage = 'Not connected';
let voicePeers: string[] = [];
let voiceRoom = '';
let voiceMuted = false;
let authMode: 'login' | 'signup' = 'signup';
let authError = '';
let notice = '';
let busy = false;
let cryptoReady = false;
const decryptedCache = new Map<string, string>();
const voice = new VoiceClient((update: VoiceUpdate) => { voiceState = update.state; voiceMessage = update.message; voicePeers = update.peers; render(); });
const esc = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const signalUrl = () => localStorage.getItem('pulse.signalUrl') || import.meta.env.VITE_PULSE_SIGNAL_URL || (window.location.hostname.startsWith('pulse.') ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.hostname.replace(/^pulse\./, 'voice.')}/voice` : 'ws://127.0.0.1:8787');
const voiceToken = () => localStorage.getItem('pulse.voiceToken') || '';

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase}/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result as T;
}

function renderAuth() {
  app.innerHTML = `<main class="auth-page"><section class="auth-card"><div class="brand-mark auth-brand">P<span>·</span></div><div class="eyebrow">YOUR SPACE, YOUR PEOPLE</div><h1>${authMode === 'signup' ? 'Create your Pulse account' : 'Welcome back'}</h1><p class="auth-subtitle">${authMode === 'signup' ? 'Make an account, add friends, and start talking.' : 'Sign in to continue to your friends.'}</p><form id="auth-form" class="auth-form"><label>Username<input name="username" required minlength="3" maxlength="24" pattern="[A-Za-z0-9._]+" autocomplete="username" placeholder="Your username"/></label><label>Password<input name="password" required minlength="10" maxlength="128" type="password" autocomplete="${authMode === 'signup' ? 'new-password' : 'current-password'}" placeholder="At least 10 characters"/></label>${authMode === 'signup' ? '<small>Usernames are 3–24 characters: letters, numbers, dots, and underscores.</small>' : ''}<p class="form-error">${esc(authError)}</p><button class="primary-button" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Please wait…' : authMode === 'signup' ? 'Create account' : 'Sign in'}</button></form><div class="auth-switch">${authMode === 'signup' ? 'Already have an account?' : 'New to Pulse?'} <button id="auth-switch">${authMode === 'signup' ? 'Sign in' : 'Create an account'}</button></div><footer>Pulse is in early access. Messages are stored on the Pulse server.</footer></section></main>`;
  app.querySelector<HTMLButtonElement>('#auth-switch')!.onclick = () => { authMode = authMode === 'signup' ? 'login' : 'signup'; authError = ''; renderAuth(); };
  app.querySelector<HTMLFormElement>('#auth-form')!.onsubmit = async e => {
    e.preventDefault(); const form = new FormData(e.currentTarget as HTMLFormElement); busy = true; authError = ''; renderAuth();
    try { const result = await api<{ token: string; user: User }>(`/${authMode}`, { method: 'POST', body: JSON.stringify({ username: form.get('username'), password: form.get('password') }) }); token = result.token; me = result.user; localStorage.setItem('pulse.authToken', token); try { await initializeAccountCrypto(me); } catch (error) { notice = `Encryption setup failed: ${error instanceof Error ? error.message : 'try signing in again'}`; } await refreshFriends(); render(); }
    catch (error) { if (me) { notice = error instanceof Error ? error.message : 'Pulse could not load your account.'; render(); } else authError = error instanceof Error ? error.message : 'Could not sign in.'; }
    finally { busy = false; if (!me) renderAuth(); }
  };
}

async function refreshFriends() { friends = await api<Friends>('/friends'); }
const fetchFriendKey = async (userId: string) => (await api<{ publicKey: JsonWebKey }>(`/keys/${encodeURIComponent(userId)}`)).publicKey;
async function initializeAccountCrypto(user: User) {
  await initializeIdentity(user.id, async publicKey => { await api('/keys', { method: 'POST', body: JSON.stringify({ publicKey }) }); });
  cryptoReady = true;
}
async function refreshMessages() {
  if (!activeFriend) { messages = []; return; }
  const result = await api<{ messages: ChatMessage[] }>(`/messages?with=${encodeURIComponent(activeFriend.username)}`);
  const friendId = activeFriend.id;
  const decrypted = await Promise.all(result.messages.map(async message => {
    if (message.encryptionVersion !== 1 || !message.ciphertext || !message.iv) return { ...message, text: 'This older message was sent before encryption was enabled.' };
    if (decryptedCache.has(message.id)) return { ...message, text: decryptedCache.get(message.id)! };
    try {
      const text = await decryptMessage(me!.id, friendId, message.iv, message.ciphertext, fetchFriendKey);
      decryptedCache.set(message.id, text);
      return { ...message, text };
    } catch (error) { return { ...message, text: error instanceof Error ? error.message : 'Could not decrypt this message.' }; }
  }));
  const changed = decrypted.length !== messages.length || decrypted.at(-1)?.id !== messages.at(-1)?.id || decrypted.at(-1)?.text !== messages.at(-1)?.text;
  messages = decrypted;
  if (changed && me) render();
}
function openFriend(friend: User) { activeFriend = friend; void refreshMessages().then(render).catch(e => { notice = e.message; render(); }); }
function chatRoom(friend: User) { return `dm-${[me?.id, friend.id].sort().join('-')}`; }

async function toggleCall() {
  if (voiceState === 'connected' || voiceState === 'waiting' || voiceState === 'connecting') { voiceRoom = ''; voiceMuted = false; voice.leave(); return; }
  if (!me || !activeFriend) return;
  if (!cryptoReady) { showError(new Error('This device’s encryption key is not ready. Sign out and back in, then retry.')); return; }
  const endpoint = signalUrl();
  let access = localStorage.getItem('pulse.voiceToken') || '';
  if (!access) {
    access = window.prompt('Enter the shared Pulse voice token. Pulse will save it on this device.', '')?.trim() || '';
    if (!access) return;
    localStorage.setItem('pulse.voiceToken', access);
  }
  try {
    const key = await voiceEncryptionKey(me.id, activeFriend.id, fetchFriendKey);
    voiceRoom = chatRoom(activeFriend);
    await voice.join(endpoint, voiceRoom, me.username, access, key);
  } catch (error) { showError(error); }
}

function render() {
  if (!me) { renderAuth(); return; }
  const draft = app.querySelector<HTMLInputElement>('#message-input')?.value || '';
  const wasComposing = document.activeElement === app.querySelector<HTMLInputElement>('#message-input');
  const friend = activeFriend;
  const callActive = voiceState === 'connected' || voiceState === 'waiting' || voiceState === 'connecting';
  app.innerHTML = `<aside class="rail"><div class="brand-mark">P<span>·</span></div><div class="rail-divider"></div><button class="server active" title="Friends">F</button><div class="rail-bottom"><button class="icon-button" title="Sign out" id="logout">↪</button><div class="avatar me">${esc(me.username[0].toUpperCase())}</div></div></aside>
  <aside class="sidebar"><header class="side-header"><div><div class="eyebrow">PULSE</div><div class="space-title">Friends</div></div><button class="icon-button" title="Sign out" id="logout-top">↪</button></header>
    <label class="search"><span>⌕</span><input id="friend-search" placeholder="Find a friend"/><kbd>⌕</kbd></label>
    <div class="side-scroll"><section><div class="section-title">FRIENDS <span>${friends.friends.length}</span></div>${friends.friends.map(f => `<div class="friend-list-row"><button class="nav-item dm-item ${friend?.id === f.id ? 'selected' : ''}" data-friend="${esc(f.id)}"><span class="avatar tiny" style="--av:#8276ff">${esc(f.username[0].toUpperCase())}</span><span>${esc(f.username)}</span></button><button class="friend-call" data-call-friend="${esc(f.id)}" title="Call ${esc(f.username)}" aria-label="Call ${esc(f.username)}">☎</button></div>`).join('') || '<p class="side-empty">Add someone by their username to start chatting.</p>'}</section>
    <section><div class="section-title">FRIEND REQUESTS <span>${friends.incoming.length}</span></div>${friends.incoming.map(f => `<div class="request-row"><span>${esc(f.username)}</span><button class="accept-button" data-accept="${esc(f.id)}">Accept</button></div>`).join('') || '<p class="side-empty">No new requests.</p>'}${friends.outgoing.map(f => `<p class="side-empty">Request sent to ${esc(f.username)}</p>`).join('')}</section>
    <section><div class="section-title">ADD A FRIEND</div><form id="add-friend" class="add-friend"><input name="username" required maxlength="24" placeholder="Pulse username"/><button title="Send friend request">＋</button></form></section></div>
    <div class="profile"><div class="avatar me">${esc(me.username[0].toUpperCase())}</div><div class="profile-copy"><strong>${esc(me.username)}</strong><small>Signed in</small></div><button class="icon-button" id="logout-bottom" title="Sign out">↪</button></div></aside>
  <main class="main"><header class="chat-header"><div class="chat-heading"><span class="head-hash">${friend ? `<span class="avatar tiny" style="--av:#8276ff">${esc(friend.username[0].toUpperCase())}</span>` : '✦'}</span><div><h1>${friend ? esc(friend.username) : 'Your friends'}</h1><p>${friend ? 'Direct message' : 'Find people you know on Pulse'}</p></div></div><div class="header-actions">${friend ? `<button id="call-button" class="call-button ${callActive ? 'call-active' : ''}" ${cryptoReady ? '' : 'disabled'}>${callActive ? 'End call' : 'Call'}</button>` : ''}<button class="icon-button" title="Sign out" id="logout-header">↪</button></div></header>
    <div class="message-area" id="messages">${friend ? (messages.length ? messages.map(m => `<article class="message ${m.from.id === me!.id ? 'own' : ''}"><div class="avatar message-avatar" style="--av:${m.from.id === me!.id ? '#8276ff' : '#d68bff'}">${esc(m.from.username[0].toUpperCase())}</div><div class="message-body"><div class="message-meta"><strong>${esc(m.from.username)}</strong><time>${time(m.createdAt)}</time></div><p>${esc(m.text)}</p></div></article>`).join('') : `<div class="empty-chat"><div class="welcome-icon">✦</div><h2>Say hello to ${esc(friend.username)}</h2><p>Messages in this conversation will appear here.</p></div>`) : `<div class="welcome"><div class="welcome-icon">✦</div><h2>Welcome to Pulse, ${esc(me.username)}</h2><p>Add a friend by username. Once they accept, you can chat and join a voice call.</p></div>`}</div>
    ${friend ? `<form id="composer" class="composer"><button type="button" class="attach" title="Attachments are not available yet" disabled>＋</button><input id="message-input" maxlength="4096" autocomplete="off" placeholder="Message ${esc(friend.username)}"/><button class="send" type="submit" title="Send encrypted message" ${cryptoReady ? '' : 'disabled'}>↑</button><div class="composer-hint">🔒 End-to-end encrypted</div></form>` : ''}
  </main><aside class="rightbar"><div class="right-title">YOUR ACCOUNT</div><div class="account-info"><div class="avatar" style="--av:#8276ff">${esc(me.username[0].toUpperCase())}</div><strong>${esc(me.username)}</strong><p>Share your username with friends so they can find you.</p></div>
    ${friend ? `<div class="voice-card ${voiceState === 'connected' ? 'connected' : ''}"><div class="voice-top"><span class="voice-dot"></span><strong>Encrypted voice</strong></div><div class="voice-room"><span>◖))</span><span>${esc(friend.username)}</span><span class="voice-count">${voicePeers.length ? voicePeers.length + 1 : '—'}</span></div><div class="voice-status ${voiceState === 'error' ? 'voice-error' : ''}">${esc(voiceMessage)}</div><div class="voice-controls">${callActive ? `<button id="voice-mute" class="voice-mute">${voiceMuted ? 'Unmute' : 'Mute'}</button>` : ''}<button id="voice-toggle" class="voice-button">${callActive ? 'End call' : 'Call'}${voiceState === 'connecting' ? 'ing…' : ''}</button></div><details class="voice-settings"><summary>Call setup</summary><label class="voice-setting">Signaling server<input id="voice-endpoint" value="${esc(signalUrl())}" spellcheck="false"/></label><label class="voice-setting">Access token<input id="voice-token" type="password" value="${esc(voiceToken())}" autocomplete="off" placeholder="Saved on this device"/></label><small>Both people need the same server and token. The first call asks for the token.</small></details></div>` : '<div class="empty-help">Choose a friend to open a DM and voice call.</div>'}
    <div class="encryption"><span class="lock">🔒</span><div><strong>End-to-end encrypted</strong><p>New DMs and voice are encrypted on this device. Old messages remain unencrypted.</p>${friend ? `<button id="show-key-codes" class="key-code-button">Compare safety codes</button>` : ''}</div></div></aside><div class="toast ${notice ? 'show' : ''}">${esc(notice)}</div>`;

  app.querySelectorAll<HTMLButtonElement>('[data-friend]').forEach(button => button.onclick = () => { const selected = friends.friends.find(f => f.id === button.dataset.friend); if (selected) openFriend(selected); });
  app.querySelectorAll<HTMLButtonElement>('[data-call-friend]').forEach(button => button.onclick = () => {
    const selected = friends.friends.find(f => f.id === button.dataset.callFriend);
    if (!selected) return;
    const isSameCall = voiceRoom === chatRoom(selected) && (voiceState === 'connecting' || voiceState === 'waiting' || voiceState === 'connected');
    if (isSameCall) { void toggleCall(); return; }
    if (voiceState === 'connecting' || voiceState === 'waiting' || voiceState === 'connected') voice.leave();
    voiceRoom = ''; activeFriend = selected; messages = []; render(); void toggleCall();
  });
  app.querySelectorAll<HTMLButtonElement>('[data-accept]').forEach(button => button.onclick = async () => { try { await api(`/friends/${button.dataset.accept}/accept`, { method: 'POST', body: '{}' }); await refreshFriends(); render(); } catch (e) { showError(e); } });
  app.querySelector<HTMLFormElement>('#add-friend')!.onsubmit = async e => { e.preventDefault(); const form = new FormData(e.currentTarget as HTMLFormElement); try { await api('/friends', { method: 'POST', body: JSON.stringify({ username: form.get('username') }) }); await refreshFriends(); notice = 'Friend request sent.'; render(); } catch (error) { showError(error); } };
  const signOut = async () => { try { await api('/logout', { method: 'POST', body: '{}' }); } catch {} token = ''; me = undefined; activeFriend = undefined; localStorage.removeItem('pulse.authToken'); voice.leave(); renderAuth(); };
  ['#logout', '#logout-top', '#logout-bottom', '#logout-header'].forEach(id => app.querySelector<HTMLButtonElement>(id)?.addEventListener('click', signOut));
  const friendSearch = app.querySelector<HTMLInputElement>('#friend-search');
  friendSearch?.addEventListener('input', () => { const query = friendSearch.value.trim().toLowerCase(); app.querySelectorAll<HTMLButtonElement>('[data-friend]').forEach(button => { button.hidden = !button.textContent?.toLowerCase().includes(query); }); });
  const composer = app.querySelector<HTMLFormElement>('#composer');
  if (composer && friend) composer.onsubmit = async e => { e.preventDefault(); const input = app.querySelector<HTMLInputElement>('#message-input')!; const text = input.value.trim(); if (!text) return; input.disabled = true; try { const envelope = await encryptMessage(me!.id, friend.id, text, fetchFriendKey); await api('/messages', { method: 'POST', body: JSON.stringify({ to: friend.username, ...envelope }) }); input.value = ''; await refreshMessages(); render(); app.querySelector<HTMLInputElement>('#message-input')?.focus(); } catch (error) { showError(error); input.disabled = false; } };
  app.querySelector<HTMLButtonElement>('#voice-toggle')?.addEventListener('click', () => void toggleCall());
  app.querySelector<HTMLButtonElement>('#call-button')?.addEventListener('click', () => void toggleCall());
  app.querySelector<HTMLButtonElement>('#show-key-codes')?.addEventListener('click', async () => { try { const codes = await safetyCodes(friend!.id, fetchFriendKey); window.alert(`Compare these codes with ${friend!.username} over a separate trusted channel. They should match exactly.\n\nYour code: ${codes.own}\nTheir code: ${codes.friend}`); } catch (error) { showError(error); } });
  app.querySelector<HTMLButtonElement>('#voice-mute')?.addEventListener('click', () => { voiceMuted = voice.toggleMute(); render(); });
  app.querySelector<HTMLInputElement>('#voice-endpoint')?.addEventListener('change', e => localStorage.setItem('pulse.signalUrl', (e.currentTarget as HTMLInputElement).value.trim()));
  app.querySelector<HTMLInputElement>('#voice-token')?.addEventListener('change', e => localStorage.setItem('pulse.voiceToken', (e.currentTarget as HTMLInputElement).value.trim()));
  const nextDraft = app.querySelector<HTMLInputElement>('#message-input');
  if (nextDraft && draft) { nextDraft.value = draft; if (wasComposing) nextDraft.focus(); }
  const area = app.querySelector('#messages'); if (area && friend) area.scrollTop = area.scrollHeight;
}

function showError(error: unknown) { notice = error instanceof Error ? error.message : 'Something went wrong.'; render(); window.setTimeout(() => { notice = ''; app.querySelector('.toast')?.classList.remove('show'); }, 3500); }

async function start() {
  if (token) {
    try { me = (await api<{ user: User }>('/me')).user; try { await initializeAccountCrypto(me); } catch (error) { notice = `Encryption setup failed: ${error instanceof Error ? error.message : 'sign in again to retry'}`; } await refreshFriends(); render(); }
    catch { token = ''; localStorage.removeItem('pulse.authToken'); renderAuth(); }
  } else renderAuth();
  window.setTimeout(() => { void checkDesktopUpdates(); }, 8000);
  window.setInterval(async () => {
    if (!me) return;
    try { const previousIncoming = friends.incoming.map(f => f.id).join(); const previousFriends = friends.friends.map(f => f.id).join(); await refreshFriends(); if (previousIncoming !== friends.incoming.map(f => f.id).join() || previousFriends !== friends.friends.map(f => f.id).join()) render(); if (activeFriend) await refreshMessages(); }
    catch (error) { if (error instanceof Error && error.message === 'Sign in to continue.') { token = ''; me = undefined; localStorage.removeItem('pulse.authToken'); renderAuth(); } }
  }, 3000);
}

async function checkDesktopUpdates() {
  if (!('__TAURI_INTERNALS__' in window)) return;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) return;
    notice = `Installing Pulse ${update.version}…`;
    render();
    await update.downloadAndInstall();
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (error) {
    console.warn('Pulse automatic update check failed:', error);
  }
}

void start();
