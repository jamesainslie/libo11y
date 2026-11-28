/**
 * replay(): the session replay collector for @libo11y/rum (design decisions P4 to P9). Installing it
 * is the opt-in. RUM starts it only while consent is granted, and stops it on revoke, shutdown and
 * the remote kill switch.
 *
 * - It refuses to start, logging once, in an extension content script (it must not record the host
 *   page), without Web Locks or CompressionStream, and without a service name.
 * - Each session is configured once, when it starts: the code settings clamped by the replay object
 *   of the remote document the session started under, which can only make replay stricter. A
 *   session records when replay is on and fnv1a32("replay:" + session.id) / 2^32 is below the
 *   sample rate, so every tab agrees: from the start when it is head-sampled, into a lead-up buffer
 *   in memory when it is not and onRetain is on. Otherwise the recorder does not run.
 * - Closed segments of a kept session upload. A session that is not kept keeps its last
 *   LEAD_UP_SEGMENTS closed segments in memory; when it is kept they and the open segment upload,
 *   and when it ends unkept they are dropped.
 * - The segment is cut when the page hides (RUM's lifecycle) and when the session changes, and the
 *   recorder restarts with a new recording ID for a new session.
 * - o11y.rum.error and o11y.rum.frustration events carry o11y.rum.replay.segment, the number of the
 *   session's segment being sent or last sent, once one has been numbered.
 * - The stop drops everything not sent. On a revoke it also removes the shared segment counter; a
 *   stop while consent holds (shutdown, kill switch) leaves it for the session's other tabs.
 */
import { O11yError } from "@libo11y/core";
import type { RumCollector, RumRuntime, SessionState, ViewState } from "@libo11y/rum";
import { fnv1a32, randomUuid } from "@libo11y/rum/internal";
import { ATTR_RUM_REPLAY_SEGMENT, EVENT_RUM_ERROR, EVENT_RUM_FRUSTRATION } from "@libo11y/spec";
import { pristineFetch } from "@libo11y/web/portable";
import { clampReplay, parseReplayRemote, type ReplaySettings, resolveReplayLimits } from "./clamp.ts";
import type { SegmentEnvelope, SegmentView } from "./envelope.ts";
import type { ReplayOptions } from "./options.ts";
import { resolvePolicy } from "./policy.ts";
import { type Recorder, type StartRecorder, startRecorder } from "./recorder.ts";
import { type ClosedSegment, createSegmenter, type Segmenter } from "./segmenter.ts";
import { allocateSegment, clearSequence, type LockManagerLike } from "./sequence.ts";
import { createUploader } from "./upload.ts";

/** Closed segments an unkept session keeps in memory, besides the open one. */
export const LEAD_UP_SEGMENTS = 2;
export const SEGMENT_MAX_MILLIS = 30_000;
export const SEGMENT_MAX_BYTES = 1_048_576;
/** Well under the gateway's default replay.max_events of 20000. */
export const SEGMENT_MAX_EVENTS = 10_000;
export const SEGMENT_MAX_REQUESTS = 200;
export const UPLOAD_MAX_QUEUE = 4;
export const UPLOAD_MAX_QUEUE_BYTES = 4_194_304;

type Timers = { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };

/** What replay runs on. Internal: the unit tests replace parts of it. */
export interface ReplayDeps {
  readonly startRecorder: StartRecorder;
  readonly fetch: typeof fetch | undefined;
  readonly locks: LockManagerLike | undefined;
  readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;
  readonly timers: Timers;
  /** Epoch milliseconds. */
  readonly now: () => number;
  /** CompressionStream exists. */
  readonly compression: boolean;
  /** The page is an extension content script. */
  readonly contentScript: boolean;
  /** The page URL, the base of the default endpoint. */
  readonly location: string;
  /** Whether a CSS selector parses. */
  readonly validSelector: (s: string) => boolean;
  /** A new recording ID. */
  readonly recordingId: () => string;
  readonly warn: (message: string) => void;
}

