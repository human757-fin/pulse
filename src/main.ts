import './style.css';
import { VoiceClient, type VoiceState, type VoiceUpdate } from './voice';

type Message = { name: string; initials: string; color: string; time: string; text: string; self?: boolean };
type Chat = { id: string; name: string; kind: 'group' | 'dm'; topic?: string; icon: string; online?: boolean; messages: Message[] };

const chats: Chat[] = [
  { id:'general', name:'general', kind:'group', topic:'The place for everything', icon:'#', messages:[
    {name:'Maya',initials:'M',color:'#d68bff',time:'10:42 AM',text:'Morning! Anyone up for a co-op session later?'},
    {name:'Theo',initials:'T',color:'#67c9a5',time:'10:45 AM',text:'I’m in. Was thinking Deep Rock around 8?'},
    {name:'Jules',initials:'J',color:'#ffb36c',time:'10:47 AM',text:'Rock and stone! ⛏️'},
    {name:'Maya',initials:'M',color:'#d68bff',time:'11:03 AM',text:'Perfect, I’ll be around. I can host.'},
  ]},
  { id:'gaming', name:'gaming', kind:'group', topic:'What are you playing?', icon:'#', messages:[
    {name:'Theo',initials:'T',color:'#67c9a5',time:'Yesterday',text:'Finally got the new setup running smoothly. Night and day difference.'},
    {name:'Jules',initials:'J',color:'#ffb36c',time:'Yesterday',text:'What did you end up changing?'},
  ]},
  { id:'music', name:'music', kind:'group', topic:'Tracks, albums, recommendations', icon:'#', messages:[
    {name:'Maya',initials:'M',color:'#d68bff',time:'Yesterday',text:'Made a playlist for the weekend drive 🎧'},
  ]},
  { id:'maya', name:'Maya Chen', kind:'dm', icon:'M', online:true, messages:[
    {name:'Maya Chen',initials:'M',color:'#d68bff',time:'9:18 AM',text:'Hey! Did you get a chance to look at that game I sent?'},
    {name:'You',initials:'Y',color:'#8276ff',time:'9:24 AM',text:'Downloading it now, should be ready tonight.',self:true},
  ]},
  { id:'theo', name:'Theo Park', kind:'dm', icon:'T', online:true, messages:[
    {name:'Theo Park',initials:'T',color:'#67c9a5',time:'Yesterday',text:'Thanks for the invite! Glad to be here.'},
  ]},
  { id:'jules', name:'Jules Rivera', kind:'dm', icon:'J', online:false, messages:[] },
];

let active = 'general';
let voiceState: VoiceState = 'disconnected';
let voiceMessage = 'Not connected';
let voicePeers: string[] = [];
let voiceRoom = '';
let voiceMuted = false;
let filter = '';
const app = document.querySelector<HTMLDivElement>('#app')!;
const voice = new VoiceClient((update: VoiceUpdate) => {
  voiceState = update.state;
  voiceMessage = update.message;
  voicePeers = update.peers;
  render();
});
const getChat = () => chats.find(c => c.id === active)!;
const signalUrl = () => localStorage.getItem('pulse.signalUrl') || import.meta.env.VITE_PULSE_SIGNAL_URL || 'ws://127.0.0.1:8787';
const displayName = () => localStorage.getItem('pulse.displayName') || 'Alex Morgan';
const voiceToken = () => localStorage.getItem('pulse.voiceToken') || '';
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

