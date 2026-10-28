type EncodedFrame = { data: ArrayBuffer };
type FrameTransformer = { readable: ReadableStream<EncodedFrame>; writable: WritableStream<EncodedFrame>; options: { mode: 'encrypt' | 'decrypt'; keyBytes: ArrayBuffer } };
type TransformEvent = Event & { transformer: FrameTransformer };

(self as unknown as { onrtctransform: (event: TransformEvent) => void }).onrtctransform = event => {
  const transformer = event.transformer;
  void crypto.subtle.importKey('raw', transformer.options.keyBytes, { name: 'AES-GCM' }, false, [transformer.options.mode]).then(key => {
    const pipeline = new TransformStream<EncodedFrame, EncodedFrame>({
      async transform(frame, controller) {
        const input = new Uint8Array(frame.data);
        if (transformer.options.mode === 'encrypt') {
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, input));
          const output = new Uint8Array(iv.length + encrypted.length);
          output.set(iv); output.set(encrypted, iv.length);
          frame.data = output.buffer;
          controller.enqueue(frame);
          return;
        }
        if (input.length < 29) return;
        const iv = input.subarray(0, 12);
        try {
          const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, input.subarray(12));
          frame.data = decrypted;
          controller.enqueue(frame);
        } catch {
          // Drop an unauthenticated frame; never pass clear or corrupted audio onward.
        }
      },
    });
    void transformer.readable.pipeThrough(pipeline).pipeTo(transformer.writable).catch(() => undefined);
  });
};
