// Buffer this small local review clip so the current preview also seeks on
// simple static servers which do not advertise byte ranges.
const video = document.querySelector('video');
const source = video?.querySelector('source')?.src;
if (video && source) {
  try {
    const response = await fetch(source);
    if (!response.ok) throw Error('Video unavailable');
    const blob = await response.blob();
    const objectURL = URL.createObjectURL(blob);
    const resume = !video.paused;
    video.src = objectURL;
    video.dataset.buffered = 'true';
    video.load();
    if (resume) await video.play();
    addEventListener('pagehide', () => URL.revokeObjectURL(objectURL), {once:true});
  } catch {
    // The original local source and native controls remain available.
  }
}
