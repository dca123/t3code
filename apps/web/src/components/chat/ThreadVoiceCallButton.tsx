import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type MessageId,
  type ThreadId,
  type ThreadVoiceEndReason,
  type ThreadVoiceObservation,
  type ThreadVoicePhase,
  THREAD_VOICE_SILENCE_MS,
  ThreadVoiceError,
  WS_METHODS,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import * as Schema from "effect/Schema";
import { MicIcon, PhoneIcon, PhoneOffIcon, Volume2Icon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { buildThreadRouteParams } from "../../threadRoutes";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { toastManager } from "../ui/toast";
import { useThreadVoiceCallStore, type ActiveThreadVoiceCall } from "./threadVoiceCallStore";

const startCall = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "thread-voice:start",
  tag: WS_METHODS.threadVoiceStart,
});
const endCall = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "thread-voice:end",
  tag: WS_METHODS.threadVoiceEnd,
});
const reportCall = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "thread-voice:report",
  tag: WS_METHODS.threadVoiceReport,
});
const quietCommand = { reportFailure: false, reportDefect: false };
const isThreadVoiceError = Schema.is(ThreadVoiceError);

type Translate = ReturnType<typeof useGT>;

function phaseLabel(gt: Translate, phase: ThreadVoicePhase) {
  switch (phase) {
    case "microphone":
      return gt("Opening microphone…");
    case "gathering":
      return gt("Gathering network candidates…");
    case "placing":
      return gt("Placing call…");
    case "connecting":
      return gt("Connecting audio…");
    case "connected":
      return gt("Voice call connected");
    case "reconnecting":
      return gt("Voice connection interrupted. Reconnecting…");
  }
}

function endMessage(gt: Translate, reason: ThreadVoiceEndReason) {
  switch (reason) {
    case "hung-up":
      return gt("You hung up.");
    case "silence":
      return gt("The call ended after five minutes of silence.");
    case "microphone-blocked":
      return /mac/i.test(navigator.platform)
        ? gt(
            "Microphone access is blocked. Allow it in System Settings → Privacy & Security → Microphone, then retry.",
          )
        : gt(
            "Microphone access is blocked. Allow access in your browser or system settings, then retry.",
          );
    case "microphone-unavailable":
      return gt("Could not open the microphone. Connect or select an input device, then retry.");
    case "microphone-ended":
      return gt("The microphone stopped. Check your input device, then start a new call.");
    case "thread-unavailable":
      return gt(
        "This thread cannot take a call yet. Send its first message or open an active thread.",
      );
    case "sign-in":
      return gt("Sign in to Codex with ChatGPT, then try the call again.");
    case "busy":
      return gt("A call is already open. Hang up there before starting another.");
    case "disabled":
      return gt("Voice calls are off on this server.");
    case "playback-blocked":
      return gt("Call audio could not play. Check your sound settings, then retry.");
    case "remote-ended":
      return gt("ChatGPT voice ended the call. Start a new call to continue.");
    case "connection-lost":
      return gt("The voice connection was lost. Start a new call to continue.");
    case "setup-timeout":
      return gt("The call took too long to connect. Check your connection and try again.");
    case "connection":
      return gt("Could not connect to ChatGPT voice. Check your connection and try again.");
  }
}

function CallClock({ startedAt }: { readonly startedAt: number }) {
  const [now, setNow] = useState(Date.now);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- track the elapsed time from the system clock
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <span className="shrink-0 tabular-nums text-muted-foreground">
      {`${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`}
    </span>
  );
}

