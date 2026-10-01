chrome.runtime.onMessage.addListener((message) => {
  if (message.action !== "play-download-control-restored-beep") return;

  const audioContext = new AudioContext();
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = 880;
  gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.15, audioContext.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.22);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.addEventListener("ended", () => audioContext.close(), { once: true });
  oscillator.start();
  oscillator.stop(audioContext.currentTime + 0.23);
});