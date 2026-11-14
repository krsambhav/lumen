/**
 * Development only: a simulated backend, so the interface can run in an
 * ordinary browser for layout work and for the Playwright tests. It answers
 * every command the real backend does and plays pretend films whose clock
 * advances like the real one, through a pretend playlist that moves on when
 * one ends.
 *
 * Compiled in only when the build sets VITE_LUMEN_DEVTOOLS, and installed
 * only when the page URL's fragment contains "mock".
 */

import { emit } from "@tauri-apps/api/event";
import { mockWindows } from "@tauri-apps/api/mocks";
import { DEFAULT_SESSION, DEFAULT_SETTINGS } from "@/app/boot";
import { OWN_SHAPE } from "@/features/video/shape";
import type {
  AppError,
  CastSnapshot,
  Chapter,
  FailureReason,
  HistoryEntry,
  PlayedIn,
  PlayerChange,
  PlayerSnapshot,
  QueueItem,
  QueueSnapshot,
  Recent,
  SavedPlaylist,
  Session,
  Settings,
  SyncStatus,
  TorrentFile,
  TorrentResult,
  Track,
} from "@/ipc";
import { mockCommands } from "@/ipc/bindings";

const TICK_MS = 100;
/** How long a pretend film runs unless the test says otherwise: 2:01:45. */
const FILM_LENGTH = 7305;

/** Where sound can go on the pretend Mac. */
const DEVICES = [
  { id: "coreaudio/BuiltInSpeakerDevice", name: "MacBook Pro Speakers" },
  { id: "coreaudio/AppleHDAEngineOutput:1", name: "Living Room TV" },
];

const IDLE: PlayerSnapshot = {
  status: "idle",
  source: null,
  title: null,
  position: 0,
  duration: null,
  volume: 100,
  muted: false,
  speed: 1,
  video: null,
  tracks: [],
  chapters: [],
  audioDelay: 0,
  subtitleDelay: 0,
  subtitleSpeed: 1,
  shape: OWN_SHAPE,
  audioDevices: DEVICES,
  visualised: false,
};

