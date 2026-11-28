// Copy decoded frames into a normal canvas to avoid video-overlay rendering bugs.
// This does not add codecs: the runtime must still decode the original file.
export function installCompatibilityPicture(shell: HTMLElement, video: HTMLVideoElement, button: HTMLButtonElement) {
  let canvas: HTMLCanvasElement | undefined;
  let enabled = false;
  let scheduled = false;
  let lastPaint = 0;
  const paint = (time: number) => {
    scheduled = false;
    if (!enabled || !shell.isConnected) return;
    if (canvas && video.videoWidth && video.readyState >= 2 && time - lastPaint >= 30) {
      const scale = Math.min(1, 1920 / video.videoWidth, 1080 / video.videoHeight);
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      try { canvas.getContext('2d', { alpha: false })?.drawImage(video, 0, 0, width, height); }
      catch {
        enabled = false; shell.classList.remove('compatibility-picture'); button.setAttribute('aria-pressed', 'false');
        button.title = 'The runtime could not decode a picture. Download to use your Windows video player.';
        return;
      }
      lastPaint = time;
    }
    if (!video.paused && !video.ended) schedule();
  };
  const schedule = () => {
    if (!enabled || scheduled) return;
    scheduled = true;
    if ('requestVideoFrameCallback' in video && !video.paused) video.requestVideoFrameCallback(paint);
    else requestAnimationFrame(paint);
  };
  button.onclick = () => {
    enabled = !enabled;
    if (!canvas) {
      canvas = document.createElement('canvas'); canvas.className = 'video-compatibility-canvas';
      canvas.setAttribute('aria-label', 'Video picture');
      canvas.onclick = () => { if (video.paused) void video.play().catch(() => undefined); else video.pause(); };
      video.after(canvas);
    }
    shell.classList.toggle('compatibility-picture', enabled);
    button.setAttribute('aria-pressed', String(enabled));
    button.title = enabled ? 'Compatibility display on' : 'Try compatibility display if the picture is black';
    if (enabled) { lastPaint = 0; schedule(); }
  };
  video.addEventListener('playing', schedule);
  video.addEventListener('loadeddata', schedule);
  video.addEventListener('seeked', schedule);
}
