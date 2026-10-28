import './style.css';
import { VoiceClient, type VoiceState, type VoiceUpdate } from './voice';

type User = { id: string; username: string };
type ChatMessage = { id: string; from: User; text: string; createdAt: string };
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
const voice = new VoiceClient((update: VoiceUpdate) => { voiceState = update.state; voiceMessage = update.message; voicePeers = update.peers; render(); });
const esc = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const signalUrl = () => localStorage.getItem('pulse.signalUrl') || import.meta.env.VITE_PULSE_SIGNAL_URL || 'ws://127.0.0.1:8787';
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
    try { const result = await api<{ token: string; user: User }>(`/${authMode}`, { method: 'POST', body: JSON.stringify({ username: form.get('username'), password: form.get('password') }) }); token = result.token; me = result.user; localStorage.setItem('pulse.authToken', token); await refreshFriends(); render(); }
    catch (error) { authError = error instanceof Error ? error.message : 'Could not sign in.'; }
    finally { busy = false; if (!me) renderAuth(); }
  };
}

async function refreshFriends() { friends = await api<Friends>('/friends'); }
async function refreshMessages() {
  if (!activeFriend) { messages = []; return; }
  const result = await api<{ messages: ChatMessage[] }>(`/messages?with=${encodeURIComponent(activeFriend.username)}`);
  const changed = result.messages.length !== messages.length || result.messages.at(-1)?.id !== messages.at(-1)?.id;
  messages = result.messages;
  if (changed && me) render();
}
function openFriend(friend: User) { activeFriend = friend; void refreshMessages().then(render).catch(e => { notice = e.message; render(); }); }
function chatRoom(friend: User) { return `dm-${[me?.id, friend.id].sort().join('-')}`; }

