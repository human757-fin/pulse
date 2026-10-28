import './style.css';
import { decryptMessage, encryptMessage, initializeIdentity, safetyCodes, voiceEncryptionKey } from './crypto';
import { VoiceClient, type VoiceState, type VoiceUpdate } from './voice';

type User = { id: string; username: string; email?: string; emailVerified?: boolean; twoFactorEnabled?: boolean; displayName?: string; profileVersion?: string; avatar?: string; banner?: string };
type ChatMessage = { id: string; from: User; text: string; createdAt: string; iv?: string; ciphertext?: string; encryptionVersion: number };
type Friends = { friends: User[]; incoming: User[]; outgoing: User[] };
const app = document.querySelector<HTMLDivElement>('#app')!;
const runningInTauri = window.location.protocol === 'tauri:' || '__TAURI_INTERNALS__' in window;
const apiBase = (import.meta.env.VITE_PULSE_API_URL || (runningInTauri ? 'https://pulse.overclockd.shop' : window.location.origin)).replace(/\/$/, '');
let token = localStorage.getItem('pulse.authToken') || '';
localStorage.removeItem('pulse.voiceToken');
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
let authPhase: 'credentials' | 'verify-email' | 'verify-two-factor' = 'credentials';
let pendingAuth: { challengeId: string; email?: string; username?: string; password?: string } | undefined;
let authError = '';
let notice = '';
let busy = false;
let settingsOpen = false;
let securityChallenge: { challengeId: string; purpose: string; email: string } | undefined;
let securityError = '';
let cryptoReady = false;
const decryptedCache = new Map<string, string>();
const voice = new VoiceClient((update: VoiceUpdate) => { voiceState = update.state; voiceMessage = update.message; voicePeers = update.peers; render(); });
const esc = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const signalUrl = () => localStorage.getItem('pulse.signalUrl') || import.meta.env.VITE_PULSE_SIGNAL_URL || (runningInTauri ? 'wss://voice.overclockd.shop/voice' : window.location.hostname.startsWith('pulse.') ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.hostname.replace(/^pulse\./, 'voice.')}/voice` : 'ws://127.0.0.1:8787');

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase}/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result as T;
}

function renderAuth() {
  app.classList.remove('settings-view');
  const verification = authPhase !== 'credentials';
  const title = authPhase === 'verify-email' ? 'Check your email' : authPhase === 'verify-two-factor' ? 'Two-factor code' : authMode === 'signup' ? 'Create your Pulse account' : 'Welcome back';
  const subtitle = authPhase === 'verify-email' ? `Enter the six-digit code we sent to ${esc(pendingAuth?.email || '')}.` : authPhase === 'verify-two-factor' ? 'Enter the sign-in code sent to your verified email.' : authMode === 'signup' ? 'Verify your email, then add friends and start talking.' : 'Sign in with your username or verified email.';
  const fields = verification
    ? '<label>Email code<input name="code" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" placeholder="6-digit code"/></label>'
    : authMode === 'signup'
      ? '<label>Username<input name="username" required minlength="3" maxlength="24" pattern="[A-Za-z0-9._]+" autocomplete="username" placeholder="Your username"/></label><label>Email<input name="email" type="email" required maxlength="254" autocomplete="email" placeholder="you@example.com"/></label><label>Password<input name="password" required minlength="10" maxlength="128" type="password" autocomplete="new-password" placeholder="At least 10 characters"/></label><small>Usernames are 3–24 characters: letters, numbers, dots, and underscores.</small>'
      : '<label>Username or email<input name="username" required autocomplete="username" placeholder="Username or email"/></label><label>Password<input name="password" required minlength="10" maxlength="128" type="password" autocomplete="current-password" placeholder="Your password"/></label>';
  app.innerHTML = `<main class="auth-page"><section class="auth-card"><div class="brand-mark auth-brand">P<span>·</span></div><div class="eyebrow">YOUR SPACE, YOUR PEOPLE</div><h1>${title}</h1><p class="auth-subtitle">${subtitle}</p><form id="auth-form" class="auth-form">${fields}<p class="form-error">${esc(authError)}</p><button class="primary-button" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Please wait…' : authPhase === 'verify-email' ? 'Verify email' : authPhase === 'verify-two-factor' ? 'Verify and sign in' : authMode === 'signup' ? 'Send verification code' : 'Sign in'}</button></form>${verification ? `<div class="auth-switch">${authPhase === 'verify-email' ? '<button id="auth-resend">Resend code</button>' : ''}<button id="auth-back">Back</button></div>` : `<div class="auth-switch">${authMode === 'signup' ? 'Already have an account?' : 'New to Pulse?'} <button id="auth-switch">${authMode === 'signup' ? 'Sign in' : 'Create an account'}</button></div>`}<footer>Pulse is in early access. Messages are stored on the Pulse server.</footer></section></main>`;
  app.querySelector<HTMLButtonElement>('#auth-switch')?.addEventListener('click', () => { authMode = authMode === 'signup' ? 'login' : 'signup'; authPhase = 'credentials'; pendingAuth = undefined; authError = ''; renderAuth(); });
  app.querySelector<HTMLButtonElement>('#auth-back')?.addEventListener('click', () => { authPhase = 'credentials'; pendingAuth = undefined; authError = ''; renderAuth(); });
  app.querySelector<HTMLButtonElement>('#auth-resend')?.addEventListener('click', async () => {
    if (!pendingAuth?.email) return;
    busy = true; authError = ''; renderAuth();
    try { const result = await api<{ challengeId: string }>('/auth/email-code', { method: 'POST', body: JSON.stringify({ email: pendingAuth.email, username: pendingAuth.username, purpose: 'signup' }) }); pendingAuth.challengeId = result.challengeId; }
    catch (error) { authError = error instanceof Error ? error.message : 'Could not resend code.'; }
    finally { busy = false; renderAuth(); }
  });
  app.querySelector<HTMLFormElement>('#auth-form')!.onsubmit = async e => {
    e.preventDefault(); const form = new FormData(e.currentTarget as HTMLFormElement); busy = true; authError = ''; renderAuth();
    try {
      if (authPhase === 'credentials' && authMode === 'signup') {
        const email = String(form.get('email') || '').trim().toLowerCase(); const username = String(form.get('username') || '').trim(); const password = String(form.get('password') || '');
        const result = await api<{ challengeId: string }>('/auth/email-code', { method: 'POST', body: JSON.stringify({ email, username, purpose: 'signup' }) });
        pendingAuth = { challengeId: result.challengeId, email, username, password }; authPhase = 'verify-email';
      } else if (authPhase === 'credentials') {
        const result = await api<{ token?: string; user?: User; requiresTwoFactor?: boolean; challengeId?: string }>('/login', { method: 'POST', body: JSON.stringify({ username: form.get('username'), password: form.get('password') }) });
        if (result.requiresTwoFactor && result.challengeId) { pendingAuth = { challengeId: result.challengeId }; authPhase = 'verify-two-factor'; }
        else if (result.token && result.user) await completeSignIn({ token: result.token, user: result.user });
      } else if (pendingAuth) {
        const verified = await api<{ emailProof?: string; token?: string; user?: User }>('/auth/verify-code', { method: 'POST', body: JSON.stringify({ challengeId: pendingAuth.challengeId, code: form.get('code') }) });
        if (authPhase === 'verify-email' && verified.emailProof) {
          const created = await api<{ token: string; user: User }>('/signup', { method: 'POST', body: JSON.stringify({ username: pendingAuth.username, email: pendingAuth.email, password: pendingAuth.password, emailProof: verified.emailProof }) });
          await completeSignIn(created);
        } else if (authPhase === 'verify-two-factor' && verified.token && verified.user) await completeSignIn({ token: verified.token, user: verified.user });
      }
    } catch (error) { authError = error instanceof Error ? error.message : 'Pulse could not complete that request.'; }
    finally { busy = false; if (!me) renderAuth(); }
  };
}