function browserStorage(): ReplayDeps["storage"] {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function isContentScript(): boolean {
  const g = globalThis as { chrome?: { runtime?: { id?: unknown } }; location?: { protocol?: string } };
  try {
    return (
      typeof g.chrome?.runtime?.id === "string" &&
      g.location?.protocol !== "chrome-extension:" &&
      g.location?.protocol !== "moz-extension:" &&
      g.location?.protocol !== "safari-web-extension:"
    );
  } catch {
    return true;
  }
}

function selectorParses(s: string): boolean {
  try {
    globalThis.document?.createDocumentFragment().querySelector(s);
    return globalThis.document !== undefined;
  } catch {
    return false;
  }
}

/** The real dependencies of a page, read when the collector starts. */
export function defaultReplayDeps(): ReplayDeps {
  const g = globalThis as { navigator?: { locks?: LockManagerLike }; location?: { href?: string } };
  return {
    startRecorder,
    fetch: pristineFetch,
    locks: g.navigator?.locks,
    storage: browserStorage(),
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
    now: Date.now,
    compression: typeof CompressionStream === "function",
    contentScript: isContentScript(),
    location: g.location?.href ?? "about:blank",
    validSelector: selectorParses,
    recordingId: randomUuid,
    // The collector's only log line, once per start, when replay cannot run here.
    warn: (m) => console.warn(m),
  };
}

interface Resolved {
  readonly options: ReplayOptions;
  readonly sampleRate: number;
  readonly onRetain: boolean;
  readonly limits: readonly [min: number, max: number];
}

function resolveOptions(options: ReplayOptions): Resolved {
  const rate = options.sampleRate ?? 1;
  if (!(typeof rate === "number" && rate >= 0 && rate <= 1)) {
    throw new O11yError("INVALID_OPTION", "replay sampleRate must be between 0 and 1");
  }
  if (options.url !== undefined && (typeof options.url !== "string" || options.url === "")) {
    throw new O11yError("INVALID_OPTION", "replay url must be a non-empty string");
  }
  resolvePolicy(options.privacy, new Set());
  return {
    options,
    sampleRate: rate,
    onRetain: options.onRetain === true,
    limits: resolveReplayLimits(rate, options.limits),
  };
}

function viewOf(rt: RumRuntime, v: ViewState): SegmentView {
  const sc = v.spanContext;
  return {
    id: v.id,
    name: v.name,
    at: Math.round(rt.timeOrigin + v.startTime),
    ...(sc === undefined ? {} : { trace_id: sc.traceId, span_id: sc.spanId }),
  };
}

const NOOP = (): void => {};

/** Where a recording's closed segments go. */
interface Route {
  /** Segments upload as they close; otherwise they go to the lead-up ring while live. */
  direct: boolean;
  /** The recording runs. */
  live: boolean;
  ring: SegmentEnvelope[];
}

interface Recording {
  readonly session: string;
  readonly recorder: Recorder;
  readonly segmenter: Segmenter;
  readonly route: Route;
}

/** replay over deps. Internal: the seam the unit tests use. Throws O11yError INVALID_OPTION for invalid options. */
export function replayWith(deps: ReplayDeps | (() => ReplayDeps), options: ReplayOptions = {}): RumCollector {
  const resolved = resolveOptions(options);
  return {
    name: "replay",
    start(rt) {
      const d = typeof deps === "function" ? deps() : deps;
      const service = rt.telemetry.resource?.attributes["service.name"];
      const refuse = (why: string): (() => void) => {
        d.warn(`o11y: rum-replay: replay is off: ${why}`);
        return NOOP;
      };
      if (rt.scope !== undefined || d.contentScript)
        return refuse("an extension content script records no page");
      if (d.locks === undefined) return refuse("this browser has no Web Locks");
      if (!d.compression) return refuse("this browser has no CompressionStream");
      if (d.storage === undefined) return refuse("localStorage is not available");
      if (typeof service !== "string" || service === "") return refuse("the telemetry has no service.name");
      const locks = d.locks;
      const storage = d.storage;
      const url = resolved.options.url ?? new URL("/_o11y/v1/replay", d.location).href;

      const code: ReplaySettings = {
        enabled: true,
        sampleRate: resolved.sampleRate,
        onRetain: resolved.onRetain,
        policy: resolvePolicy(resolved.options.privacy, rt.settings().queryAllowList),
      };
      const uploader = createUploader({
        url,
        service,
        ...(rt.settings().clientToken === undefined ? {} : { clientToken: rt.settings().clientToken }),
        fetch: d.fetch ?? globalThis.fetch,
        allocate: (id) => allocateSegment(id, storage, locks),
        now: d.now,
        allowed: (id) => rt.gate.recording() && rt.session.decide(id) === "send",
        timers: d.timers,
        maxQueue: UPLOAD_MAX_QUEUE,
        maxQueueBytes: UPLOAD_MAX_QUEUE_BYTES,
      });

      /** The recording of the current session, while one runs. */
      let recording: Recording | undefined;

      /** Ends the recording. Its open segment closes first, routed as the recording routed its own, unless discard. */
      const stopRecording = (discard: boolean): void => {
        const r = recording;
        if (r === undefined) return;
        recording = undefined;
        if (discard) r.route.direct = false;
        r.route.live = false;
        r.route.ring = [];
        r.segmenter.cut("stop");
        r.recorder.stop();
      };

      const begin = (session: SessionState | undefined): void => {
        stopRecording(false);
        if (session === undefined || !rt.gate.recording()) return;
        const s = clampReplay(
          code,
          resolved.limits,
          parseReplayRemote(rt.remoteDocument()?.replay, d.validSelector),
        );
        if (!s.enabled || fnv1a32(`replay:${session.id}`) / 2 ** 32 >= s.sampleRate) return;
        const kept = rt.session.decide(session.id) === "send";
        const direct = session.sampled || (kept && s.onRetain);
        if (!direct && !s.onRetain) return;
        const id = session.id;
        const route: Route = { direct, live: true, ring: [] };
        let recorder: Recorder | undefined;
        const segmenter = createSegmenter({
          recording: d.recordingId(),
          maxMillis: SEGMENT_MAX_MILLIS,
          maxBytes: SEGMENT_MAX_BYTES,
          maxEvents: SEGMENT_MAX_EVENTS,
          maxRequests: SEGMENT_MAX_REQUESTS,
          timers: d.timers,
          checkout: () => recorder?.checkout(),
          onClose: (c: ClosedSegment) => {
            if (route.direct) uploader.enqueue(id, c.envelope);
            else if (route.live) {
              route.ring.push(c.envelope);
              if (route.ring.length > LEAD_UP_SEGMENTS) route.ring.shift();
            }
          },
        });
        const v = rt.views.current();
        if (v !== undefined) segmenter.view(viewOf(rt, v));
        recorder = d.startRecorder(
          s.policy,
          (e) => segmenter.push(e),
          (err) => d.warn(`o11y: rum-replay: the recorder failed: ${String(err)}`),
        );
        if (recorder === undefined) {
          route.live = false;
          segmenter.cut("stop");
          return;
        }
        recording = { session: id, recorder, segmenter, route };
      };

      /** The session was kept: its lead-up and its open segment upload, and segments upload as they close. */
      const keep = (r: Recording): void => {
        if (r.route.direct) return;
        r.route.direct = true;
        for (const env of r.route.ring) uploader.enqueue(r.session, env);
        r.route.ring = [];
        r.segmenter.cut("session");
      };

      const offs: (() => void)[] = [
        rt.ignoreUrl(url),
        rt.onHide(() => recording?.segmenter.cut("hide")),
        rt.session.subscribe((e) => {
          const r = recording;
          if (e.type === "start") {
            if (r?.session !== e.session.id) begin(e.session);
          } else if (r?.session !== e.session.id) {
            // another session's event
          } else if (e.type === "kept") keep(r);
          else if (!r.route.direct) r.route.ring = [];
        }),
        rt.views.subscribe((e) => {
          if (e.type !== "end") recording?.segmenter.view(viewOf(rt, rt.views.current() ?? e.view));
        }),
        rt.onRequestStart((span) => {
          const sc = span.spanContext();
          recording?.segmenter.request({ trace_id: sc.traceId, span_id: sc.spanId, at: d.now() });
        }),
        rt.addEventAttributes([EVENT_RUM_ERROR, EVENT_RUM_FRUSTRATION], () => {
          const id = rt.session.current()?.id;
          const n = id === undefined ? undefined : uploader.currentSegment(id);
          return n === undefined ? undefined : { [ATTR_RUM_REPLAY_SEGMENT]: n };
        }),
      ];

      begin(rt.session.current());

      return () => {
        for (const off of offs.splice(0)) off();
        stopRecording(true);
        uploader.clear();
        if (!rt.gate.recording()) clearSequence(storage);
      };
    },
  };
}

/**
 * Session replay for `@libo11y/rum`: records the page with rrweb at its strictest, scrubs every event
 * against libo11y's privacy rules before it is kept, and uploads self-contained segments of kept
 * sessions to the gateway. Text is masked unless privacy.unmask lists it; input values and
 * editable content are never recorded. Throws O11yError INVALID_OPTION for invalid options.
 */
export function replay(options: ReplayOptions = {}): RumCollector {
  return replayWith(defaultReplayDeps, options);
}