function render() {
  if (!me) { renderAuth(); return; }
  const draft = app.querySelector<HTMLInputElement>('#message-input')?.value || '';
  const wasComposing = document.activeElement === app.querySelector<HTMLInputElement>('#message-input');
  const friend = activeFriend;
  app.innerHTML = `<aside class="rail"><div class="brand-mark">P<span>·</span></div><div class="rail-divider"></div><button class="server active" title="Friends">F</button><div class="rail-bottom"><button class="icon-button" title="Sign out" id="logout">↪</button><div class="avatar me">${esc(me.username[0].toUpperCase())}</div></div></aside>
  <aside class="sidebar"><header class="side-header"><div><div class="eyebrow">PULSE</div><div class="space-title">Friends</div></div><button class="icon-button" title="Sign out" id="logout-top">↪</button></header>
    <label class="search"><span>⌕</span><input id="friend-search" placeholder="Find a friend"/><kbd>⌕</kbd></label>
    <div class="side-scroll"><section><div class="section-title">FRIENDS <span>${friends.friends.length}</span></div>${friends.friends.map(f => `<button class="nav-item dm-item ${friend?.id === f.id ? 'selected' : ''}" data-friend="${esc(f.id)}"><span class="avatar tiny" style="--av:#8276ff">${esc(f.username[0].toUpperCase())}</span><span>${esc(f.username)}</span></button>`).join('') || '<p class="side-empty">Add someone by their username to start chatting.</p>'}</section>
    <section><div class="section-title">FRIEND REQUESTS <span>${friends.incoming.length}</span></div>${friends.incoming.map(f => `<div class="request-row"><span>${esc(f.username)}</span><button class="accept-button" data-accept="${esc(f.id)}">Accept</button></div>`).join('') || '<p class="side-empty">No new requests.</p>'}${friends.outgoing.map(f => `<p class="side-empty">Request sent to ${esc(f.username)}</p>`).join('')}</section>
    <section><div class="section-title">ADD A FRIEND</div><form id="add-friend" class="add-friend"><input name="username" required maxlength="24" placeholder="Pulse username"/><button title="Send friend request">＋</button></form></section></div>
    <div class="profile"><div class="avatar me">${esc(me.username[0].toUpperCase())}</div><div class="profile-copy"><strong>${esc(me.username)}</strong><small>Signed in</small></div><button class="icon-button" id="logout-bottom" title="Sign out">↪</button></div></aside>
  <main class="main"><header class="chat-header"><div class="chat-heading"><span class="head-hash">${friend ? `<span class="avatar tiny" style="--av:#8276ff">${esc(friend.username[0].toUpperCase())}</span>` : '✦'}</span><div><h1>${friend ? esc(friend.username) : 'Your friends'}</h1><p>${friend ? 'Direct message' : 'Find people you know on Pulse'}</p></div></div><div class="header-actions"><button class="icon-button" title="Sign out" id="logout-header">↪</button></div></header>
    <div class="message-area" id="messages">${friend ? (messages.length ? messages.map(m => `<article class="message ${m.from.id === me!.id ? 'own' : ''}"><div class="avatar message-avatar" style="--av:${m.from.id === me!.id ? '#8276ff' : '#d68bff'}">${esc(m.from.username[0].toUpperCase())}</div><div class="message-body"><div class="message-meta"><strong>${esc(m.from.username)}</strong><time>${time(m.createdAt)}</time></div><p>${esc(m.text)}</p></div></article>`).join('') : `<div class="empty-chat"><div class="welcome-icon">✦</div><h2>Say hello to ${esc(friend.username)}</h2><p>Messages in this conversation will appear here.</p></div>`) : `<div class="welcome"><div class="welcome-icon">✦</div><h2>Welcome to Pulse, ${esc(me.username)}</h2><p>Add a friend by username. Once they accept, you can chat and join a voice call.</p></div>`}</div>
    ${friend ? `<form id="composer" class="composer"><button type="button" class="attach" title="Attachments are not available yet" disabled>＋</button><input id="message-input" maxlength="4096" autocomplete="off" placeholder="Message ${esc(friend.username)}"/><button class="send" type="submit" title="Send message">↑</button><div class="composer-hint">Messages are stored on the server</div></form>` : ''}
  </main><aside class="rightbar"><div class="right-title">YOUR ACCOUNT</div><div class="account-info"><div class="avatar" style="--av:#8276ff">${esc(me.username[0].toUpperCase())}</div><strong>${esc(me.username)}</strong><p>Share your username with friends so they can find you.</p></div>
    ${friend ? `<div class="voice-card ${voiceState === 'connected' ? 'connected' : ''}"><div class="voice-top"><span class="voice-dot"></span><strong>Voice chat · 1:1</strong></div><div class="voice-room"><span>◖))</span><span>${esc(friend.username)}</span><span class="voice-count">${voicePeers.length ? voicePeers.length + 1 : '—'}</span></div><div class="voice-status ${voiceState === 'error' ? 'voice-error' : ''}">${esc(voiceMessage)}</div><label class="voice-setting">Signaling server<input id="voice-endpoint" value="${esc(signalUrl())}" spellcheck="false"/></label><label class="voice-setting">Voice access token<input id="voice-token" type="password" value="${esc(voiceToken())}" autocomplete="off"/></label><div class="voice-controls">${voiceState === 'connected' || voiceState === 'waiting' ? `<button id="voice-mute" class="voice-mute">${voiceMuted ? 'Unmute mic' : 'Mute mic'}</button>` : ''}<button id="voice-toggle" class="voice-button">${voiceState === 'connected' || voiceState === 'waiting' ? 'Leave voice' : voiceState === 'connecting' ? 'Cancel' : 'Join voice'}</button></div><p>WebRTC peer-to-peer · TURN relay optional</p></div>` : '<div class="empty-help">Choose a friend to open a DM and voice call.</div>'}
    <div class="encryption"><span class="lock">ⓘ</span><div><strong>Account security</strong><p>Passwords are hashed. Messages are stored on this server and are not end-to-end encrypted yet.</p></div></div></aside><div class="toast ${notice ? 'show' : ''}">${esc(notice)}</div>`;

  app.querySelectorAll<HTMLButtonElement>('[data-friend]').forEach(button => button.onclick = () => { const selected = friends.friends.find(f => f.id === button.dataset.friend); if (selected) openFriend(selected); });
  app.querySelectorAll<HTMLButtonElement>('[data-accept]').forEach(button => button.onclick = async () => { try { await api(`/friends/${button.dataset.accept}/accept`, { method: 'POST', body: '{}' }); await refreshFriends(); render(); } catch (e) { showError(e); } });
  app.querySelector<HTMLFormElement>('#add-friend')!.onsubmit = async e => { e.preventDefault(); const form = new FormData(e.currentTarget as HTMLFormElement); try { await api('/friends', { method: 'POST', body: JSON.stringify({ username: form.get('username') }) }); await refreshFriends(); notice = 'Friend request sent.'; render(); } catch (error) { showError(error); } };
  const signOut = async () => { try { await api('/logout', { method: 'POST', body: '{}' }); } catch {} token = ''; me = undefined; activeFriend = undefined; localStorage.removeItem('pulse.authToken'); voice.leave(); renderAuth(); };
  ['#logout', '#logout-top', '#logout-bottom', '#logout-header'].forEach(id => app.querySelector<HTMLButtonElement>(id)?.addEventListener('click', signOut));
  const friendSearch = app.querySelector<HTMLInputElement>('#friend-search');
  friendSearch?.addEventListener('input', () => { const query = friendSearch.value.trim().toLowerCase(); app.querySelectorAll<HTMLButtonElement>('[data-friend]').forEach(button => { button.hidden = !button.textContent?.toLowerCase().includes(query); }); });
  const composer = app.querySelector<HTMLFormElement>('#composer');
  if (composer && friend) composer.onsubmit = async e => { e.preventDefault(); const input = app.querySelector<HTMLInputElement>('#message-input')!; const text = input.value.trim(); if (!text) return; input.disabled = true; try { await api('/messages', { method: 'POST', body: JSON.stringify({ to: friend.username, text }) }); input.value = ''; await refreshMessages(); render(); app.querySelector<HTMLInputElement>('#message-input')?.focus(); } catch (error) { showError(error); input.disabled = false; } };
  app.querySelector<HTMLButtonElement>('#voice-toggle')?.addEventListener('click', () => {
    if (voiceState === 'connected' || voiceState === 'waiting' || voiceState === 'connecting') { voiceRoom = ''; voiceMuted = false; voice.leave(); return; }
    const endpoint = app.querySelector<HTMLInputElement>('#voice-endpoint')!.value.trim(); const access = app.querySelector<HTMLInputElement>('#voice-token')!.value.trim();
    if (!endpoint) { voiceState = 'error'; voiceMessage = 'Enter the signaling server address.'; render(); return; }
    localStorage.setItem('pulse.signalUrl', endpoint); localStorage.setItem('pulse.voiceToken', access); voiceRoom = chatRoom(friend!); void voice.join(endpoint, voiceRoom, me!.username, access);
  });
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
    try { me = (await api<{ user: User }>('/me')).user; await refreshFriends(); render(); }
    catch { token = ''; localStorage.removeItem('pulse.authToken'); renderAuth(); }
  } else renderAuth();
  window.setInterval(async () => {
    if (!me) return;
    try { const previousIncoming = friends.incoming.map(f => f.id).join(); const previousFriends = friends.friends.map(f => f.id).join(); await refreshFriends(); if (previousIncoming !== friends.incoming.map(f => f.id).join() || previousFriends !== friends.friends.map(f => f.id).join()) render(); if (activeFriend) await refreshMessages(); }
    catch (error) { if (error instanceof Error && error.message === 'Sign in to continue.') { token = ''; me = undefined; localStorage.removeItem('pulse.authToken'); renderAuth(); } }
  }, 3000);
}
void start();