async function completeSignIn(result: { token: string; user: User }) {
  token = result.token; me = await hydrateProfile(result.user); localStorage.setItem('pulse.authToken', token); pendingAuth = undefined; authPhase = 'credentials';
  try { await initializeAccountCrypto(me); } catch (error) { notice = `Encryption setup failed: ${error instanceof Error ? error.message : 'try signing in again'}`; }
  await refreshFriends(); render();
}

async function fetchProfile(user: User): Promise<User> {
  const result = await api<{ profile: Pick<User, 'displayName' | 'avatar' | 'banner'> }>(`/profile/${encodeURIComponent(user.id)}`);
  return { ...user, ...result.profile };
}
async function hydrateProfile(user: User): Promise<User> {
  try { return await fetchProfile(user); } catch { return user; }
}
async function refreshFriends() {
  const previous = new Map(friends.friends.map(friend => [friend.id, friend]));
  const updated = await api<Friends>('/friends');
  updated.friends = await Promise.all(updated.friends.map(async friend => {
    const cached = previous.get(friend.id);
    return cached && cached.profileVersion === friend.profileVersion ? { ...friend, avatar: cached.avatar, banner: cached.banner } : hydrateProfile(friend);
  }));
  friends = updated;
  if (activeFriend) activeFriend = friends.friends.find(friend => friend.id === activeFriend!.id) || activeFriend;
}
const displayName = (user: User) => user.displayName?.trim() || user.username;
const avatar = (user: User, className = '') => `<span class="avatar ${className}"${user.avatar ? ` style="background-image:url('${esc(user.avatar)}');background-size:cover;background-position:center;color:transparent"` : ''}>${user.avatar ? '' : esc(displayName(user)[0]?.toUpperCase() || '?')}</span>`;
function readImage(file: File | undefined, maxBytes: number, label: string): Promise<string | undefined> {
  if (!file) return Promise.resolve(undefined);
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return Promise.reject(new Error(`${label} must be PNG, JPEG, or WebP.`));
  if (file.size > maxBytes) return Promise.reject(new Error(`${label} must be smaller than ${Math.round(maxBytes / 1024)} KB.`));
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error(`Could not read ${label.toLowerCase()}.`)); reader.readAsDataURL(file); });
}
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
  try {
    const key = await voiceEncryptionKey(me.id, activeFriend.id, fetchFriendKey);
    voiceRoom = chatRoom(activeFriend);
    await voice.join(endpoint, voiceRoom, activeFriend.id, token, key);
  } catch (error) { showError(error); }
}