/** What the mock torrent server knows: a film that is ready, a season to fetch, and an archive. */
const MOCK_TORRENTS: { result: TorrentResult; files: TorrentFile[] }[] = [
  {
    result: {
      name: "The Long Take 2019 1080p BluRay x264-LUMEN",
      hash: "a".repeat(40),
      magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`,
      size: "2.1 GB",
      seeders: 1843,
      leechers: 120,
      uploaded: "2020-02-11",
      category: "Video",
      trusted: true,
      ready: true,
    },
    files: [
      {
        index: 0,
        name: "The.Long.Take.2019.1080p.BluRay.x264.mkv",
        size: 2_254_857_830,
        playable: true,
      },
    ],
  },
  {
    result: {
      name: "The Long Take S01 Complete 720p WEB-DL",
      hash: "b".repeat(40),
      magnet: `magnet:?xt=urn:btih:${"b".repeat(40)}`,
      size: "4.6 GB",
      seeders: 312,
      leechers: 40,
      uploaded: "2021-06-02",
      category: "Video",
      trusted: false,
      ready: false,
    },
    files: [
      { index: 0, name: "The.Long.Take.S01E10.720p.mkv", size: 480_000_000, playable: true },
      { index: 1, name: "The.Long.Take.S01E01.720p.mkv", size: 470_000_000, playable: true },
      { index: 2, name: "The.Long.Take.S01E02.720p.mkv", size: 465_000_000, playable: true },
      { index: 3, name: "The.Long.Take.S01E01.720p.srt", size: 42_000, playable: false },
    ],
  },
  {
    result: {
      name: "The Long Take Original Score FLAC",
      hash: "c".repeat(40),
      magnet: `magnet:?xt=urn:btih:${"c".repeat(40)}`,
      size: "612 MB",
      seeders: 9,
      leechers: 2,
      uploaded: null,
      category: "Audio",
      trusted: false,
      ready: true,
    },
    files: [{ index: 0, name: "The Long Take OST.zip", size: 641_728_512, playable: false }],
  },
];
MOCK_TORRENTS.push({
  result: {
    name: "MobLand S02E10 Song for the Dead 720p AMZN WEB-DL DDP5 1 H 264-RAWR",
    hash: "d".repeat(40),
    magnet: `magnet:?xt=urn:btih:${"d".repeat(40)}`,
    size: "1.4 GB",
    seeders: 862,
    leechers: 31,
    uploaded: "2026-11-02",
    category: "Video",
    trusted: false,
    ready: true,
  },
  files: [{ index: 0, name: "MobLand.S02E10.720p.mkv", size: 1_503_238_553, playable: true }],
});
/** How far each mock torrent asked for has come, by id. */
const torrentPolls = new Map<string, number>();

export interface MockFilm {
  source: string;
  duration: number;
  position?: number;
  paused?: boolean;
  chapters?: Chapter[];
  /** Sound only: no picture, so no preview either. */
  audio?: boolean;
  /** Its audio and subtitle tracks; without any, one audio track of no language. */
  tracks?: Track[];
}

/** A track, with what a file would leave out filled in. */
export function mockTrack(kind: Track["kind"], id: number, given: Partial<Track> = {}): Track {
  return {
    id,
    kind,
    title: null,
    language: null,
    codec: kind === "audio" ? "aac" : kind === "subtitle" ? "subrip" : "hevc",
    selected: false,
    default: false,
    forced: false,
    external: false,
    file: null,
    secondary: false,
    channels: kind === "audio" ? 2 : null,
    ...given,
  };
}

/** A film as it comes off a disc: two languages of sound, three sets of subtitles. */
export const FILM_TRACKS: readonly Track[] = [
  mockTrack("audio", 1, { language: "eng", codec: "ac3", channels: 6, selected: true }),
  mockTrack("audio", 2, { language: "fre", title: "Version française" }),
  mockTrack("subtitle", 1, { language: "eng" }),
  mockTrack("subtitle", 2, { language: "eng", title: "For the hard of hearing" }),
  mockTrack("subtitle", 3, { language: "fre", codec: "hdmv_pgs_subtitle", forced: true }),
];

export interface LumenMock {
  /** Starts a pretend film, as a playlist of that one item. */
  open: (film: MockFilm) => void;
  /** Starts a playlist of these, playing the first (paused if asked). */
  openQueue: (sources: string[], options?: { paused?: boolean; at?: number }) => void;
  /** Reports that `source` could not be opened, as a file that is no longer there unless told otherwise. */
  fail: (source: string, reason?: FailureReason, reveal?: string | null) => void;
  /** Reports that an item of the playlist was stepped over. */
  skip: (source: string, reason?: FailureReason) => void;
  /** Reports that the film now open started where it was left. */
  resume: (seconds: number) => void;
  /** Replaces what has been played, newest first. */
  seedHistory: (entries: Partial<Recent>[]) => void;
  /** Adds a saved playlist. */
  seedPlaylist: (name: string, sources: string[]) => SavedPlaylist;
  /**
   * Makes a command fail with `error` from now on, as the backend would
   * refuse it; `null` lets it through again.
   */
  refuse: (command: string, error: AppError | null) => void;
  /** Every command the page has sent, oldest first. */
  calls: { command: string; args: unknown }[];
  chromeVisible: boolean;
  fullscreen: boolean;
  /** The picture is shown in high dynamic range. */
  hdr: boolean;
  /** As the backend does when the picture starts or stops being HDR. */
  setHdr: (hdr: boolean) => void;
  /** The width the page has asked the window to keep for the panel. */
  panelWidth: number;
  /** How long each source runs; anything not listed runs two hours. `null` means not known. */
  lengths: Record<string, number | null>;
  snapshot: () => PlayerSnapshot;
  queue: () => QueueSnapshot;
  /**
   * How a pretend subtitle sync ends: with this timing, or failing with
   * this message. Each step of it takes `step` ms (default 120).
   */
  sync: { speed: number; delay: number; step?: number } | { fails: string; step?: number };
}

declare global {
  interface Window {
    __lumenMock?: LumenMock;
  }
}

/** The backend's rule for what resumes, and where: `resume_point` in src-tauri/src/library/history.rs. */
function resumePoint(position: number, duration: number | null): number | null {
  if (duration === null || duration < 600 || position < 10) {
    return null;
  }
  return position >= duration - Math.max(10, duration * 0.03) ? null : Math.max(0, position - 3);
}

/** The kinds of file whose extension the backend leaves out of a name (a sample of `media::formats`). */
const KNOWN_EXTENSION = /\.(mkv|mp4|m4v|mov|avi|webm|ts|flac|mp3|m4a|wav|ogg|opus|m3u8?|pls)$/i;

/** What the backend calls a source: `display_name` in src-tauri/src/media/sources.rs. */
function nameOf(source: string): string {
  if (source.includes("://")) {
    return source;
  }
  const file = source.split("/").pop() ?? source;
  return file.replace(KNOWN_EXTENSION, "") || file;
}

/** A flat picture in a colour that depends on the time, so a test can tell stills apart. */
function still(seconds: number): string {
  const hue = Math.round(seconds) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="384" height="216"><rect width="384" height="216" fill="hsl(${hue} 40% 30%)"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function installMockBackend(): LumenMock {
  let player: PlayerSnapshot = { ...IDLE };
  let settings: Settings = DEFAULT_SETTINGS;
  let session: Session = DEFAULT_SESSION;
  let ticker: ReturnType<typeof setInterval> | undefined;

  let items: QueueItem[] = [];
  let current: number | null = null;
  /** The saved playlist the queue is, if it is one: it has that one's name. */
  let queueKept: number | null = null;
  /** What the history knows the queue by, as the backend's conductor keeps it. */
  let queueKey: string | null = null;
  let openings = 0;
  let repeat: QueueSnapshot["repeat"] = "off";
  let shuffle = false;
  let nextId = 1;

  let history: Recent[] = [];
  let clock = 1_700_000_000;
  const saved = new Map<number, { playlist: SavedPlaylist; sources: string[]; deleted: boolean }>();
  let nextPlaylistId = 1;

  function change(update: PlayerChange) {
    void emit("player-changed", update);
  }

  // Casting: two Chromecasts turn up shortly after the first search.
  let cast: CastSnapshot = { searching: false, devices: [], session: null };
  function sayCast(next: CastSnapshot) {
    cast = next;
    void emit("cast-changed", next);
  }
  const MOCK_DEVICES: CastSnapshot["devices"] = [
    {
      id: "cast:living",
      name: "Living Room TV",
      model: "Google TV Streamer",
      protocol: "chromecast",
      video: true,
    },
    {
      id: "cast:bedroom",
      name: "Bedroom",
      model: "Chromecast",
      protocol: "chromecast",
      video: true,
    },
    { id: "airplay:den", name: "Den", model: "Apple TV", protocol: "airPlay", video: true },
    { id: "airplay:kitchen", name: "Kitchen", model: "HomePod", protocol: "airPlay", video: false },
  ];

  // The subtitle sync: the model is downloaded the first time, then eight
  // samples are listened to, as the backend does.
  let syncStatus: SyncStatus = { state: "idle", installed: false };
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  function saySync(status: SyncStatus) {
    syncStatus = status;
    void emit("subtitle-sync-changed", status);
  }
  function runSync(source: string, track: number, before: [number, number]) {
    const step = mock.sync.step ?? 120;
    const steps: (() => void)[] = [];
    if (syncStatus.state === "idle" && !syncStatus.installed) {
      for (const progress of [0, 0.18, 0.41, 0.66, 0.9, 1]) {
        steps.push(() =>
          saySync({ state: "installing", source, track, progress, size: 59_707_625 }),
        );
      }
    }
    for (let done = 0; done <= 8; done += 1) {
      steps.push(() => saySync({ state: "listening", source, track, done, total: 8 }));
    }
    steps.push(() => {
      const outcome = mock.sync;
      if ("fails" in outcome) {
        saySync({ state: "failed", source, track, message: outcome.fails });
        return;
      }
      player = { ...player, subtitleSpeed: outcome.speed, subtitleDelay: outcome.delay };
      change({ type: "subtitleSpeed", rate: outcome.speed });
      change({ type: "subtitleDelay", seconds: outcome.delay });
      saySync({
        state: "synced",
        source,
        track,
        speed: outcome.speed,
        delay: outcome.delay,
        byWords: true,
        agreeing: 8,
        heard: 8,
        speedBefore: before[0],
        delayBefore: before[1],
      });
    });
    const next = () => {
      const run = steps.shift();
      if (run) {
        run();
        syncTimer = setTimeout(next, step);
      } else {
        syncTimer = undefined;
      }
    };
    next();
  }

  function lengthOf(source: string): number | null {
    return source in mock.lengths ? (mock.lengths[source] ?? null) : FILM_LENGTH;
  }

  function queueSnapshot(): QueueSnapshot {
    const at = items.findIndex((item) => item.id === current);
    const wraps = repeat !== "off" && items.length > 0;
    return {
      items,
      current,
      name: queueName(),
      repeat,
      shuffle,
      hasNext: at >= 0 && (at + 1 < items.length || wraps),
      hasPrevious: at >= 0 && (at > 0 || wraps),
    };
  }

  function announce() {
    void emit("queue-changed", queueSnapshot());
  }

  /** The queue's name: that of the saved playlist it is, while there is one. */
  function queueName(): string | null {
    const kept = queueKept === null ? undefined : saved.get(queueKept);
    return kept && !kept.deleted ? kept.playlist.name : null;
  }

  function savedList(): SavedPlaylist[] {
    return [...saved.values()]
      .filter((entry) => !entry.deleted)
      .map((entry) => entry.playlist)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** As the backend does whenever what was played is not what it was. */
  function announceHistory() {
    void emit("history-changed", null);
  }

  /** As the backend does whenever what is saved changes. */
  function announceSaved() {
    void emit("playlists-changed", savedList());
  }

  function makeItems(sources: string[]): QueueItem[] {
    return sources.map((source) => ({
      id: nextId++,
      source,
      title: nameOf(source),
      duration: lengthOf(source),
      failed: null,
    }));
  }

  /** The playlist what is playing is part of, as the backend records it; `null` when it plays alone. */
  function playedIn(): PlayedIn | null {
    if (items.length < 2) {
      return null;
    }
    queueKey ??= queueKept === null ? `mock-${++openings}` : `saved:${queueKept}`;
    return {
      key: queueKey,
      name: queueName(),
      items: items.map((item) => ({
        source: item.source,
        title: item.title,
        duration: item.duration,
      })),
    };
  }

  function remember(source: string, title: string) {
    const known = history.find((entry) => entry.source === source);
    clock += 60;
    history = [
      {
        source,
        title,
        duration: known?.duration ?? null,
        position: known?.position ?? 0,
        finished: known?.finished ?? false,
        playedAt: clock,
        state: known?.state ?? null,
        playlist: playedIn(),
        available: true,
        poster: known?.poster ?? null,
        resumesAt: known?.resumesAt ?? null,
      },
      ...history.filter((entry) => entry.source !== source),
    ];
    announceHistory();
  }

  function noteProgress() {
    history = history.map((entry) =>
      entry.source === player.source
        ? {
            ...entry,
            position: player.position,
            duration: player.duration,
            resumesAt: resumePoint(player.position, player.duration),
          }
        : entry,
    );
  }

  function setTracks(tracks: Track[]) {
    player = { ...player, tracks };
    change({ type: "tracks", tracks });
  }

  /** What was showing when subtitles were last switched off: the first track and the second. */
  let setAside: [number | null, number | null] = [null, null];

  function setStatus(status: PlayerSnapshot["status"]) {
    if (player.status !== status) {
      player = { ...player, status };
      change({ type: "status", status });
    }
  }

  function setPosition(seconds: number) {
    const length = player.duration ?? Number.POSITIVE_INFINITY;
    const position = Math.min(length, Math.max(0, seconds));
    player = { ...player, position };
    change({ type: "position", seconds: position });
    if (player.duration !== null && position >= player.duration && player.status === "playing") {
      setStatus("ended");
      // As the conductor does: what follows it plays.
      const at = items.findIndex((item) => item.id === current);
      const next =
        repeat === "one" ? items[at] : (items[at + 1] ?? (repeat === "all" ? items[0] : undefined));
      if (next) {
        current = next.id;
        announce();
        load({ source: next.source, duration: next.duration ?? FILM_LENGTH });
      }
    }
  }

  function tick() {
    if (player.status === "playing") {
      setPosition(player.position + (TICK_MS / 1000) * player.speed);
      noteProgress();
    }
  }

  /** The player's part of opening something. */
  function load(film: MockFilm) {
    clearInterval(ticker);
    const title = nameOf(film.source);
    player = { ...player, source: film.source, title, status: "loading", position: 0 };
    change({ type: "media", source: film.source, title });
    change({ type: "position", seconds: film.position ?? 0 });
    change({ type: "status", status: "loading" });
    player = { ...player, duration: film.duration, chapters: film.chapters ?? [] };
    change({ type: "duration", seconds: film.duration });
    // As a file's own tracks: a new file starts with its own, and its own timing and frame.
    setTracks(
      (film.tracks ?? [mockTrack("audio", 1, { selected: true })]).map((track) => ({ ...track })),
    );
    player = { ...player, audioDelay: 0, subtitleDelay: 0, shape: OWN_SHAPE };
    change({ type: "audioDelay", seconds: 0 });
    change({ type: "subtitleDelay", seconds: 0 });
    change({ type: "shape", shape: OWN_SHAPE });
    change({ type: "chapters", chapters: player.chapters });
    const video = film.audio
      ? null
      : {
          width: 1920,
          height: 1080,
          fps: 24,
          codec: "hevc",
          dynamicRange: "sdr" as const,
          hardwareDecoder: "videotoolbox",
        };
    player = { ...player, video };
    change({ type: "video", video });
    remember(film.source, title);
    setPosition(film.position ?? 0);
    setStatus(film.paused ? "paused" : "playing");
    ticker = setInterval(tick, TICK_MS);
  }

  function startQueue(sources: string[], film?: Partial<MockFilm>) {
    items = makeItems(sources);
    current = items[0]?.id ?? null;
    queueKept = null;
    queueKey = null;
    announce();
    const first = items[0];
    if (first) {
      if (film?.duration !== undefined) {
        first.duration = film.duration;
      }
      load({ source: first.source, duration: first.duration ?? FILM_LENGTH, ...film });
    }
  }

  function playItem(item: QueueItem) {
    current = item.id;
    announce();
    load({ source: item.source, duration: item.duration ?? FILM_LENGTH });
  }

  function stop() {
    clearInterval(ticker);
    player = { ...IDLE, volume: player.volume, muted: player.muted };
    change({ type: "media", source: null, title: null });
    change({ type: "position", seconds: 0 });
    change({ type: "status", status: "idle" });
    if (items.length > 0) {
      items = [];
      current = null;
      queueKept = null;
      announce();
    }
  }

  function step(by: 1 | -1): boolean {
    const at = items.findIndex((item) => item.id === current);
    let target = items[at + by];
    if (!target && repeat !== "off" && items.length > 0) {
      target = by > 0 ? items[0] : items[items.length - 1];
    }
    if (at < 0 || !target) {
      return false;
    }
    playItem(target);
    return true;
  }

  function summary(id: number): SavedPlaylist | undefined {
    return saved.get(id)?.playlist;
  }

  const refusals = new Map<string, AppError>();

  function record<T>(command: string, args: unknown, result: T): T {
    mock.calls.push({ command, args });
    const refused = refusals.get(command);
    if (refused) {
      // What the generated bindings turn into `{ status: "error" }`.
      throw refused;
    }
    return result;
  }

  const mock: LumenMock = {
    open: (film) => startQueue([film.source], film),
    openQueue: (sources, options = {}) =>
      startQueue(sources, {
        ...(options.paused === undefined ? {} : { paused: options.paused }),
        ...(options.at === undefined ? {} : { position: options.at }),
      }),
    fail: (source, reason = { kind: "missing" }, reveal = null) => {
      // As the real backend does it: the attempt replaces what was open, then fails.
      change({ type: "media", source, title: nameOf(source) });
      change({ type: "failed", source, reason, reveal });
      stop();
    },
    skip: (source, reason = { kind: "missing" }) => {
      // As the backend does: the item's row goes on saying so.
      items = items.map((item) => (item.source === source ? { ...item, failed: reason } : item));
      void emit("playback-skipped", { source, title: nameOf(source), reason });
      void emit("queue-changed", queueSnapshot());
    },
    resume: (seconds) => change({ type: "resumed", seconds }),
    seedHistory: (entries) => {
      history = entries.map((given, index) => {
        const entry = {
          source: `/Users/me/Films/Film ${index + 1}.mkv`,
          title: nameOf(given.source ?? `/Users/me/Films/Film ${index + 1}.mkv`),
          duration: FILM_LENGTH,
          position: 0,
          finished: false,
          playedAt: clock - index * 3600,
          state: null,
          playlist: null,
          available: true,
          poster: null,
          ...given,
        };
        return {
          ...entry,
          resumesAt: entry.finished ? null : resumePoint(entry.position, entry.duration),
        };
      });
      announceHistory();
    },
    seedPlaylist: (name, sources) => {
      const playlist: SavedPlaylist = {
        id: nextPlaylistId++,
        name,
        count: sources.length,
        duration: sources.reduce((sum, source) => sum + (lengthOf(source) ?? 0), 0),
        updatedAt: clock,
      };
      saved.set(playlist.id, { playlist, sources, deleted: false });
      announceSaved();
      return playlist;
    },
    refuse: (command, error) => {
      if (error === null) {
        refusals.delete(command);
      } else {
        refusals.set(command, error);
      }
    },
    calls: [],
    chromeVisible: true,
    fullscreen: false,
    hdr: false,
    setHdr: (hdr) => {
      mock.hdr = hdr;
      void emit("dynamic-range-changed", hdr);
    },
    panelWidth: 0,
    lengths: {},
    sync: { speed: 1, delay: -2.35 },
    snapshot: () => player,
    queue: queueSnapshot,
  };

  const FOLDER = [1, 2, 3].map((episode) => `/Users/me/Series/Episode ${episode}.mkv`);

  mockWindows("main");
  mockCommands({
    appReady: () => record("appReady", null, null),
    menuSet: (args) => record("menuSet", args, null),
    settingsGet: () => settings,
    settingsSet: (args) => {
      settings = args.settings;
      void emit("settings-changed", settings);
      return record("settingsSet", args, null);
    },
    sessionGet: () => session,
    sessionSetInterface: (args) => {
      session = { ...session, interface: args.layout };
      return record("sessionSetInterface", args, null);
    },
    windowSetChromeVisible: (args) => {
      mock.chromeVisible = args.visible;
      return record("windowSetChromeVisible", args, null);
    },
    windowSetFullscreen: (args) => {
      mock.fullscreen = args.fullscreen;
      void emit("fullscreen-changed", mock.fullscreen);
      return record("windowSetFullscreen", args, null);
    },
    windowToggleFullscreen: () => {
      mock.fullscreen = !mock.fullscreen;
      void emit("fullscreen-changed", mock.fullscreen);
      return record("windowToggleFullscreen", null, null);
    },
    windowIsFullscreen: () => mock.fullscreen,
    windowIsHdr: () => mock.hdr,
    windowSetPanelWidth: (args) => {
      mock.panelWidth = args.width;
      return record("windowSetPanelWidth", args, null);
    },
    windowSetAlwaysOnTop: (args) => record("windowSetAlwaysOnTop", args, null),
    playerSnapshot: () => player,
    playerSetPaused: (args) => {
      setStatus(args.paused ? "paused" : "playing");
      return record("playerSetPaused", args, null);
    },
    playerTogglePaused: () => {
      if (player.status === "ended") {
        setPosition(0);
      }
      setStatus(player.status === "playing" ? "paused" : "playing");
      return record("playerTogglePaused", null, null);
    },
    playerSeekTo: (args) => {
      if (player.status === "ended") {
        player = { ...player, status: "paused" };
        change({ type: "status", status: "paused" });
      }
      setPosition(args.seconds);
      noteProgress();
      return record("playerSeekTo", args, null);
    },
    playerSeekBy: (args) => {
      setPosition(player.position + args.seconds);
      return record("playerSeekBy", args, null);
    },
    playerStepFrame: (args) => {
      setStatus("paused");
      setPosition(player.position + (args.forward ? 1 : -1) / 24);
      return record("playerStepFrame", args, null);
    },
    playerPreviewFrame: (args) =>
      record(
        "playerPreviewFrame",
        args,
        player.video === null || (player.source ?? "").includes("://") ? null : still(args.seconds),
      ),
    playerSetVolume: (args) => {
      const percent = Math.min(200, Math.max(0, args.percent));
      player = { ...player, volume: percent };
      change({ type: "volume", percent });
      return record("playerSetVolume", args, null);
    },
    playerSetMuted: (args) => {
      player = { ...player, muted: args.muted };
      change({ type: "muted", muted: args.muted });
      return record("playerSetMuted", args, null);
    },
    playerSetSpeed: (args) => {
      player = { ...player, speed: args.rate };
      change({ type: "speed", rate: args.rate });
      return record("playerSetSpeed", args, null);
    },
    playerSelectTrack: (args) => {
      record("playerSelectTrack", args, null);
      if (
        args.id !== null &&
        !player.tracks.some((t) => t.kind === args.kind && t.id === args.id)
      ) {
        throw { kind: "notFound", message: `there is no track ${args.id}` } as AppError;
      }
      setTracks(
        player.tracks.map((track) => {
          if (track.kind !== args.kind) {
            return track;
          }
          if (track.id === args.id) {
            return { ...track, selected: true, secondary: false };
          }
          // The second subtitle track stays as it is.
          return track.secondary ? track : { ...track, selected: false };
        }),
      );
      return null;
    },
    playerSelectSecondSubtitle: (args) => {
      record("playerSelectSecondSubtitle", args, null);
      setTracks(
        player.tracks.map((track) => {
          if (track.kind !== "subtitle" || (track.selected && !track.secondary)) {
            return track;
          }
          return { ...track, selected: track.id === args.id, secondary: track.id === args.id };
        }),
      );
      return null;
    },
    playerToggleSubtitles: () => {
      const subtitles = player.tracks.filter((track) => track.kind === "subtitle");
      const first = subtitles.find((track) => track.selected && !track.secondary);
      const second = subtitles.find((track) => track.selected && track.secondary);
      if (first || second) {
        setAside = [first?.id ?? null, second?.id ?? null];
        setTracks(
          player.tracks.map((track) =>
            track.kind === "subtitle" ? { ...track, selected: false, secondary: false } : track,
          ),
        );
        return record("playerToggleSubtitles", null, false);
      }
      if (subtitles.length === 0) {
        throw { kind: "invalid", message: "there are no subtitles" } as AppError;
      }
      const [was, wasSecond] = setAside;
      const on = was ?? subtitles[0]?.id ?? null;
      setTracks(
        player.tracks.map((track) => {
          if (track.kind !== "subtitle") {
            return track;
          }
          if (track.id === on) {
            return { ...track, selected: true, secondary: false };
          }
          return track.id === wasSecond ? { ...track, selected: true, secondary: true } : track;
        }),
      );
      return record("playerToggleSubtitles", null, true);
    },
    playerAddSubtitles: (args) => {
      record("playerAddSubtitles", args, null);
      if (player.source === null) {
        throw { kind: "invalid", message: "nothing is open" } as AppError;
      }
      const taken = player.tracks.filter((track) => track.kind === "subtitle").length;
      const added = args.files.map((file, index) =>
        mockTrack("subtitle", taken + index + 1, { external: true, file, selected: index === 0 }),
      );
      setTracks([
        ...player.tracks.map((track) =>
          track.kind === "subtitle" && !track.secondary ? { ...track, selected: false } : track,
        ),
        ...added,
      ]);
      return added.length;
    },
    playerAddSubtitlesDialog: () => record("playerAddSubtitlesDialog", null, 0),
    playerSetAudioDelay: (args) => {
      player = { ...player, audioDelay: args.seconds };
      change({ type: "audioDelay", seconds: args.seconds });
      return record("playerSetAudioDelay", args, null);
    },
    playerSetSubtitleDelay: (args) => {
      player = { ...player, subtitleDelay: args.seconds };
      change({ type: "subtitleDelay", seconds: args.seconds });
      return record("playerSetSubtitleDelay", args, null);
    },
    playerSetShape: (args) => {
      player = { ...player, shape: args.shape };
      change({ type: "shape", shape: args.shape });
      return record("playerSetShape", args, null);
    },
    playerSetSubtitleLift: (args) => record("playerSetSubtitleLift", args, null),
    castSnapshot: () => cast,
    castSearch: () => {
      if (!cast.searching) {
        sayCast({ ...cast, searching: true });
        setTimeout(() => sayCast({ ...cast, devices: MOCK_DEVICES }), 400);
      }
    },
    castStart: (args) => {
      const device = cast.devices.find((each) => each.id === args.device);
      if (device === undefined) {
        throw { kind: "notFound", message: "that device is no longer on the network" } as AppError;
      }
      sayCast({
        ...cast,
        session: {
          device: device.name,
          protocol: device.protocol,
          phase: "connecting",
          delivery: null,
        },
      });
      setTimeout(
        () =>
          sayCast({
            ...cast,
            session: {
              device: device.name,
              protocol: device.protocol,
              phase: "casting",
              delivery: "remux",
            },
          }),
        300,
      );
      return record("castStart", args, null);
    },
    castAirplay: (args) => record("castAirplay", args, null),
    castStop: () => {
      sayCast({ ...cast, session: null });
      return record("castStop", null, null);
    },
    subtitlesSyncStatus: () => syncStatus,
    subtitlesSync: () => {
      record("subtitlesSync", null, null);
      const shown = player.tracks.find(
        (track) => track.kind === "subtitle" && track.selected && !track.secondary,
      );
      if (player.source === null || shown === undefined) {
        throw { kind: "invalid", message: "no subtitles are showing" } as AppError;
      }
      if (syncTimer !== undefined) {
        throw { kind: "exists", message: "a sync is already running" } as AppError;
      }
      runSync(player.source, shown.id, [player.subtitleSpeed, player.subtitleDelay]);
      return null;
    },
    subtitlesSyncCancel: () => {
      record("subtitlesSyncCancel", null, null);
      if (syncTimer !== undefined) {
        clearTimeout(syncTimer);
        syncTimer = undefined;
        saySync({ state: "idle", installed: syncStatus.state !== "installing" });
      }
      return null;
    },
    subtitlesSyncUndo: () => {
      record("subtitlesSyncUndo", null, null);
      if (syncStatus.state !== "synced") {
        throw { kind: "invalid", message: "there is no sync to undo" } as AppError;
      }
      const { speedBefore, delayBefore } = syncStatus;
      player = { ...player, subtitleSpeed: speedBefore, subtitleDelay: delayBefore };
      change({ type: "subtitleSpeed", rate: speedBefore });
      change({ type: "subtitleDelay", seconds: delayBefore });
      saySync({ state: "idle", installed: true });
      return null;
    },
    fontsList: () =>
      record("fontsList", null, [
        "Avenir Next",
        "Baskerville",
        "Futura",
        "Gill Sans",
        "Helvetica Neue",
        "Hoefler Text",
        "Optima",
        "Palatino",
        "SF Pro Text",
        "Times New Roman",
      ]),
    playlistSnapshot: queueSnapshot,
    playlistOpen: (args) => {
      record("playlistOpen", args, null);
      const known = history.find((entry) => entry.source === args.sources[0]);
      const at =
        args.resume && known && !known.finished && known.position >= 10 ? known.position : 0;
      startQueue(args.sources, at > 0 ? { position: at - 3 } : {});
      if (at > 0) {
        change({ type: "resumed", seconds: at - 3 });
      }
      return null;
    },
    playlistOpenRecent: (args) => {
      record("playlistOpenRecent", args, null);
      const known = history.find((entry) => entry.source === args.source);
      const playlist = known?.playlist;
      // Another item chosen from the list starts from its own place, which the mock does not keep.
      const other = args.play !== null && args.play !== args.source;
      const at =
        args.resume && known && !other && !known.finished && known.position >= 10
          ? known.position - 3
          : 0;
      if (!playlist?.items.some((item) => item.source === args.source)) {
        startQueue([args.source], at > 0 ? { position: at } : {});
      } else {
        items = makeItems(playlist.items.map((item) => item.source));
        queueKept = playlist.key.startsWith("saved:") ? Number(playlist.key.slice(6)) : null;
        queueKey = playlist.key;
        const wanted = args.play ?? args.source;
        const chosen = (items.find((item) => item.source === wanted) ??
          items.find((item) => item.source === args.source)) as QueueItem;
        current = chosen.id;
        announce();
        load({
          source: chosen.source,
          duration: chosen.duration ?? FILM_LENGTH,
          ...(at > 0 ? { position: at } : {}),
        });
      }
      if (at > 0) {
        change({ type: "resumed", seconds: at });
      }
      return null;
    },
    playlistOpenDialog: (args) => {
      record("playlistOpenDialog", args, true);
      startQueue(args.folder ? FOLDER : ["/Users/me/Films/The Long Take (2019).mkv"]);
      return true;
    },
    playlistAdd: (args) => {
      record("playlistAdd", args, args.sources.length);
      const added = makeItems(args.sources);
      const at = args.index ?? items.length;
      items = [...items.slice(0, at), ...added, ...items.slice(at)];
      const first = added[0];
      if (player.source === null && first) {
        playItem(first);
      } else {
        announce();
      }
      return added.length;
    },
    playlistAddDialog: () => {
      record("playlistAddDialog", null, 2);
      items = [
        ...items,
        ...makeItems(["/Users/me/Films/Added 1.mkv", "/Users/me/Films/Added 2.mkv"]),
      ];
      announce();
      return 2;
    },
    playlistPlay: (args) => {
      record("playlistPlay", args, null);
      const item = items.find((other) => other.id === args.id);
      if (!item) {
        throw { kind: "notFound", message: "that item is no longer in the playlist" } as AppError;
      }
      if (item.id === current) {
        setPosition(0);
        setStatus("playing");
      } else {
        playItem(item);
      }
      return null;
    },
    playlistRemove: (args) => {
      record("playlistRemove", args, null);
      const at = items.findIndex((item) => item.id === args.id);
      if (at < 0) {
        return null;
      }
      const wasCurrent = items[at]?.id === current;
      const follower = items[at + 1] ?? items[at - 1];
      items = items.filter((item) => item.id !== args.id);
      if (!wasCurrent) {
        announce();
      } else if (follower) {
        playItem(follower);
      } else {
        stop();
      }
      return null;
    },
    playlistMove: (args) => {
      record("playlistMove", args, null);
      const item = items.find((other) => other.id === args.id);
      if (item) {
        const rest = items.filter((other) => other.id !== args.id);
        items = [...rest.slice(0, args.index), item, ...rest.slice(args.index)];
        announce();
      }
      return null;
    },
    playlistClear: () => {
      record("playlistClear", null, null);
      items = items.filter((item) => item.id === current);
      queueKept = null;
      announce();
      return null;
    },
    playlistNext: () => record("playlistNext", null, step(1)),
    playlistPrevious: () => record("playlistPrevious", null, step(-1)),
    playlistSetRepeat: (args) => {
      repeat = args.repeat;
      announce();
      return record("playlistSetRepeat", args, null);
    },
    playlistSetShuffle: (args) => {
      shuffle = args.shuffle;
      announce();
      return record("playlistSetShuffle", args, null);
    },
    playlistClose: () => {
      record("playlistClose", null, null);
      stop();
      return null;
    },
    playlistsList: () => savedList(),
    playlistsSave: (args) => {
      record("playlistsSave", args, null);
      const name = args.name.trim();
      const existing = [...saved.values()].find(
        (entry) => !entry.deleted && entry.playlist.name.toLowerCase() === name.toLowerCase(),
      );
      if (existing && !args.replace) {
        throw {
          kind: "exists",
          message: `there is already a playlist called “${name}”`,
        } as AppError;
      }
      const sources = items.map((item) => item.source);
      const playlist: SavedPlaylist = {
        id: existing?.playlist.id ?? nextPlaylistId++,
        name,
        count: sources.length,
        duration: items.reduce((sum, item) => sum + (item.duration ?? 0), 0),
        updatedAt: clock,
      };
      saved.set(playlist.id, { playlist, sources, deleted: false });
      queueKept = playlist.id;
      announce();
      announceSaved();
      return playlist;
    },
    playlistsOpen: (args) => {
      record("playlistsOpen", args, null);
      const entry = saved.get(args.id);
      if (!entry || entry.deleted) {
        throw { kind: "notFound", message: "that playlist is no longer saved" } as AppError;
      }
      startQueue(entry.sources);
      queueKept = args.id;
      announce();
      return null;
    },
    playlistsRename: (args) => {
      record("playlistsRename", args, null);
      const entry = saved.get(args.id);
      if (!entry) {
        throw { kind: "notFound", message: "that playlist is no longer saved" } as AppError;
      }
      entry.playlist = { ...entry.playlist, name: args.name.trim() };
      // The queue that is this playlist is renamed with it.
      if (queueKept === args.id) {
        announce();
      }
      announceSaved();
      return entry.playlist;
    },
    playlistsDelete: (args) => {
      const entry = saved.get(args.id);
      const deleted = record("playlistsDelete", args, entry !== undefined && !entry.deleted);
      if (entry && deleted) {
        entry.deleted = true;
        // The queue that was this playlist plays on without its name.
        if (queueKept === args.id) {
          announce();
        }
        announceSaved();
      }
      return deleted;
    },
    playlistsUndelete: (args) => {
      record("playlistsUndelete", args, null);
      const entry = saved.get(args.id);
      const playlist = summary(args.id);
      if (!entry || !playlist) {
        throw {
          kind: "notFound",
          message: "that playlist can no longer be brought back",
        } as AppError;
      }
      entry.deleted = false;
      // A queue that is still the one it was deleted from under is named again.
      if (queueKept === args.id) {
        announce();
      }
      announceSaved();
      return playlist;
    },
    historyRecent: (args) => {
      // A playlist is listed once, by the item played last, as the backend does.
      const seen = new Set<string>();
      const listed = history.filter((entry) => {
        const key = entry.playlist?.key;
        if (key === undefined) {
          return true;
        }
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
      return record("historyRecent", args, listed.slice(0, args.limit));
    },
    historyForget: (args) => {
      const gone = history.find((entry) => entry.source === args.source);
      const had = gone !== undefined;
      const forgotten = record("historyForget", args, had);
      // A playlist is forgotten whole.
      const key = gone?.playlist?.key;
      history = history.filter(
        (entry) =>
          entry.source !== args.source && (key === undefined || entry.playlist?.key !== key),
      );
      if (had) {
        announceHistory();
      }
      return forgotten;
    },
    historyRestore: (args) => {
      const entry: HistoryEntry = args.entry;
      history = [
        ...history,
        {
          ...entry,
          available: true,
          poster: null,
          resumesAt: entry.finished ? null : resumePoint(entry.position, entry.duration),
        },
      ].sort((a, b) => b.playedAt - a.playedAt);
      record("historyRestore", args, null);
      announceHistory();
      return null;
    },
    historyClear: () => {
      record("historyClear", null, null);
      history = [];
      announceHistory();
      return null;
    },
    filesShowInFinder: (args) => record("filesShowInFinder", args, null),
    torrentsSearch: async (args) => {
      record("torrentsSearch", args, null);
      await new Promise((resolve) => setTimeout(resolve, 250));
      const words = args.query.toLowerCase().split(/\s+/).filter(Boolean);
      // Like the real search: only what TorBox already has.
      return MOCK_TORRENTS.filter(
        (entry) =>
          entry.result.ready === true &&
          words.every((word) => entry.result.name.toLowerCase().includes(word)),
      ).map((entry) => entry.result);
    },
    torrentsPrepare: (args) => {
      record("torrentsPrepare", args, null);
      const entry = MOCK_TORRENTS.find((candidate) => candidate.result.magnet === args.magnet);
      if (!entry) {
        throw { kind: "network", message: "the server did not take that torrent" } as AppError;
      }
      const id = `tb-${entry.result.hash}`;
      torrentPolls.set(id, entry.result.ready ? 100 : 0);
      return id;
    },
    torrentsStatus: (args) => {
      record("torrentsStatus", args, null);
      const entry = MOCK_TORRENTS.find((candidate) => `tb-${candidate.result.hash}` === args.id);
      const done = torrentPolls.get(args.id);
      if (!entry || done === undefined) {
        return {
          phase: "failed",
          message: "No one is sharing this right now. Try another result.",
        };
      }
      if (done < 100) {
        torrentPolls.set(args.id, Math.min(100, done + 34));
        return {
          phase: "working",
          name: entry.result.name,
          state: done === 0 ? "metaDL" : "downloading",
          progress: done,
          speed: done === 0 ? 0 : 4_200_000,
          seeders: entry.result.seeders,
        };
      }
      return { phase: "ready", name: entry.result.name, files: entry.files };
    },
    torrentsPlay: (args) => {
      record("torrentsPlay", args, null);
      const entry = MOCK_TORRENTS.find((candidate) => `tb-${candidate.result.hash}` === args.id);
      const file = entry?.files.find((candidate) => candidate.index === args.index);
      if (!file) {
        throw { kind: "notFound", message: "that file is not in the torrent" } as AppError;
      }
      startQueue([`https://torrents.example/dl/${args.id}/${file.index}/${file.name}`]);
      return null;
    },
    torrentsPlayNext: (args) => {
      record("torrentsPlayNext", args, null);
      const entry = MOCK_TORRENTS.find((candidate) => `tb-${candidate.result.hash}` === args.id);
      const file = entry?.files.find((candidate) => candidate.index === args.index);
      if (!file) {
        throw { kind: "notFound", message: "that file is not in the torrent" } as AppError;
      }
      const added = makeItems([
        `https://torrents.example/dl/${args.id}/${file.index}/${file.name}`,
      ]);
      const at = items.findIndex((item) => item.source === player.source) + 1;
      items = [...items.slice(0, at), ...added, ...items.slice(at)];
      announce();
      return added.length;
    },
    torrentsDownload: (args) => record("torrentsDownload", args, null),
    windowSetBackdropBlur: (args) => record("windowSetBackdropBlur", args, null),
  });

  forgetRemovedListeners();

  window.__lumenMock = mock;
  return mock;
}

type Invoke = (command: string, args?: unknown, options?: unknown) => Promise<unknown>;

/**
 * The event mock in @tauri-apps/api 2.12 looks for `id` where the event API
 * sends `eventId`, so it never forgets a removed listener and warns on every
 * event after that. This passes the id along under the name it expects.
 */
function forgetRemovedListeners(): void {
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } })
    .__TAURI_INTERNALS__;
  const invoke = internals.invoke;
  internals.invoke = (command, args, options) => {
    if (command === "plugin:event|unlisten" && typeof args === "object" && args !== null) {
      const { eventId } = args as { eventId?: unknown };
      return invoke(command, { ...args, id: eventId }, options);
    }
    return invoke(command, args, options);
  };
}