function waitForCandidates(peer: RTCPeerConnection, signal: AbortSignal) {
  if (peer.iceGatheringState === "complete" || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const update = () => {
      if (peer.iceGatheringState === "complete") finish();
    };
    const finish = () => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", update);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 3_000);
    peer.addEventListener("icegatheringstatechange", update);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export function ThreadVoiceCallButton({
  environmentId,
  threadId,
  available,
  blocked,
  title,
  agentStatus,
  failedHandoffId,
  statusTarget,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly available: boolean;
  readonly blocked: boolean;
  readonly title: string;
  readonly agentStatus: "approval" | "working" | "idle";
  readonly failedHandoffId: MessageId | null;
  readonly statusTarget: HTMLDivElement | null;
}) {
  const gt = useGT();
  const start = useAtomCommand(startCall, quietCommand);
  const end = useAtomCommand(endCall, quietCommand);
  const report = useAtomCommand(reportCall, quietCommand);
  const allowed = useAtomValue(startCall.permissionAtom(environmentId));
  const active = useThreadVoiceCallStore((state) => state.active);
  const ended = useThreadVoiceCallStore((state) => state.ended);
  const target = { environmentId, threadId, title };
  const owns = (other: { environmentId: EnvironmentId; threadId: ThreadId }) =>
    other.environmentId === environmentId && other.threadId === threadId;

  const placeCall = async () => {
    if (useThreadVoiceCallStore.getState().active !== null || blocked || !allowed) return;
    const callId = randomUUID();
    const observe = (observation: ThreadVoiceObservation) => {
      void report({ environmentId, input: { callId, threadId, observation } });
    };
    if (!available) {
      observe({ _tag: "end", reason: "thread-unavailable" });
      useThreadVoiceCallStore.setState({ ended: { target, reason: "thread-unavailable" } });
      return;
    }
    const cancellation = new AbortController();
    const { signal } = cancellation;
    const playback = new Audio();
    let mic: MediaStream | null = null;
    let peer: RTCPeerConnection | null = null;
    let serverRequested = false;
    let audioContext: AudioContext | null = null;
    let samples: ReturnType<typeof setInterval> | undefined;
    const micMeter = { current: null as HTMLMeterElement | null };
    const incomingMeter = { current: null as HTMLMeterElement | null };
    let silenceTimer: ReturnType<typeof setTimeout> | undefined;
    let upstreamWarning: ReturnType<typeof setTimeout> | undefined;
    let upstreamEndsAt: number | null = null;
    let lastSpeechAt = 0;
    const markSpeech = () => {
      lastSpeechAt = Date.now();
    };
    const checkSilence = () => {
      const remaining = THREAD_VOICE_SILENCE_MS - (Date.now() - lastSpeechAt);
      if (remaining <= 0) finish("silence");
      else silenceTimer = setTimeout(checkSilence, remaining);
    };
    let connectionGrace: ReturnType<typeof setTimeout> | undefined;
    let phase: ThreadVoicePhase | null = null;
    const advance = (next: ThreadVoicePhase) => {
      if (phase === next) return;
      phase = next;
      useThreadVoiceCallStore.setState((state) =>
        state.active?.callId === callId ? { active: { ...state.active, phase: next } } : state,
      );
      observe({ _tag: "phase", phase: next });
    };
    const finish = (reason: ThreadVoiceEndReason) => {
      if (signal.aborted) return;
      cancellation.abort();
      clearTimeout(setupDeadline);
      clearTimeout(silenceTimer);
      clearTimeout(upstreamWarning);
      clearTimeout(connectionGrace);
      clearInterval(samples);
      observe({ _tag: "end", reason });
      peer?.close();
      mic?.getTracks().forEach((track) => track.stop());
      playback.pause();
      playback.srcObject = null;
      void audioContext?.close().catch(() => undefined);
      if (serverRequested) void end({ environmentId, input: { callId } });
      useThreadVoiceCallStore.setState({ active: null, ended: { target, reason } });
    };
    const setupDeadline = setTimeout(() => finish("setup-timeout"), 70_000);
    useThreadVoiceCallStore.setState({
      active: {
        target,
        callId,
        startedAt: Date.now(),
        phase: "microphone",

        handoffId: null,
        bindMicMeter: (element) => {
          micMeter.current = element;
        },
        bindIncomingMeter: (element) => {
          incomingMeter.current = element;
        },
        finish,
      },
      ended: null,
    });
    advance("microphone");
    try {
      audioContext = new AudioContext();
      void audioContext.resume().catch(() => undefined);
    } catch {
      // A metering failure should not prevent a call.
    }
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      finish(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "microphone-blocked"
          : "microphone-unavailable",
      );
      return;
    }
    if (signal.aborted) {
      mic.getTracks().forEach((track) => track.stop());
      return;
    }
    try {
      const track = mic.getAudioTracks()[0];
      if (track === undefined) {
        finish("microphone-unavailable");
        return;
      }
      const reportMic = () => {
        if (signal.aborted) return;
        observe({
          _tag: "microphone",
          state: track.readyState,
          muted: track.muted,
          enabled: track.enabled,
        });
        if (track.readyState === "ended") finish("microphone-ended");
      };
      for (const event of ["mute", "unmute", "ended"])
        track.addEventListener(event, reportMic, { signal });
      reportMic();
      if (signal.aborted) return;
      if (audioContext !== null) samples = meterMicrophone(audioContext, mic, micMeter, markSpeech);

      const rtc = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
      peer = rtc;
      const transceiver = rtc.addTransceiver(track, { direction: "sendrecv", streams: [mic] });
      const opus = RTCRtpSender.getCapabilities("audio")?.codecs.filter(
        (codec) => codec.mimeType === "audio/opus",
      );
      if (opus !== undefined && opus.length > 0) transceiver.setCodecPreferences(opus);
      const channel = rtc.createDataChannel("oai-events");
      const updatePeer = () => {
        if (signal.aborted) return;
        observe({
          _tag: "peer",
          connection: rtc.connectionState,
          ice: rtc.iceConnectionState,
          gathering: rtc.iceGatheringState,
          dataChannel: channel.readyState,
        });
        if (
          rtc.connectionState === "failed" ||
          rtc.iceConnectionState === "failed" ||
          channel.readyState === "closed"
        ) {
          finish("connection-lost");
        } else if (
          rtc.connectionState === "disconnected" ||
          rtc.iceConnectionState === "disconnected"
        ) {
          advance("reconnecting");
          if (connectionGrace === undefined) {
            connectionGrace = setTimeout(() => finish("connection-lost"), 5_000);
          }
        } else if (rtc.connectionState === "connected" && channel.readyState === "open") {
          clearTimeout(connectionGrace);
          connectionGrace = undefined;
          clearTimeout(setupDeadline);
          if (silenceTimer === undefined) {
            markSpeech();
            silenceTimer = setTimeout(checkSilence, THREAD_VOICE_SILENCE_MS);
          }
          advance("connected");
        }
      };
      rtc.onicegatheringstatechange = updatePeer;
      rtc.oniceconnectionstatechange = updatePeer;
      rtc.onconnectionstatechange = updatePeer;
      channel.onopen = updatePeer;
      channel.onclose = updatePeer;
      channel.onerror = () => finish("connection-lost");
      channel.onmessage = ({ data }) => {
        if (signal.aborted || typeof data !== "string") return;
        let event: unknown;
        try {
          event = JSON.parse(data);
        } catch {
          return;
        }
        if (!event || typeof event !== "object" || !("type" in event)) return;
        switch (event.type) {
          case "session.closed":
            finish("remote-ended");
            break;
          case "error":
            finish("connection-lost");
            break;
          case "input_transcript.added":
          case "output_transcript.added":
            markSpeech();
            break;
          case "delegation.created": {
            if (
              !("item" in event) ||
              !event.item ||
              typeof event.item !== "object" ||
              !("id" in event.item) ||
              typeof event.item.id !== "string"
            )
              break;
            const handoffId = event.item.id;
            useThreadVoiceCallStore.setState((state) =>
              state.active?.callId === callId ? { active: { ...state.active, handoffId } } : state,
            );
            break;
          }
          case "session.started":
          case "session.updated": {
            if (
              !("session" in event) ||
              !event.session ||
              typeof event.session !== "object" ||
              !("expires_at" in event.session) ||
              typeof event.session.expires_at !== "number"
            )
              break;
            const expiresAt = event.session.expires_at * 1000;
            if (
              !Number.isFinite(expiresAt) ||
              expiresAt <= Date.now() ||
              expiresAt === upstreamEndsAt
            )
              break;
            upstreamEndsAt = expiresAt;
            clearTimeout(upstreamWarning);
            upstreamWarning = setTimeout(
              () => toastManager.add({ type: "warning", title: gt("Voice session ends soon") }),
              Math.max(0, expiresAt - Date.now() - 60_000),
            );
            break;
          }
        }
      };
      rtc.ontrack = ({ track: remote, receiver }) => {
        if (signal.aborted || remote.kind !== "audio") return;
        observe({ _tag: "playback", state: "track" });
        meterIncomingAudio(receiver, incomingMeter, signal, observe, markSpeech);
        playback.srcObject = new MediaStream([remote]);
        void playback
          .play()
          .then(() => {
            if (!signal.aborted) observe({ _tag: "playback", state: "playing" });
          })
          .catch(() => {
            if (signal.aborted) return;
            observe({ _tag: "playback", state: "blocked" });
            finish("playback-blocked");
          });
      };
      advance("gathering");
      await rtc.setLocalDescription(await rtc.createOffer());
      await waitForCandidates(rtc, signal);
      if (signal.aborted) return;
      const sdp = rtc.localDescription?.sdp;
      if (sdp === undefined) {
        finish("connection");
        return;
      }
      advance("placing");
      serverRequested = true;
      const result = await start({ environmentId, input: { callId, threadId, sdp } }, { signal });
      if (signal.aborted) return;
      if (result._tag !== "Success") {
        const error = squashAtomCommandFailure(result);
        finish(isThreadVoiceError(error) ? error.reason : "connection");
        return;
      }
      advance("connecting");
      await rtc.setRemoteDescription({ type: "answer", sdp: result.value.sdp });
    } catch {
      finish("connection");
    }
  };

  if (active !== null) {
    if (!owns(active.target)) {
      return (
        <Link
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(
            scopeThreadRef(active.target.environmentId, active.target.threadId),
          )}
          className="min-w-0 truncate text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          {gt('On a call in "{thread}"', { thread: active.target.title })}
        </Link>
      );
    }
    return statusTarget !== null
      ? createPortal(
          <CallStatus
            call={active}
            agentStatus={agentStatus}
            handoffFailed={
              active.handoffId !== null &&
              failedHandoffId === `voice-handoff-failed:${active.callId}:${active.handoffId}`
            }
          />,
          statusTarget,
        )
      : null;
  }
  const label = gt("Start voice call");
  return (
    <>
      {ended !== null &&
        owns(ended.target) &&
        statusTarget !== null &&
        createPortal(
          <section
            aria-label={gt("Thread voice call")}
            data-voice-phase="ended"
            className={panelClass}
          >
            <p role="status" className="min-w-0 flex-1 truncate">
              {endMessage(gt, ended.reason)}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={gt("Dismiss call status")}
              onClick={() => useThreadVoiceCallStore.setState({ ended: null })}
            >
              <XIcon />
            </Button>
          </section>,
          statusTarget,
        )}
      <SharedTooltipTrigger
        label={available ? label : gt("Send the first message before calling")}
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            disabled={blocked || !allowed}
            onClick={() => void placeCall()}
          >
            <PhoneIcon />
          </Button>
        }
      />
    </>
  );
}