function render() {
  if (!me) { renderAuth(); return; }
  if (settingsOpen) { renderSettings(); return; }
  app.classList.remove('settings-view');
  const draft = app.querySelector<HTMLInputElement>('#message-input')?.value || '';
  const wasComposing = document.activeElement === app.querySelector<HTMLInputElement>('#message-input');
  const friend = activeFriend;
  const callActive = voiceState === 'connected' || voiceState === 'waiting' || voiceState === 'connecting';
  app.innerHTML = `<aside class="rail"><div class="brand-mark">P<span>·</span></div><div class="rail-divider"></div><button class="server active" title="Friends">F</button><div class="rail-bottom">${avatar(me, 'me')}</div></aside>
  <aside class="sidebar"><header class="side-header"><div><div class="eyebrow">PULSE</div><div class="space-title">Friends</div></div></header>
    <label class="search"><span>⌕</span><input id="friend-search" placeholder="Find a friend"/><kbd>⌕</kbd></label>
    <div class="side-scroll"><section><div class="section-title">FRIENDS <span>${friends.friends.length}</span></div>${friends.friends.map(f => `<div class="friend-list-row"><button class="nav-item dm-item ${friend?.id === f.id ? 'selected' : ''}" data-friend="${esc(f.id)}">${avatar(f, 'tiny')}<span>${esc(displayName(f))}</span></button><button class="friend-call" data-call-friend="${esc(f.id)}" title="Call ${esc(displayName(f))}" aria-label="Call ${esc(displayName(f))}">☎</button></div>`).join('') || '<p class="side-empty">Add someone by their username to start chatting.</p>'}</section>
    <section><div class="section-title">FRIEND REQUESTS <span>${friends.incoming.length}</span></div>${friends.incoming.map(f => `<div class="request-row"><span>${esc(f.username)}</span><button class="accept-button" data-accept="${esc(f.id)}">Accept</button></div>`).join('') || '<p class="side-empty">No new requests.</p>'}${friends.outgoing.map(f => `<p class="side-empty">Request sent to ${esc(f.username)}</p>`).join('')}</section>
    <section><div class="section-title">ADD A FRIEND</div><form id="add-friend" class="add-friend"><input name="username" required maxlength="24" placeholder="Pulse username"/><button title="Send friend request">＋</button></form></section></div>
    <div class="profile">${avatar(me, 'me')}<div class="profile-copy"><strong>${esc(displayName(me))}</strong><small>@${esc(me.username)}</small></div><button class="icon-button" id="settings-open" title="Settings" aria-label="Settings">⚙</button><button class="icon-button" id="logout-bottom" title="Sign out" aria-label="Sign out">↪</button></div></aside>
  <main class="main"><header class="chat-header"><div class="chat-heading"><span class="head-hash">${friend ? avatar(friend, 'tiny') : '✦'}</span><div><h1>${friend ? esc(displayName(friend)) : 'Your friends'}</h1><p>${friend ? 'Direct message' : 'Find people you know on Pulse'}</p></div></div><div class="header-actions">${friend ? `<button id="call-button" class="call-button ${callActive ? 'call-active' : ''}" ${cryptoReady ? '' : 'disabled'}>${callActive ? 'End call' : 'Call'}</button>` : ''}</div></header>
    <div class="message-area" id="messages">${friend ? (messages.length ? messages.map(m => `<article class="message ${m.from.id === me!.id ? 'own' : ''}">${avatar(m.from, 'message-avatar')}<div class="message-body"><div class="message-meta"><strong>${esc(displayName(m.from))}</strong><time>${time(m.createdAt)}</time></div><p>${esc(m.text)}</p></div></article>`).join('') : `<div class="empty-chat"><div class="welcome-icon">✦</div><h2>Say hello to ${esc(displayName(friend))}</h2><p>Messages in this conversation will appear here.</p></div>`) : `<div class="welcome"><div class="welcome-icon">✦</div><h2>Welcome to Pulse, ${esc(displayName(me))}</h2><p>Add a friend by username. Once they accept, you can chat and join a voice call.</p></div>`}</div>
    ${friend ? `<form id="composer" class="composer"><button type="button" class="attach" title="Attachments are not available yet" disabled>＋</button><input id="message-input" maxlength="4096" autocomplete="off" placeholder="Message ${esc(friend.username)}"/><button class="send" type="submit" title="Send encrypted message" ${cryptoReady ? '' : 'disabled'}>↑</button><div class="composer-hint">🔒 End-to-end encrypted</div></form>` : ''}
  </main><aside class="rightbar"><div class="right-title">YOUR ACCOUNT</div><div class="account-info">${avatar(me, '')}<strong>${esc(displayName(me))}</strong><small>@${esc(me.username)}</small>${me.banner ? `<div class="account-banner" style="background-image:url('${esc(me.banner)}')"></div>` : ''}<p>Share your username with friends so they can find you.</p><button class="text-button" id="settings-right">Edit profile</button></div>
    ${friend ? `<div class="voice-card ${voiceState === 'connected' ? 'connected' : ''}"><div class="voice-top"><span class="voice-dot"></span><strong>Encrypted voice</strong></div><div class="voice-room"><span>◖))</span><span>${esc(friend.username)}</span><span class="voice-count">${voicePeers.length ? voicePeers.length + 1 : '—'}</span></div><div class="voice-status ${voiceState === 'error' ? 'voice-error' : ''}">${esc(voiceMessage)}</div><div class="voice-controls">${callActive ? `<button id="voice-mute" class="voice-mute">${voiceMuted ? 'Unmute' : 'Mute'}</button>` : ''}<button id="voice-toggle" class="voice-button">${callActive ? 'End call' : 'Call'}${voiceState === 'connecting' ? 'ing…' : ''}</button></div><details class="voice-settings"><summary>Call setup</summary><label class="voice-setting">Signaling server<input id="voice-endpoint" value="${esc(signalUrl())}" spellcheck="false"/></label><small>Calls are authorized through your Pulse account. You do not need a shared voice token.</small></details></div>` : '<div class="empty-help">Choose a friend to open a DM and voice call.</div>'}
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
  app.querySelector<HTMLButtonElement>('#settings-open')?.addEventListener('click', () => { settingsOpen = true; render(); });
  app.querySelector<HTMLButtonElement>('#settings-right')?.addEventListener('click', () => { settingsOpen = true; render(); });
  app.querySelector<HTMLButtonElement>('#logout-bottom')?.addEventListener('click', () => void signOut());
  const friendSearch = app.querySelector<HTMLInputElement>('#friend-search');
  friendSearch?.addEventListener('input', () => { const query = friendSearch.value.trim().toLowerCase(); app.querySelectorAll<HTMLButtonElement>('[data-friend]').forEach(button => { button.hidden = !button.textContent?.toLowerCase().includes(query); }); });
  const composer = app.querySelector<HTMLFormElement>('#composer');
  if (composer && friend) composer.onsubmit = async e => { e.preventDefault(); const input = app.querySelector<HTMLInputElement>('#message-input')!; const text = input.value.trim(); if (!text) return; input.disabled = true; try { const envelope = await encryptMessage(me!.id, friend.id, text, fetchFriendKey); await api('/messages', { method: 'POST', body: JSON.stringify({ to: friend.username, ...envelope }) }); input.value = ''; await refreshMessages(); render(); app.querySelector<HTMLInputElement>('#message-input')?.focus(); } catch (error) { showError(error); input.disabled = false; } };
  app.querySelector<HTMLButtonElement>('#voice-toggle')?.addEventListener('click', () => void toggleCall());
  app.querySelector<HTMLButtonElement>('#call-button')?.addEventListener('click', () => void toggleCall());
  app.querySelector<HTMLButtonElement>('#show-key-codes')?.addEventListener('click', async () => { try { const codes = await safetyCodes(friend!.id, fetchFriendKey); window.alert(`Compare these codes with ${friend!.username} over a separate trusted channel. They should match exactly.\n\nYour code: ${codes.own}\nTheir code: ${codes.friend}`); } catch (error) { showError(error); } });
  app.querySelector<HTMLButtonElement>('#voice-mute')?.addEventListener('click', () => { voiceMuted = voice.toggleMute(); render(); });
  app.querySelector<HTMLInputElement>('#voice-endpoint')?.addEventListener('change', e => localStorage.setItem('pulse.signalUrl', (e.currentTarget as HTMLInputElement).value.trim()));
  const nextDraft = app.querySelector<HTMLInputElement>('#message-input');
  if (nextDraft && draft) { nextDraft.value = draft; if (wasComposing) nextDraft.focus(); }
  const area = app.querySelector('#messages'); if (area && friend) area.scrollTop = area.scrollHeight;
}

function showError(error: unknown) { notice = error instanceof Error ? error.message : 'Something went wrong.'; render(); window.setTimeout(() => { notice = ''; app.querySelector('.toast')?.classList.remove('show'); }, 3500); }

async function signOut() {
  try { await api('/logout', { method: 'POST', body: '{}' }); } catch {}
  token = ''; me = undefined; activeFriend = undefined; settingsOpen = false;
  localStorage.removeItem('pulse.authToken'); voice.leave(); renderAuth();
}

function renderSettings() {
  if (!me) return;
  app.classList.add('settings-view');
  app.innerHTML = `<aside class="rail"><div class="brand-mark">P<span>·</span></div><div class="rail-divider"></div><button class="server" id="friends-open" title="Friends" aria-label="Friends">F</button><div class="rail-bottom">${avatar(me, 'me')}</div></aside>
  <aside class="sidebar"><header class="side-header"><div><div class="eyebrow">PULSE</div><div class="space-title">Settings</div></div></header><div class="settings-nav"><button class="settings-nav-item active">Profile</button><small>ACCOUNT</small><div class="settings-account">${avatar(me, '')}<span><strong>${esc(displayName(me))}</strong><small>@${esc(me.username)}</small></span></div></div><div class="profile">${avatar(me, 'me')}<div class="profile-copy"><strong>${esc(displayName(me))}</strong><small>@${esc(me.username)}</small></div><button class="icon-button" id="logout-settings" title="Sign out" aria-label="Sign out">↪</button></div></aside>
  <main class="main settings-main"><header class="chat-header"><div class="chat-heading"><div><h1>Profile settings</h1><p>Make your Pulse profile yours.</p></div></div><button class="mobile-signout" id="logout-settings-mobile" type="button">Sign out</button></header><div class="settings-scroll"><form id="profile-form" class="settings-form"><section class="settings-section"><div class="settings-section-heading"><div><h2>Profile appearance</h2><p>Choose a picture and banner your friends will see.</p></div></div>
    <label class="banner-preview" id="banner-preview" style="${me.banner ? `background-image:url('${esc(me.banner)}')` : ''}"><span>Profile banner</span><input type="file" id="banner-file" accept="image/png,image/jpeg,image/webp" aria-label="Choose banner image"></label>
    <div class="avatar-editor"><label class="profile-avatar-picker" title="Choose profile picture">${avatar(me, 'profile-large')}<span>Change</span><input type="file" id="avatar-file" accept="image/png,image/jpeg,image/webp" aria-label="Choose profile picture"></label><button type="button" class="text-button" id="clear-avatar" ${me.avatar ? '' : 'hidden'}>Remove</button></div>
    <label class="field-label">Display name<input name="displayName" required minlength="1" maxlength="40" value="${esc(displayName(me))}" placeholder="What should friends call you?"></label>
    <label class="field-label">Username<div class="readonly-field">@${esc(me.username)}<small>Your username is used to sign in and add friends.</small></div></label>
    <div class="settings-form-error" id="profile-error" role="alert"></div><div class="settings-form-actions"><span>PNG, JPEG, or WebP · picture up to 256 KB · banner up to 768 KB</span><button class="primary-button" type="submit">Save changes</button></div>
  </section></form><section class="settings-section security-section"><div class="settings-section-heading"><div><h2>Sign-in security</h2><p>Email sign-in and an optional second step for new sign-ins.</p></div></div>
    <label class="field-label">Email address<input id="security-email" type="email" maxlength="254" value="${esc(me.email || '')}" placeholder="you@example.com" autocomplete="email"></label><div class="security-status ${me.emailVerified ? 'verified' : ''}">${me.emailVerified ? 'Verified · email can be used to sign in' : me.email ? 'Not verified yet' : 'Add and verify an email to enable email sign-in'}</div><button type="button" class="secondary-button" id="verify-email-button">${me.emailVerified ? 'Change or re-verify email' : 'Send verification code'}</button>
    <div class="twofactor-row"><div><strong>Two-factor authentication</strong><p>${me.twoFactorEnabled ? 'A code is required for every new sign-in.' : 'Require an email code after your password.'}</p></div><button type="button" class="secondary-button" id="twofactor-button" ${me.emailVerified ? '' : 'disabled'}>${me.twoFactorEnabled ? 'Turn off' : 'Turn on'}</button></div>
    ${securityChallenge ? `<label class="field-label">Code sent to ${esc(securityChallenge.email)}<input id="security-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="6-digit code"></label><button type="button" class="primary-button security-verify" id="security-verify">Verify code</button>` : ''}<div class="settings-form-error" role="alert">${esc(securityError)}</div>
  </section><section class="settings-section update-section"><div class="settings-section-heading"><div><h2>Beta access</h2><p>Preview upcoming Pulse builds before they reach everyone.</p></div></div><label class="beta-setting"><span><strong>Check for beta updates</strong><small>At startup, Pulse will ask before installing an available beta.</small></span><input id="beta-access" type="checkbox" ${localStorage.getItem('pulse.betaAccess') === 'true' ? 'checked' : ''}><span class="toggle-track" aria-hidden="true"></span></label></section></div></main><div class="toast ${notice ? 'show' : ''}">${esc(notice)}</div>`;
  let avatarData: string | undefined; let bannerData: string | undefined; let clearAvatar = false;
  app.querySelector<HTMLButtonElement>('#friends-open')!.onclick = () => { settingsOpen = false; render(); };
  app.querySelector<HTMLButtonElement>('#logout-settings')!.onclick = () => void signOut();
  app.querySelector<HTMLButtonElement>('#logout-settings-mobile')!.onclick = () => void signOut();
  app.querySelector<HTMLInputElement>('#beta-access')!.onchange = event => { localStorage.setItem('pulse.betaAccess', String((event.currentTarget as HTMLInputElement).checked)); };
  app.querySelector<HTMLButtonElement>('#verify-email-button')!.onclick = async () => {
    try { const email = (app.querySelector<HTMLInputElement>('#security-email')!.value || '').trim().toLowerCase(); const result = await api<{ challengeId: string }>('/auth/email-code', { method: 'POST', body: JSON.stringify({ email, purpose: 'verify-email' }) }); securityChallenge = { challengeId: result.challengeId, purpose: 'verify-email', email }; securityError = ''; renderSettings(); }
    catch (error) { securityError = error instanceof Error ? error.message : 'Could not send verification code.'; renderSettings(); }
  };
  app.querySelector<HTMLButtonElement>('#twofactor-button')!.onclick = async () => {
    if (!me?.email) { securityError = 'Add and verify your email first.'; renderSettings(); return; }
    try { const purpose = me.twoFactorEnabled ? 'disable-2fa' : 'enable-2fa'; const result = await api<{ challengeId: string }>('/auth/email-code', { method: 'POST', body: JSON.stringify({ email: me.email, purpose }) }); securityChallenge = { challengeId: result.challengeId, purpose, email: me.email }; securityError = ''; renderSettings(); }
    catch (error) { securityError = error instanceof Error ? error.message : 'Could not send two-factor code.'; renderSettings(); }
  };
  app.querySelector<HTMLButtonElement>('#security-verify')?.addEventListener('click', async () => {
    if (!securityChallenge) return;
    try { const result = await api<{ user?: User }>('/auth/verify-code', { method: 'POST', body: JSON.stringify({ challengeId: securityChallenge.challengeId, code: app.querySelector<HTMLInputElement>('#security-code')!.value }) }); if (result.user) me = { ...me!, ...result.user }; securityChallenge = undefined; securityError = ''; notice = 'Sign-in security updated.'; renderSettings(); }
    catch (error) { securityError = error instanceof Error ? error.message : 'Could not verify code.'; renderSettings(); }
  });
  app.querySelector<HTMLInputElement>('#avatar-file')!.onchange = async event => {
    try { avatarData = await readImage((event.currentTarget as HTMLInputElement).files?.[0], 256 * 1024, 'Profile picture'); clearAvatar = false; const preview = app.querySelector('.profile-large') as HTMLElement; if (avatarData) { preview.style.backgroundImage = `url('${avatarData}')`; preview.style.backgroundSize = 'cover'; preview.textContent = ''; app.querySelector<HTMLButtonElement>('#clear-avatar')!.hidden = false; } }
    catch (error) { app.querySelector('#profile-error')!.textContent = error instanceof Error ? error.message : 'Could not read picture.'; }
  };
  app.querySelector<HTMLInputElement>('#banner-file')!.onchange = async event => {
    try { bannerData = await readImage((event.currentTarget as HTMLInputElement).files?.[0], 768 * 1024, 'Banner'); if (bannerData) (app.querySelector('#banner-preview') as HTMLElement).style.backgroundImage = `url('${bannerData}')`; }
    catch (error) { app.querySelector('#profile-error')!.textContent = error instanceof Error ? error.message : 'Could not read banner.'; }
  };
  app.querySelector<HTMLButtonElement>('#clear-avatar')!.onclick = () => { clearAvatar = true; avatarData = ''; const preview = app.querySelector('.profile-large') as HTMLElement; preview.style.backgroundImage = ''; preview.textContent = displayName(me!)[0].toUpperCase(); };
  app.querySelector<HTMLFormElement>('#profile-form')!.onsubmit = async event => {
    event.preventDefault(); const form = new FormData(event.currentTarget as HTMLFormElement); const submit = app.querySelector<HTMLButtonElement>('#profile-form button[type=submit]')!; submit.disabled = true;
    try { const result = await api<{ user: User; profile: Pick<User, 'avatar' | 'banner'> }>('/profile', { method: 'POST', body: JSON.stringify({ displayName: form.get('displayName'), ...(avatarData !== undefined ? { avatar: avatarData } : clearAvatar ? { avatar: '' } : {}), ...(bannerData !== undefined ? { banner: bannerData } : {}) }) }); me = { ...result.user, ...result.profile }; notice = 'Profile saved.'; await refreshFriends(); renderSettings(); }
    catch (error) { app.querySelector('#profile-error')!.textContent = error instanceof Error ? error.message : 'Could not save your profile.'; submit.disabled = false; }
  };
}

async function start() {
  if (token) {
    try { me = await hydrateProfile((await api<{ user: User }>('/me')).user); try { await initializeAccountCrypto(me); } catch (error) { notice = `Encryption setup failed: ${error instanceof Error ? error.message : 'sign in again to retry'}`; } await refreshFriends(); render(); }
    catch { token = ''; localStorage.removeItem('pulse.authToken'); renderAuth(); }
  } else renderAuth();
  window.setTimeout(() => { void checkDesktopUpdates(); }, 8000);
  window.setInterval(async () => {
    if (!me) return;
    try { const previousIncoming = friends.incoming.map(f => `${f.id}:${f.displayName}`).join(); const previousFriends = friends.friends.map(f => `${f.id}:${f.profileVersion}:${f.displayName}`).join(); await refreshFriends(); if (previousIncoming !== friends.incoming.map(f => `${f.id}:${f.displayName}`).join() || previousFriends !== friends.friends.map(f => `${f.id}:${f.profileVersion}:${f.displayName}`).join()) render(); if (activeFriend) await refreshMessages(); }
    catch (error) { if (error instanceof Error && error.message === 'Sign in to continue.') { token = ''; me = undefined; localStorage.removeItem('pulse.authToken'); renderAuth(); } }
  }, 3000);
}

async function checkDesktopUpdates() {
  if (!('__TAURI_INTERNALS__' in window)) return;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const betaAccess = localStorage.getItem('pulse.betaAccess') === 'true';
    const update = await check({ headers: { 'X-Pulse-Channel': betaAccess ? 'beta' : 'stable' } });
    if (!update) return;
    if (betaAccess && !window.confirm(`Pulse beta ${update.version} is available. Install it now?${update.body ? `\n\n${update.body}` : ''}`)) return;
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
