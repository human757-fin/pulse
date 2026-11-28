import { umbraEnvelopeKey } from './crypto';

type Api = <T>(path: string, options?: RequestInit) => Promise<T>;
type Target = { kind: 'dm' | 'group'; id: string; label: string; members: { id: string; publicKey: JsonWebKey }[] };
type Connection = { id: string; key: string };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Umbra could not complete the request.';

export function parseUmbraCode(code: string): Connection | undefined {
  const match = /^([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(code.trim());
  return match ? { id: match[1], key: match[2] } : undefined;
}

export function readUmbraConnection(): Connection | undefined {
  const url = new URL(location.href);
  if (!url.searchParams.has('umbra')) return;
  const connection = parseUmbraCode(`${url.searchParams.get('umbra')}.${url.hash.slice(1)}`);
  url.searchParams.delete('umbra');
  url.hash = '';
  history.replaceState(null, '', url);
  return connection;
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
const fromBase64 = (value: string) => Uint8Array.from(atob(value), byte => byte.charCodeAt(0));

export function showUmbraApproval(app: HTMLElement, connection: Connection, user: { id: string; username: string }, ready: boolean, api: Api, close: () => void) {
  if (app.querySelector('#umbra-approval')) return;
  app.classList.remove('settings-view');
  app.innerHTML = `<main class="auth-page" id="umbra-approval"><section class="auth-card"><div class="auth-brand"><img src="/pulse-mark.svg" alt=""><span>Umbra</span></div><h1>Connect Umbra Clips</h1><p id="umbra-account" class="auth-subtitle"></p><form class="auth-form"><label>Send clips to<select required disabled><option value="">Loading your chats…</option></select></label><p class="auth-subtitle">Umbra Clips can send encrypted clips to the chat you choose. You control automatic sharing in Umbra Clips.</p><p class="form-error" role="status" aria-live="polite"></p><button class="primary-button" type="submit" disabled>Approve connection</button></form><div class="auth-switch"><button type="button" id="umbra-close">Cancel</button></div></section></main>`;
  const form = app.querySelector<HTMLFormElement>('#umbra-approval form')!;
  const select = form.querySelector('select')!;
  const status = form.querySelector<HTMLElement>('[role=status]')!;
  const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
  const dismiss = app.querySelector<HTMLButtonElement>('#umbra-close')!;
  dismiss.onclick = close;
  app.querySelector('#umbra-account')!.textContent = `Signed in as @${user.username}`;
  if (!ready) {
    form.querySelector('label')!.hidden = true;
    status.textContent = 'Paste the connection code in Settings → Sign-in security on the Umbra device that already holds your chat encryption key.';
    submit.hidden = true;
    return;
  }
  const endpoint = `/umbra/pairings/${connection.id}`;
  let targets: Target[] = [];
  void api<{ targets: Target[] }>(endpoint).then(result => {
    targets = result.targets;
    select.replaceChildren(new Option(targets.length ? 'Choose a chat' : 'No eligible chats', ''));
    targets.forEach((target, index) => select.add(new Option(target.label, String(index))));
    select.disabled = !targets.length;
    if (!targets.length) status.textContent = 'Add a friend or join a chat with encryption enabled to send clips.';
  }).catch(error => { select.replaceChildren(new Option('Chats unavailable', '')); status.textContent = errorMessage(error); });
  select.onchange = () => {
    const target = select.value ? targets[Number(select.value)] : undefined;
    submit.disabled = !target;
    status.textContent = target ? `Encrypted recipients in this chat, including you: ${target.members.length}.` : '';
  };
  form.onsubmit = async event => {
    event.preventDefault();
    if (!select.value || submit.disabled) return;
    const target = targets[Number(select.value)];
    submit.disabled = select.disabled = dismiss.disabled = true;
    status.textContent = 'Connecting Umbra Clips…';
    try {
      const linkNonce = toHex(crypto.getRandomValues(new Uint8Array(16)));
      const keys = Object.fromEntries(await Promise.all(target.members.map(async member => [member.id, await umbraEnvelopeKey(user.id, member.id, member.publicKey, linkNonce)] as const)));
      const secret = Uint8Array.from(connection.key.match(/../g)!, byte => parseInt(byte, 16));
      const key = await crypto.subtle.importKey('raw', secret, 'AES-GCM', false, ['encrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encoder = new TextEncoder();
      const additionalData = encoder.encode(`pulse-umbra-pairing-v1:${connection.id}:${linkNonce}:${user.id}:${target.id}`);
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, encoder.encode(JSON.stringify(keys)));
      await api(endpoint, { method: 'POST', body: JSON.stringify({ kind: target.kind, targetId: target.id, members: target.members, linkNonce, sealed: { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) } }) });
      status.textContent = `Approved for ${target.label}. Return to Umbra Clips to finish connecting.`;
      dismiss.textContent = 'Continue to Umbra';
    } catch (error) { status.textContent = errorMessage(error); submit.disabled = select.disabled = false; }
    finally { dismiss.disabled = false; }
  };
}

export function mountUmbraSettings(parent: HTMLElement, api: Api, connect: (connection: Connection) => void) {
  parent.insertAdjacentHTML('beforeend', `<section class="settings-section" id="umbra-settings"><h2>Umbra Clips</h2><form class="settings-form"><label>Connection code from Umbra Clips<input name="code" autocomplete="off" spellcheck="false" maxlength="97" required></label><p>Copy the code from Umbra Clips to approve a connection here.</p><button type="submit" class="primary-button">Choose a chat</button></form><div id="umbra-links"></div><p role="status" aria-live="polite"></p></section>`);
  const section = parent.querySelector('#umbra-settings')!;
  const form = section.querySelector('form')!;
  const links = section.querySelector('#umbra-links')!;
  const status = section.querySelector('[role=status]')!;
  form.onsubmit = event => {
    event.preventDefault();
    const code = parseUmbraCode(String(new FormData(form).get('code') || ''));
    if (code) connect(code);
    else status.textContent = 'Enter the connection code shown in Umbra Clips.';
  };
  async function refreshLinks() {
    const { links: active } = await api<{ links: { id: string; label: string; expiresAt: number }[] }>('/umbra/links');
    links.replaceChildren();
    if (!active.length) links.textContent = 'No connected Umbra Clips devices.';
    for (const link of active) {
      const row = document.createElement('p');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Disconnect';
      button.setAttribute('aria-label', `Disconnect Umbra Clips from ${link.label}`);
      row.append(`${link.label} · Expires ${new Date(link.expiresAt).toLocaleDateString()} `, button);
      button.onclick = async () => {
        button.disabled = true;
        try { await api(`/umbra/links/${link.id}`, { method: 'DELETE' }); await refreshLinks(); status.textContent = 'Umbra Clips disconnected.'; }
        catch (error) { status.textContent = errorMessage(error); button.disabled = false; }
      };
      links.append(row);
    }
  }
  links.textContent = 'Loading connected devices…';
  void refreshLinks().catch(error => { links.textContent = ''; status.textContent = errorMessage(error); });
}

type PickerLink = { id: string; label: string; nonce: string };
type Clip = { name: string; size: number };
type Box = { iv: string; ciphertext: string };

export function showUmbraPicker(targetId: string, userId: string, api: Api, loadOwnKey: () => Promise<JsonWebKey>) {
  if (document.querySelector('#umbra-picker')) return;
  const dialog = document.createElement('dialog');
  dialog.id = 'umbra-picker';
  dialog.setAttribute('aria-labelledby', 'umbra-picker-title');
  dialog.innerHTML = `<h2 id="umbra-picker-title">Send from Umbra Clips</h2><form id="umbra-picker-form" class="settings-form"><label id="umbra-device-row" hidden>Connected device<select id="umbra-device"></select></label><label id="umbra-clip-row" hidden>Recent clips<select id="umbra-clip" required></select></label><p role="status" aria-live="polite">Looking for Umbra Clips…</p><button type="submit" class="primary-button" disabled>Send clip</button></form><form method="dialog"><button type="submit">Close</button></form>`;
  document.body.append(dialog);
  dialog.showModal();
  const controller = new AbortController();
  dialog.addEventListener('close', () => { controller.abort(); dialog.remove(); });
  const { signal } = controller;
  const form = dialog.querySelector<HTMLFormElement>('#umbra-picker-form')!;
  const status = dialog.querySelector<HTMLElement>('[role=status]')!;
  const devices = dialog.querySelector<HTMLSelectElement>('#umbra-device')!;
  const clips = dialog.querySelector<HTMLSelectElement>('#umbra-clip')!;
  const send = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
  let selected: PickerLink | undefined;
  let available: Clip[] = [];
  let links: PickerLink[] = [];
  let sending = false;
  let activeLoad = 0;
  const encoder = new TextEncoder();

  async function exchange<T>(link: PickerLink, action: 'list' | 'send', name?: string): Promise<T> {
    const id = toHex(crypto.getRandomValues(new Uint8Array(16)));
    const path = `/umbra/links/${link.id}/requests/${id}`;
    const keyBytes = fromBase64(await umbraEnvelopeKey(userId, userId, await loadOwnKey(), link.nonce));
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const context = `pulse-umbra-library-v1:${link.id}:${id}`;
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`${context}:request`) }, key, encoder.encode(JSON.stringify({ action, name })));
    await api(path, { method: 'POST', signal, body: JSON.stringify({ command: { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) } }) });
    const deadline = Date.now() + 24_000;
    while (!signal.aborted && Date.now() < deadline) {
      await new Promise(resolve => window.setTimeout(resolve, 900));
      if (signal.aborted) break;
      const { result } = await api<{ result?: Box }>(path, { signal });
      if (!result) continue;
      const reply = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(result.iv), additionalData: encoder.encode(`${context}:response`) }, key, fromBase64(result.ciphertext));
      const value = JSON.parse(new TextDecoder().decode(reply));
      if (value.error) throw new Error(value.error);
      return value as T;
    }
    throw new Error('Umbra Clips did not respond. Check that it is running on your PC and try again.');
  }

  async function load(link: PickerLink) {
    const version = ++activeLoad;
    selected = link;
    send.disabled = true;
    clips.disabled = true;
    status.textContent = 'Loading recent clips from Umbra Clips…';
    try {
      const reply = await exchange<{ clips: Clip[] }>(link, 'list');
      if (version !== activeLoad || signal.aborted) return;
      available = reply.clips;
      clips.replaceChildren(new Option(available.length ? 'Choose a clip' : 'No clips available', ''));
      available.forEach((clip, index) => clips.add(new Option(`${clip.name} (${(clip.size / 1_000_000).toFixed(1)} MB)`, String(index))));
      dialog.querySelector<HTMLElement>('#umbra-clip-row')!.hidden = false;
      clips.disabled = !available.length;
      status.textContent = available.length ? 'Umbra Clips will upload the clip you select.' : 'Save an MP4 clip in Umbra Clips, then reopen this picker.';
    } catch (error) { if (version === activeLoad && !signal.aborted) status.textContent = errorMessage(error); }
  }

  void api<{ links: PickerLink[] }>(`/umbra/pickers?target=${encodeURIComponent(targetId)}`, { signal }).then(result => {
    links = result.links;
    if (!links.length) { status.textContent = 'In Umbra Clips, sign in with Umbra and choose this chat as your destination.'; return; }
    links.forEach((link, index) => devices.add(new Option(`${link.label} · Device ${index + 1}`, String(index))));
    dialog.querySelector<HTMLElement>('#umbra-device-row')!.hidden = links.length < 2;
    void load(links[0]);
  }).catch(error => { if (!signal.aborted) status.textContent = errorMessage(error); });
  devices.onchange = () => { if (!sending) void load(links[Number(devices.value)]); };
  clips.onchange = () => { send.disabled = !clips.value; };
  form.onsubmit = async event => {
    event.preventDefault();
    if (!selected || !clips.value || sending) return;
    const clip = available[Number(clips.value)];
    sending = send.disabled = devices.disabled = clips.disabled = true;
    status.textContent = 'Asking Umbra Clips to send the clip…';
    try {
      await exchange<{ queued: boolean }>(selected, 'send', clip.name);
      clips.value = '';
      status.textContent = 'Clip queued. It will appear in this chat when Umbra Clips finishes uploading.';
    } catch (error) { if (!signal.aborted) status.textContent = errorMessage(error); }
    finally { sending = devices.disabled = clips.disabled = false; send.disabled = !clips.value; }
  };
}