function meterMicrophone(
  context: AudioContext,
  stream: MediaStream,
  meter: { readonly current: HTMLMeterElement | null },
  markSpeech: () => void,
) {
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  context.createMediaStreamSource(stream).connect(analyser);
  const waveform = new Float32Array(analyser.fftSize);
  return setInterval(() => {
    analyser.getFloatTimeDomainData(waveform);
    const rms = Math.sqrt(
      waveform.reduce((sum, sample) => sum + sample * sample, 0) / waveform.length,
    );
    if (rms > 0.02) markSpeech();
    const element = meter.current;
    if (element !== null) element.value = Math.min(1, rms * 5);
  }, 100);
}

function meterIncomingAudio(
  receiver: RTCRtpReceiver,
  meter: { readonly current: HTMLMeterElement | null },
  signal: AbortSignal,
  observe: (observation: ThreadVoiceObservation) => void,
  markSpeech: () => void,
) {
  let nextTraceAt = performance.now();
  let timer: ReturnType<typeof setTimeout>;
  const sample = async () => {
    if (signal.aborted) return;
    const report = await receiver.getStats().catch(() => null);
    if (signal.aborted) return;
    let inbound: RTCInboundRtpStreamStats | undefined;
    report?.forEach((stat: RTCStats) => {
      if (stat.type === "inbound-rtp") inbound = stat as RTCInboundRtpStreamStats;
    });
    const level = inbound?.audioLevel ?? 0;
    if (level > 0.02) markSpeech();
    const element = meter.current;
    const meterValue = Math.min(1, level * 5);
    if (element !== null && element.value !== meterValue) element.value = meterValue;

    const now = performance.now();
    if (
      now >= nextTraceAt &&
      inbound?.bytesReceived !== undefined &&
      inbound.totalAudioEnergy !== undefined &&
      inbound.audioLevel !== undefined
    ) {
      nextTraceAt = now + 2_000;
      observe({
        _tag: "inbound-audio",
        bytesReceived: inbound.bytesReceived,
        totalAudioEnergy: inbound.totalAudioEnergy,
        audioLevel: inbound.audioLevel,
      });
    }
    timer = setTimeout(() => void sample(), 100);
  };
  signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  void sample();
}

