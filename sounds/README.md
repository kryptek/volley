# Desk sound themes

The Volley Desk plays short sounds for what happens on it: clicks, drags, tethers, panels, agents
spawning and finishing, CI, merges, waves, steering, the broker and anything that needs you. There
are twelve themes; Settings › Sound picks one and plays any clip of any theme. This folder holds
what the clips are made from; the clips themselves are committed under
[`packages/volley-desk/public/sounds/`](../packages/volley-desk/public/sounds/), one folder per
theme with a `manifest.json`.

- [`prompts.yaml`](prompts.yaml) is the source: each theme's style line and each event's base
  prompt, duration and severity. A clip's prompt is
  `base_prompt, style_suffix, severity_suffix`. Theme ids and labels match the Desk's
  `src/sounds/themes.ts`, event ids its `src/sounds/events.ts` (a test keeps them in step).
- `review/` (untracked) holds the generated candidates, `review/<theme>/<event>.<n>.wav`, and
  `review/_log.jsonl`, one line per request (prompt, duration, status, bytes).

## Making the clips

Generation uses the [ElevenLabs Sound Effects API](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert).
It needs `ELEVENLABS_API_KEY` in the environment of that one command and nothing else: the script
never takes the key as a flag, never prints it and never writes it anywhere. `ffmpeg` and `ffprobe`
must be on the `PATH` for `pick`.

```sh
bun run sounds:generate --dry-run                     # how many requests, how many seconds
ELEVENLABS_API_KEY=… bun run sounds:generate          # every clip not yet in review/, 3 variants each
bun run sounds:pick --auto                            # promote a variant for every clip not yet picked
bun run sounds:pick --interactive --theme arcade      # listen to the variants, pick 1/2/3, r to re-roll
bun run sounds:check                                  # manifests, Opus mono, 200 KB per theme, no strays
```

`generate` asks only for what `review/` lacks (`--theme` / `--event` narrow it, `--variants`
sets how many per clip), retries 429 and 5xx responses, stops on a 401, and with
`--budget <credits> --rate <credits per second>` refuses a run that would cost more. It asks for
44.1 kHz PCM (saved as WAV) and falls back to MP3 when the plan does not offer PCM.

`pick <theme> <event> <variant>` trims the silence at both ends, normalises the loudness to
−16 LUFS (it measures, then applies one gain under a −1 dBTP limiter) and encodes mono Ogg/Opus,
48 kHz, 48 kbps VBR, into `public/sounds/<theme>/<event>.ogg`, then rewrites the theme's manifest:

```json
{ "theme": "arcade", "label": "Arcade 8-bit", "version": 3, "generated_at": "…",
  "clips": { "ui_click": { "file": "ui_click.ogg", "ms": 120, "variant": 2 } }, "missing": [] }
```

`--auto` chooses the variant whose trimmed length is closest to the prompt's duration: a stand-in
until someone has listened. `--mp3` also writes an MP3 beside a clip, listed as its `fallback`
(the player uses it where the browser cannot decode Opus).

**Re-rolling one clip:** delete its variants from `review/<theme>/` (or answer `r` in
`--interactive`), run `sounds:generate --theme <theme> --event <event>`, then `sounds:pick` the
variant you like and `sounds:check`.

## Browsers

The clips are Ogg/Opus only. Chromium and Firefox decode it; so does WebKit 26 (the engine of
Safari 26): `canPlayType('audio/ogg; codecs="opus"')` answers `probably` and `decodeAudioData`
decodes a theme's clip (mono, 48 kHz). No MP3 fallbacks are committed. A browser that cannot decode
a clip gets silence for it, never an error.

## Licensing

Every clip was generated for this project on a paid ElevenLabs plan of the owner's account, whose
terms permit commercial use of the output. No third-party samples are used. The Desk's previous
attention chime (`notify.mp3`) was synthesized in-repo and is removed; the legacy dashboard keeps
its own copy.

## Budget

12 themes × 28 events × 3 variants = 1,008 generations, 795.6 seconds of audio. Measured at about
12 credits per second with an explicit duration. Spent on the first full run: 9,183 credits.