function render() {
  const chat = getChat();
  const matches = (c: Chat) => c.name.toLowerCase().includes(filter.toLowerCase());
  app.innerHTML = `
  <aside class="rail"><div class="brand-mark">P<span>·</span></div><div class="rail-divider"></div><button class="server active" title="The Hangout">H</button><button class="server add" title="Add a group">＋</button><div class="rail-bottom"><button class="icon-button" title="Settings">⚙</button><div class="avatar me">A</div></div></aside>
  <aside class="sidebar"><header class="side-header"><div><div class="eyebrow">YOUR SPACE</div><div class="space-title">The Hangout <span class="chevron">⌄</span></div></div><button class="icon-button" title="More options">···</button></header>
    <label class="search"><span>⌕</span><input id="search" placeholder="Find a chat" value="${esc(filter)}"/><kbd>⌘ K</kbd></label>
    <div class="side-scroll"><section><div class="section-title">GROUP CHATS <button class="mini-add" title="Create group">＋</button></div>${chats.filter(c=>c.kind==='group'&&matches(c)).map(c=>`<button class="nav-item ${active===c.id?'selected':''}" data-chat="${c.id}"><span class="hash">#</span><span>${esc(c.name)}</span></button>`).join('')}</section>
    <section><div class="section-title">DIRECT MESSAGES <button class="mini-add" title="New message">＋</button></div>${chats.filter(c=>c.kind==='dm'&&matches(c)).map(c=>`<button class="nav-item dm-item ${active===c.id?'selected':''}" data-chat="${c.id}"><span class="avatar tiny" style="--av:${c.messages[0]?.color||'#aaa'}">${c.icon}</span><span>${esc(c.name)}</span><i class="presence ${c.online?'online':''}"></i></button>`).join('')}</section></div>
    <div class="profile"><div class="avatar me">A</div><div class="profile-copy"><strong>${esc(displayName())}</strong><small>Online</small></div><button class="icon-button" title="Set your display name" id="name-setting">⚙</button></div>
  </aside>
  <main class="main"><header class="chat-header"><div class="chat-heading"><span class="head-hash">${chat.kind==='group'?'#':`<span class="avatar tiny" style="--av:${chat.messages[0]?.color||'#aaa'}">${chat.icon}</span>`}</span><div><h1>${esc(chat.name)}</h1><p>${esc(chat.topic||'Direct message')}</p></div></div><div class="header-actions"><button class="icon-button" title="Search messages">⌕</button><button class="icon-button" title="Members">♙</button><span class="header-sep"></span><button class="icon-button" title="Notifications">♧</button><button class="icon-button" title="Pinned messages">⌑</button><button class="icon-button" title="Help">?</button></div></header>
    <div class="message-area" id="messages">${chat.messages.length?`<div class="welcome"><div class="welcome-icon">${chat.kind==='group'?'#':chat.icon}</div><h2>${chat.kind==='group'?'Welcome to #'+esc(chat.name):'This is the beginning of your conversation'}</h2><p>${chat.kind==='group'?'This is the start of the '+esc(chat.name)+' group chat.':'Say hello and start chatting.'}</p></div>${chat.messages.map(messageHTML).join('')}`:`<div class="empty-chat"><div class="welcome-icon">✦</div><h2>Start a conversation</h2><p>Send ${esc(chat.name)} a message to get things going.</p></div>`}</div>
    <form id="composer" class="composer"><button type="button" class="attach" title="Attachments are coming later">＋</button><input id="message-input" maxlength="4096" autocomplete="off" placeholder="Message ${chat.kind==='group'?'#'+chat.name:chat.name}"/><button class="send" type="submit" title="Send message">↑</button><div class="composer-hint">Messages are local demo data</div></form>
  </main>
  <aside class="rightbar"><div class="right-title">IN THIS SPACE</div><div class="members"><div class="member-heading">ONLINE — 3</div>${[['A','Alex Morgan','#8276ff'],['M','Maya Chen','#d68bff'],['T','Theo Park','#67c9a5']].map(([i,n,c])=>`<div class="member"><span class="avatar tiny" style="--av:${c}">${i}<i class="presence online"></i></span><span>${n}</span></div>`).join('')}<div class="member-heading offline">OFFLINE — 1</div><div class="member"><span class="avatar tiny" style="--av:#ffb36c">J<i class="presence"></i></span><span>Jules Rivera</span></div></div>
    <div class="voice-card ${voiceState==='connected'?'connected':''}"><div class="voice-top"><span class="voice-dot"></span><strong>Voice chat · 1:1</strong></div><div class="voice-room"><span>◖))</span><span>${esc(voiceRoom ? chats.find(c=>c.id===voiceRoom)?.name || 'Voice room' : chat.kind==='group'?'#'+chat.name:chat.name)}</span><span class="voice-count">${voicePeers.length ? voicePeers.length+1 : '—'}</span></div><div class="voice-status ${voiceState==='error'?'voice-error':''}">${esc(voiceMessage)}</div><label class="voice-setting">Signaling server<input id="voice-endpoint" value="${esc(signalUrl())}" spellcheck="false"/></label><label class="voice-setting">Access token (if required)<input id="voice-token" type="password" value="${esc(voiceToken())}" autocomplete="off"/></label><div class="voice-controls">${voiceState==='connected'||voiceState==='waiting'?`<button id="voice-mute" class="voice-mute">${voiceMuted?'Unmute mic':'Mute mic'}</button>`:''}<button id="voice-toggle" class="voice-button">${voiceState==='connected'||voiceState==='waiting'?'Leave voice':voiceState==='connecting'?'Cancel':'Join voice'}</button></div><p>WebRTC peer-to-peer · TURN relay optional</p></div>
    <div class="encryption"><span class="lock">◖))</span><div><strong>Peer-to-peer voice</strong><p>Call setup uses the signaling server. Audio goes directly between callers.</p></div></div>
  </aside>`;

  app.querySelectorAll<HTMLButtonElement>('[data-chat]').forEach(button => button.onclick = () => { active = button.dataset.chat!; render(); });
  const search = app.querySelector<HTMLInputElement>('#search')!;
  search.oninput = () => { const pos=search.selectionStart; filter=search.value; render(); const next=app.querySelector<HTMLInputElement>('#search')!; next.focus(); next.setSelectionRange(pos,pos); };
  app.querySelector<HTMLFormElement>('#composer')!.onsubmit = e => { e.preventDefault(); const input=app.querySelector<HTMLInputElement>('#message-input')!; const text=input.value.trim(); if(!text)return; chat.messages.push({name:'You',initials:'Y',color:'#8276ff',time:new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}),text,self:true}); render(); const area=app.querySelector('#messages')!; area.scrollTop=area.scrollHeight; app.querySelector<HTMLInputElement>('#message-input')!.focus(); };
  app.querySelector<HTMLButtonElement>('#voice-toggle')!.onclick = () => {
    if (voiceState==='connected'||voiceState==='waiting'||voiceState==='connecting') { voiceRoom=''; voiceMuted=false; voice.leave(); }
    else {
      const endpoint=app.querySelector<HTMLInputElement>('#voice-endpoint')!.value.trim();
      const token=app.querySelector<HTMLInputElement>('#voice-token')!.value.trim();
      if(!endpoint){voiceState='error';voiceMessage='Enter the signaling server address.';render();return;}
      localStorage.setItem('pulse.signalUrl',endpoint);
      localStorage.setItem('pulse.voiceToken',token);
      voiceRoom=active;
      void voice.join(endpoint,voiceRoom,displayName(),token);
    }
  };
  const muteButton=app.querySelector<HTMLButtonElement>('#voice-mute');
  if(muteButton) muteButton.onclick=()=>{voiceMuted=voice.toggleMute();render();};
  app.querySelector<HTMLInputElement>('#voice-endpoint')!.onchange = e => localStorage.setItem('pulse.signalUrl',(e.currentTarget as HTMLInputElement).value.trim());
  app.querySelector<HTMLInputElement>('#voice-token')!.onchange = e => localStorage.setItem('pulse.voiceToken',(e.currentTarget as HTMLInputElement).value.trim());
  app.querySelector<HTMLButtonElement>('#name-setting')!.onclick = () => {
    const name=window.prompt('Choose your voice display name',displayName())?.trim();
    if(name){localStorage.setItem('pulse.displayName',name.slice(0,48));render();}
  };
}

function messageHTML(m: Message) { return `<article class="message ${m.self?'own':''}"><div class="avatar message-avatar" style="--av:${m.color}">${m.initials}</div><div class="message-body"><div class="message-meta"><strong>${esc(m.name)}</strong><time>${esc(m.time)}</time></div><p>${esc(m.text)}</p></div></article>`; }

render();