const panelClass =
  "mx-3 mb-2 flex min-w-0 flex-nowrap items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-2 py-1 text-xs sm:mx-4";

function callStatusLabel(
  gt: Translate,
  phase: ThreadVoicePhase,
  agentStatus: "approval" | "working" | "idle",
  handoffFailed: boolean,
) {
  if (phase !== "connected") return phaseLabel(gt, phase);
  if (agentStatus === "approval") return gt("Approval needed");
  if (handoffFailed) return gt("Handoff failed");
  if (agentStatus === "working") return gt("Agent working");
  return phaseLabel(gt, phase);
}

function CallStatus({
  call,
  agentStatus,
  handoffFailed,
}: {
  readonly call: ActiveThreadVoiceCall;
  readonly agentStatus: "approval" | "working" | "idle";
  readonly handoffFailed: boolean;
}) {
  const gt = useGT();
  const status = callStatusLabel(gt, call.phase, agentStatus, handoffFailed);
  return (
    <section
      aria-label={gt("Thread voice call")}
      data-voice-phase={call.phase}
      className={panelClass}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <span role="status" className="min-w-0 truncate font-medium">
          {status}
        </span>
        <span aria-hidden="true" className="text-muted-foreground">
          ·
        </span>
        <CallClock startedAt={call.startedAt} />
      </div>
      <AudioLevel icon={MicIcon} label={gt("Microphone level")} bind={call.bindMicMeter} />
      <AudioLevel
        icon={Volume2Icon}
        label={gt("Incoming audio level")}
        bind={call.bindIncomingMeter}
      />
      <Button
        type="button"
        size="icon-xs"
        variant="destructive"
        aria-label={gt("Hang up voice call")}
        onClick={() => call.finish("hung-up")}
      >
        <PhoneOffIcon />
      </Button>
    </section>
  );
}

function AudioLevel({
  icon: Icon,
  label,
  bind,
}: {
  readonly icon: typeof MicIcon;
  readonly label: string;
  readonly bind: (element: HTMLMeterElement | null) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 text-muted-foreground">
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      <meter
        ref={bind}
        aria-label={label}
        min={0}
        max={1}
        defaultValue={0}
        className="h-2 w-7 sm:w-12"
      />
    </div>
  );
}
