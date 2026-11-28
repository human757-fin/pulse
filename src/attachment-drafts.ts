export type AttachmentDraft = { id: string; file: File; url: string; percent: number; error?: string };

export class AttachmentDrafts {
  private conversations = new Map<string, AttachmentDraft[]>();
  constructor(private createUrl = (file: File) => URL.createObjectURL(file), private revokeUrl = (url: string) => URL.revokeObjectURL(url)) {}
  list(conversation: string) { return this.conversations.get(conversation) || []; }
  add(conversation: string, files: File[]) {
    const items = this.list(conversation);
    if (items.length + files.length > 10) throw new Error('Attach up to 10 files at a time.');
    for (const file of files) if (!file.size || file.size > 750_000_000) throw new Error(`${file.name}: choose a non-empty file up to 750 MB.`);
    const added = files.map(file => ({ id: crypto.randomUUID(), file, url: this.createUrl(file), percent: 0 }));
    this.conversations.set(conversation, [...items, ...added]);
  }
  remove(conversation: string, id: string) {
    const items = this.list(conversation);
    const item = items.find(entry => entry.id === id);
    if (item) this.revokeUrl(item.url);
    const remaining = items.filter(entry => entry.id !== id);
    if (remaining.length) this.conversations.set(conversation, remaining);
    else this.conversations.delete(conversation);
  }
  clear() {
    for (const items of this.conversations.values()) for (const item of items) this.revokeUrl(item.url);
    this.conversations.clear();
  }
}
