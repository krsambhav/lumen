# Lumen — product

Lumen is a video player for macOS. It plays local files in any common format, streams from a pasted link, and sends what is playing to a TV.

## Who it is for

Mac users who keep their own video and music files and want to watch them properly, on the Mac or on the TV across the room. They are comfortable with the Mac, use the keyboard, and notice when an app is fussy. They are usually sitting back, often in a dim room, sometimes with the laptop on a table two metres away.

Three situations cover most use:

1. **Watching.** Open a file and it plays. The picture fills the window; everything else gets out of the way within two seconds. Pick up tomorrow where you stopped tonight.
2. **Adjusting.** The subtitles are late, the dialogue is quiet, the picture is dark, the audio is on the wrong device. Fix it in a few seconds without leaving the film.
3. **Sending.** Put the same file on the television, with its subtitles, and keep controlling it from the Mac.

## What it must do

Playback of every common container and codec with hardware decoding and HDR; speed, frame stepping, A–B loop, bookmarks and resume; a video tuner and geometry controls; a ten-band equaliser, audio delay, device and channel selection, passthrough, 200% boost; external and embedded subtitles, two at once, styling and online search; playlists and a library of watched folders; casting to AirPlay, Chromecast, DLNA and Roku with transcoding when the target needs it; opening and downloading online video through yt-dlp; screenshots; a full settings window with rebindable shortcuts.

The complete list, with what is built and what is not, lives in the milestone summaries.

## Tone

**Calm, precise, cinematic.**

- *Calm*: the interface is quiet until asked. Nothing blinks, bounces or asks for attention while a film is playing.
- *Precise*: timecodes line up, sliders land on round values, labels say exactly what will happen. It should feel like a well-made instrument rather than an app with features.
- *Cinematic*: dark by default, built around the picture. The chrome behaves like house lights: it dims when the film starts.

## What it must not look like

- A SaaS dashboard: cards in a grid, cards inside cards, metric tiles, sidebars full of badges.
- Purple gradients, neon-on-dark, glass panels with glow.
- Another player's skin. No borrowed layouts, icons or branding from Elmedia or anyone else.

## Principles

1. **The picture comes first.** Anything drawn over the video must justify being there, and must leave on its own.
2. **One way to reach everything.** Every action has a name, a shortcut, a tooltip that shows the shortcut, and an entry in the command palette. They all come from one registry, so they cannot disagree.
3. **Adjust while watching.** Controls that change the picture or sound sit beside the video, never on top of it, and take effect live.
4. **Say what happened.** Every change made from the keyboard is confirmed on screen for a moment, in words and numbers.
5. **Never fake it.** If a device cannot do something, the control says so. No placeholder data, no buttons that do nothing.

## Platform

macOS 12 and later, Apple silicon and Intel. Distributed outside the Mac App Store, signed and notarised.

Third-party software and licences are listed in `NOTICES`.
