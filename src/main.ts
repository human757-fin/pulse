import './style.css';
import { decryptMessage, encryptMessage, initializeIdentity, voiceEncryptionKey } from './crypto';
import { VoiceClient, type VoiceState, type VoiceUpdate } from './voice';

type User = { id: string; username: string; email?: string; emailVerified?: boolean; twoFactorEnabled?: boolean; displayName?: string; bio?: string; profileVersion?: string; avatar?: string; banner?: string };
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
let settingsTab: 'profile' | 'security' | 'updates' = 'profile';
let friendsPanel: 'friends' | 'requests' | 'add' = 'friends';
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
  app.innerHTML = `<main class="auth-page"><section class="auth-card"><div class="auth-brand"><img src="/pulse-mark.svg" alt=""><span>Pulse</span></div><div class="eyebrow">YOUR SPACE, YOUR PEOPLE</div><h1>${title}</h1><p class="auth-subtitle">${subtitle}</p><form id="auth-form" class="auth-form">${fields}<p class="form-error">${esc(authError)}</p><button class="primary-button" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Please wait…' : authPhase === 'verify-email' ? 'Verify email' : authPhase === 'verify-two-factor' ? 'Verify and sign in' : authMode === 'signup' ? 'Send verification code' : 'Sign in'}</button></form>${verification ? `<div class="auth-switch">${authPhase === 'verify-email' ? '<button id="auth-resend">Resend code</button>' : ''}<button id="auth-back">Back</button></div>` : `<div class="auth-switch">${authMode === 'signup' ? 'Already have an account?' : 'New to Pulse?'} <button id="auth-switch">${authMode === 'signup' ? 'Sign in' : 'Create an account'}</button></div>`}<footer>Pulse is in early access. Messages are stored on the Pulse server.</footer></section></main>`;
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
  const result = await api<{ profile: Pick<User, 'displayName' | 'bio' | 'avatar' | 'banner'> }>(`/profile/${encodeURIComponent(user.id)}`);
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
const attachmentPrefix = 'PULSE_ATTACHMENT_V1:';
function messageBody(text: string) {
  if (!text.startsWith(attachmentPrefix)) return `<p>${esc(text)}</p>`;
  try {
    const file = JSON.parse(text.slice(attachmentPrefix.length)) as { name?: string; type?: string; data?: string };
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain'];
    if (!file.name || !allowed.includes(file.type || '') || !file.data || !/^data:(?:image\/(?:png|jpeg|webp|gif)|application\/pdf|text\/plain);base64,[A-Za-z0-9+/]+={0,2}$/.test(file.data) || !file.data.startsWith(`data:${file.type};base64,`)) throw new Error('invalid attachment');
    const name = esc(file.name.slice(0, 120)); const url = esc(file.data);
    if ((file.type || '').startsWith('image/')) return `<div class="message-attachment"><a href="${url}" download="${name}"><img class="message-attachment-image" src="${url}" alt="${name}"/></a><a class="attachment-name" href="${url}" download="${name}">${name}</a></div>`;
    return `<div class="message-attachment-file"><span class="attachment-file-icon">${file.type === 'application/pdf' ? 'PDF' : 'TXT'}</span><a href="${url}" download="${name}">${name}</a></div>`;
  } catch { return '<p>Could not display this attachment.</p>'; }
}
function readImage(file: File | undefined, maxBytes: number, label: string, allowGif = false): Promise<string | undefined> {
  if (!file) return Promise.resolve(undefined);
  if (!['image/png', 'image/jpeg', 'image/webp', ...(allowGif ? ['image/gif'] : [])].includes(file.type)) return Promise.reject(new Error(`${label} must be PNG, JPEG, WebP${allowGif ? ', or GIF' : ''}.`));
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
function leaveCall() { voiceRoom = ''; voiceMuted = false; voice.leave(); }

function readAttachment(file: File): Promise<string> {
  const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain'];
  if (!allowed.includes(file.type)) return Promise.reject(new Error('Choose an image, PDF, or plain-text file.'));
  if (file.size > 512 * 1024) return Promise.reject(new Error('Attachments must be 512 KB or smaller.'));
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Could not read that attachment.')); reader.readAsDataURL(file); });
}

function render() {
  if (!me) { renderAuth(); return; }
  if (settingsOpen) { renderSettings(); return; }
  app.classList.remove('settings-view');
  const draft = app.querySelector<HTMLInputElement>('#message-input')?.value || '';
  const wasComposing = document.activeElement === app.querySelector<HTMLInputElement>('#message-input');
  const friend = activeFriend;
  const callActive = voiceState === 'connected' || voiceState === 'waiting' || voiceState === 'connecting';
  const friendIsInCall = !!friend && voicePeers.some(peer => peer.toLowerCase() === friend.username.toLowerCase());
  const callStage = friend && callActive ? `<section class="call-view"><div class="call-view-heading"><span class="call-live-dot"></span><div><h2>${voiceState === 'connected' ? 'Voice call connected' : voiceState === 'connecting' ? 'Joining call…' : 'Waiting for your friend'}</h2><p>${esc(voiceMessage)}</p></div></div><div class="call-participants"><article class="call-participant ${voiceState === 'connected' ? 'speaking-ready' : ''}">${avatar(me!, 'call-avatar')}<strong>${esc(displayName(me!))}</strong><span>You · ${voiceMuted ? 'Muted' : 'Microphone on'}</span></article><article class="call-participant ${friendIsInCall ? 'speaking-ready' : ''}">${avatar(friend, 'call-avatar')}<strong>${esc(displayName(friend))}</strong><span>${friendIsInCall ? 'In call' : 'Waiting to join'}</span></article></div><div class="call-controls"><button type="button" id="call-mute" class="call-control ${voiceMuted ? 'muted' : ''}">${voiceMuted ? 'Unmute mic' : 'Mute mic'}</button><button type="button" id="call-leave" class="call-control leave-call">Leave call</button></div><details class="call-settings"><summary>Call connection settings</summary><label class="voice-setting">Signaling server<input id="voice-endpoint" value="${esc(signalUrl())}" spellcheck="false"/></label><small>Pulse calls are encrypted and authorized through your account.</small></details></section>` : '';
  const friendProfile = friend ? `<div class="profile-banner" ${friend.banner ? `style="background-image:url('${esc(friend.banner)}')"` : ''}></div><div class="profile-detail-avatar">${avatar(friend, 'profile-detail-pic')}</div><section class="profile-detail-copy"><h2>${esc(displayName(friend))}</h2><span>@${esc(friend.username)}</span><p>${esc(friend.bio || 'No bio yet.')}</p></section><div class="profile-divider"></div><div class="profile-detail-meta"><strong>Pulse member</strong><span>Direct message</span></div>` : `<div class="profilebar-empty"><div class="welcome-icon">✦</div><strong>Your conversation</strong><p>Choose a friend to see their profile here.</p></div>`;
  const friendsTitle = friendsPanel === 'requests' ? 'Friend requests' : friendsPanel === 'add' ? 'Add a friend' : 'Friends';
  const friendPanelContent = friendsPanel === 'friends'
    ? `<div class="section-title">FRIENDS <span>${friends.friends.length}</span></div>${friends.friends.map(f => `<div class="friend-list-row"><button class="nav-item dm-item ${friend?.id === f.id ? 'selected' : ''}" data-friend="${esc(f.id)}">${avatar(f, 'tiny')}<span>${esc(displayName(f))}</span></button><button class="friend-call" data-call-friend="${esc(f.id)}" title="Call ${esc(displayName(f))}" aria-label="Call ${esc(displayName(f))}">☎</button></div>`).join('') || '<p class="side-empty">Your friends will show up here.</p>'}`
    : friendsPanel === 'requests'
      ? `<div class="section-title">INCOMING <span>${friends.incoming.length}</span></div>${friends.incoming.map(f => `<div class="request-row"><span>${esc(f.username)}</span><button class="accept-button" data-accept="${esc(f.id)}">Accept</button></div>`).join('') || '<p class="side-empty">No new requests.</p>'}<div class="section-title">SENT</div>${friends.outgoing.map(f => `<p class="side-empty">Request sent to ${esc(f.username)}</p>`).join('') || '<p class="side-empty">No pending requests.</p>'}`
      : `<p class="side-empty add-friend-help">Add someone by their Pulse username. They’ll appear in Friends after they accept.</p><form id="add-friend" class="add-friend"><input name="username" required minlength="3" maxlength="24" placeholder="Pulse username"/><button title="Send friend request" aria-label="Send friend request">＋</button></form>`;
  app.innerHTML = `<aside class="rail"><button class="brand-mark brand-tab ${!settingsOpen ? 'active' : ''}" id="friends-home" title="Friends" aria-label="Friends"><img class="app-mark" src="/pulse-mark.svg" alt=""></button><div class="rail-divider"></div><div class="rail-bottom"><button class="account-tab" id="settings-open" title="Open settings" aria-label="Open settings">${avatar(me, 'me')}</button></div></aside>
  <aside class="sidebar"><header class="side-header"><div><div class="eyebrow">PULSE</div><div class="space-title">${friendsTitle}</div></div></header>
    ${friendsPanel === 'friends' ? '<label class="search"><span>⌕</span><input id="friend-search" placeholder="Find a friend"/><kbd>⌕</kbd></label>' : ''}
    <nav class="friend-tabs" aria-label="Friends navigation"><button class="friend-tab ${friendsPanel === 'friends' ? 'active' : ''}" data-friends-panel="friends">Friends</button><button class="friend-tab ${friendsPanel === 'requests' ? 'active' : ''}" data-friends-panel="requests">Requests <span>${friends.incoming.length}</span></button><button class="friend-tab ${friendsPanel === 'add' ? 'active' : ''}" data-friends-panel="add">Add friend</button></nav>
    <div class="side-scroll"><section>${friendPanelContent}</section></div><div class="sidebar-settings"><button class="settings-open" id="settings-open-sidebar"><span>⚙</span> Settings</button></div></aside>
  <main class="main ${callActive && friend ? 'in-call' : ''}"><header class="chat-header"><div class="chat-heading"><span class="head-hash">${friend ? avatar(friend, 'tiny') : '✦'}</span><div><h1>${friend ? esc(displayName(friend)) : friendsTitle}</h1><p>${friend ? esc(friend.bio || 'Direct message') : friendsPanel === 'friends' ? 'Chat and call your friends.' : friendsTitle}</p></div></div><div class="header-actions">${friend && !callActive ? `<button id="call-button" class="call-button" ${cryptoReady ? '' : 'disabled'}>Call</button>` : ''}</div></header>
    ${callActive && friend ? callStage : `<div class="message-area" id="messages">${friend ? (messages.length ? messages.map(m => `<article class="message ${m.from.id === me!.id ? 'own' : ''}">${avatar(m.from, 'message-avatar')}<div class="message-body"><div class="message-meta"><strong>${esc(displayName(m.from))}</strong><time>${time(m.createdAt)}</time></div>${messageBody(m.text)}</div></article>`).join('') : `<div class="empty-chat"><div class="welcome-icon">✦</div><h2>Say hello to ${esc(displayName(friend))}</h2><p>Messages in this conversation will appear here.</p></div>`) : `<div class="welcome"><div class="welcome-icon">✦</div><h2>${friendsPanel === 'friends' ? `Welcome to Pulse, ${esc(displayName(me))}` : friendsPanel === 'requests' ? 'Friend requests' : 'Add a friend'}</h2><p>${friendsPanel === 'friends' ? 'Choose a friend to start chatting, or send a request to someone new.' : friendsPanel === 'requests' ? 'Incoming requests appear in the sidebar. Accept one to start chatting.' : 'Enter a Pulse username in the sidebar to send a friend request.'}</p></div>`}</div>`}
    ${friend && !callActive ? `<form id="composer" class="composer"><button type="button" class="attach" id="attach-button" title="Attach an image, PDF, or text file" aria-label="Attach a file">＋</button><input id="attachment-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain" hidden/><input id="message-input" maxlength="4096" autocomplete="off" placeholder="Message ${esc(friend.username)}"/><button class="send" type="submit" title="Send encrypted message" ${cryptoReady ? '' : 'disabled'}>↑</button><div class="composer-hint">🔒 End-to-end encrypted</div></form>` : ''}
  </main><aside class="profilebar">${friendProfile}</aside><div class="toast ${notice ? 'show' : ''}">${esc(notice)}</div>`;

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
  app.querySelector<HTMLFormElement>('#add-friend')?.addEventListener('submit', async e => { e.preventDefault(); const form = new FormData(e.currentTarget as HTMLFormElement); try { await api('/friends', { method: 'POST', body: JSON.stringify({ username: form.get('username') }) }); await refreshFriends(); notice = 'Friend request sent.'; friendsPanel = 'requests'; render(); } catch (error) { showError(error); } });
  app.querySelectorAll<HTMLButtonElement>('[data-friends-panel]').forEach(button => button.onclick = () => { friendsPanel = button.dataset.friendsPanel as typeof friendsPanel; if (friendsPanel !== 'friends') { activeFriend = undefined; messages = []; } render(); });
  app.querySelector<HTMLButtonElement>('#friends-home')?.addEventListener('click', () => { settingsOpen = false; friendsPanel = 'friends'; render(); });
  const openSettings = () => { settingsOpen = true; settingsTab = 'profile'; render(); };
  app.querySelector<HTMLButtonElement>('#settings-open')?.addEventListener('click', openSettings);
  app.querySelector<HTMLButtonElement>('#settings-open-sidebar')?.addEventListener('click', openSettings);
  const friendSearch = app.querySelector<HTMLInputElement>('#friend-search');
  friendSearch?.addEventListener('input', () => { const query = friendSearch.value.trim().toLowerCase(); app.querySelectorAll<HTMLButtonElement>('[data-friend]').forEach(button => { button.hidden = !button.textContent?.toLowerCase().includes(query); }); });
  const composer = app.querySelector<HTMLFormElement>('#composer');
  if (composer && friend) composer.onsubmit = async e => { e.preventDefault(); const input = app.querySelector<HTMLInputElement>('#message-input')!; const text = input.value.trim(); if (!text) return; input.disabled = true; try { const envelope = await encryptMessage(me!.id, friend.id, text, fetchFriendKey); await api('/messages', { method: 'POST', body: JSON.stringify({ to: friend.username, ...envelope }) }); input.value = ''; await refreshMessages(); render(); app.querySelector<HTMLInputElement>('#message-input')?.focus(); } catch (error) { showError(error); input.disabled = false; } };
  app.querySelector<HTMLButtonElement>('#attach-button')?.addEventListener('click', () => app.querySelector<HTMLInputElement>('#attachment-input')?.click());
  app.querySelector<HTMLInputElement>('#attachment-input')?.addEventListener('change', async event => {
    const picker = event.currentTarget as HTMLInputElement; const file = picker.files?.[0]; picker.value = ''; if (!file || !friend) return;
    try { const data = await readAttachment(file); const content = attachmentPrefix + JSON.stringify({ name: file.name.slice(0, 120), type: file.type, data }); const envelope = await encryptMessage(me!.id, friend.id, content, fetchFriendKey); await api('/messages', { method: 'POST', body: JSON.stringify({ to: friend.username, ...envelope }) }); await refreshMessages(); render(); }
    catch (error) { showError(error); }
  });
  app.querySelector<HTMLButtonElement>('#call-button')?.addEventListener('click', () => void toggleCall());
  app.querySelector<HTMLButtonElement>('#call-mute')?.addEventListener('click', () => { voiceMuted = voice.toggleMute(); render(); });
  app.querySelector<HTMLButtonElement>('#call-leave')?.addEventListener('click', leaveCall);
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
  const profileSettings = `<form id="profile-form" class="settings-form"><section class="settings-section"><div class="settings-section-heading"><div><h2>Profile appearance</h2><p>Choose how friends see you.</p></div></div>
    <div class="banner-tools"><label class="banner-preview" id="banner-preview" style="${me.banner ? `background-image:url('${esc(me.banner)}')` : ''}"><span>Click to choose a banner</span><input type="file" id="banner-file" accept="image/png,image/jpeg,image/webp" aria-label="Choose banner image"></label><button type="button" class="text-button" id="clear-banner" ${me.banner ? '' : 'hidden'}>Remove banner</button></div>
    <div class="avatar-editor"><label class="profile-avatar-picker" title="Choose profile picture">${avatar(me, 'profile-large')}<span>Change</span><input type="file" id="avatar-file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label="Choose profile picture"></label><button type="button" class="text-button" id="clear-avatar" ${me.avatar ? '' : 'hidden'}>Remove</button></div>
    <label class="field-label">Display name<input name="displayName" required minlength="1" maxlength="40" value="${esc(displayName(me))}" placeholder="What should friends call you?"></label>
    <label class="field-label">Bio<textarea name="bio" maxlength="160" placeholder="A little about you">${esc(me.bio || '')}</textarea><small class="field-hint">Up to 160 characters. Your friends can see this.</small></label>
    <label class="field-label">Username<div class="readonly-field">@${esc(me.username)}<small>Your username is used to sign in and add friends.</small></div></label>
    <div class="settings-form-error" id="profile-error" role="alert"></div><div class="settings-form-actions"><span>GIF, PNG, JPEG, or WebP avatar · avatar up to 512 KB · banner up to 768 KB</span><button class="primary-button" type="submit">Save changes</button></div>
  </section></form>`;
  const securitySettings = `<section class="settings-section"><div class="settings-section-heading"><div><h2>Sign-in security</h2><p>Email sign-in and an optional second step for new sign-ins.</p></div></div>
    <label class="field-label">Email address<input id="security-email" type="email" maxlength="254" value="${esc(me.email || '')}" placeholder="you@example.com" autocomplete="email"></label><div class="security-status ${me.emailVerified ? 'verified' : ''}">${me.emailVerified ? 'Verified · email can be used to sign in' : me.email ? 'Not verified yet' : 'Add and verify an email to enable email sign-in'}</div><button type="button" class="secondary-button" id="verify-email-button">${me.emailVerified ? 'Change or re-verify email' : 'Send verification code'}</button>
    <div class="twofactor-row"><div><strong>Two-factor authentication</strong><p>${me.twoFactorEnabled ? 'A code is required for every new sign-in.' : 'Require an email code after your password.'}</p></div><button type="button" class="secondary-button" id="twofactor-button" ${me.emailVerified ? '' : 'disabled'}>${me.twoFactorEnabled ? 'Turn off' : 'Turn on'}</button></div>
    ${securityChallenge ? `<label class="field-label">Code sent to ${esc(securityChallenge.email)}<input id="security-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="6-digit code"></label><button type="button" class="primary-button security-verify" id="security-verify">Verify code</button>` : ''}<div class="settings-form-error" role="alert">${esc(securityError)}</div>
  </section>`;
  const updateSettings = `<section class="settings-section"><div class="settings-section-heading"><div><h2>Beta access</h2><p>Preview upcoming Pulse builds before they reach everyone.</p></div></div><label class="beta-setting"><span><strong>Check for beta updates</strong><small>At startup, Pulse will ask before installing an available beta.</small></span><input id="beta-access" type="checkbox" ${localStorage.getItem('pulse.betaAccess') === 'true' ? 'checked' : ''}><span class="toggle-track" aria-hidden="true"></span></label></section>`;
  const settingsTitle = settingsTab === 'security' ? 'Security' : settingsTab === 'updates' ? 'Updates' : 'Profile';
  app.innerHTML = `<aside class="rail"><button class="brand-mark brand-tab" id="friends-home" title="Friends" aria-label="Friends"><img class="app-mark" src="/pulse-mark.svg" alt=""></button><div class="rail-divider"></div><div class="rail-bottom"><button class="account-tab active" id="settings-open" title="Settings" aria-label="Settings">${avatar(me, 'me')}</button></div></aside>
  <aside class="sidebar settings-sidebar"><header class="side-header"><div><div class="eyebrow">PULSE</div><div class="space-title">Settings</div></div></header><nav class="settings-nav" aria-label="Settings sections"><button class="settings-nav-item ${settingsTab === 'profile' ? 'active' : ''}" data-settings-tab="profile">Profile</button><button class="settings-nav-item ${settingsTab === 'security' ? 'active' : ''}" data-settings-tab="security">Security</button><button class="settings-nav-item ${settingsTab === 'updates' ? 'active' : ''}" data-settings-tab="updates">Updates</button></nav><div class="settings-sidebar-bottom"><button class="settings-nav-item signout-item" id="logout-settings" type="button">↪ <span>Sign out</span></button></div></aside>
  <main class="main settings-main"><header class="chat-header"><div class="chat-heading"><div><h1>${settingsTitle}</h1><p>${settingsTab === 'profile' ? 'Edit your public profile.' : settingsTab === 'security' ? 'Manage your sign-in and account protection.' : 'Choose which builds Pulse checks for.'}</p></div></div></header><div class="settings-scroll"><div class="settings-content">${settingsTab === 'profile' ? profileSettings : settingsTab === 'security' ? securitySettings : updateSettings}</div></div></main><div class="toast ${notice ? 'show' : ''}">${esc(notice)}</div>`;
  let avatarData: string | undefined; let bannerData: string | undefined; let clearAvatar = false;
  let clearBanner = false;
  app.querySelector<HTMLButtonElement>('#friends-home')!.onclick = () => { settingsOpen = false; friendsPanel = 'friends'; render(); };
  app.querySelector<HTMLButtonElement>('#logout-settings')!.onclick = () => void signOut();
  app.querySelectorAll<HTMLButtonElement>('[data-settings-tab]').forEach(button => button.onclick = () => { settingsTab = button.dataset.settingsTab as typeof settingsTab; renderSettings(); });
  app.querySelector<HTMLInputElement>('#beta-access')?.addEventListener('change', event => { localStorage.setItem('pulse.betaAccess', String((event.currentTarget as HTMLInputElement).checked)); });
  app.querySelector<HTMLButtonElement>('#verify-email-button')?.addEventListener('click', async () => {
    try { const email = (app.querySelector<HTMLInputElement>('#security-email')!.value || '').trim().toLowerCase(); const result = await api<{ challengeId: string }>('/auth/email-code', { method: 'POST', body: JSON.stringify({ email, purpose: 'verify-email' }) }); securityChallenge = { challengeId: result.challengeId, purpose: 'verify-email', email }; securityError = ''; renderSettings(); }
    catch (error) { securityError = error instanceof Error ? error.message : 'Could not send verification code.'; renderSettings(); }
  });
  app.querySelector<HTMLButtonElement>('#twofactor-button')?.addEventListener('click', async () => {
    if (!me?.email) { securityError = 'Add and verify your email first.'; renderSettings(); return; }
    try { const purpose = me.twoFactorEnabled ? 'disable-2fa' : 'enable-2fa'; const result = await api<{ challengeId: string }>('/auth/email-code', { method: 'POST', body: JSON.stringify({ email: me.email, purpose }) }); securityChallenge = { challengeId: result.challengeId, purpose, email: me.email }; securityError = ''; renderSettings(); }
    catch (error) { securityError = error instanceof Error ? error.message : 'Could not send two-factor code.'; renderSettings(); }
  });
  app.querySelector<HTMLButtonElement>('#security-verify')?.addEventListener('click', async () => {
    if (!securityChallenge) return;
    try { const result = await api<{ user?: User }>('/auth/verify-code', { method: 'POST', body: JSON.stringify({ challengeId: securityChallenge.challengeId, code: app.querySelector<HTMLInputElement>('#security-code')!.value }) }); if (result.user) me = { ...me!, ...result.user }; securityChallenge = undefined; securityError = ''; notice = 'Sign-in security updated.'; renderSettings(); }
    catch (error) { securityError = error instanceof Error ? error.message : 'Could not verify code.'; renderSettings(); }
  });
  app.querySelector<HTMLInputElement>('#avatar-file')?.addEventListener('change', async event => {
    try { avatarData = await readImage((event.currentTarget as HTMLInputElement).files?.[0], 512 * 1024, 'Profile picture', true); clearAvatar = false; const preview = app.querySelector('.profile-large') as HTMLElement; if (avatarData) { preview.style.backgroundImage = `url('${avatarData}')`; preview.style.backgroundSize = 'cover'; preview.textContent = ''; app.querySelector<HTMLButtonElement>('#clear-avatar')!.hidden = false; } }
    catch (error) { app.querySelector('#profile-error')!.textContent = error instanceof Error ? error.message : 'Could not read picture.'; }
  });
  app.querySelector<HTMLInputElement>('#banner-file')?.addEventListener('change', async event => {
    try { bannerData = await readImage((event.currentTarget as HTMLInputElement).files?.[0], 768 * 1024, 'Banner'); if (bannerData) (app.querySelector('#banner-preview') as HTMLElement).style.backgroundImage = `url('${bannerData}')`; }
    catch (error) { app.querySelector('#profile-error')!.textContent = error instanceof Error ? error.message : 'Could not read banner.'; }
  });
  app.querySelector<HTMLButtonElement>('#clear-avatar')?.addEventListener('click', () => { clearAvatar = true; avatarData = ''; const preview = app.querySelector('.profile-large') as HTMLElement; preview.style.backgroundImage = ''; preview.textContent = displayName(me!)[0].toUpperCase(); });
  app.querySelector<HTMLButtonElement>('#clear-banner')?.addEventListener('click', () => { clearBanner = true; bannerData = ''; (app.querySelector('#banner-preview') as HTMLElement).style.backgroundImage = ''; app.querySelector<HTMLButtonElement>('#clear-banner')!.hidden = true; });
  app.querySelector<HTMLFormElement>('#profile-form')?.addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.currentTarget as HTMLFormElement); const submit = app.querySelector<HTMLButtonElement>('#profile-form button[type=submit]')!; submit.disabled = true;
    try { const result = await api<{ user: User; profile: Pick<User, 'avatar' | 'banner' | 'bio'> }>('/profile', { method: 'POST', body: JSON.stringify({ displayName: form.get('displayName'), bio: form.get('bio'), ...(avatarData !== undefined ? { avatar: avatarData } : clearAvatar ? { avatar: '' } : {}), ...(bannerData !== undefined ? { banner: bannerData } : clearBanner ? { banner: '' } : {}) }) }); me = { ...result.user, ...result.profile }; notice = 'Profile saved.'; await refreshFriends(); renderSettings(); }
    catch (error) { app.querySelector('#profile-error')!.textContent = error instanceof Error ? error.message : 'Could not save your profile.'; submit.disabled = false; }
  });
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
