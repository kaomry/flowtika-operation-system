import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ProcessRunner } from "../src/models/claudeCode.ts";
import { cleanTranscript, WhisperCppTranscriber } from "../src/voice/transcriber.ts";

const options = { whisperBin: "whisper-cli", modelPath: "/models/ggml.bin", ffmpegBin: "ffmpeg", language: "auto" };

describe("cleanTranscript", () => {
  it("joins lines and drops silence markers", () => {
    expect(cleanTranscript(" [BLANK_AUDIO]\n Remind me to call Dana\n tomorrow at ten. \n")).toBe(
      "Remind me to call Dana tomorrow at ten.",
    );
    expect(cleanTranscript("[BLANK_AUDIO]\n")).toBe("");
  });

  it("keeps Hebrew as is", () => {
    expect(cleanTranscript(" תזכיר לי להתקשר לדנה מחר\n")).toBe("תזכיר לי להתקשר לדנה מחר");
  });
});

describe("WhisperCppTranscriber", () => {
  it("converts with ffmpeg, then runs whisper.cpp on the WAV, and cleans up", async () => {
    const calls: { bin: string; args: string[]; cwd: string }[] = [];
    const runner: ProcessRunner = async (bin, args, _stdin, { cwd }) => {
      calls.push({ bin, args, cwd });
      if (bin === "ffmpeg") {
        expect(existsSync(args[args.indexOf("-i") + 1]!)).toBe(true);
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: " Hello there.\n", stderr: "" };
    };
    const text = await new WhisperCppTranscriber(options, runner).transcribe(Buffer.from("ogg bytes"));

    expect(text).toBe("Hello there.");
    expect(calls.map((c) => c.bin)).toEqual(["ffmpeg", "whisper-cli"]);
    const ff = calls[0]!.args;
    expect(ff.slice(ff.indexOf("-ar"), ff.indexOf("-ar") + 4)).toEqual(["-ar", "16000", "-ac", "1"]);
    const w = calls[1]!.args;
    expect(w[w.indexOf("-m") + 1]).toBe("/models/ggml.bin");
    expect(w[w.indexOf("-l") + 1]).toBe("auto");
    expect(w[w.indexOf("-f") + 1]).toBe(ff.at(-1));
    expect(existsSync(calls[0]!.cwd)).toBe(false);
  });

  it("explains an unreadable recording", async () => {
    const runner: ProcessRunner = async () => ({ code: 1, stdout: "", stderr: "Invalid data found" });
    await expect(new WhisperCppTranscriber(options, runner).transcribe(Buffer.from("x"))).rejects.toThrow(
      /ffmpeg couldn't read the recording: Invalid data/,
    );
  });

  it("reports a whisper failure", async () => {
    const runner: ProcessRunner = async (bin) =>
      bin === "ffmpeg" ? { code: 0, stdout: "", stderr: "" } : { code: 2, stdout: "", stderr: "failed to load model" };
    await expect(new WhisperCppTranscriber(options, runner).transcribe(Buffer.from("x"))).rejects.toThrow(
      /whisper.cpp failed: failed to load model/,
    );
  });
});
