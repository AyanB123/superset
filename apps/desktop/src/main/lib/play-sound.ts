import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

interface PlaySoundCallbacks {
	onComplete?: () => void;
	isCanceled?: () => boolean;
	onProcessChange?: (process: ChildProcess) => void;
}

/**
 * Plays a sound file at the given volume using platform-specific commands.
 * Returns the primary ChildProcess, or null if playback was skipped.
 *
 * On macOS, volume is controlled via afplay -v (0.0-1.0).
 * On Linux, volume is controlled via paplay --volume (0-65536), with aplay fallback.
 * On Windows, there is no built-in CLI wav player, so a short system sound is
 * played via PowerShell + SystemSounds instead. The `volume` argument is
 * ignored on Windows (the system mixer controls loudness); `soundPath` is
 * likewise ignored because SystemSounds are fixed OS assets.
 */
export function playSoundFile(
	soundPath: string,
	volume: number = 100,
	callbacks?: PlaySoundCallbacks,
): ChildProcess | null {
	if (!existsSync(soundPath)) {
		console.warn(`[play-sound] Sound file not found: ${soundPath}`);
		return null;
	}

	const volumeDecimal = volume / 100;

	if (process.platform === "darwin") {
		return execFile("afplay", ["-v", volumeDecimal.toString(), soundPath], () =>
			callbacks?.onComplete?.(),
		);
	}

	if (process.platform === "win32") {
		// No bundled CLI wav player on Windows; play a short system sound via
		// PowerShell. SystemSounds.Play() is non-blocking on the .NET side and
		// the spawned process exits immediately, matching the fire-and-forget
		// lifecycle of the darwin/linux branches. Volume is controlled by the
		// OS mixer, so the `volume` argument is intentionally ignored here.
		return execFile(
			"powershell.exe",
			[
				"-NoProfile",
				"-Command",
				"[System.Media.SystemSounds]::Asterisk.Play()",
			],
			{ windowsHide: true },
			() => callbacks?.onComplete?.(),
		);
	}

	// Linux: paplay --volume accepts 0-65536 (65536 = 100%)
	const paVolume = Math.round(volumeDecimal * 65536);
	return execFile(
		"paplay",
		["--volume", paVolume.toString(), soundPath],
		(error) => {
			if (error) {
				if (callbacks?.isCanceled?.()) {
					callbacks?.onComplete?.();
					return;
				}
				if (volume === 0) {
					callbacks?.onComplete?.();
					return;
				}
				const fallback = execFile("aplay", [soundPath], () =>
					callbacks?.onComplete?.(),
				);
				callbacks?.onProcessChange?.(fallback);
				return;
			}
			callbacks?.onComplete?.();
		},
	);
}
