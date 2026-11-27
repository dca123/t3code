import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ThreadId,
  type ThreadVoiceEndReason,
  type ThreadVoiceObservation,
  type ThreadVoicePhase,
  THREAD_VOICE_MAX_DURATION_MS,
  ThreadVoiceError,
  WS_METHODS,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import * as Schema from "effect/Schema";
import { MicIcon, PhoneIcon, PhoneOffIcon, Volume2Icon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import {
  emptyVoiceActivity,
  receiveVoiceActivity,
  type VoiceActivity,
} from "./threadVoiceActivity";

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

type CallDisplay =
  | { readonly kind: "idle" }
  | { readonly kind: "active"; readonly phase: ThreadVoicePhase }
  | { readonly kind: "ended"; readonly reason: ThreadVoiceEndReason };

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
    case "left-thread":
      return gt("You left the thread.");
    case "expired":
      return gt("The call reached its time limit. Start another call to continue.");
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

function CallClock({ deadline }: { readonly deadline: number }) {
  const gt = useGT();
  const [now, setNow] = useState(Date.now);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refresh the remaining time from the system clock
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const remaining = Math.max(0, Math.ceil((deadline - now) / 1000));
  const time = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
  return (
    <span className="shrink-0 tabular-nums text-muted-foreground">
      {gt("{time} left", { time })}
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
  onActiveChange,
  statusTarget,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly available: boolean;
  readonly blocked: boolean;
  readonly onActiveChange: (active: boolean) => void;
  readonly statusTarget: HTMLDivElement | null;
}) {
  const gt = useGT();
  const start = useAtomCommand(startCall, quietCommand);
  const end = useAtomCommand(endCall, quietCommand);
  const report = useAtomCommand(reportCall, quietCommand);
  const allowed = useAtomValue(startCall.permissionAtom(environmentId));
  const [display, setDisplay] = useState<CallDisplay>({ kind: "idle" });
  const [micName, setMicName] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [activity, setActivity] = useState(emptyVoiceActivity);
  const micMeter = useRef<HTMLMeterElement>(null);
  const incomingMeter = useRef<HTMLMeterElement>(null);
  const current = useRef<((reason: ThreadVoiceEndReason) => void) | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases microphone and peer when this thread's composer unmounts
  useEffect(() => () => current.current?.("left-thread"), []);

  const placeCall = async () => {
    if (current.current !== null || blocked || !allowed) return;
    const callId = randomUUID();
    const observe = (observation: ThreadVoiceObservation) => {
      void report({ environmentId, input: { callId, threadId, observation } });
    };
    if (!available) {
      observe({ _tag: "end", reason: "thread-unavailable" });
      setDisplay({ kind: "ended", reason: "thread-unavailable" });
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
    let expiration: ReturnType<typeof setTimeout> | undefined;
    let connectionGrace: ReturnType<typeof setTimeout> | undefined;
    let phase: ThreadVoicePhase | null = null;
    const advance = (next: ThreadVoicePhase) => {
      if (phase === next) return;
      phase = next;
      setDisplay({ kind: "active", phase: next });
      observe({ _tag: "phase", phase: next });
    };
    const finish = (reason: ThreadVoiceEndReason) => {
      if (signal.aborted) return;
      current.current = null;
      cancellation.abort();
      clearTimeout(setupDeadline);
      clearTimeout(expiration);
      clearTimeout(connectionGrace);
      clearInterval(samples);
      observe({ _tag: "end", reason });
      peer?.close();
      mic?.getTracks().forEach((track) => track.stop());
      playback.pause();
      playback.srcObject = null;
      void audioContext?.close().catch(() => undefined);
      if (serverRequested) void end({ environmentId, input: { callId } });
      onActiveChange(false);
      if (reason !== "left-thread") setDisplay({ kind: "ended", reason });
    };
    const setupDeadline = setTimeout(() => finish("setup-timeout"), 70_000);
    current.current = finish;
    onActiveChange(true);
    setActivity(emptyVoiceActivity);
    setMicName(null);
    setExpiresAt(null);
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
      setMicName(track.label || gt("Default microphone"));
      reportMic();
      if (signal.aborted) return;
      if (audioContext !== null) samples = meterMicrophone(audioContext, mic, micMeter);

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
        const received = receiveVoiceActivity(data, performance.now());
        if (received.type === "ended") finish(received.reason);
        if (received.type === "activity") setActivity(received.update);
      };
      rtc.ontrack = ({ track: remote, receiver }) => {
        if (signal.aborted || remote.kind !== "audio") return;
        observe({ _tag: "playback", state: "track" });
        meterIncomingAudio(receiver, incomingMeter, signal, observe);
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
      const expires = Date.now() + THREAD_VOICE_MAX_DURATION_MS;
      const result = await start({ environmentId, input: { callId, threadId, sdp } }, { signal });
      if (signal.aborted) return;
      if (result._tag !== "Success") {
        const error = squashAtomCommandFailure(result);
        finish(isThreadVoiceError(error) ? error.reason : "connection");
        return;
      }
      setExpiresAt(expires);
      expiration = setTimeout(() => finish("expired"), Math.max(0, expires - Date.now()));
      advance("connecting");
      await rtc.setRemoteDescription({ type: "answer", sdp: result.value.sdp });
    } catch {
      finish("connection");
    }
  };

  const active = display.kind === "active";
  const label = active ? gt("Hang up voice call") : gt("Start voice call");
  const tooltip = available || active ? label : gt("Send the first message before calling");
  return (
    <>
      {statusTarget !== null &&
        display.kind !== "idle" &&
        createPortal(
          <CallStatus
            display={display}
            activity={activity}
            micName={micName}
            expiresAt={expiresAt}
            micMeter={micMeter}
            incomingMeter={incomingMeter}
            dismiss={() => setDisplay({ kind: "idle" })}
          />,
          statusTarget,
        )}
      <SharedTooltipTrigger
        label={tooltip}
        render={
          <Button
            type="button"
            size="icon-sm"
            variant={active ? "destructive" : "ghost"}
            aria-label={label}
            disabled={!active && (blocked || !allowed)}
            onClick={active ? () => current.current?.("hung-up") : () => void placeCall()}
            className="shrink-0"
          >
            {active ? <PhoneOffIcon /> : <PhoneIcon />}
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
) {
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  context.createMediaStreamSource(stream).connect(analyser);
  const waveform = new Float32Array(analyser.fftSize);
  return setInterval(() => {
    const element = meter.current;
    if (element === null) return;
    analyser.getFloatTimeDomainData(waveform);
    const rms = Math.sqrt(
      waveform.reduce((sum, sample) => sum + sample * sample, 0) / waveform.length,
    );
    element.value = Math.min(1, rms * 5);
  }, 100);
}

function meterIncomingAudio(
  receiver: RTCRtpReceiver,
  meter: { readonly current: HTMLMeterElement | null },
  signal: AbortSignal,
  observe: (observation: ThreadVoiceObservation) => void,
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

function CallStatus({
  display,
  activity,
  micName,
  expiresAt,
  micMeter,
  incomingMeter,
  dismiss,
}: {
  readonly display: Exclude<CallDisplay, { kind: "idle" }>;
  readonly activity: VoiceActivity;
  readonly micName: string | null;
  readonly expiresAt: number | null;
  readonly micMeter: React.RefObject<HTMLMeterElement | null>;
  readonly incomingMeter: React.RefObject<HTMLMeterElement | null>;
  readonly dismiss: () => void;
}) {
  const gt = useGT();
  const { user, assistant } = activity.transcript;
  return (
    <section
      aria-label={gt("Thread voice call")}
      data-voice-phase={display.kind === "active" ? display.phase : "ended"}
      className="mx-3 mb-3 min-w-0 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs sm:mx-4"
    >
      {display.kind === "ended" ? (
        <div className="flex items-start justify-between gap-2">
          <div role="status" className="leading-relaxed">
            <p className="font-medium">{gt("Voice call ended")}</p>
            <p className="text-muted-foreground">{endMessage(gt, display.reason)}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={gt("Dismiss call status")}
            onClick={dismiss}
          >
            <XIcon />
          </Button>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <p role="status" className="font-medium">
              {phaseLabel(gt, display.phase)}
            </p>
            {expiresAt !== null ? <CallClock deadline={expiresAt} /> : null}
          </div>
          {micName !== null ? (
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
              <AudioLevel
                icon={MicIcon}
                label={micName}
                meterLabel={gt("Microphone level")}
                meter={micMeter}
              />
              <AudioLevel
                icon={Volume2Icon}
                label={gt("ChatGPT voice")}
                meterLabel={gt("Incoming audio level")}
                meter={incomingMeter}
              />
            </div>
          ) : null}
          {user.text || assistant.text || activity.handoffs.length > 0 ? (
            <dl className="mt-2 max-h-28 space-y-1 overflow-y-auto border-t border-border/60 pt-2">
              {user.text ? <TranscriptRow label={gt("You")} text={user.text} /> : null}
              {assistant.text ? (
                <TranscriptRow label={gt("ChatGPT voice")} text={assistant.text} />
              ) : null}
              {activity.handoffs.map((handoff) => (
                <TranscriptRow
                  key={handoff.id}
                  label={gt("Thread agent")}
                  text={
                    handoff.answered === null
                      ? gt("Handoff in progress…")
                      : gt("Answered in {seconds}s", {
                          seconds: ((handoff.answered - handoff.started) / 1000).toFixed(1),
                        })
                  }
                />
              ))}
            </dl>
          ) : null}
        </>
      )}
    </section>
  );
}

function AudioLevel({
  icon: Icon,
  label,
  meterLabel,
  meter,
}: {
  readonly icon: typeof MicIcon;
  readonly label: string;
  readonly meterLabel: string;
  readonly meter: React.RefObject<HTMLMeterElement | null>;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
      <meter
        ref={meter}
        aria-label={meterLabel}
        min={0}
        max={1}
        defaultValue={0}
        className="h-2 w-16 shrink-0"
      />
    </div>
  );
}

function TranscriptRow({ label, text }: { readonly label: string; readonly text: string }) {
  return (
    <div className="flex gap-2 break-words">
      <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{text}</dd>
    </div>
  );
}
