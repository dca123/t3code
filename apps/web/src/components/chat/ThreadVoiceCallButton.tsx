import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ThreadId,
  ThreadVoiceError,
  WS_METHODS,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import * as Schema from "effect/Schema";
import { PhoneIcon, PhoneOffIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { toastManager } from "../ui/toast";

const startCall = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "thread-voice:start",
  tag: WS_METHODS.threadVoiceStart,
});
const endCall = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "thread-voice:end",
  tag: WS_METHODS.threadVoiceEnd,
});
const isThreadVoiceError = Schema.is(ThreadVoiceError);

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
  blocked,
  onActiveChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly blocked: boolean;
  readonly onActiveChange: (active: boolean) => void;
}) {
  const gt = useGT();
  const start = useAtomCommand(startCall, { reportFailure: false, reportDefect: false });
  const end = useAtomCommand(endCall, { reportFailure: false, reportDefect: false });
  const allowed = useAtomValue(startCall.permissionAtom(environmentId));
  const [phase, setPhase] = useState<"idle" | "connecting" | "live">("idle");
  const current = useRef<(() => void) | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases microphone and peer when this thread's composer unmounts
  useEffect(() => () => current.current?.(), []);

  const hangUp = () => {
    current.current?.();
    setPhase("idle");
  };

  const fail = (description: string) => {
    hangUp();
    toastManager.add({ type: "error", title: gt("Voice call ended"), description });
  };

  const callFailure = (error: unknown) => {
    if (isThreadVoiceError(error)) {
      switch (error.reason) {
        case "sign-in":
          return gt("Sign in to Codex with ChatGPT, then try the call again.");
        case "busy":
          return gt("A call is already open. Hang up there before starting another.");
        case "thread-unavailable":
          return gt("This thread cannot receive a voice call.");
        case "disabled":
          return gt("Voice calls are off on this server.");
        case "connection":
          break;
      }
    }
    return gt("Could not connect to ChatGPT voice. Check your connection and try again.");
  };

  const placeCall = async () => {
    if (current.current !== null || blocked || !allowed) return;
    const cancellation = new AbortController();
    const { signal } = cancellation;
    const callId = randomUUID();
    let mic: MediaStream | null = null;
    let peer: RTCPeerConnection | null = null;
    let audio: HTMLAudioElement | null = null;
    let serverRequested = false;
    const deadline = setTimeout(() => fail(callFailure(null)), 70_000);
    const dispose = () => {
      current.current = null;
      cancellation.abort();
      clearTimeout(deadline);
      peer?.close();
      mic?.getTracks().forEach((track) => track.stop());
      if (audio !== null) {
        audio.pause();
        audio.srcObject = null;
      }
      if (serverRequested) void end({ environmentId, input: { callId } });
      onActiveChange(false);
    };
    current.current = dispose;
    onActiveChange(true);
    setPhase("connecting");
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      if (!signal.aborted)
        fail(gt("Could not open the microphone. Allow microphone access, then try again."));
      return;
    }
    if (signal.aborted) {
      mic.getTracks().forEach((track) => track.stop());
      return;
    }
    try {
      const track = mic.getAudioTracks()[0];
      if (track === undefined) {
        fail(gt("Could not open the microphone. Allow microphone access, then try again."));
        return;
      }
      const rtc = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
      peer = rtc;
      const transceiver = rtc.addTransceiver(track, { direction: "sendrecv", streams: [mic] });
      const opus = RTCRtpSender.getCapabilities("audio")?.codecs.filter(
        (codec) => codec.mimeType === "audio/opus",
      );
      if (opus !== undefined && opus.length > 0) transceiver.setCodecPreferences(opus);
      const channel = rtc.createDataChannel("oai-events");
      channel.onclose = () => {
        if (!signal.aborted) hangUp();
      };
      channel.onmessage = ({ data }) => {
        if (typeof data !== "string" || signal.aborted) return;
        try {
          if (JSON.parse(data)?.type === "session.closed") hangUp();
        } catch {
          return;
        }
      };
      const playback = new Audio();
      audio = playback;
      rtc.ontrack = ({ track: remote }) => {
        if (signal.aborted) return;
        playback.srcObject = new MediaStream([remote]);
        void playback.play().catch(() => {
          if (!signal.aborted)
            fail(gt("The browser blocked call audio. Allow sound for this site and try again."));
        });
      };
      rtc.onconnectionstatechange = () => {
        if (signal.aborted) return;
        if (rtc.connectionState === "connected") {
          clearTimeout(deadline);
          setPhase("live");
        }
        if (rtc.connectionState === "failed" || rtc.connectionState === "disconnected") {
          fail(gt("The voice connection was interrupted. Start a new call to continue."));
        }
      };
      await rtc.setLocalDescription(await rtc.createOffer());
      await waitForCandidates(rtc, signal);
      if (signal.aborted) return;
      const sdp = rtc.localDescription?.sdp;
      if (sdp === undefined) {
        fail(callFailure(null));
        return;
      }
      serverRequested = true;
      const result = await start({ environmentId, input: { callId, threadId, sdp } }, { signal });
      if (signal.aborted) return;
      if (result._tag !== "Success") {
        fail(callFailure(squashAtomCommandFailure(result)));
        return;
      }
      await rtc.setRemoteDescription({ type: "answer", sdp: result.value.sdp });
    } catch {
      if (!signal.aborted) fail(callFailure(null));
    }
  };

  const label = phase === "idle" ? gt("Start voice call") : gt("Hang up voice call");
  const active = phase !== "idle";
  return (
    <SharedTooltipTrigger
      label={label}
      render={
        <Button
          type="button"
          size="icon-sm"
          variant={active ? "destructive" : "ghost"}
          aria-label={label}
          disabled={!active && (blocked || !allowed)}
          onClick={active ? hangUp : () => void placeCall()}
          className="shrink-0"
        >
          {active ? <PhoneOffIcon /> : <PhoneIcon />}
        </Button>
      }
    />
  );
}
