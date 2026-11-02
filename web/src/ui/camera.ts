// The browser camera: a live preview through the engine and a "photograph" that is a frame of the video
// stream — display-referred, white-balanced and tone-mapped by the browser, never RAW. The page says so.

export interface CameraSession {
  video: HTMLVideoElement;
  stream: MediaStream;
  width: number;
  height: number;
  stop(): void;
}

export async function startCamera(video: HTMLVideoElement): Promise<CameraSession> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not offer camera access.');
  const constraints: MediaStreamConstraints = {
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = stream;
  await video.play();
  await new Promise<void>((resolve) => {
    if (video.videoWidth > 0) resolve();
    else video.addEventListener('loadedmetadata', () => resolve(), { once: true });
  });
  return {
    video, stream, width: video.videoWidth, height: video.videoHeight,
    stop() {
      for (const t of stream.getTracks()) t.stop();
      video.srcObject = null;
    },
  };
}
