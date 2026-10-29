import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultRunner, type ProcessRunner } from "../models/claudeCode.ts";

export interface Transcriber {
  readonly name: string;
  /** Turns a recording (any format ffmpeg reads, such as Telegram's OGG/Opus) into text. */
  transcribe(audio: Buffer): Promise<string>;
}

export interface WhisperCppOptions {
  whisperBin: string;
  modelPath: string;
  ffmpegBin: string;
  /** "auto" detects Hebrew or English per recording; a code like "he" forces one language. */
  language: string;
  threads?: number;
  timeoutMs?: number;
}

/**
 * Transcribes on this machine with whisper.cpp: free, private, and no audio leaves the Mac.
 * ffmpeg first converts the recording to the 16 kHz mono WAV whisper.cpp expects.
 */
export class WhisperCppTranscriber implements Transcriber {
  readonly name = "whisper-cpp";

  constructor(
    private readonly options: WhisperCppOptions,
    private readonly run: ProcessRunner = defaultRunner,
  ) {}

  async transcribe(audio: Buffer): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "flowtika-voice-"));
    const timeoutMs = this.options.timeoutMs ?? 10 * 60 * 1000;
    try {
      const input = path.join(dir, "input");
      const wav = path.join(dir, "audio.wav");
      await writeFile(input, audio);

      const ffmpeg = await this.run(
        this.options.ffmpegBin,
        ["-nostdin", "-loglevel", "error", "-y", "-i", input, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav],
        "",
        { cwd: dir, timeoutMs },
      );
      if (ffmpeg.code !== 0) throw new Error(`ffmpeg couldn't read the recording: ${ffmpeg.stderr.slice(0, 300)}`);

      const args = ["-m", this.options.modelPath, "-f", wav, "-l", this.options.language, "-nt", "-np"];
      if (this.options.threads) args.push("-t", String(this.options.threads));
      const whisper = await this.run(this.options.whisperBin, args, "", { cwd: dir, timeoutMs });
      if (whisper.code !== 0) throw new Error(`whisper.cpp failed: ${whisper.stderr.slice(0, 300)}`);
      return cleanTranscript(whisper.stdout);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** Joins whisper's lines and drops the markers it prints for silence or music. */
export function cleanTranscript(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE)\]/gi, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
