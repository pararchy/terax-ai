import { invoke } from "@tauri-apps/api/core";

let context: AudioContext | undefined;
let buffersPromise: Promise<AudioBuffer[]> | undefined;
let activeSource: AudioBufferSourceNode | undefined;
let requestSequence = 0;
let lastIndex = -1;

async function decodeAll(
  ctx: AudioContext,
  sources: Array<ArrayBuffer | number[]>,
): Promise<AudioBuffer[]> {
  const buffers: AudioBuffer[] = [];
  for (const source of sources) {
    try {
      const data = Array.isArray(source) ? Uint8Array.from(source).buffer : source;
      buffers.push(await ctx.decodeAudioData(data));
    } catch {
      // Skip undecodable entries.
    }
  }
  return buffers;
}

async function loadSounds(ctx: AudioContext): Promise<AudioBuffer[]> {
  // User override: every audio file in ~/.config/terax/sounds/ wins over the
  // bundled library. Single-file legacy override: ~/.config/terax/notification.mp3.
  try {
    const overrides = await invoke<number[][]>("read_notification_sounds");
    const buffers = await decodeAll(ctx, overrides);
    if (buffers.length > 0) return buffers;
  } catch {
    // No override dir — fall through.
  }
  try {
    const bytes = await invoke<number[]>("read_notification_sound");
    return await decodeAll(ctx, [bytes]);
  } catch {
    // No single-file override — fall through to bundled library.
  }
  const manifest = await fetch("/sounds/manifest.json");
  if (!manifest.ok) throw new Error(`sounds manifest: ${manifest.status}`);
  const { sounds } = (await manifest.json()) as { sounds: string[] };
  const responses = await Promise.all(
    sounds.map(async (path) => {
      const response = await fetch(`/${path}`);
      if (!response.ok) throw new Error(`${path}: ${response.status}`);
      return response.arrayBuffer();
    }),
  );
  const buffers = await decodeAll(ctx, responses);
  if (buffers.length === 0) throw new Error("no playable notification sounds");
  return buffers;
}

function pickIndex(length: number): number {
  if (length === 1) return 0;
  let index = Math.floor(Math.random() * length);
  if (index === lastIndex) index = (index + 1) % length;
  lastIndex = index;
  return index;
}

async function playLatest(sequence: number): Promise<void> {
  try {
    if (typeof AudioContext === "undefined" || typeof fetch === "undefined") return;
    context ??= new AudioContext();
    if (context.state === "suspended") await context.resume();

    buffersPromise ??= loadSounds(context).catch((error) => {
      buffersPromise = undefined;
      throw error;
    });
    const buffers = await buffersPromise;
    if (sequence !== requestSequence) return;

    activeSource?.stop();
    const source = context.createBufferSource();
    source.buffer = buffers[pickIndex(buffers.length)];
    source.connect(context.destination);
    source.onended = () => {
      if (activeSource !== source) return;
      activeSource = undefined;
      void context?.suspend().catch(() => undefined);
    };
    activeSource = source;
    source.start();
  } catch {
    return;
  }
}

export function playAgentNotificationSound(): void {
  void playLatest(++requestSequence);
}
